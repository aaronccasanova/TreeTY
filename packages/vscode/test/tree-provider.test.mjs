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

function createTreeProviderFixture(options = {}) {
  const vscode = {
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    TreeItem: class {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: { None: 0, Expanded: 2 },
    ThemeIcon: class {
      constructor(id, color) {
        this.id = id;
        this.color = color;
      }
    },
    ThemeColor: class {
      constructor(id) { this.id = id; }
    },
    Uri: { from: components => components },
    workspace: {
      getConfiguration: section => ({
        get: (key, fallback) => options.configuration?.[`${section}.${key}`] ?? fallback,
      }),
    },
  };
  const treeProviderModule = new module.Module(path.join(testDirPath, "tree-provider-fixture.cjs"));
  const require = module.createRequire(import.meta.url);

  treeProviderModule.require = name => name === "vscode" ? vscode : name === "@treety/core" ? {} : require(name);
  treeProviderModule._compile(treeProviderCode, path.join(testDirPath, "tree-provider-fixture.cjs"));

  const treeProvider = new treeProviderModule.exports.TreeTYTreeProvider({
    onDidChangeWorkspaceModels: () => ({ dispose() {} }),
    getTerminalSessionState: () => options.terminalSessionState ?? { status: "running" },
  });
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
      resolvedTreeConfig: { workspaceDirPath: path.join(testDirPath, "workspace") },
      vscodeTerminalHost: {
        getSessionRecoveryMessage: () => options.recoveryMessage,
        getSessionActivity: () => options.terminalActivity ?? { state: "unknown", showSpinner: false },
      },
    },
  };

  return { treeProvider, nodeTreeEntry };
}
