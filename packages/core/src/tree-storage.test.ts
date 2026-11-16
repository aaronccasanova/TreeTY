import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as test from "node:test";

import { addTreeTerminal, createEmptyTreeConfig, renameTreeNode } from "./tree-editor";
import { mutateDocumentFile } from "./file-storage";
import {
  loadTreeConfigFile,
  mutateTreeConfigFile,
  writeTreeConfigFile,
} from "./tree-storage";

test.test("serializes concurrent semantic configuration mutations", async () => {
  const temporaryDirPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "treety-storage-"),
  );
  const treeConfigFilePath = path.join(
    temporaryDirPath,
    ".treety",
    "tree.json",
  );
  const treeConfig = addTreeTerminal(
    addTreeTerminal(createEmptyTreeConfig(), {
      id: "first",
      name: "First",
    }),
    {
      id: "second",
      name: "Second",
    },
  );

  try {
    await writeTreeConfigFile(treeConfigFilePath, treeConfig);
    const lockFilePath = `${treeConfigFilePath}.lock`;
    const staleLockDate = new Date(Date.now() - 60_000);

    await fs.writeFile(lockFilePath, "abandoned", "utf8");
    await fs.utimes(lockFilePath, staleLockDate, staleLockDate);
    await mutateTreeConfigFile(treeConfigFilePath, (latestTreeConfig) =>
      renameTreeNode(latestTreeConfig, "first", "Recovered first"),
    );

    await Promise.all([
      mutateTreeConfigFile(treeConfigFilePath, (latestTreeConfig) =>
        renameTreeNode(latestTreeConfig, "first", "Updated first"),
      ),
      mutateTreeConfigFile(treeConfigFilePath, (latestTreeConfig) =>
        renameTreeNode(latestTreeConfig, "second", "Updated second"),
      ),
    ]);

    const updatedTreeConfig = await loadTreeConfigFile(treeConfigFilePath);

    assert.deepEqual(
      updatedTreeConfig.tree.map((treeNode) => treeNode.name),
      ["Updated first", "Updated second"],
    );

    const generatedFileNames = await fs.readdir(
      path.dirname(treeConfigFilePath),
    );

    assert.equal(
      generatedFileNames.some(
        (generatedFileName) =>
          generatedFileName.endsWith(".lock") ||
          generatedFileName.endsWith(".tmp"),
      ),
      false,
    );
  } finally {
    await fs.rm(temporaryDirPath, { recursive: true, force: true });
  }
});

test.test("preserves aged locks with live or unknown owners when requested", async (testContext) => {
  const temporaryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-storage-"));

  testContext.after(() => fs.rm(temporaryDirPath, { recursive: true, force: true }));

  const documentFilePath = path.join(temporaryDirPath, "document.json");
  const lockFilePath = `${documentFilePath}.lock`;
  const staleLockDate = new Date(Date.now() - 60_000);

  for (const lockFileContent of [JSON.stringify({ pid: process.pid }), "partial", "{}", JSON.stringify({ pid: -1 })]) {
    await fs.writeFile(lockFilePath, lockFileContent);
    await fs.utimes(lockFilePath, staleLockDate, staleLockDate);

    await assert.rejects(mutateDocumentFile(documentFilePath, JSON.parse, JSON.stringify,
      (document) => document, undefined, {
        createDocument: () => ({}), preserveLiveLocks: true, lockWaitMilliseconds: 0,
      },
    ), /Timed out waiting/);
    assert.equal(await fs.readFile(lockFilePath, "utf8"), lockFileContent);
  }

  testContext.mock.method(process, "kill", () => {
    throw Object.assign(new Error("process is inaccessible"), { code: "EPERM" });
  });
  await fs.writeFile(lockFilePath, JSON.stringify({ pid: 42 }));
  await fs.utimes(lockFilePath, staleLockDate, staleLockDate);
  await assert.rejects(mutateDocumentFile(documentFilePath, JSON.parse, JSON.stringify,
    (document) => document, undefined, {
      createDocument: () => ({}), preserveLiveLocks: true, lockWaitMilliseconds: 0,
    },
  ), /Timed out waiting/);
});

test.test("recovers aged locks only after their owner has exited", async (testContext) => {
  const temporaryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-storage-"));

  testContext.after(() => fs.rm(temporaryDirPath, { recursive: true, force: true }));
  testContext.mock.method(process, "kill", () => {
    throw Object.assign(new Error("process has exited"), { code: "ESRCH" });
  });

  const documentFilePath = path.join(temporaryDirPath, "document.json");
  const lockFilePath = `${documentFilePath}.lock`;
  const staleLockDate = new Date(Date.now() - 60_000);

  await fs.writeFile(lockFilePath, JSON.stringify({ pid: 42 }));
  await assert.rejects(mutateDocumentFile(documentFilePath, JSON.parse, JSON.stringify,
    (document) => document, undefined, {
      createDocument: () => ({}), preserveLiveLocks: true, lockWaitMilliseconds: 0,
    },
  ), /Timed out waiting/);

  await fs.utimes(lockFilePath, staleLockDate, staleLockDate);

  const document = await mutateDocumentFile(documentFilePath, JSON.parse, JSON.stringify,
    () => ({ recovered: true }), undefined, {
      createDocument: () => ({}), preserveLiveLocks: true, lockWaitMilliseconds: 0,
    },
  );

  assert.deepEqual(document, { recovered: true });
  await assert.rejects(fs.stat(lockFilePath), { code: "ENOENT" });
});

test.test("does not release a replacement lock owned by another transaction", async (testContext) => {
  const temporaryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-storage-"));

  testContext.after(() => fs.rm(temporaryDirPath, { recursive: true, force: true }));

  const documentFilePath = path.join(temporaryDirPath, "document.json");
  const lockFilePath = `${documentFilePath}.lock`;
  const replacementLockContent = JSON.stringify({ pid: process.pid, replacement: true });

  await mutateDocumentFile(documentFilePath, JSON.parse, JSON.stringify, async (document) => {
    await fs.rename(lockFilePath, `${lockFilePath}.previous`);
    await fs.writeFile(lockFilePath, replacementLockContent);

    return document;
  }, undefined, { createDocument: () => ({}), preserveLiveLocks: true });

  assert.equal(await fs.readFile(lockFilePath, "utf8"), replacementLockContent);
});

test.test("releases a newly acquired lock when its initialization fails", async (testContext) => {
  const temporaryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-storage-"));

  testContext.after(() => fs.rm(temporaryDirPath, { recursive: true, force: true }));

  const documentFilePath = path.join(temporaryDirPath, "document.json");
  const fileHandle = await fs.open(path.join(temporaryDirPath, "probe"), "w");
  const fileHandlePrototype = Object.getPrototypeOf(fileHandle) as { sync: () => Promise<void> };

  await fileHandle.close();
  testContext.mock.method(fileHandlePrototype, "sync", async () => {
    throw new Error("lock persistence failed");
  });

  await assert.rejects(mutateDocumentFile(documentFilePath, JSON.parse, JSON.stringify,
    (document) => document, undefined, { createDocument: () => ({}), preserveLiveLocks: true },
  ), /lock persistence failed/);
  await assert.rejects(fs.stat(`${documentFilePath}.lock`), { code: "ENOENT" });
});
