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
} from "./tree-editor";

test.test("adds nested groups and terminals with stable generated IDs", () => {
  const emptyTreeConfig = createEmptyTreeConfig();
  const treeConfigWithGroup = addTreeGroup(emptyTreeConfig, {
    name: "API services",
    cwd: "services",
  });
  const treeConfigWithTerminal = addTreeTerminal(treeConfigWithGroup, {
    name: "API services",
    parentId: "api-services",
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

  assert.equal(apiServicesGroup.id, "api-services");
  assert.equal(apiServicesGroup.children[0]?.id, "api-services-2");
  assert.deepEqual(apiServicesGroup.children[0], {
    kind: "terminal",
    id: "api-services-2",
    name: "API services",
    cwd: "api",
    command: {
      executable: "pnpm",
      args: ["dev"],
    },
  });
  assert.deepEqual(emptyTreeConfig.tree, []);
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
