import * as assert from "node:assert/strict";
import * as fileSystem from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as nodeTest from "node:test";

import {
  buildTerminalTitle,
  getTerminalRecoveryToken,
  TerminalRecoveryFileStorage,
  TerminalRecoveryRegistry,
} from "./terminal-recovery";
import type {
  TerminalRecoveryRecord,
  TerminalRecoveryRecordUpdate,
  TerminalRecoveryStorage,
} from "./terminal-recovery";

nodeTest.test("large record refreshes bound open files and only reread changed records", async (testContext) => {
  const recoveryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-recovery-"));

  testContext.after(() => fs.rm(recoveryDirPath, { recursive: true, force: true }));

  const storage = new TerminalRecoveryFileStorage(recoveryDirPath);
  const terminalRecoveryKeys: string[] = [];

  for (let recordIndex = 0; recordIndex < 128; recordIndex += 1) {
    const token = recordIndex.toString().padStart(22, "0");
    const terminalRecoveryKey = `treety.terminalRecovery.v1.${token}`;

    terminalRecoveryKeys.push(terminalRecoveryKey);
    await storage.update(terminalRecoveryKey, { sessionId: "original" });
  }

  const readFile = fileSystem.promises.readFile;
  let pendingReads = 0;
  let maximumPendingReads = 0;
  let readCount = 0;

  testContext.mock.method(fileSystem.promises, "readFile", async (...readFileArguments: Parameters<typeof fs.readFile>) => {
    pendingReads += 1;
    maximumPendingReads = Math.max(maximumPendingReads, pendingReads);
    readCount += 1;

    try {
      assert.ok(pendingReads <= 16, "refresh exceeded the available file descriptor budget");
      await new Promise<void>((resolve) => setImmediate(resolve));

      return await Reflect.apply(readFile, fileSystem.promises, readFileArguments);
    } finally {
      pendingReads -= 1;
    }
  });

  await storage.refresh();
  assert.equal(storage.keys().length, 128);
  assert.equal(readCount, 128);
  assert.ok(maximumPendingReads > 1);
  assert.equal(pendingReads, 0);

  await storage.refresh();
  assert.equal(readCount, 128);

  const changedRecoveryFilePath = path.join(recoveryDirPath, `${"0".repeat(22)}.json`);
  const changedRecoveryFileStat = await fs.stat(changedRecoveryFilePath);
  const replacementFilePath = path.join(recoveryDirPath, "replacement.tmp");

  await fs.writeFile(replacementFilePath, JSON.stringify({ sessionId: "replaced" }));
  await fs.utimes(replacementFilePath, changedRecoveryFileStat.atime, changedRecoveryFileStat.mtime);
  await fs.rename(replacementFilePath, changedRecoveryFilePath);
  await storage.refresh();
  assert.equal(readCount, 129);
  assert.deepEqual(storage.get(terminalRecoveryKeys[0]!), { sessionId: "replaced" });

  await fs.unlink(changedRecoveryFilePath);
  await storage.refresh();
  assert.equal(storage.keys().length, 127);
  assert.equal(storage.get(terminalRecoveryKeys[0]!), undefined);
  assert.equal(readCount, 129);
});

