import * as assert from "node:assert/strict";
import * as test from "node:test";

import {
  addTreeGroup,
  addTreeTerminal,
  createEmptyTreeConfig,
  moveTreeNode,
  removeTreeNode,
  renameTreeNode,
  TreeNodeOperationError,
  updateTreeNode,
  clearTreeNodeMetadataPath,
  setTreeNodeMetadataPath,
} from "./tree-editor";

test.test("adds nested groups and terminals with opaque stable IDs", () => {
  const emptyTreeConfig = createEmptyTreeConfig();
  const treeConfigWithGroup = addTreeGroup(emptyTreeConfig, {
    name: "API services",
    cwd: "services",
  });
  const treeConfigWithTerminal = addTreeTerminal(treeConfigWithGroup, {
    name: "API services",
    parentId: treeConfigWithGroup.tree[0]?.id,
    cwd: "api",
    command: {
      executable: "pnpm",
      args: ["dev"],
    },
  });
  const apiServicesGroup = treeConfigWithTerminal.tree[0];

  assert.equal(apiServicesGroup?.kind, "group");

  if (!apiServicesGroup || apiServicesGroup.kind !== "group") {
    assert.fail("Expected an API services group.");
  }

  assert.match(apiServicesGroup.id, /^[0-9a-f-]{36}$/);
  assert.match(apiServicesGroup.children[0]?.id ?? "", /^[0-9a-f-]{36}$/);
  assert.notEqual(apiServicesGroup.id, apiServicesGroup.children[0]?.id);
  assert.equal(apiServicesGroup.children[0]?.name, "API services");
  assert.deepEqual(emptyTreeConfig.tree, []);
});

test.test("updates node configuration and metadata without changing identity", () => {
  const treeConfig = addTreeTerminal(createEmptyTreeConfig(), {
    id: "shell",
    name: "Shell",
    env: {
      KEEP: "yes",
      REMOVE: "yes",
    },
  });
  const updatedTreeConfig = updateTreeNode(treeConfig, {
    nodeId: "shell",
    cwd: "packages/cli",
    env: {
      delete: ["REMOVE"],
      set: {
        ADDED: "yes",
      },
    },
    metadata: {
      owner: "platform",
      tags: ["review", "cli"],
    },
    metadataAction: "replace",
    projectDir: "../..",
  });
  const shellNode = updatedTreeConfig.tree[0];

  assert.equal(shellNode?.id, "shell");
  assert.equal(shellNode?.cwd, "packages/cli");
  assert.equal(shellNode?.projectDir, "../..");
  assert.deepEqual(shellNode?.env, {
    KEEP: "yes",
    ADDED: "yes",
  });
  assert.deepEqual(shellNode?.metadata, {
    owner: "platform",
    tags: ["review", "cli"],
  });
  assert.equal(treeConfig.tree[0]?.cwd, undefined);
});

test.test("renames, moves, and removes tree nodes without mutating input", () => {
  const treeConfig = addTreeTerminal(
    addTreeGroup(
      addTreeGroup(createEmptyTreeConfig(), { id: "first", name: "First" }),
      { id: "second", name: "Second" },
    ),
    { id: "shell", name: "Shell", parentId: "first" },
  );
  const renamedTreeConfig = renameTreeNode(treeConfig, "shell", "Main shell");
  const movedTreeConfig = moveTreeNode(renamedTreeConfig, {
    nodeId: "shell",
    parentId: "second",
  });
  const finalTreeConfig = removeTreeNode(movedTreeConfig, "first");
  const secondGroup = finalTreeConfig.tree[0];

  assert.equal(secondGroup?.kind, "group");

  if (!secondGroup || secondGroup.kind !== "group") {
    assert.fail("Expected the second group.");
  }

  assert.equal(secondGroup.children[0]?.name, "Main shell");
  assert.equal(treeConfig.tree.length, 2);
});

