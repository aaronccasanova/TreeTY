import * as assert from "node:assert/strict";
import * as nodeTest from "node:test";

import type * as vscode from "vscode";

import { TreeCollapseController } from "./tree-collapse-controller";
import type { NodeTreeEntry, TreeEntry, WorkspaceTreeEntry } from "./tree-provider";
import type { ConfiguredWorkspaceModel } from "./workspace-model";

nodeTest.test("collapses nested groups before closing the global root on the next click", async () => {
  const globalRoot = createWorkspaceTreeEntry("global");
  const group = createGroupTreeEntry(globalRoot);
  const nestedGroup = createGroupTreeEntry(globalRoot, "nested", "group");
  const fixture = createFixture([
    [globalRoot, group, nestedGroup],
    [globalRoot],
    [],
  ]);

  await fixture.treeCollapseController.collapseAll();

  assert.deepEqual(fixture.reveals, [{
    treeEntry: globalRoot,
    options: { expand: true, select: false, focus: false },
  }]);
  assert.equal(fixture.listeners.size, 0);

  await fixture.treeCollapseController.collapseAll();
  await fixture.treeCollapseController.collapseAll();

  assert.equal(fixture.reveals.length, 1);
  assert.equal(fixture.collapseCalls.length, 3);
});

nodeTest.test("keeps all previously open roots open while preserving a closed workspace root", async () => {
  const globalRoot = createWorkspaceTreeEntry("global");
  const workspaceRoot = createWorkspaceTreeEntry("workspace");
  const closedRoot = createWorkspaceTreeEntry("closed");
  const fixture = createFixture([[
    createGroupTreeEntry(globalRoot),
    createGroupTreeEntry(closedRoot),
    workspaceRoot,
    globalRoot,
  ]]);

  await fixture.treeCollapseController.collapseAll();

  assert.deepEqual(
    fixture.reveals.map((reveal) => reveal.treeEntry),
    [workspaceRoot, globalRoot],
  );
});

nodeTest.test("hidden expanded descendants do not prevent fully collapsing visible roots", async () => {
  const globalRoot = createWorkspaceTreeEntry("global");
  const closedRoot = createWorkspaceTreeEntry("closed");
  const fixture = createFixture([[
    globalRoot,
    createGroupTreeEntry(globalRoot, "nested", "closed-parent"),
    createGroupTreeEntry(closedRoot),
  ]]);

  await fixture.treeCollapseController.collapseAll();

  assert.deepEqual(fixture.reveals, []);
});

nodeTest.test("empty trees, leaf-only roots, and already-collapsed groups need no intermediate reveal", async () => {
  const globalRoot = createWorkspaceTreeEntry("global");
  const fixture = createFixture([[], [globalRoot], [globalRoot]]);

  for (let invocation = 0; invocation < 3; invocation += 1) {
    await fixture.treeCollapseController.collapseAll();
  }

  assert.deepEqual(fixture.reveals, []);
  assert.equal(fixture.listeners.size, 0);
});

nodeTest.test("reopening a group between clicks starts the groups-first step again", async () => {
  const globalRoot = createWorkspaceTreeEntry("global");
  const group = createGroupTreeEntry(globalRoot);
  const fixture = createFixture([
    [globalRoot, group],
    [globalRoot, group],
    [globalRoot],
  ]);

  await fixture.treeCollapseController.collapseAll();
  await fixture.treeCollapseController.collapseAll();
  await fixture.treeCollapseController.collapseAll();

  assert.deepEqual(
    fixture.reveals.map((reveal) => reveal.treeEntry),
    [globalRoot, globalRoot],
  );
});

nodeTest.test("rapid clicks wait for root restoration before starting the next collapse", async () => {
  const globalRoot = createWorkspaceTreeEntry("global");
  const fixture = createFixture([[globalRoot, createGroupTreeEntry(globalRoot)], [globalRoot]]);
  const revealStarted = createDeferredPromise();
  const revealFinished = createDeferredPromise();
  const reveal = fixture.options.treeView.reveal;

  fixture.options.treeView.reveal = async (...revealArguments) => {
    assert.equal(fixture.listeners.size, 0);
    revealStarted.resolve();
    await revealFinished.promise;
    await reveal(...revealArguments);
  };

  const firstCollapse = fixture.treeCollapseController.collapseAll();
  const secondCollapse = fixture.treeCollapseController.collapseAll();

  await revealStarted.promise;

  assert.equal(fixture.collapseCalls.length, 1);
  revealFinished.resolve();
  await Promise.all([firstCollapse, secondCollapse]);

  assert.equal(fixture.collapseCalls.length, 2);
  assert.equal(fixture.reveals.length, 1);
  assert.equal(fixture.listeners.size, 0);
});

