import * as assert from "node:assert/strict";
import * as nodeTest from "node:test";

import { resolveTreeConfig } from "@treety/core";
import type { TreeNodeConfig } from "@treety/core";
import type * as vscode from "vscode";

import { NodeSearchPicker } from "./node-search-picker";
import type { NodeSearchQuickPickItem } from "./node-search-picker";
import type { NodeTreeEntry } from "./tree-provider";
import type { WorkspaceModel, WorkspaceModelChange, WorkspaceModelSource } from "./workspace-model";

nodeTest.test("filters typo matches, handles no results, and cancels without opening a node", () => {
  const harness = createSearchHarness();

  harness.picker.show();

  const quickPick = harness.quickPicks[0];

  assert.ok(quickPick);
  assert.equal(quickPick.items.length, 3);

  quickPick.changeValue("paymnets tests");

  assert.equal(quickPick.items.length, 1);
  assert.equal(quickPick.items[0]?.nodeSearchEntry.nodeId, "tests");
  assert.equal(quickPick.items[0]?.alwaysShow, true);

  quickPick.selectedItems = quickPick.items;
  quickPick.changeValue("unfindable");
  quickPick.accept();

  assert.equal(quickPick.items.length, 0);
  assert.equal(quickPick.activeItems.length, 0);
  assert.equal(harness.openedNodes.length, 0);

  quickPick.hide();

  assert.equal(quickPick.disposeCount, 1);
  assert.equal(harness.modelChanges.listenerCount, 0);
  assert.equal(quickPick.listenerCount, 0);
});

nodeTest.test("reuses an open picker and preserves selection through renames and moves", () => {
  const harness = createSearchHarness();

  harness.picker.show();
  harness.picker.show();

  const quickPick = harness.quickPicks[0];

  assert.ok(quickPick);
  assert.equal(harness.quickPicks.length, 1);
  assert.equal(quickPick.showCount, 2);

  quickPick.activeItems = quickPick.items.filter((item) => item.nodeSearchEntry.nodeId === "tests");

  const updatedWorkspace = createWorkspace([{ kind: "terminal", id: "tests", name: "Renamed tests" }]);

  harness.setWorkspaceModels([updatedWorkspace]);

  assert.equal(quickPick.activeItems[0]?.nodeSearchEntry.nodeId, "tests");
  assert.equal(quickPick.activeItems[0]?.description, "Personal");
  assert.match(quickPick.activeItems[0]?.label ?? "", /Renamed tests/);

  quickPick.accept();
  quickPick.accept();

  assert.equal(harness.openedNodes.length, 1);
  assert.equal(harness.openedNodes[0]?.workspaceModel, updatedWorkspace);
  assert.equal(quickPick.disposeCount, 1);
  assert.equal(harness.modelChanges.listenerCount, 0);
});

nodeTest.test("rejects a stale selection even before a model change notification arrives", () => {
  const harness = createSearchHarness();

  harness.picker.show();

  const quickPick = harness.quickPicks[0];

  assert.ok(quickPick);

  quickPick.selectedItems = quickPick.items.filter((item) => item.nodeSearchEntry.nodeId === "tests");
  harness.setWorkspaceModels([], false);
  quickPick.accept();

  assert.equal(harness.openedNodes.length, 0);
  assert.match(quickPick.title, /no longer available/);
  assert.equal(quickPick.items.length, 0);
  assert.equal(quickPick.disposeCount, 0);

  harness.picker.dispose();

  assert.equal(quickPick.disposeCount, 1);
});

nodeTest.test("re-resolves selected identities against current models and reports opening errors", async () => {
  const openError = new Error("Terminal disappeared during opening");
  const harness = createSearchHarness(async () => { throw openError; });

  harness.picker.show();

  const quickPick = harness.quickPicks[0];

  assert.ok(quickPick);

  quickPick.selectedItems = quickPick.items.filter((item) => item.nodeSearchEntry.nodeId === "tests");
  harness.setWorkspaceModels([createWorkspace([{ kind: "terminal", id: "tests", name: "Current tests" }])], false);
  quickPick.accept();

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.openedNodes[0]?.treeNode.name, "Current tests");
  assert.deepEqual(harness.errors, [openError]);
  assert.equal(quickPick.disposeCount, 1);
});

