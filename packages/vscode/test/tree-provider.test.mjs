import * as assert from "node:assert/strict";
import * as module from "node:module";
import * as path from "node:path";
import * as nodeTest from "node:test";
import * as url from "node:url";

import { buildSync } from "esbuild";

const testDirPath = path.dirname(url.fileURLToPath(import.meta.url));
const treeProviderCode = buildSync({
  entryPoints: [path.join(testDirPath, "../src/tree-provider.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode", "@treety/core"],
  write: false,
}).outputFiles[0].text;

nodeTest.test("terminal rows omit descriptions while exposing every status and activity to assistive technology", () => {
  for (const status of ["stopped", "starting", "idle", "running", "failed"]) {
    for (const state of ["unknown", "idle", "busy"]) {
      const treeProviderFixture = createTreeProviderFixture({
        terminalSessionState: { status, exitCode: status === "failed" ? 1 : undefined },
        terminalActivity: { state, showSpinner: false },
      });
      const terminalTreeItem = treeProviderFixture.treeProvider.getTreeItem(treeProviderFixture.nodeTreeEntry);

      assert.equal(terminalTreeItem.label, "Service logs");
      assert.equal(terminalTreeItem.description, undefined);
      assert.equal(terminalTreeItem.accessibilityInformation.label, `Service logs, status: ${status}, activity: ${state}`);
      assert.ok(terminalTreeItem.tooltip.includes(`Status: ${status}\nActivity: ${state}\n`));
      assert.ok(terminalTreeItem.tooltip.includes("Working directory:"));
      assert.ok(terminalTreeItem.tooltip.includes("Node ID: service-logs"));

      if (status === "failed") assert.ok(terminalTreeItem.tooltip.includes("Exit code: 1"));

      treeProviderFixture.treeProvider.dispose();
    }
  }
});

nodeTest.test("recovery explanations appear in tooltips without changing terminal names or descriptions", () => {
  const recoveryMessage = "A previous terminal session could not be recovered.";
  const fixture = createTreeProviderFixture({ recoveryMessage });
  const terminalTreeItem = fixture.treeProvider.getTreeItem(fixture.nodeTreeEntry);

  assert.equal(terminalTreeItem.label, "Service logs");
  assert.equal(terminalTreeItem.description, undefined);
  assert.ok(terminalTreeItem.tooltip.includes(recoveryMessage));
  fixture.treeProvider.dispose();
});

nodeTest.test("busy terminals keep the native spinner and static animation alternatives", () => {
  for (const configuration of [
    {},
    { "treety.activityAnimation": "off" },
    { "terminal.integrated.tabs.enableAnimation": false },
    { "workbench.reduceMotion": "on" },
  ]) {
    const treeProviderFixture = createTreeProviderFixture({
      terminalActivity: { state: "busy", showSpinner: true },
      configuration,
    });
    const terminalTreeItem = treeProviderFixture.treeProvider.getTreeItem(treeProviderFixture.nodeTreeEntry);

    assert.equal(terminalTreeItem.iconPath.id, Object.keys(configuration).length === 0 ? "loading~spin" : "circle-filled");
    assert.equal(terminalTreeItem.description, undefined);
    assert.ok(terminalTreeItem.accessibilityInformation.label.includes("activity: busy"));
    assert.ok(terminalTreeItem.tooltip.includes("Activity: busy"));
    treeProviderFixture.treeProvider.dispose();
  }
});

nodeTest.test("workspace and configuration messages retain their meaningful descriptions", () => {
  const treeProviderFixture = createTreeProviderFixture();
  const workspaceTreeItem = treeProviderFixture.treeProvider.getTreeItem({
    kind: "workspace",
    workspaceModel: treeProviderFixture.nodeTreeEntry.workspaceModel,
  });

  assert.equal(workspaceTreeItem.description, "workspace");

  const globalWorkspaceTreeItem = treeProviderFixture.treeProvider.getTreeItem({
    kind: "workspace",
    workspaceModel: { ...treeProviderFixture.nodeTreeEntry.workspaceModel, configSource: "global" },
  });

  assert.equal(globalWorkspaceTreeItem.description, "global");

  for (const configSource of ["workspace", "global"]) {
    const messageTreeItem = treeProviderFixture.treeProvider.getTreeItem({
      kind: "message",
      workspaceModel: { kind: "unconfigured", configSource },
    });

    assert.equal(messageTreeItem.description, configSource === "global" ? "Create the global tree" : "Create .treety/tree.json");
  }

  const errorTreeItem = treeProviderFixture.treeProvider.getTreeItem({
    kind: "message",
    workspaceModel: { kind: "invalid", errorMessage: "Invalid terminal configuration" },
  });

  assert.equal(errorTreeItem.description, "Invalid terminal configuration");
  treeProviderFixture.treeProvider.dispose();
});

nodeTest.test("configuration additions refresh only the loaded parent and preserve sibling entries and decorations", () => {
  const fixture = createTreeProviderFixture();
  const workspaceModel = fixture.nodeTreeEntry.workspaceModel;
  workspaceModel.resolvedTreeConfig.tree = [
    createGroup("alpha", [createGroup("inner", [createTerminal("alert", true)])]),
    createGroup("beta"),
  ];
  fixture.emitWorkspaceModelChange({ kind: "workspace" });
  const root = fixture.treeProvider.getChildren()[0];
  const [alpha, beta] = fixture.treeProvider.getChildren(root);
  const inner = fixture.treeProvider.getChildren(alpha)[0];
  const treeChanges = [];
  const decorationChanges = [];
  fixture.treeProvider.onDidChangeTreeData(change => treeChanges.push(change));
  fixture.treeProvider.onDidChangeFileDecorations(change => decorationChanges.push(change));

  workspaceModel.resolvedTreeConfig.tree = [
    structuredClone(alpha.treeNode), createGroup("beta", [createTerminal("new")]),
  ];
  fixture.emitWorkspaceModelChange({ kind: "configuration", workspaceId: "workspace", parentIds: ["beta"], nodeIds: [] });

  assert.deepEqual(treeChanges, [beta]);
  assert.deepEqual(decorationChanges, []);
  assert.equal(fixture.treeProvider.getChildren()[0], root);
  assert.equal(fixture.treeProvider.getChildren(root)[0], alpha);
  assert.equal(fixture.treeProvider.getChildren(alpha)[0], inner);
  assert.equal(fixture.treeProvider.getChildren(beta)[0].treeNode.id, "new");

  treeChanges.length = 0;
  fixture.emitWorkspaceModelChange({ kind: "configuration", workspaceId: "workspace", parentIds: [], nodeIds: [] });

  assert.deepEqual(treeChanges, []);
  assert.deepEqual(decorationChanges, []);
  fixture.treeProvider.dispose();
});

nodeTest.test("root edits refresh one workspace and rename updates use the existing row with current data", () => {
  const fixture = createTreeProviderFixture();
  const workspaceModel = fixture.nodeTreeEntry.workspaceModel;
  workspaceModel.resolvedTreeConfig.tree = [createGroup("alpha")];
  const secondWorkspaceModel = { ...workspaceModel, id: "second" };
  fixture.workspaceModels.push(secondWorkspaceModel);
  fixture.emitWorkspaceModelChange({ kind: "workspace" });
  const [root, secondRoot] = fixture.treeProvider.getChildren();
  const alpha = fixture.treeProvider.getChildren(root)[0];
  const treeChanges = [];
  fixture.treeProvider.onDidChangeTreeData(change => treeChanges.push(change));

  workspaceModel.resolvedTreeConfig = { ...workspaceModel.resolvedTreeConfig, tree: [{ ...createGroup("alpha"), name: "Renamed" }] };
  fixture.emitWorkspaceModelChange({ kind: "configuration", workspaceId: "workspace", parentIds: [], nodeIds: ["alpha"] });

  assert.deepEqual(treeChanges, [alpha]);
  assert.equal(fixture.treeProvider.getTreeItem(alpha).label, "Renamed");
  assert.equal(fixture.treeProvider.getChildren()[1], secondRoot);

  treeChanges.length = 0;
  workspaceModel.resolvedTreeConfig.tree.push(createTerminal("top-level"));
  fixture.emitWorkspaceModelChange({ kind: "configuration", workspaceId: "workspace", parentIds: [undefined], nodeIds: [] });

  assert.deepEqual(treeChanges, [root]);
  fixture.treeProvider.dispose();
});

nodeTest.test("attention moves invalidate only changed ancestor URIs and deletion removes old decorations", () => {
  const fixture = createTreeProviderFixture();
  const workspaceModel = fixture.nodeTreeEntry.workspaceModel;
  workspaceModel.resolvedTreeConfig.tree = [createGroup("alpha", [createTerminal("alert", true)]), createGroup("beta")];
  fixture.emitWorkspaceModelChange({ kind: "workspace" });
  const decorationChanges = [];
  fixture.treeProvider.onDidChangeFileDecorations(change => decorationChanges.push(change.map(uri => uri.path)));

  workspaceModel.resolvedTreeConfig.tree = [createGroup("alpha"), createGroup("beta", [createTerminal("alert", true)])];
  fixture.emitWorkspaceModelChange({ kind: "configuration", workspaceId: "workspace", parentIds: ["alpha", "beta"], nodeIds: [] });

  assert.deepEqual(decorationChanges, [["/workspace/alpha", "/workspace/beta"]]);

  decorationChanges.length = 0;
  fixture.emitWorkspaceModelChange({ kind: "workspace" });
  assert.deepEqual(decorationChanges, []);

  workspaceModel.resolvedTreeConfig.tree = [createGroup("alpha"), createGroup("beta")];
  fixture.emitWorkspaceModelChange({ kind: "configuration", workspaceId: "workspace", parentIds: ["beta"], nodeIds: [] });

  assert.deepEqual(decorationChanges, [["/workspace/beta", "/workspace/alert"]]);
  assert.equal(fixture.treeProvider.provideFileDecoration({ scheme: "treety", path: "/workspace/alert" }), undefined);
  fixture.treeProvider.dispose();
});

nodeTest.test("attention changes refresh current terminal entries without refreshing groups", () => {
  const fixture = createTreeProviderFixture();
  const workspaceModel = fixture.nodeTreeEntry.workspaceModel;
  workspaceModel.resolvedTreeConfig.tree = [createGroup("alpha", [createTerminal("alert")])];
  fixture.emitWorkspaceModelChange({ kind: "workspace" });
  const alpha = fixture.treeProvider.getChildren(fixture.treeProvider.getChildren()[0])[0];
  const alert = fixture.treeProvider.getChildren(alpha)[0];
  const treeChanges = [];
  const decorationChanges = [];
  fixture.treeProvider.onDidChangeTreeData(change => treeChanges.push(change));
  fixture.treeProvider.onDidChangeFileDecorations(change => decorationChanges.push(change.map(uri => uri.path)));

  workspaceModel.resolvedTreeConfig.tree = [createGroup("alpha", [createTerminal("alert", true)])];
  fixture.emitWorkspaceModelChange({ kind: "attention", workspaceId: "workspace", nodeIds: ["alpha", "alert"] });

  assert.deepEqual(treeChanges, [alert]);
  assert.equal(alert.treeNode.needsAttention, true);
  assert.deepEqual(decorationChanges, [["/workspace/alpha", "/workspace/alert"]]);
  fixture.treeProvider.dispose();
});

nodeTest.test("saved collapse survives refresh and provider recreation, including never-loaded descendants", async () => {
  const savedValues = new Map();
  const workspaceState = {
    get: key => savedValues.get(key),
    update: async (key, value) => { savedValues.set(key, value); },
  };
  const fixture = createTreeProviderFixture({ workspaceState });
  fixture.nodeTreeEntry.workspaceModel.resolvedTreeConfig.tree = [createGroup("alpha", [createGroup("inner", [createGroup("deep")])])];
  const root = fixture.treeProvider.getChildren()[0];
  const alpha = fixture.treeProvider.getChildren(root)[0];

  assert.equal(fixture.treeProvider.getTreeItem(alpha).collapsibleState, 2);
  await fixture.treeProvider.collapseAll();
  await fixture.treeProvider.setExpanded(root, true);
  fixture.emitWorkspaceModelChange({ kind: "workspace" });

  const refreshedAlpha = fixture.treeProvider.getChildren(fixture.treeProvider.getChildren()[0])[0];
  assert.equal(fixture.treeProvider.getTreeItem(refreshedAlpha).collapsibleState, 1);
  await fixture.treeProvider.setExpanded(refreshedAlpha, true);
  const inner = fixture.treeProvider.getChildren(refreshedAlpha)[0];
  assert.equal(fixture.treeProvider.getTreeItem(inner).collapsibleState, 1);

  const restoredFixture = createTreeProviderFixture({ workspaceState });
  restoredFixture.nodeTreeEntry.workspaceModel.resolvedTreeConfig = fixture.nodeTreeEntry.workspaceModel.resolvedTreeConfig;
  const restoredRoot = restoredFixture.treeProvider.getChildren()[0];
  const restoredAlpha = restoredFixture.treeProvider.getChildren(restoredRoot)[0];
  const restoredInner = restoredFixture.treeProvider.getChildren(restoredAlpha)[0];

  assert.equal(restoredFixture.treeProvider.getTreeItem(restoredRoot).collapsibleState, 2);
  assert.equal(restoredFixture.treeProvider.getTreeItem(restoredAlpha).collapsibleState, 2);
  assert.equal(restoredFixture.treeProvider.getTreeItem(restoredInner).collapsibleState, 1);
  assert.equal(restoredFixture.treeProvider.getTreeItem(restoredFixture.treeProvider.getChildren(restoredInner)[0]).collapsibleState, 1);
  fixture.treeProvider.dispose();
  restoredFixture.treeProvider.dispose();
});

function createGroup(id, children = []) {
  return { kind: "group", id, name: id, cwd: "/workspace", children };
}

function createTerminal(id, needsAttention = false) {
  return { kind: "terminal", id, name: id, cwd: "/workspace", needsAttention };
}

function createTreeProviderFixture(options = {}) {
  const vscode = {
    EventEmitter: class {
      listeners = new Set();
      event = (listener) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
      fire(value) { for (const listener of this.listeners) listener(value); }
      dispose() { this.listeners.clear(); }
    },
    TreeItem: class {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {
      constructor(id, color) {
        this.id = id;
        this.color = color;
      }
    },
    ThemeColor: class {
      constructor(id) { this.id = id; }
    },
    FileDecoration: class {
      constructor(badge, tooltip, color) { Object.assign(this, { badge, tooltip, color }); }
    },
    Uri: { from: components => ({ ...components, toString() { return `${this.scheme}:${this.path}`; } }) },
    workspace: {
      getConfiguration: section => ({
        get: (key, fallback) => options.configuration?.[`${section}.${key}`] ?? fallback,
      }),
    },
  };
  const treeProviderModule = new module.Module(path.join(testDirPath, "tree-provider-fixture.cjs"));
  const require = module.createRequire(import.meta.url);

  treeProviderModule.require = name => name === "vscode" ? vscode : name === "@treety/core" ? { getTreeNodeNeedsAttention } : require(name);
  treeProviderModule._compile(treeProviderCode, path.join(testDirPath, "tree-provider-fixture.cjs"));

  const nodeTreeEntry = {
    kind: "node",
    treeNode: {
      kind: "terminal",
      id: "service-logs",
      name: "Service logs",
      cwd: path.join(testDirPath, "workspace"),
    },
    workspaceModel: {
      kind: "configured",
      id: "workspace",
      name: "Workspace",
      configSource: "workspace",
      configFileUri: { fsPath: path.join(testDirPath, "workspace/.treety/tree.json") },
      treeState: { version: 1, nodes: {} },
      resolvedTreeConfig: { workspaceDirPath: path.join(testDirPath, "workspace"), tree: [] },
      vscodeTerminalHost: {
        getSessionRecoveryMessage: () => options.recoveryMessage,
        getSessionActivity: () => options.terminalActivity ?? { state: "unknown", showSpinner: false },
      },
    },
  };

  const workspaceModels = [nodeTreeEntry.workspaceModel];
  const workspaceModelChangeEmitter = new vscode.EventEmitter();
  const treeProvider = new treeProviderModule.exports.TreeTYTreeProvider({
    onDidChangeWorkspaceModels: workspaceModelChangeEmitter.event,
    getWorkspaceModels: () => workspaceModels,
    getTerminalSessionState: () => options.terminalSessionState ?? { status: "running" },
  }, options.workspaceState);

  return {
    treeProvider, nodeTreeEntry, workspaceModels,
    emitWorkspaceModelChange: (change) => workspaceModelChangeEmitter.fire(change),
  };
}

function getTreeNodeNeedsAttention(treeNode) {
  return treeNode.kind === "terminal" ? Boolean(treeNode.needsAttention) : treeNode.children.some(getTreeNodeNeedsAttention);
}
