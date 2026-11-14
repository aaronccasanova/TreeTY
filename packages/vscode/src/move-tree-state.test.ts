import * as assert from "node:assert/strict";
import * as nodeTest from "node:test";

import { resolveTreeConfig } from "@treety/core";

import { collapseMoveTree } from "./move-tree-state";

nodeTest.test("collapses every group before closing the move tree root on the next click", () => {
  const treeNodes = createTreeNodes();
  const moveTreeEditorState = {
    collapsedGroupIds: new Set<string>(),
    isRootCollapsed: false,
    showAllGroups: false,
  };
  const rootOverviewState = collapseMoveTree(treeNodes, moveTreeEditorState);

  assert.deepEqual(rootOverviewState, {
    collapsedGroupIds: new Set(["services", "backend", "workers", "tools"]),
    isRootCollapsed: false,
    showAllGroups: false,
  });
  assert.deepEqual(moveTreeEditorState.collapsedGroupIds, new Set());

  const rootCollapsedState = collapseMoveTree(treeNodes, rootOverviewState);

  assert.deepEqual(rootCollapsedState, { ...rootOverviewState, isRootCollapsed: true });
  assert.deepEqual(collapseMoveTree(treeNodes, rootCollapsedState), rootCollapsedState);
});

nodeTest.test("keeps the root open when any visible top-level group is expanded", () => {
  const treeNodes = createTreeNodes();

  for (const collapsedGroupId of ["services", "tools"]) {
    const rootOverviewState = collapseMoveTree(treeNodes, {
      collapsedGroupIds: new Set([collapsedGroupId]),
      isRootCollapsed: false,
      showAllGroups: false,
    });

    assert.equal(rootOverviewState.isRootCollapsed, false);
    assert.deepEqual(
      rootOverviewState.collapsedGroupIds,
      new Set(["services", "backend", "workers", "tools"]),
    );
  }
});

nodeTest.test("expanded descendants behind collapsed top-level groups do not keep the root open", () => {
  const rootCollapsedState = collapseMoveTree(createTreeNodes(), {
    collapsedGroupIds: new Set(["services", "tools"]),
    isRootCollapsed: false,
    showAllGroups: false,
  });

  assert.equal(rootCollapsedState.isRootCollapsed, true);
  assert.deepEqual(
    rootCollapsedState.collapsedGroupIds,
    new Set(["services", "backend", "workers", "tools"]),
  );
});

nodeTest.test("already closed, leaf-only, and empty roots need no intermediate overview", () => {
  const closedRootState = collapseMoveTree(createTreeNodes(), {
    collapsedGroupIds: new Set<string>(),
    isRootCollapsed: true,
    showAllGroups: false,
  });

  assert.equal(closedRootState.isRootCollapsed, true);
  assert.equal(closedRootState.collapsedGroupIds.size, 4);

  const leafOnlyTreeConfig = resolveTreeConfig({
    version: 1,
    tree: [{ kind: "terminal", id: "shell", name: "Shell" }],
  }, "/workspace");

  for (const treeNodes of [leafOnlyTreeConfig.tree, []]) {
    const rootCollapsedState = collapseMoveTree(treeNodes, {
      collapsedGroupIds: new Set<string>(),
      isRootCollapsed: false,
      showAllGroups: false,
    });

    assert.deepEqual(rootCollapsedState, {
      collapsedGroupIds: new Set(),
      isRootCollapsed: true,
      showAllGroups: false,
    });
  }
});

nodeTest.test("search-expanded groups collapse to an unfiltered overview even when saved state is closed", () => {
  const treeNodes = createTreeNodes();
  const rootOverviewState = collapseMoveTree(treeNodes, {
    collapsedGroupIds: new Set(["services", "backend", "workers", "tools"]),
    isRootCollapsed: true,
    showAllGroups: true,
  });

  assert.deepEqual(rootOverviewState, {
    collapsedGroupIds: new Set(["services", "backend", "workers", "tools"]),
    isRootCollapsed: false,
    showAllGroups: false,
  });
  assert.equal(collapseMoveTree(treeNodes, rootOverviewState).isRootCollapsed, true);
});

nodeTest.test("reopening a group starts the groups-first collapse again", () => {
  const treeNodes = createTreeNodes();
  const rootOverviewState = collapseMoveTree(treeNodes, {
    collapsedGroupIds: new Set<string>(),
    isRootCollapsed: false,
    showAllGroups: false,
  });

  rootOverviewState.collapsedGroupIds.delete("services");

  const refreshedRootOverviewState = collapseMoveTree(treeNodes, rootOverviewState);

  assert.equal(refreshedRootOverviewState.isRootCollapsed, false);
  assert.equal(refreshedRootOverviewState.collapsedGroupIds.has("services"), true);
  assert.equal(collapseMoveTree(treeNodes, refreshedRootOverviewState).isRootCollapsed, true);
});

function createTreeNodes() {
  return resolveTreeConfig({
    version: 1,
    tree: [
      {
        kind: "group", id: "services", name: "Services", children: [{
          kind: "group", id: "backend", name: "Backend", children: [{
            kind: "group", id: "workers", name: "Workers", children: [
              { kind: "terminal", id: "worker", name: "Worker" },
            ],
          }],
        }],
      },
      {
        kind: "group", id: "tools", name: "Tools", children: [
          { kind: "terminal", id: "tool", name: "Tool" },
        ],
      },
      { kind: "terminal", id: "shell", name: "Shell" },
    ],
  }, "/workspace").tree;
}