nodeTest.test("persists independent recovery records and retrieves only the exact host and tree scope", async () => {
  const fixture = createFixture();
  const otherHostRegistry = createRegistry(fixture.storage, "other-host");
  const terminalRecoveryRecords = await Promise.all([
    fixture.registry.createRecord(createTarget()),
    fixture.registry.createRecord({ ...createTarget(), sessionId: "other-session" }),
    fixture.registry.createRecord({ ...createTarget(), workspaceId: "other-window" }),
    fixture.registry.createRecord({ ...createTarget(), configFilePath: "/other/.treety/tree.json" }),
    otherHostRegistry.createRecord(createTarget()),
  ]);

  assert.equal(fixture.storedRecordsByKey.size, 5);
  assert.equal(new Set(terminalRecoveryRecords.map((terminalRecoveryRecord) => terminalRecoveryRecord.token)).size, 5);

  for (const terminalRecoveryRecord of terminalRecoveryRecords) {
    assert.match(terminalRecoveryRecord.token, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(Buffer.from(terminalRecoveryRecord.token, "base64url").length, 16);
  }

  assert.deepEqual(fixture.registry.getRecords(createTarget()), terminalRecoveryRecords.slice(0, 2));
  assert.equal(fixture.registry.getRecord(terminalRecoveryRecords[4]!.token), undefined);
  assert.deepEqual(otherHostRegistry.getRecords(createTarget()), [terminalRecoveryRecords[4]]);

  const reloadedRegistry = createRegistry(fixture.storage, "host");

  assert.deepEqual(reloadedRegistry.getRecord(terminalRecoveryRecords[0]!.token), terminalRecoveryRecords[0]);
});

nodeTest.test("does not expose a successful creation before persistence finishes and propagates storage failures", async () => {
  const fixture = createFixture();
  let finishPersistence: (() => void) | undefined;
  const persistence = new Promise<void>((resolve) => { finishPersistence = resolve; });
  const update = fixture.storage.update;

  fixture.storage.update = async (key, value) => {
    await persistence;
    await update(key, value);
  };

  let didCreateRecord = false;
  const terminalRecoveryRecordPromise = fixture.registry.createRecord(createTarget()).then((terminalRecoveryRecord) => {
    didCreateRecord = true;

    return terminalRecoveryRecord;
  });

  await Promise.resolve();
  assert.equal(didCreateRecord, false);
  assert.deepEqual(fixture.registry.getRecords(createTarget()), []);
  finishPersistence?.();

  const terminalRecoveryRecord = await terminalRecoveryRecordPromise;

  assert.deepEqual(fixture.registry.getRecord(terminalRecoveryRecord.token), terminalRecoveryRecord);
  fixture.storage.update = async () => { throw new Error("storage unavailable"); };
  await assert.rejects(fixture.registry.createRecord(createTarget()), /storage unavailable/);
  assert.equal(fixture.storedRecordsByKey.size, 1);
});

nodeTest.test("retries an occupied token key without overwriting malformed stored data", async () => {
  const fixture = createFixture();
  const get = fixture.storage.get;
  let occupiedKey: string | undefined;
  const malformedRecord = { version: "unknown", preserved: true };

  fixture.storage.get = <T>(key: string): T | undefined => {
    if (!occupiedKey) {
      occupiedKey = key;
      fixture.storedRecordsByKey.set(key, malformedRecord);
    }

    return get<T>(key);
  };

  const terminalRecoveryRecord = await fixture.registry.createRecord(createTarget());

  assert.ok(occupiedKey);
  assert.equal(fixture.storedRecordsByKey.size, 2);
  assert.deepEqual(fixture.storedRecordsByKey.get(occupiedKey), malformedRecord);
  assert.notEqual(occupiedKey, `treety.terminalRecovery.v1.${terminalRecoveryRecord.token}`);
  assert.deepEqual(fixture.registry.getRecords(createTarget()), [terminalRecoveryRecord]);
});

nodeTest.test("rejects malformed records, mismatched tokens, and unrelated storage keys without pruning them", async () => {
  const fixture = createFixture();
  const terminalRecoveryRecord = await fixture.registry.createRecord(createTarget());
  const terminalRecoveryKey = fixture.storage.keys()[0]!;

  for (const malformedRecord of [
    null,
    [],
    { ...terminalRecoveryRecord, version: 2 },
    { ...terminalRecoveryRecord, token: "invalid" },
    { ...terminalRecoveryRecord, token: "x".repeat(22) },
    { ...terminalRecoveryRecord, ownerBindingId: "" },
    { ...terminalRecoveryRecord, ownerBindingId: "invalid\nidentity" },
    { ...terminalRecoveryRecord, ownerBindingId: 42 },
    { ...terminalRecoveryRecord, ownerProtocol: "unknown" },
    { ...terminalRecoveryRecord, closeReason: "unknown" },
    { ...terminalRecoveryRecord, closeReason: 42 },
    { ...terminalRecoveryRecord, persistence: "always" },
    { ...terminalRecoveryRecord, persistence: false },
    ...["configFilePath", "workspaceId", "hostId", "sessionId", "nodeId"].flatMap((field) => [
      { ...terminalRecoveryRecord, [field]: undefined },
      { ...terminalRecoveryRecord, [field]: "" },
      { ...terminalRecoveryRecord, [field]: "invalid\nidentity" },
      { ...terminalRecoveryRecord, [field]: 42 },
    ]),
  ]) {
    fixture.storedRecordsByKey.set(terminalRecoveryKey, malformedRecord);
    assert.equal(fixture.registry.getRecord(terminalRecoveryRecord.token), undefined);
    assert.deepEqual(fixture.registry.getRecords(createTarget()), []);
    await fixture.registry.removeRecord(terminalRecoveryRecord.token);
    assert.equal(fixture.storedRecordsByKey.get(terminalRecoveryKey), malformedRecord);
  }

  fixture.storedRecordsByKey.set("unrelated-setting", terminalRecoveryRecord);
  fixture.storedRecordsByKey.set("treety.terminalRecovery.v1.invalid", terminalRecoveryRecord);
  assert.deepEqual(fixture.registry.getRecords(createTarget()), []);
  assert.equal(fixture.storedRecordsByKey.size, 3);
});

nodeTest.test("removes only a requested valid record on the current host", async () => {
  const fixture = createFixture();
  const otherHostRegistry = createRegistry(fixture.storage, "other-host");
  const terminalRecoveryRecord = await fixture.registry.createRecord(createTarget());
  const otherTerminalRecoveryRecord = await otherHostRegistry.createRecord(createTarget());

  await fixture.registry.removeRecord(otherTerminalRecoveryRecord.token);
  await fixture.registry.removeRecord("invalid");
  assert.equal(fixture.storedRecordsByKey.size, 2);

  await fixture.registry.removeRecord(terminalRecoveryRecord.token);
  assert.equal(fixture.registry.getRecord(terminalRecoveryRecord.token), undefined);
  assert.deepEqual(otherHostRegistry.getRecord(otherTerminalRecoveryRecord.token), otherTerminalRecoveryRecord);
  assert.equal(fixture.storedRecordsByKey.size, 1);
});

nodeTest.test("rejects invalid creation identities before writing storage", async () => {
  const fixture = createFixture();

  assert.throws(() => createRegistry(fixture.storage, ""), /host identity/);
  await assert.rejects(fixture.registry.createRecord({ ...createTarget(), sessionId: "" }), /valid tree and session identity/);
  assert.equal(fixture.storedRecordsByKey.size, 0);
});

nodeTest.test("cleanup cannot delete a record claimed by a newer host binding", async () => {
  const fixture = createFixture();
  const terminalRecoveryRecord = await fixture.registry.createRecord({ ...createTarget(), ownerBindingId: "previous-binding" });
  let clearedStateCount = 0;
  const clearState = async () => { clearedStateCount += 1; };

  assert.equal(terminalRecoveryRecord.ownerBindingId, "previous-binding");

  await fixture.registry.runWithNodeLock(terminalRecoveryRecord, () => fixture.registry.updateRecord(
    terminalRecoveryRecord.token, { ownerBindingId: "current-binding" },
  ));
  await fixture.registry.removeRecord(terminalRecoveryRecord.token, {
    ownerId: fixture.registry.ownerId, ownerBindingId: "previous-binding",
  }, clearState);
  assert.equal(fixture.registry.getRecord(terminalRecoveryRecord.token)?.ownerBindingId, "current-binding");
  assert.equal(clearedStateCount, 0);

  await fixture.registry.removeRecord(terminalRecoveryRecord.token, {
    ownerId: fixture.registry.ownerId, ownerBindingId: "current-binding",
  }, clearState);
  assert.equal(fixture.registry.getRecord(terminalRecoveryRecord.token), undefined);
  assert.equal(clearedStateCount, 1);

  await fixture.registry.removeRecord(terminalRecoveryRecord.token, undefined, clearState);
  assert.equal(clearedStateCount, 2);
});

nodeTest.test("record deletion still completes when associated session cleanup fails", async () => {
  const fixture = createFixture();
  const terminalRecoveryRecord = await fixture.registry.createRecord(createTarget());

  await assert.rejects(fixture.registry.removeRecord(terminalRecoveryRecord.token, undefined, async () => {
    throw new Error("session state is unavailable");
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.match(String(error.errors[0]), /session state is unavailable/);

    return true;
  });
  assert.equal(fixture.registry.getRecord(terminalRecoveryRecord.token), undefined);
});

nodeTest.test("recognizes only an exact final recovery marker while allowing the user to rename the title", () => {
  const token = "AbCdEf0123456789_-abcQ";
  const terminalTitle = buildTerminalTitle("Development shell", token);

  assert.equal(terminalTitle, `TreeTY: Development shell [treety:${token}]`);
  assert.equal(getTerminalRecoveryToken(terminalTitle), token);
  assert.equal(getTerminalRecoveryToken(`Renamed terminal [treety:${token}]`), token);

  for (const invalidTitle of [
    "TreeTY: Development shell",
    `TreeTY: [treety:${token}] suffix`,
    `TreeTY: [treety:${token}] `,
    `TreeTY: [treety:${token}]\n`,
    `TreeTY:[treety:${token}]`,
    `TreeTY: [treety:${token.slice(1)}]`,
    `TreeTY: [treety:${token}a]`,
    `TreeTY: [treety:${token.slice(1)}!]`,
    `TreeTY: [TREETY:${token}]`,
  ]) {
    assert.equal(getTerminalRecoveryToken(invalidTitle), undefined);
  }

  assert.throws(() => buildTerminalTitle("Development shell", "invalid"), /token is invalid/);
  assert.throws(() => buildTerminalTitle("Development shell", `${token}\n`), /token is invalid/);
});

nodeTest.test("independent file storage instances retain concurrent records and observe scoped removal after refresh", async (testContext) => {
  const temporaryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-recovery-"));

  testContext.after(() => fs.rm(temporaryDirPath, { recursive: true, force: true }));

  const recoveryDirPath = path.join(temporaryDirPath, "records");
  const firstRegistry = createRegistry(new TerminalRecoveryFileStorage(recoveryDirPath), "host");
  const secondRegistry = createRegistry(new TerminalRecoveryFileStorage(recoveryDirPath), "host");

  await Promise.all([firstRegistry.refresh(true), secondRegistry.refresh(true)]);
  assert.deepEqual(firstRegistry.getRecords(createTarget()), []);

  const [firstTerminalRecoveryRecord, secondTerminalRecoveryRecord] = await Promise.all([
    firstRegistry.createRecord(createTarget()),
    secondRegistry.createRecord({ ...createTarget(), sessionId: "second-session" }),
  ]);

  await Promise.all([firstRegistry.refresh(true), secondRegistry.refresh(true)]);

  for (const registry of [firstRegistry, secondRegistry]) {
    assert.deepEqual(registry.getRecord(firstTerminalRecoveryRecord.token), firstTerminalRecoveryRecord);
    assert.deepEqual(registry.getRecord(secondTerminalRecoveryRecord.token), secondTerminalRecoveryRecord);
  }

  const [, thirdTerminalRecoveryRecord] = await Promise.all([
    firstRegistry.removeRecord(firstTerminalRecoveryRecord.token),
    secondRegistry.createRecord({ ...createTarget(), sessionId: "third-session" }),
  ]);

  await Promise.all([firstRegistry.refresh(true), secondRegistry.refresh(true)]);

  for (const registry of [firstRegistry, secondRegistry]) {
    assert.equal(registry.getRecord(firstTerminalRecoveryRecord.token), undefined);
    assert.deepEqual(registry.getRecord(secondTerminalRecoveryRecord.token), secondTerminalRecoveryRecord);
    assert.deepEqual(registry.getRecord(thirdTerminalRecoveryRecord.token), thirdTerminalRecoveryRecord);
  }
});

nodeTest.test("file refresh and local writes preserve their order without replacing newer cached records", async (testContext) => {
  const recoveryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-recovery-"));

  testContext.after(() => fs.rm(recoveryDirPath, { recursive: true, force: true }));

  const registry = createRegistry(new TerminalRecoveryFileStorage(recoveryDirPath), "host");
  const refresh = registry.refresh();
  const terminalRecoveryRecord = await registry.createRecord(createTarget());

  await refresh;
  assert.deepEqual(registry.getRecord(terminalRecoveryRecord.token), terminalRecoveryRecord);

  const removal = registry.removeRecord(terminalRecoveryRecord.token);

  await registry.refresh();
  await removal;
  assert.equal(registry.getRecord(terminalRecoveryRecord.token), undefined);
});

nodeTest.test("file storage preserves corrupt and occupied files and rejects path traversal", async (testContext) => {
  const temporaryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-recovery-"));

  testContext.after(() => fs.rm(temporaryDirPath, { recursive: true, force: true }));

  const recoveryDirPath = path.join(temporaryDirPath, "records");

  await fs.mkdir(recoveryDirPath);

  const malformedToken = "A".repeat(22);
  const symlinkToken = "B".repeat(22);
  const malformedFilePath = path.join(recoveryDirPath, `${malformedToken}.json`);
  const externalFilePath = path.join(temporaryDirPath, "external.json");

  await fs.writeFile(malformedFilePath, "invalid JSON");
  await fs.writeFile(externalFilePath, JSON.stringify({ private: true }));
  await fs.symlink(externalFilePath, path.join(recoveryDirPath, `${symlinkToken}.json`));
  await fs.writeFile(path.join(recoveryDirPath, "unrelated.json"), "unrelated");

  const storage = new TerminalRecoveryFileStorage(recoveryDirPath);
  const registry = createRegistry(storage, "host");

  await registry.refresh();
  assert.equal(storage.keys().length, 2);
  assert.equal(registry.getRecord(malformedToken), undefined);
  assert.equal(storage.get(`treety.terminalRecovery.v1.${symlinkToken}`), undefined);
  assert.deepEqual(registry.getRecords(createTarget()), []);

  await assert.rejects(storage.update(`treety.terminalRecovery.v1.${malformedToken}`, { overwritten: true }), { code: "EEXIST" });
  await registry.removeRecord(malformedToken);
  assert.equal(await fs.readFile(malformedFilePath, "utf8"), "invalid JSON");

  for (const invalidKey of [
    "../external.json",
    "treety.terminalRecovery.v1.../external",
    `treety.terminalRecovery.v1.${malformedToken}/../external`,
  ]) {
    await assert.rejects(storage.update(invalidKey, {}), /storage key is invalid/);
    await assert.rejects(storage.update(invalidKey, undefined), /storage key is invalid/);
  }

  assert.equal(await fs.readFile(externalFilePath, "utf8"), JSON.stringify({ private: true }));
  assert.throws(() => new TerminalRecoveryFileStorage("relative/path"), /absolute directory/);
});

nodeTest.test("registry retries exclusive filesystem collisions and propagates unexpected filesystem failures", async (testContext) => {
  const fixture = createFixture();
  const update = fixture.storage.update;
  let updateAttempts = 0;

  fixture.storage.update = async (key, value) => {
    updateAttempts += 1;

    if (updateAttempts === 1) throw Object.assign(new Error("occupied"), { code: "EEXIST" });

    await update(key, value);
  };

  assert.ok(await fixture.registry.createRecord(createTarget()));
  assert.equal(updateAttempts, 2);

  const temporaryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-recovery-"));

  testContext.after(() => fs.rm(temporaryDirPath, { recursive: true, force: true }));

  const blockedDirPath = path.join(temporaryDirPath, "regular-file");

  await fs.writeFile(blockedDirPath, "not a directory");

  const registry = createRegistry(new TerminalRecoveryFileStorage(blockedDirPath), "host");

  await assert.rejects(registry.refresh(), { code: "ENOTDIR" });
  await assert.rejects(registry.createRecord(createTarget()));
});

nodeTest.test("node locks serialize cross-window reservations for the same leaf", async (testContext) => {
  const recoveryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-recovery-"));

  testContext.after(() => fs.rm(recoveryDirPath, { recursive: true, force: true }));

  const firstRegistry = createRegistry(new TerminalRecoveryFileStorage(recoveryDirPath), "host");
  const secondRegistry = createRegistry(new TerminalRecoveryFileStorage(recoveryDirPath), "host");
  const terminalRecoveryNodeScope = { configFilePath: createTarget().configFilePath, nodeId: "shell" };
  const reservations = await Promise.all([firstRegistry, secondRegistry].map((registry, index) =>
    registry.runWithNodeLock(terminalRecoveryNodeScope, async () => {
      await registry.refresh(true);

      if (registry.getRecordsForNode(terminalRecoveryNodeScope).some((terminalRecoveryRecord) => !terminalRecoveryRecord.retired)) return undefined;

      return await registry.createRecord({ ...createTarget(), workspaceId: `window-${index}` });
    }),
  ));

  assert.equal(reservations.filter(Boolean).length, 1);
  await Promise.all([firstRegistry.refresh(true), secondRegistry.refresh(true)]);
  assert.equal(firstRegistry.getRecordsForNode(terminalRecoveryNodeScope).length, 1);
  assert.equal(secondRegistry.getRecordsForNode(terminalRecoveryNodeScope).length, 1);
});

nodeTest.test("normal refresh coalesces and caches scans while forced and token refresh observe other instances", async (testContext) => {
  const recoveryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-recovery-"));

  testContext.after(() => fs.rm(recoveryDirPath, { recursive: true, force: true }));

  const storage = new TerminalRecoveryFileStorage(recoveryDirPath);
  const refreshMock = testContext.mock.method(storage, "refresh");
  const registry = createRegistry(storage, "host");
  const otherRegistry = createRegistry(new TerminalRecoveryFileStorage(recoveryDirPath), "host");

  await Promise.all([registry.refresh(), registry.refresh(), registry.refresh()]);
  await registry.refresh();
  assert.equal(refreshMock.mock.callCount(), 1);

  const terminalRecoveryRecord = await otherRegistry.createRecord(createTarget());

  assert.equal(registry.getRecord(terminalRecoveryRecord.token), undefined);
  await registry.refreshRecord(terminalRecoveryRecord.token);
  assert.deepEqual(registry.getRecord(terminalRecoveryRecord.token), terminalRecoveryRecord);
  assert.equal(refreshMock.mock.callCount(), 1);
  await registry.refresh(true);
  assert.equal(refreshMock.mock.callCount(), 2);
});

nodeTest.test("retirement preserves title identity and atomic updates remove owner fields without resurrecting deleted records", async (testContext) => {
  const recoveryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-recovery-"));

  testContext.after(() => fs.rm(recoveryDirPath, { recursive: true, force: true }));

  const registry = createRegistry(new TerminalRecoveryFileStorage(recoveryDirPath), "host");
  const otherRegistry = createRegistry(new TerminalRecoveryFileStorage(recoveryDirPath), "host");
  const terminalRecoveryRecord = await registry.createRecord(createTarget());
  const boundTerminalRecoveryRecord = await registry.runWithNodeLock(terminalRecoveryRecord, () => registry.updateRecord(
    terminalRecoveryRecord.token, { ownerBindingId: "host-binding" },
  ));

  assert.equal(boundTerminalRecoveryRecord?.ownerBindingId, "host-binding");

  const retiredTerminalRecoveryRecord = await registry.runWithNodeLock(terminalRecoveryRecord, () => registry.updateRecord(
    terminalRecoveryRecord.token, {
      retired: true, terminalProcessId: 42,
    },
  ));

  assert.ok(retiredTerminalRecoveryRecord);
  assert.equal(retiredTerminalRecoveryRecord.retired, true);
  assert.equal(Object.hasOwn(retiredTerminalRecoveryRecord, "ownerId"), false);
  assert.equal(Object.hasOwn(retiredTerminalRecoveryRecord, "ownerBindingId"), false);
  assert.equal(Object.hasOwn(retiredTerminalRecoveryRecord, "ownerProcessId"), false);
  assert.equal(Object.hasOwn(retiredTerminalRecoveryRecord, "ownerProtocol"), false);
  assert.equal(Object.hasOwn(retiredTerminalRecoveryRecord, "terminalProcessId"), false);
  assert.equal(retiredTerminalRecoveryRecord.token, terminalRecoveryRecord.token);
  await otherRegistry.refreshRecord(terminalRecoveryRecord.token);
  assert.deepEqual(otherRegistry.getRecord(terminalRecoveryRecord.token), retiredTerminalRecoveryRecord);

  await otherRegistry.removeRecord(terminalRecoveryRecord.token);

  assert.equal(await registry.runWithNodeLock(terminalRecoveryRecord, () => registry.updateRecord(
    terminalRecoveryRecord.token, { ownerId: registry.ownerId, ownerProcessId: registry.ownerProcessId },
  )), undefined);
  await registry.refresh(true);
  assert.equal(registry.getRecord(terminalRecoveryRecord.token), undefined);
});

nodeTest.test("liveness can veto replacement but dead or missing processes remain unknown", async () => {
  const fixture = createFixture();
  const liveProcessIds = new Set<number>([process.pid, 42]);
  const registry = createRegistry(fixture.storage, "host", {
    getProcessIsAlive: (processId) => liveProcessIds.has(processId),
  });
  const ownedTerminalRecoveryRecord = await registry.createRecord(createTarget());
  const otherWindowTerminalRecoveryRecord = await fixture.registry.createRecord(createTarget());

  assert.notEqual(registry.ownerId, fixture.registry.ownerId);
  assert.equal(registry.getRecordLiveness(ownedTerminalRecoveryRecord), "owned");
  assert.equal(registry.getRecordLiveness(otherWindowTerminalRecoveryRecord), "other-window");

  const runningTerminalRecoveryRecord = { ...otherWindowTerminalRecoveryRecord, ownerId: undefined, ownerProcessId: undefined, terminalProcessId: 42 };

  assert.equal(registry.getRecordLiveness(runningTerminalRecoveryRecord), "running");
  assert.equal(registry.getRecordLiveness({ ...runningTerminalRecoveryRecord, retired: true }), "unknown");
  assert.equal(registry.getRecordLiveness({ ...ownedTerminalRecoveryRecord, retired: true }), "owned");
  assert.equal(registry.getRecordLiveness({ ...otherWindowTerminalRecoveryRecord, retired: true }), "other-window");
  liveProcessIds.clear();
  assert.equal(registry.getRecordLiveness(otherWindowTerminalRecoveryRecord), "unknown");
  assert.equal(registry.getRecordLiveness(runningTerminalRecoveryRecord), "unknown");
  assert.ok(registry.getRecord(otherWindowTerminalRecoveryRecord.token));
});

nodeTest.test("retires only positively closed records without a live owner and retains native token identities", async () => {
  const fixture = createFixture();
  const registry = createRegistry(fixture.storage, "host", {
    getProcessIsAlive: (processId) => processId === 42,
  });
  const closedSessionCases: {
    sessionId: string;
    update: TerminalRecoveryRecordUpdate;
    shouldRetire: boolean;
  }[] = [
    { sessionId: "user-dead", update: { closeReason: "user", terminalProcessId: 43 }, shouldRetire: false },
    { sessionId: "user-alive", update: { closeReason: "user", terminalProcessId: 42 }, shouldRetire: false },
    { sessionId: "user-missing", update: { closeReason: "user" }, shouldRetire: false },
    { sessionId: "disabled-alive", update: { closeReason: "shutdown", persistence: "disabled", terminalProcessId: 42 }, shouldRetire: true },
    { sessionId: "disabled-missing", update: { closeReason: "shutdown", persistence: "disabled" }, shouldRetire: true },
    { sessionId: "reconnect-dead", update: { closeReason: "shutdown", persistence: "reconnect", terminalProcessId: 43 }, shouldRetire: true },
    { sessionId: "reconnect-alive", update: { closeReason: "shutdown", persistence: "reconnect", terminalProcessId: 42 }, shouldRetire: false },
    { sessionId: "reconnect-missing", update: { closeReason: "shutdown", persistence: "reconnect" }, shouldRetire: false },
    { sessionId: "revive-dead", update: { closeReason: "shutdown", persistence: "revive", terminalProcessId: 43 }, shouldRetire: false },
    { sessionId: "unknown-dead", update: { terminalProcessId: 43 }, shouldRetire: false },
    { sessionId: "owned-disabled", update: { closeReason: "shutdown", persistence: "disabled", ownerId: registry.ownerId }, shouldRetire: false },
    { sessionId: "foreign-owned-disabled", update: { closeReason: "shutdown", persistence: "disabled", ownerId: "other-owner", ownerProcessId: 42 }, shouldRetire: false },
    { sessionId: "dead-owner-disabled", update: { closeReason: "shutdown", persistence: "disabled", ownerId: "other-owner", ownerProcessId: 43 }, shouldRetire: true },
  ];

  await registry.runWithNodeLock(createTarget(), async () => {
    for (const closedSessionCase of closedSessionCases) {
      const terminalRecoveryRecord = await registry.createRecord({ ...createTarget(), sessionId: closedSessionCase.sessionId });

      await registry.updateRecord(terminalRecoveryRecord.token, {
        ownerId: undefined, ownerBindingId: undefined, ownerProcessId: undefined, ...closedSessionCase.update,
      });
    }
  });

  const otherNodeTerminalRecoveryRecord = await registry.createRecord({ ...createTarget(), nodeId: "other-node" });

  await registry.runWithNodeLock(otherNodeTerminalRecoveryRecord, () => registry.updateRecord(
    otherNodeTerminalRecoveryRecord.token, { ownerId: undefined, ownerProcessId: undefined, closeReason: "user", terminalProcessId: 43 },
  ));

  const retiredTerminalRecoveryRecords = await registry.runWithNodeLock(createTarget(), () =>
    registry.retireClosedRecordsForNode(createTarget()),
  );

  assert.deepEqual(
    retiredTerminalRecoveryRecords.map((terminalRecoveryRecord) => terminalRecoveryRecord.sessionId).sort(),
    closedSessionCases.filter((closedSessionCase) => closedSessionCase.shouldRetire).map((closedSessionCase) => closedSessionCase.sessionId).sort(),
  );
  assert.deepEqual(
    registry.getRecordsForNode(createTarget()).filter((terminalRecoveryRecord) => !terminalRecoveryRecord.retired).map((terminalRecoveryRecord) => terminalRecoveryRecord.sessionId).sort(),
    closedSessionCases.filter((closedSessionCase) => !closedSessionCase.shouldRetire).map((closedSessionCase) => closedSessionCase.sessionId).sort(),
  );
  assert.ok(registry.getRecord(otherNodeTerminalRecoveryRecord.token));

  for (const retiredTerminalRecoveryRecord of retiredTerminalRecoveryRecords) {
    assert.deepEqual(registry.getRecord(retiredTerminalRecoveryRecord.token), retiredTerminalRecoveryRecord);
    assert.equal(retiredTerminalRecoveryRecord.terminalProcessId, undefined);
    assert.equal(retiredTerminalRecoveryRecord.ownerProcessId, undefined);
  }

  assert.deepEqual(await registry.runWithNodeLock(createTarget(), () =>
    registry.retireClosedRecordsForNode(createTarget()),
  ), []);
});

nodeTest.test("updates and clears close policy fields without changing retained identity", async () => {
  const fixture = createFixture();
  const terminalRecoveryRecord = await fixture.registry.createRecord(createTarget());

  const closedTerminalRecoveryRecord = await fixture.registry.runWithNodeLock(terminalRecoveryRecord, () => fixture.registry.updateRecord(
    terminalRecoveryRecord.token, { closeReason: "shutdown", persistence: "revive" },
  ));

  assert.equal(closedTerminalRecoveryRecord?.closeReason, "shutdown");
  assert.equal(closedTerminalRecoveryRecord?.persistence, "revive");

  const claimedTerminalRecoveryRecord = await fixture.registry.runWithNodeLock(terminalRecoveryRecord, () => fixture.registry.updateRecord(
    terminalRecoveryRecord.token, { closeReason: undefined, persistence: undefined },
  ));

  assert.deepEqual(claimedTerminalRecoveryRecord, terminalRecoveryRecord);
});

nodeTest.test("exact owners distinguish concurrent instances from a reused live PID without losing records", async () => {
  const fixture = createFixture();
  const otherRegistry = createRegistry(fixture.storage, "host", { getProcessIsAlive: () => true });
  const terminalRecoveryRecord = await fixture.registry.createRecord(createTarget());
  const otherTerminalRecoveryRecord = await otherRegistry.createRecord({ ...createTarget(), sessionId: "other-session" });

  assert.equal(terminalRecoveryRecord.ownerProtocol, "ipc-v1");
  assert.equal(terminalRecoveryRecord.ownerProcessId, otherTerminalRecoveryRecord.ownerProcessId);
  await otherRegistry.refresh(true);
  assert.equal(otherRegistry.getRecordLiveness(terminalRecoveryRecord), "other-window");
  await fixture.registry.shutdown();
  await otherRegistry.refresh(true);
  assert.equal(otherRegistry.getRecordLiveness(terminalRecoveryRecord), "unknown");
  assert.equal(otherRegistry.getRecordLiveness(otherTerminalRecoveryRecord), "owned");
  assert.deepEqual(otherRegistry.getRecord(terminalRecoveryRecord.token), terminalRecoveryRecord);

  const claimedTerminalRecoveryRecord = await otherRegistry.runWithNodeLock(terminalRecoveryRecord, () =>
    otherRegistry.updateRecord(terminalRecoveryRecord.token, {
      ownerId: otherRegistry.ownerId, ownerProcessId: otherRegistry.ownerProcessId,
    }),
  );

  assert.equal(claimedTerminalRecoveryRecord?.ownerProtocol, "ipc-v1");
  assert.equal(claimedTerminalRecoveryRecord?.ownerId, otherRegistry.ownerId);
});

nodeTest.test("owner probes fail closed, coalesce per owner, and retain legacy PID safeguards", async () => {
  const fixture = createFixture();
  const terminalRecoveryRecord = await fixture.registry.createRecord(createTarget());

  await fixture.registry.createRecord({ ...createTarget(), sessionId: "another-session" });

  let ownerProbeCount = 0;
  const otherRegistry = createRegistry(fixture.storage, "host", {
    getProcessIsAlive: () => true,
    getOwnerLiveness: async () => {
      ownerProbeCount += 1;

      throw Object.assign(new Error("access denied"), { code: "EACCES" });
    },
  });

  await otherRegistry.refresh(true);
  assert.equal(ownerProbeCount, 1);
  assert.equal(otherRegistry.getRecordLiveness(terminalRecoveryRecord), "other-window");

  const absentOwnerRegistry = createRegistry(fixture.storage, "host", {
    getProcessIsAlive: () => true,
    getOwnerLiveness: async () => "dead",
  });

  await absentOwnerRegistry.refresh(true);
  assert.equal(absentOwnerRegistry.getRecordLiveness(terminalRecoveryRecord), "unknown");
  assert.equal(absentOwnerRegistry.getRecordLiveness({ ...terminalRecoveryRecord, ownerProtocol: undefined }), "other-window");
});

nodeTest.test("ownership waits for the endpoint startup attempt before persistence", async () => {
  const fixture = createFixture();
  let startOwner: (() => void) | undefined;
  const ownerStartup = new Promise<void>((resolve) => { startOwner = resolve; });
  const registry = createRegistry(fixture.storage, "host", {
    owner: { start: async () => ownerStartup, shutdown: async () => {} },
  });
  const terminalRecoveryRecordPromise = registry.createRecord(createTarget());

  await Promise.resolve();
  assert.equal(fixture.storage.keys().length, 0);
  startOwner?.();
  await terminalRecoveryRecordPromise;
  assert.equal(fixture.storage.keys().length, 1);
});

nodeTest.test("failed owner startup uses conservative PID ownership for creation and recovery until a retry succeeds", async () => {
  const fixture = createFixture();
  const previousTerminalRecoveryRecord = await fixture.registry.createRecord(createTarget());
  let canStartOwner = false;
  let ownerStartupCount = 0;
  const registry = createRegistry(fixture.storage, "host", {
    owner: {
      start: async () => {
        ownerStartupCount += 1;

        if (!canStartOwner) throw Object.assign(new Error("socket denied"), { code: "EACCES" });
      },
      shutdown: async () => {},
    },
  });
  const terminalRecoveryRecord = await registry.createRecord({ ...createTarget(), sessionId: "new-session" });

  assert.equal(Object.hasOwn(terminalRecoveryRecord, "ownerProtocol"), false);
  assert.equal(terminalRecoveryRecord.ownerId, registry.ownerId);
  assert.equal(terminalRecoveryRecord.ownerProcessId, registry.ownerProcessId);
  await fixture.registry.shutdown();

  const claimedTerminalRecoveryRecord = await registry.runWithNodeLock(previousTerminalRecoveryRecord, () =>
    registry.updateRecord(previousTerminalRecoveryRecord.token, {
      ownerId: registry.ownerId, ownerProcessId: registry.ownerProcessId, ownerBindingId: "recovered-binding",
    }),
  );

  assert.ok(claimedTerminalRecoveryRecord);
  assert.equal(Object.hasOwn(claimedTerminalRecoveryRecord, "ownerProtocol"), false);
  assert.equal(claimedTerminalRecoveryRecord.ownerBindingId, "recovered-binding");
  assert.equal(claimedTerminalRecoveryRecord.sessionId, previousTerminalRecoveryRecord.sessionId);
  assert.equal(claimedTerminalRecoveryRecord.token, previousTerminalRecoveryRecord.token);

  const otherRegistry = createRegistry(fixture.storage, "host", {
    getProcessIsAlive: () => true,
    getOwnerLiveness: async () => "dead",
  });

  await otherRegistry.refresh(true);
  assert.equal(otherRegistry.getRecordLiveness(terminalRecoveryRecord), "other-window");
  assert.equal(otherRegistry.getRecordLiveness(claimedTerminalRecoveryRecord), "other-window");
  canStartOwner = true;

  const upgradedTerminalRecoveryRecord = await registry.runWithNodeLock(claimedTerminalRecoveryRecord, () =>
    registry.updateRecord(claimedTerminalRecoveryRecord.token, { ownerBindingId: "later-binding" }),
  );
  const newTerminalRecoveryRecord = await registry.createRecord({ ...createTarget(), sessionId: "later-session" });

  assert.equal(upgradedTerminalRecoveryRecord?.ownerProtocol, "ipc-v1");
  assert.equal(newTerminalRecoveryRecord.ownerProtocol, "ipc-v1");
  assert.equal(ownerStartupCount, 4);
});

nodeTest.test("owner fallback never hides persistence failures", async () => {
  const fixture = createFixture();
  const terminalRecoveryRecord = await fixture.registry.createRecord(createTarget());
  const registry = createRegistry(fixture.storage, "host", {
    owner: {
      start: async () => { throw new Error("socket denied"); },
      shutdown: async () => {},
    },
  });

  fixture.storage.update = async () => { throw new Error("persistence unavailable"); };

  await assert.rejects(registry.createRecord(createTarget()), /persistence unavailable/);
  await assert.rejects(registry.updateRecord(terminalRecoveryRecord.token, {
    ownerId: registry.ownerId, ownerProcessId: registry.ownerProcessId,
  }), /persistence unavailable/);
  assert.equal(fixture.storage.keys().length, 1);
  assert.deepEqual(fixture.registry.getRecord(terminalRecoveryRecord.token), terminalRecoveryRecord);
});

nodeTest.test("shutdown prevents fallback ownership during a failed startup and on later creation or recovery", async () => {
  const fixture = createFixture();
  const terminalRecoveryRecord = await fixture.registry.createRecord(createTarget());
  let failOwnerStartup: ((error: Error) => void) | undefined;
  const ownerStartup = new Promise<void>((_resolve, reject) => { failOwnerStartup = reject; });
  const registry = createRegistry(fixture.storage, "host", {
    owner: { start: async () => ownerStartup, shutdown: async () => {} },
  });
  const terminalRecoveryRecordPromise = registry.createRecord({ ...createTarget(), sessionId: "pending-session" });

  await registry.shutdown();
  failOwnerStartup?.(new Error("socket denied"));
  await assert.rejects(terminalRecoveryRecordPromise, /shut down/);
  await assert.rejects(registry.createRecord(createTarget()), /shut down/);
  await assert.rejects(registry.updateRecord(terminalRecoveryRecord.token, {
    ownerId: registry.ownerId, ownerProcessId: registry.ownerProcessId,
  }), /shut down/);
  assert.equal(fixture.storage.keys().length, 1);
  assert.deepEqual(fixture.registry.getRecord(terminalRecoveryRecord.token), terminalRecoveryRecord);
});

nodeTest.test("unavailable coordination preserves read access and rejects launch reservations", async () => {
  const registry = TerminalRecoveryRegistry.createUnavailable("host", "Shared terminal storage is unavailable.");

  assert.equal(registry.isAvailable, false);
  assert.equal(registry.unavailableReason, "Shared terminal storage is unavailable.");
  await registry.refresh();
  assert.deepEqual(registry.getRecords(createTarget()), []);
  await assert.rejects(registry.createRecord(createTarget()), /Shared terminal storage is unavailable/);
  await assert.rejects(registry.runWithNodeLock(createTarget(), async () => true), /Shared terminal storage is unavailable/);
});

function createRegistry(...options: ConstructorParameters<typeof TerminalRecoveryRegistry>): TerminalRecoveryRegistry {
  const registry = new TerminalRecoveryRegistry(...options);

  nodeTest.after(() => registry.shutdown());

  return registry;
}

function createFixture() {
  const storedRecordsByKey = new Map<string, unknown>();
  const storage: TerminalRecoveryStorage = {
    get<T>(key: string): T | undefined {
      return storedRecordsByKey.get(key) as T | undefined;
    },
    async update(key, value) {
      await Promise.resolve();

      if (value === undefined) {
        storedRecordsByKey.delete(key);

        return;
      }

      storedRecordsByKey.set(key, value);
    },
    keys() {
      return [...storedRecordsByKey.keys()];
    },
  };

  return { storedRecordsByKey, storage, registry: createRegistry(storage, "host") };
}

function createTarget(): Omit<TerminalRecoveryRecord, "version" | "token" | "hostId"> {
  return {
    configFilePath: "/workspace/.treety/tree.json",
    workspaceId: "window",
    nodeId: "shell",
    sessionId: "session",
  };
}
