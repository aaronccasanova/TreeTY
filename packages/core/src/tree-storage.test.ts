import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as test from "node:test";

import { addTreeTerminal, createEmptyTreeConfig, renameTreeNode } from "./tree-editor";
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
