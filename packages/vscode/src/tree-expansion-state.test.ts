import * as assert from "node:assert/strict";
import * as nodeTest from "node:test";

import type * as vscode from "vscode";

import { TreeExpansionState } from "./tree-expansion-state";

nodeTest.test("a fresh view starts expanded and manual collapse preserves untouched descendants across reload", async () => {
  const workspaceState = createWorkspaceState();
  const treeExpansionState = new TreeExpansionState(workspaceState);

  assert.equal(treeExpansionState.getExpanded("workspace:alpha"), true);

  await treeExpansionState.setExpanded("workspace:alpha", false, () => ["workspace", "workspace:alpha", "workspace:inner"]);

  const restoredTreeExpansionState = new TreeExpansionState(workspaceState);

  assert.equal(restoredTreeExpansionState.getExpanded("workspace"), true);
  assert.equal(restoredTreeExpansionState.getExpanded("workspace:alpha"), false);
  assert.equal(restoredTreeExpansionState.getExpanded("workspace:inner"), true);
  assert.equal(restoredTreeExpansionState.getExpanded("workspace:new-group"), false);
});

nodeTest.test("collapse all also closes never-loaded descendants and root reveal opens only that root", async () => {
  const workspaceState = createWorkspaceState();
  const treeExpansionState = new TreeExpansionState(workspaceState);

  await treeExpansionState.collapseAll();
  await treeExpansionState.setExpanded("workspace", true, () => []);

  const restoredTreeExpansionState = new TreeExpansionState(workspaceState);

  assert.equal(restoredTreeExpansionState.getExpanded("workspace"), true);
  assert.equal(restoredTreeExpansionState.getExpanded("workspace:unloaded"), false);
  assert.equal(restoredTreeExpansionState.getExpanded("workspace:unloaded:deeper"), false);

  await treeExpansionState.collapseAll();

  assert.equal(new TreeExpansionState(workspaceState).getExpanded("workspace"), false);
});

nodeTest.test("expansion changes keep workspace identities independent and persist in order", async () => {
  const workspaceState = createWorkspaceState();
  const treeExpansionState = new TreeExpansionState(workspaceState);

  await Promise.all([
    treeExpansionState.collapseAll(),
    treeExpansionState.setExpanded("first:group", true, () => []),
    treeExpansionState.setExpanded("second:group", true, () => []),
    treeExpansionState.setExpanded("first:group", false, () => []),
  ]);

  const restoredTreeExpansionState = new TreeExpansionState(workspaceState);

  assert.equal(restoredTreeExpansionState.getExpanded("first:group"), false);
  assert.equal(restoredTreeExpansionState.getExpanded("second:group"), true);
});

nodeTest.test("a failed storage write does not prevent a later expansion update", async () => {
  const workspaceState = createWorkspaceState();
  const update = workspaceState.update;
  workspaceState.update = async () => { throw new Error("write failed"); };
  const treeExpansionState = new TreeExpansionState(workspaceState);

  await assert.rejects(treeExpansionState.collapseAll(), /write failed/);
  workspaceState.update = update;
  await treeExpansionState.setExpanded("workspace", true, () => []);

  assert.equal(new TreeExpansionState(workspaceState).getExpanded("workspace"), true);
  assert.equal(new TreeExpansionState(workspaceState).getExpanded("unloaded"), false);
});

function createWorkspaceState(): Pick<vscode.Memento, "get" | "update"> {
  const savedValues = new Map<string, unknown>();

  return {
    get: <Value>(key: string, defaultValue?: Value): Value => (savedValues.get(key) ?? defaultValue) as Value,
    update: async (key: string, value: unknown) => { savedValues.set(key, value); },
  };
}
