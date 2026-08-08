import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as test from "node:test";

import {
  formatTreeStateContent,
  getTreeNodeNeedsAttention,
  getTreeStateFilePath,
  loadTreeStateFile,
  parseTreeStateContent,
  setTreeNodeAttention,
} from "./state";
import { addTreeTerminal, createEmptyTreeConfig } from "./tree-editor";
import { writeTreeConfigFile } from "./tree-storage";

test.test("parses and formats only non-default attention state", () => {
  const treeState = parseTreeStateContent(`{
    "version": 1,
    "nodes": {
      "ready": { "needsAttention": true },
      "idle": { "needsAttention": false }
    }
  }`);

  assert.deepEqual(treeState, {
    version: 1,
    nodes: {
      ready: { needsAttention: true },
    },
  });
  assert.equal(
    formatTreeStateContent(treeState),
    '{\n  "version": 1,\n  "nodes": {\n    "ready": {\n      "needsAttention": true\n    }\n  }\n}\n',
  );
});

test.test("derives collision-free default and custom state paths", () => {
  assert.equal(
    getTreeStateFilePath("/workspace/.treety/tree.json"),
    "/workspace/.treety/state.json",
  );
  assert.equal(
    getTreeStateFilePath("/workspace/config/review.json"),
    "/workspace/config/review.state.json",
  );
});

test.test("propagates terminal attention through ancestor groups", () => {
  assert.equal(
    getTreeNodeNeedsAttention({
      kind: "group",
      id: "group",
      name: "Group",
      cwd: "/workspace",
      env: {},
      restartPolicy: "manual",
      children: [
        {
          kind: "terminal",
          id: "shell",
          name: "Shell",
          cwd: "/workspace",
          env: {},
          needsAttention: true,
          restartPolicy: "manual",
          parentId: "group",
        },
      ],
    }),
    true,
  );
});

test.test("mutates attention idempotently and prunes stale nodes", async () => {
  const temporaryDirPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "treety-state-"),
  );
  const treeConfigFilePath = path.join(
    temporaryDirPath,
    ".treety",
    "tree.json",
  );
  const treeConfig = addTreeTerminal(createEmptyTreeConfig(), {
    id: "shell",
    name: "Shell",
  });

  try {
    await writeTreeConfigFile(treeConfigFilePath, treeConfig);
    await fs.writeFile(
      getTreeStateFilePath(treeConfigFilePath),
      '{"version":1,"nodes":{"stale":{"needsAttention":true}}}\n',
      "utf8",
    );

    await setTreeNodeAttention(
      treeConfigFilePath,
      "shell",
      true,
    );
    await setTreeNodeAttention(
      treeConfigFilePath,
      "shell",
      true,
    );

    assert.deepEqual(await loadTreeStateFile(treeConfigFilePath), {
      version: 1,
      nodes: {
        shell: { needsAttention: true },
      },
    });

    await setTreeNodeAttention(
      treeConfigFilePath,
      "shell",
      false,
    );

    assert.deepEqual(await loadTreeStateFile(treeConfigFilePath), {
      version: 1,
      nodes: {},
    });
    assert.match(
      await fs.readFile(
        path.join(temporaryDirPath, ".treety", ".gitignore"),
        "utf8",
      ),
      /state\.json/,
    );
  } finally {
    await fs.rm(temporaryDirPath, { recursive: true, force: true });
  }
});