test.test("rejects invalid parents and recursive moves", () => {
  const treeConfig = addTreeGroup(
    addTreeGroup(createEmptyTreeConfig(), {
      id: "parent",
      name: "Parent",
    }),
    {
      id: "child",
      name: "Child",
      parentId: "parent",
    },
  );

  assert.throws(
    () =>
      moveTreeNode(treeConfig, {
        nodeId: "parent",
        parentId: "child",
      }),
    (error: unknown) =>
      error instanceof TreeNodeOperationError &&
      error.message.includes("own descendant"),
  );

  assert.throws(
    () =>
      addTreeTerminal(treeConfig, {
        name: "Terminal",
        parentId: "missing",
      }),
    (error: unknown) =>
      error instanceof TreeNodeOperationError &&
      error.message.includes("does not exist"),
  );
});

test.test("places nodes before and after siblings across tree levels", () => {
  const treeConfig = addTreeTerminal(
    addTreeTerminal(
      addTreeGroup(
        addTreeGroup(createEmptyTreeConfig(), { id: "first", name: "First" }),
        { id: "second", name: "Second" },
      ),
      { id: "one", name: "One", parentId: "first" },
    ),
    { id: "two", name: "Two", parentId: "second" },
  );
  const treeConfigAtRoot = moveTreeNode(treeConfig, {
    nodeId: "one",
    beforeId: "first",
  });
  const rootNodeIds = treeConfigAtRoot.tree.map((treeNode) => treeNode.id);

  assert.deepEqual(rootNodeIds, ["one", "first", "second"]);

  const treeConfigInSecondGroup = moveTreeNode(treeConfigAtRoot, {
    nodeId: "one",
    afterId: "two",
  });
  const secondGroup = treeConfigInSecondGroup.tree[1];

  assert.equal(secondGroup?.kind, "group");

  if (!secondGroup || secondGroup.kind !== "group") {
    assert.fail("Expected the second group.");
  }

  assert.deepEqual(
    secondGroup.children.map((treeNode) => treeNode.id),
    ["two", "one"],
  );

  assert.throws(
    () =>
      moveTreeNode(treeConfigInSecondGroup, {
        nodeId: "second",
        beforeId: "one",
      }),
    /own descendant/,
  );
  assert.throws(
    () =>
      moveTreeNode(treeConfigInSecondGroup, {
        nodeId: "one",
        afterId: "one",
      }),
    /contain itself/,
  );
});

test.test("sets commands and updates metadata paths without replacing siblings", () => {
  const treeConfig = addTreeTerminal(createEmptyTreeConfig(), {
    id: "shell",
    name: "Shell",
    metadata: {
      owner: "platform",
    },
  });
  const treeConfigWithSession = setTreeNodeMetadataPath(
    treeConfig,
    "shell",
    "/integrations/pi/sessionId",
    "session-123",
  );
  const configuredTreeConfig = updateTreeNode(treeConfigWithSession, {
    nodeId: "shell",
    command: {
      executable: "pi",
      args: ["--session", "session-123"],
    },
  });
  const clearedTreeConfig = clearTreeNodeMetadataPath(
    configuredTreeConfig,
    "shell",
    "/integrations/pi/sessionId",
  );
  const clearedCommandTreeConfig = updateTreeNode(clearedTreeConfig, {
    nodeId: "shell",
    command: null,
  });

  assert.deepEqual(configuredTreeConfig.tree[0]?.metadata, {
    owner: "platform",
    integrations: {
      pi: {
        sessionId: "session-123",
      },
    },
  });
  assert.deepEqual(
    configuredTreeConfig.tree[0]?.kind === "terminal"
      ? configuredTreeConfig.tree[0].command
      : undefined,
    {
      executable: "pi",
      args: ["--session", "session-123"],
    },
  );
  assert.deepEqual(clearedTreeConfig.tree[0]?.metadata, {
    owner: "platform",
    integrations: {
      pi: {},
    },
  });
  assert.equal(
    clearedCommandTreeConfig.tree[0]?.kind === "terminal"
      ? clearedCommandTreeConfig.tree[0].command
      : undefined,
    undefined,
  );
  assert.throws(
    () =>
      setTreeNodeMetadataPath(
        configuredTreeConfig,
        "shell",
        "/owner/id",
        "platform-id",
      ),
    /incompatible value/,
  );
});
