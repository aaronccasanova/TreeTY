import * as assert from "node:assert/strict";
import * as nodeTest from "node:test";

import { resolveTreeConfig } from "@treety/core";
import type { TreeNodeConfig } from "@treety/core";

import { getWorkspaceTreeChange } from "./get-workspace-tree-change";

nodeTest.test("identical rewrites produce no row or child changes", () => {
  const tree = [createGroup("alpha", [createTerminal("shell")])];
  const previousTreeNodes = resolveTreeConfig({ version: 1, tree }, "/workspace").tree;
  const treeNodes = resolveTreeConfig({ version: 1, tree: structuredClone(tree) }, "/workspace").tree;

  assert.deepEqual(getWorkspaceTreeChange(previousTreeNodes, treeNodes), {
    parentIds: [], nodeIds: [],
  });
});

nodeTest.test("adding or removing a leaf refreshes only its parent", () => {
  const previousTreeNodes = resolveTree([createGroup("alpha"), createGroup("beta")]);
  const treeNodes = resolveTree([createGroup("alpha"), createGroup("beta", [createTerminal("new")])]);

  assert.deepEqual(getWorkspaceTreeChange(previousTreeNodes, treeNodes).parentIds, ["beta"]);
  assert.deepEqual(getWorkspaceTreeChange(treeNodes, previousTreeNodes).parentIds, ["beta"]);
  assert.deepEqual(getWorkspaceTreeChange(previousTreeNodes, treeNodes).nodeIds, []);
});

nodeTest.test("moves and reorders refresh both surviving parents without refreshing unrelated roots", () => {
  const previousTreeNodes = resolveTree([
    createGroup("alpha", [createTerminal("one"), createTerminal("two")]),
    createGroup("beta"),
  ]);
  const treeNodes = resolveTree([
    createGroup("alpha", [createTerminal("two")]),
    createGroup("beta", [createTerminal("one")]),
  ]);

  assert.deepEqual(getWorkspaceTreeChange(previousTreeNodes, treeNodes).parentIds, ["alpha", "beta"]);

  const reorderedTreeNodes = resolveTree([
    createGroup("alpha", [createTerminal("two"), createTerminal("one")]),
    createGroup("beta"),
  ]);

  assert.deepEqual(getWorkspaceTreeChange(previousTreeNodes, reorderedTreeNodes).parentIds, ["alpha"]);
  assert.deepEqual(getWorkspaceTreeChange(previousTreeNodes, [...previousTreeNodes].reverse()).parentIds, [undefined]);
});

nodeTest.test("inherited presentation changes refresh affected descendants and retain child lists", () => {
  const previousTreeNodes = resolveTree([createGroup("alpha", [createTerminal("shell")])]);
  const tree = createGroup("alpha", [createTerminal("shell")]);
  tree.cwd = "/other";
  const treeNodes = resolveTree([tree]);
  const workspaceTreeChange = getWorkspaceTreeChange(previousTreeNodes, treeNodes);

  assert.deepEqual(workspaceTreeChange.parentIds, []);
  assert.deepEqual(workspaceTreeChange.nodeIds, ["alpha", "shell"]);
});

function resolveTree(tree: TreeNodeConfig[]) {
  return resolveTreeConfig({ version: 1, tree }, "/workspace").tree;
}

function createGroup(id: string, children: TreeNodeConfig[] = []): TreeNodeConfig & { kind: "group" } {
  return { kind: "group", id, name: id, children };
}

function createTerminal(id: string): TreeNodeConfig {
  return { kind: "terminal", id, name: id };
}
