import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as test from "node:test";

import {
  parseTreeConfigContent,
  resolveTreeConfig,
  TreeConfigError,
} from "./config";

test.test("resolves inherited directories, environments, and policies", () => {
  const treeConfig = parseTreeConfigContent(`{
    "version": 1,
    "defaults": {
      "env": { "SHARED": "yes", "REMOVED": "initial" },
      "restartPolicy": "manual"
    },
    "tree": [
      {
        "kind": "group",
        "id": "services",
        "name": "Services",
        "cwd": "services",
        "projectDir": "..",
        "env": { "GROUP": "api" },
        "children": [
          {
            "kind": "terminal",
            "id": "api",
            "name": "API",
            "cwd": "api",
            "env": { "REMOVED": null },
            "restartPolicy": "onOpen",
            "metadata": {
              "owner": "platform",
              "tags": ["api", "development"]
            },
            "command": {
              "executable": "pnpm",
              "args": ["dev"]
            }
          }
        ]
      }
    ]
  }`);
  const workspaceDirPath = path.resolve("/workspace");
  const resolvedTreeConfig = resolveTreeConfig(treeConfig, workspaceDirPath);
  const serviceGroup = resolvedTreeConfig.tree[0];

  assert.equal(serviceGroup?.kind, "group");

  if (!serviceGroup || serviceGroup.kind !== "group") {
    assert.fail("Expected a resolved group.");
  }

  const apiTerminal = serviceGroup.children[0];

  assert.equal(apiTerminal?.kind, "terminal");

  if (!apiTerminal || apiTerminal.kind !== "terminal") {
    assert.fail("Expected a resolved terminal.");
  }

  assert.equal(apiTerminal.cwd, path.resolve(workspaceDirPath, "services/api"));
  assert.equal(apiTerminal.projectDir, workspaceDirPath);
  assert.deepEqual(apiTerminal.env, {
    SHARED: "yes",
    REMOVED: null,
    GROUP: "api",
  });
  assert.equal(apiTerminal.restartPolicy, "onOpen");
  assert.deepEqual(apiTerminal.metadata, {
    owner: "platform",
    tags: ["api", "development"],
  });
  assert.deepEqual(apiTerminal.command, {
    executable: "pnpm",
    args: ["dev"],
  });
});

test.test("rejects duplicate node IDs", () => {
  assert.throws(
    () =>
      parseTreeConfigContent(`{
        "version": 1,
        "tree": [
          { "kind": "terminal", "id": "shell", "name": "First" },
          { "kind": "terminal", "id": "shell", "name": "Second" }
        ]
      }`),
    (error: unknown) =>
      error instanceof TreeConfigError && error.message.includes("duplicated"),
  );
});

test.test("reports invalid JSON as a configuration error", () => {
  assert.throws(
    () => parseTreeConfigContent("{"),
    (error: unknown) =>
      error instanceof TreeConfigError &&
      error.message.includes("not valid JSON"),
  );
});