nodeTest.test("refreshes matching results for metadata changes but ignores status and attention events", () => {
  const harness = createSearchHarness();

  harness.picker.show();

  const quickPick = harness.quickPicks[0];

  assert.ok(quickPick);

  quickPick.changeValue("owner platform");

  assert.equal(quickPick.items.length, 0);

  harness.setWorkspaceModels([createWorkspace([{ kind: "terminal", id: "tests", name: "Tests", metadata: { owner: "Platform" } }])]);

  assert.equal(quickPick.items.length, 1);

  const currentItems = quickPick.items;

  harness.modelChanges.fire({ kind: "terminal", workspaceId: "personal", nodeIds: ["tests"] });
  harness.modelChanges.fire({ kind: "attention", workspaceId: "personal", nodeIds: ["tests"] });

  assert.equal(quickPick.items, currentItems);

  harness.picker.dispose();
  harness.modelChanges.fire({ kind: "workspace" });

  assert.equal(quickPick.items, currentItems);
  assert.equal(harness.modelChanges.listenerCount, 0);
});

nodeTest.test("supports reopening after cancellation and disposes the active session on shutdown", () => {
  const harness = createSearchHarness();

  harness.picker.show();
  harness.quickPicks[0]?.hide();
  harness.picker.show();

  assert.equal(harness.quickPicks.length, 2);
  assert.equal(harness.modelChanges.listenerCount, 1);

  harness.picker.dispose();
  harness.picker.dispose();

  assert.equal(harness.quickPicks[1]?.disposeCount, 1);
  assert.equal(harness.modelChanges.listenerCount, 0);
  assert.equal(harness.quickPicks[1]?.listenerCount, 0);
});

function createSearchHarness(openNode?: (nodeTreeEntry: NodeTreeEntry) => Promise<void>) {
  let workspaceModels = [createWorkspace([{
    kind: "group", id: "payments", name: "Payments", children: [
      { kind: "terminal", id: "tests", name: "Service tests" },
      { kind: "terminal", id: "shell", name: "Shell" },
    ],
  }])];
  const modelChanges = createEvent<WorkspaceModelChange>();
  const openedNodes: NodeTreeEntry[] = [];
  const errors: unknown[] = [];
  const quickPicks: ReturnType<typeof createQuickPick>[] = [];
  const workspaceModelSource: WorkspaceModelSource = {
    getWorkspaceModels: () => workspaceModels,
    onDidChangeWorkspaceModels: modelChanges.event,
    getTerminalSessionState: () => { throw new Error("Search does not inspect sessions."); },
  };
  const picker = new NodeSearchPicker({
    workspaceModelSource,
    createQuickPick: () => {
      const quickPick = createQuickPick();

      quickPicks.push(quickPick);

      return quickPick as unknown as vscode.QuickPick<NodeSearchQuickPickItem>;
    },
    openNode: async (nodeTreeEntry) => {
      openedNodes.push(nodeTreeEntry);
      await openNode?.(nodeTreeEntry);
    },
    showError: (error) => errors.push(error),
  });

  return {
    picker, quickPicks, openedNodes, errors, modelChanges,
    setWorkspaceModels: (updatedWorkspaceModels: WorkspaceModel[], notify = true) => {
      workspaceModels = updatedWorkspaceModels;

      if (notify) modelChanges.fire({ kind: "workspace" });
    },
  };
}

function createWorkspace(tree: TreeNodeConfig[]): WorkspaceModel {
  return {
    kind: "configured", id: "personal", name: "Personal",
    resolvedTreeConfig: resolveTreeConfig({ version: 1, tree }, "/workspace"),
  } as WorkspaceModel;
}

function createQuickPick() {
  const changeValueEvent = createEvent<string>();
  const acceptEvent = createEvent<void>();
  const hideEvent = createEvent<void>();
  const quickPick = {
    items: [] as readonly NodeSearchQuickPickItem[],
    activeItems: [] as readonly NodeSearchQuickPickItem[],
    selectedItems: [] as readonly NodeSearchQuickPickItem[],
    value: "", title: "", placeholder: "", showCount: 0, disposeCount: 0,
    onDidChangeValue: changeValueEvent.event,
    onDidAccept: acceptEvent.event,
    onDidHide: hideEvent.event,
    show: () => { quickPick.showCount += 1; },
    dispose: () => { quickPick.disposeCount += 1; },
    changeValue: (value: string) => {
      quickPick.value = value;
      changeValueEvent.fire(value);
    },
    accept: () => acceptEvent.fire(),
    hide: () => hideEvent.fire(),
    get listenerCount() {
      return changeValueEvent.listenerCount + acceptEvent.listenerCount + hideEvent.listenerCount;
    },
  };

  return quickPick;
}

function createEvent<Value>() {
  const listeners = new Set<(value: Value) => void>();
  const event: vscode.Event<Value> = (listener) => {
    listeners.add(listener);

    return { dispose: () => { listeners.delete(listener); } };
  };

  return {
    event,
    fire: (value: Value) => { for (const listener of listeners) listener(value); },
    get listenerCount() { return listeners.size; },
  };
}
