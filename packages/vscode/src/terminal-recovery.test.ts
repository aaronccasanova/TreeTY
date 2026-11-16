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

  assert.equal(fixture.values.size, 5);
  assert.equal(new Set(terminalRecoveryRecords.map((record) => record.token)).size, 5);

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
  const terminalRecoveryRecordPromise = fixture.registry.createRecord(createTarget()).then((record) => {
    didCreateRecord = true;

    return record;
  });

  await Promise.resolve();
  assert.equal(didCreateRecord, false);
  assert.deepEqual(fixture.registry.getRecords(createTarget()), []);
  finishPersistence?.();

  const terminalRecoveryRecord = await terminalRecoveryRecordPromise;

  assert.deepEqual(fixture.registry.getRecord(terminalRecoveryRecord.token), terminalRecoveryRecord);
  fixture.storage.update = async () => { throw new Error("storage unavailable"); };
  await assert.rejects(fixture.registry.createRecord(createTarget()), /storage unavailable/);
  assert.equal(fixture.values.size, 1);
});

nodeTest.test("retries an occupied token key without overwriting malformed stored data", async () => {
  const fixture = createFixture();
  const get = fixture.storage.get;
  let occupiedKey: string | undefined;
  const malformedRecord = { version: "unknown", preserved: true };

  fixture.storage.get = <T>(key: string): T | undefined => {
    if (!occupiedKey) {
      occupiedKey = key;
      fixture.values.set(key, malformedRecord);
    }

    return get<T>(key);
  };

  const terminalRecoveryRecord = await fixture.registry.createRecord(createTarget());

  assert.ok(occupiedKey);
  assert.equal(fixture.values.size, 2);
  assert.deepEqual(fixture.values.get(occupiedKey), malformedRecord);
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
    ...["configFilePath", "workspaceId", "hostId", "sessionId", "nodeId"].flatMap((field) => [
      { ...terminalRecoveryRecord, [field]: undefined },
      { ...terminalRecoveryRecord, [field]: "" },
      { ...terminalRecoveryRecord, [field]: "invalid\nidentity" },
      { ...terminalRecoveryRecord, [field]: 42 },
    ]),
  ]) {
    fixture.values.set(terminalRecoveryKey, malformedRecord);
    assert.equal(fixture.registry.getRecord(terminalRecoveryRecord.token), undefined);
    assert.deepEqual(fixture.registry.getRecords(createTarget()), []);
    await fixture.registry.removeRecord(terminalRecoveryRecord.token);
    assert.equal(fixture.values.get(terminalRecoveryKey), malformedRecord);
  }

  fixture.values.set("unrelated-setting", terminalRecoveryRecord);
  fixture.values.set("treety.terminalRecovery.v1.invalid", terminalRecoveryRecord);
  assert.deepEqual(fixture.registry.getRecords(createTarget()), []);
  assert.equal(fixture.values.size, 3);
});

nodeTest.test("removes only a requested valid record on the current host", async () => {
  const fixture = createFixture();
  const otherHostRegistry = new TerminalRecoveryRegistry(fixture.storage, "other-host");
  const terminalRecoveryRecord = await fixture.registry.createRecord(createTarget());
  const otherTerminalRecoveryRecord = await otherHostRegistry.createRecord(createTarget());

  await fixture.registry.removeRecord(otherTerminalRecoveryRecord.token);
  await fixture.registry.removeRecord("invalid");
  assert.equal(fixture.values.size, 2);

  await fixture.registry.removeRecord(terminalRecoveryRecord.token);
  assert.equal(fixture.registry.getRecord(terminalRecoveryRecord.token), undefined);
  assert.deepEqual(otherHostRegistry.getRecord(otherTerminalRecoveryRecord.token), otherTerminalRecoveryRecord);
  assert.equal(fixture.values.size, 1);
});

nodeTest.test("rejects invalid creation identities before writing storage", async () => {
  const fixture = createFixture();

  assert.throws(() => new TerminalRecoveryRegistry(fixture.storage, ""), /host identity/);
  await assert.rejects(fixture.registry.createRecord({ ...createTarget(), sessionId: "" }), /valid tree and session identity/);
  assert.equal(fixture.values.size, 0);
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

  await Promise.all([firstRegistry.refresh(), secondRegistry.refresh()]);
  assert.deepEqual(firstRegistry.getRecords(createTarget()), []);

  const [firstRecord, secondRecord] = await Promise.all([
    firstRegistry.createRecord(createTarget()),
    secondRegistry.createRecord({ ...createTarget(), sessionId: "second-session" }),
  ]);

  await Promise.all([firstRegistry.refresh(), secondRegistry.refresh()]);

  for (const registry of [firstRegistry, secondRegistry]) {
    assert.deepEqual(registry.getRecord(firstRecord.token), firstRecord);
    assert.deepEqual(registry.getRecord(secondRecord.token), secondRecord);
  }

  const [, thirdRecord] = await Promise.all([
    firstRegistry.removeRecord(firstRecord.token),
    secondRegistry.createRecord({ ...createTarget(), sessionId: "third-session" }),
  ]);

  await Promise.all([firstRegistry.refresh(), secondRegistry.refresh()]);

  for (const registry of [firstRegistry, secondRegistry]) {
    assert.equal(registry.getRecord(firstRecord.token), undefined);
    assert.deepEqual(registry.getRecord(secondRecord.token), secondRecord);
    assert.deepEqual(registry.getRecord(thirdRecord.token), thirdRecord);
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

function createFixture() {
  const values = new Map<string, unknown>();
  const storage: TerminalRecoveryStorage = {
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    async update(key, value) {
      await Promise.resolve();

      if (value === undefined) {
        values.delete(key);

        return;
      }

      values.set(key, value);
    },
    keys() {
      return [...values.keys()];
    },
  };

  return { values, storage, registry: new TerminalRecoveryRegistry(storage, "host") };
}

function createTarget(): Omit<TerminalRecoveryRecord, "version" | "token" | "hostId"> {
  return {
    configFilePath: "/workspace/.treety/tree.json",
    workspaceId: "window",
    nodeId: "shell",
    sessionId: "session",
  };
}
