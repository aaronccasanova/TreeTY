import * as assert from "node:assert/strict";
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
  TerminalRecoveryStorage,
} from "./terminal-recovery";

nodeTest.test("persists independent recovery records and retrieves only the exact host and tree scope", async () => {
  const fixture = createFixture();
  const otherHostRegistry = new TerminalRecoveryRegistry(fixture.storage, "other-host");
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

  const reloadedRegistry = new TerminalRecoveryRegistry(fixture.storage, "host");

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
  const otherHostRegistry = new TerminalRecoveryRegistry(fixture.storage, "other-host");
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

  assert.throws(() => new TerminalRecoveryRegistry(fixture.storage, ""), /host identity/);
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
  const firstRegistry = new TerminalRecoveryRegistry(new TerminalRecoveryFileStorage(recoveryDirPath), "host");
  const secondRegistry = new TerminalRecoveryRegistry(new TerminalRecoveryFileStorage(recoveryDirPath), "host");

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

  const registry = new TerminalRecoveryRegistry(new TerminalRecoveryFileStorage(recoveryDirPath), "host");
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
  const registry = new TerminalRecoveryRegistry(storage, "host");

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

  const registry = new TerminalRecoveryRegistry(new TerminalRecoveryFileStorage(blockedDirPath), "host");

  await assert.rejects(registry.refresh(), { code: "ENOTDIR" });
  await assert.rejects(registry.createRecord(createTarget()));
});

nodeTest.test("node locks serialize cross-window reservations for the same leaf", async (testContext) => {
  const recoveryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-recovery-"));

  testContext.after(() => fs.rm(recoveryDirPath, { recursive: true, force: true }));

  const firstRegistry = new TerminalRecoveryRegistry(new TerminalRecoveryFileStorage(recoveryDirPath), "host");
  const secondRegistry = new TerminalRecoveryRegistry(new TerminalRecoveryFileStorage(recoveryDirPath), "host");
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
  const registry = new TerminalRecoveryRegistry(storage, "host");
  const otherRegistry = new TerminalRecoveryRegistry(new TerminalRecoveryFileStorage(recoveryDirPath), "host");

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

  const registry = new TerminalRecoveryRegistry(new TerminalRecoveryFileStorage(recoveryDirPath), "host");
  const otherRegistry = new TerminalRecoveryRegistry(new TerminalRecoveryFileStorage(recoveryDirPath), "host");
  const terminalRecoveryRecord = await registry.createRecord(createTarget());
  const boundTerminalRecoveryRecord = await registry.runWithNodeLock(terminalRecoveryRecord, () => registry.updateRecord(
    terminalRecoveryRecord.token, { ownerBindingId: "host-binding" },
  ));

  assert.equal(boundTerminalRecoveryRecord?.ownerBindingId, "host-binding");

  const retiredTerminalRecoveryRecord = await registry.runWithNodeLock(terminalRecoveryRecord, () => registry.updateRecord(
    terminalRecoveryRecord.token, {
      retired: true, ownerId: undefined, ownerBindingId: undefined, ownerProcessId: undefined, terminalProcessId: 42,
    },
  ));

  assert.ok(retiredTerminalRecoveryRecord);
  assert.equal(retiredTerminalRecoveryRecord.retired, true);
  assert.equal(Object.hasOwn(retiredTerminalRecoveryRecord, "ownerId"), false);
  assert.equal(Object.hasOwn(retiredTerminalRecoveryRecord, "ownerBindingId"), false);
  assert.equal(Object.hasOwn(retiredTerminalRecoveryRecord, "ownerProcessId"), false);
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
  const registry = new TerminalRecoveryRegistry(fixture.storage, "host", {
    getProcessIsAlive: (processId) => liveProcessIds.has(processId),
  });
  const ownedTerminalRecoveryRecord = await registry.createRecord(createTarget());
  const otherWindowTerminalRecoveryRecord = await fixture.registry.createRecord(createTarget());

  assert.notEqual(registry.ownerId, fixture.registry.ownerId);
  assert.equal(registry.getRecordLiveness(ownedTerminalRecoveryRecord), "owned");
  assert.equal(registry.getRecordLiveness(otherWindowTerminalRecoveryRecord), "other-window");

  const runningTerminalRecoveryRecord = { ...otherWindowTerminalRecoveryRecord, ownerId: undefined, ownerProcessId: undefined, terminalProcessId: 42 };

  assert.equal(registry.getRecordLiveness(runningTerminalRecoveryRecord), "running");
  liveProcessIds.clear();
  assert.equal(registry.getRecordLiveness(otherWindowTerminalRecoveryRecord), "unknown");
  assert.equal(registry.getRecordLiveness(runningTerminalRecoveryRecord), "unknown");
  assert.ok(registry.getRecord(otherWindowTerminalRecoveryRecord.token));
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

  return { storedRecordsByKey, storage, registry: new TerminalRecoveryRegistry(storage, "host") };
}

function createTarget(): Omit<TerminalRecoveryRecord, "version" | "token" | "hostId"> {
  return {
    configFilePath: "/workspace/.treety/tree.json",
    workspaceId: "window",
    nodeId: "shell",
    sessionId: "session",
  };
}