nodeTest.test("native command failure disposes the listener and allows a queued retry", async () => {
  const globalRoot = createWorkspaceTreeEntry("global");
  const fixture = createFixture([[globalRoot, createGroupTreeEntry(globalRoot)]]);
  const collapseAll = fixture.options.collapseAll;
  const collapseError = new Error("native collapse failed");

  fixture.options.collapseAll = async () => {
    fixture.options.collapseAll = collapseAll;
    fixture.emitCollapse(globalRoot);
    throw collapseError;
  };

  const failedCollapse = fixture.treeCollapseController.collapseAll();
  const retriedCollapse = fixture.treeCollapseController.collapseAll();

  await assert.rejects(failedCollapse, collapseError);
  await retriedCollapse;

  assert.equal(fixture.reveals.length, 1);
  assert.equal(fixture.listeners.size, 0);
  assert.equal(fixture.disposedListeners.length, 2);
});

nodeTest.test("root reveal failure propagates without blocking subsequent collapse commands", async () => {
  const globalRoot = createWorkspaceTreeEntry("global");
  const fixture = createFixture([[globalRoot, createGroupTreeEntry(globalRoot)], []]);
  const revealError = new Error("root disappeared");

  fixture.options.treeView.reveal = async () => {
    assert.equal(fixture.listeners.size, 0);
    throw revealError;
  };

  await assert.rejects(fixture.treeCollapseController.collapseAll(), revealError);
  await fixture.treeCollapseController.collapseAll();

  assert.equal(fixture.collapseCalls.length, 2);
  assert.equal(fixture.listeners.size, 0);
});

nodeTest.test("clears saved descendants after native collapse and before restoring roots", async () => {
  const globalRoot = createWorkspaceTreeEntry("global");
  const fixture = createFixture([[globalRoot, createGroupTreeEntry(globalRoot)], [globalRoot]]);
  const operations: string[] = [];
  const collapseAll = fixture.options.collapseAll;
  const reveal = fixture.options.treeView.reveal;

  fixture.options.collapseAll = async () => {
    operations.push("native");
    await collapseAll();
  };
  fixture.options.onDidCollapseAll = async () => { operations.push("persist"); };
  fixture.options.treeView.reveal = async (...revealArguments) => {
    operations.push("reveal");
    await reveal(...revealArguments);
  };

  await fixture.treeCollapseController.collapseAll();
  await fixture.treeCollapseController.collapseAll();

  assert.deepEqual(operations, ["native", "persist", "reveal", "native", "persist"]);
});

function createFixture(collapseBatches: TreeEntry[][]) {
  const listeners = new Set<(event: vscode.TreeViewExpansionEvent<TreeEntry>) => unknown>();
  const disposedListeners: unknown[] = [];
  const collapseCalls: unknown[] = [];
  const reveals: {
    treeEntry: TreeEntry;
    options: Parameters<vscode.TreeView<TreeEntry>["reveal"]>[1];
  }[] = [];
  const emitCollapse = (treeEntry: TreeEntry): void => {
    for (const listener of listeners) listener({ element: treeEntry });
  };
  const options = {
    onDidCollapseAll: async (): Promise<void> => {},
    treeView: {
      onDidCollapseElement: (listener: (event: vscode.TreeViewExpansionEvent<TreeEntry>) => unknown) => {
        listeners.add(listener);

        return {
          dispose: () => {
            assert.equal(listeners.delete(listener), true);
            disposedListeners.push(listener);
          },
        };
      },
      reveal: async (
        treeEntry: TreeEntry,
        revealOptions?: Parameters<vscode.TreeView<TreeEntry>["reveal"]>[1],
      ): Promise<void> => {
        reveals.push({ treeEntry, options: revealOptions });
      },
    },
    collapseAll: async (): Promise<void> => {
      collapseCalls.push(undefined);

      for (const treeEntry of collapseBatches.shift() ?? []) emitCollapse(treeEntry);
    },
  };
  const treeCollapseController = new TreeCollapseController(options);

  return { treeCollapseController, options, listeners, disposedListeners, collapseCalls, reveals, emitCollapse };
}

function createWorkspaceTreeEntry(workspaceId: string): WorkspaceTreeEntry {
  return {
    kind: "workspace",
    workspaceModel: {
      id: workspaceId,
      configSource: workspaceId === "global" ? "global" : "workspace",
    } as ConfiguredWorkspaceModel,
  };
}

function createGroupTreeEntry(
  workspaceTreeEntry: WorkspaceTreeEntry,
  nodeId = "group",
  parentId?: string,
): NodeTreeEntry {
  return {
    kind: "node",
    workspaceModel: workspaceTreeEntry.workspaceModel as ConfiguredWorkspaceModel,
    treeNode: {
      kind: "group",
      id: nodeId,
      name: nodeId,
      parentId,
      children: [],
      cwd: "/tmp",
      env: {},
      restartPolicy: "manual",
    },
  };
}

function createDeferredPromise() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });

  return { promise, resolve };
}
