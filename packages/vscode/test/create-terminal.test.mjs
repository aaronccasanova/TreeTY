import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as module from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as nodeTest from "node:test";
import * as url from "node:url";

import * as core from "@treety/core";
import { buildSync } from "esbuild";

const testDirPath = path.dirname(url.fileURLToPath(import.meta.url));
const controllerCode = buildSync({
  entryPoints: [path.join(testDirPath, "../src/controller.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode", "@treety/core"],
  write: false,
}).outputFiles[0].text;

nodeTest.test("saves and refreshes a new nested leaf before revealing it and focusing its terminal", async (testContext) => {
  const fixture = await createFixture(testContext);
  const revealStarted = createDeferred();
  const revealFinished = createDeferred();
  let revealedNodeTreeEntry;

  fixture.controller.revealNode = async (nodeTreeEntry) => {
    revealedNodeTreeEntry = nodeTreeEntry;
    fixture.calls.push("reveal");
    revealStarted.resolve();
    await revealFinished.promise;
  };

  const creating = fixture.controller.createTerminal(fixture.groupTreeEntry);

  await revealStarted.promise;
  assert.deepEqual(fixture.calls, ["refresh", "reveal"]);
  assert.equal(revealedNodeTreeEntry.treeNode.parentId, "group");
  assert.equal(revealedNodeTreeEntry.treeNode.name, "Shell");
  assert.equal(revealedNodeTreeEntry.treeNode.env.EXAMPLE, "inherited");

  const treeConfig = await core.loadTreeConfigFile(fixture.configFilePath);

  assert.equal(core.getTreeNode(treeConfig, revealedNodeTreeEntry.treeNode.id).name, "Shell");
  assert.deepEqual(treeConfig.tree[0].metadata, { description: "Project terminals" });
  revealFinished.resolve();
  await creating;
  assert.deepEqual(fixture.calls, ["refresh", "reveal", "launch", "focus"]);
});

nodeTest.test("creates at the root and still opens the terminal when revealing the tree fails", async (testContext) => {
  const fixture = await createFixture(testContext);

  fixture.controller.revealNode = async (nodeTreeEntry) => {
    assert.equal(nodeTreeEntry.treeNode.parentId, undefined);
    fixture.calls.push("reveal");
    throw new Error("tree unavailable");
  };

  await assert.rejects(fixture.controller.createTerminal(), /tree unavailable/);
  assert.deepEqual(fixture.calls, ["refresh", "reveal", "launch", "focus"]);
});

nodeTest.test("uses the current model if a workspace reload replaces it during reveal", async (testContext) => {
  const fixture = await createFixture(testContext);
  const replacementStarted = createDeferred();
  const replacementFinished = createDeferred();

  fixture.controller.revealNode = async () => {
    void fixture.controller.queueWorkspaceOperation(async () => {
      replacementStarted.resolve();
      await replacementFinished.promise;
      fixture.controller.workspaceModels = [{
        ...fixture.workspaceModel,
        treeTYEngine: {
          openTerminal: async () => { fixture.calls.push("focus replacement"); },
        },
      }];
    });
  };

  const creating = fixture.controller.createTerminal();

  await replacementStarted.promise;
  assert.deepEqual(fixture.calls, ["refresh"]);
  replacementFinished.resolve();
  await creating;
  assert.deepEqual(fixture.calls, ["refresh", "focus replacement"]);
});

nodeTest.test("cancellation, invalid configuration, and a removed parent never reveal or open a terminal", async (testContext) => {
  const fixture = await createFixture(testContext);

  fixture.vscode.window.showInputBox = async () => undefined;
  await fixture.controller.createTerminal();
  assert.deepEqual(fixture.calls, []);

  fixture.vscode.window.showInputBox = async () => "Shell";
  await fs.writeFile(fixture.configFilePath, "invalid JSON");
  await assert.rejects(fixture.controller.createTerminal());
  assert.deepEqual(fixture.calls, []);

  await fs.writeFile(fixture.configFilePath, JSON.stringify(core.createEmptyTreeConfig()));
  await assert.rejects(fixture.controller.createTerminal(fixture.groupTreeEntry), /does not exist/);
  assert.deepEqual(fixture.calls, []);
});

nodeTest.test("a leaf removed during reveal is never launched", async (testContext) => {
  const fixture = await createFixture(testContext);

  fixture.controller.revealNode = async (nodeTreeEntry) => {
    fixture.workspaceModel.resolvedTreeConfig.tree = fixture.workspaceModel.resolvedTreeConfig.tree.filter(
      (treeNode) => treeNode.id !== nodeTreeEntry.treeNode.id,
    );
  };

  await assert.rejects(fixture.controller.createTerminal(), /no longer available/);
  assert.deepEqual(fixture.calls, ["refresh"]);
});

nodeTest.test("reports launch failures while keeping the saved leaf", async (testContext) => {
  const fixture = await createFixture(testContext);

  fixture.terminalHost.createSession = async () => { throw new Error("launch failed"); };

  await assert.rejects(fixture.controller.createTerminal(), /launch failed/);

  const treeConfig = await core.loadTreeConfigFile(fixture.configFilePath);

  assert.equal(treeConfig.tree[1].name, "Shell");
  assert.deepEqual(fixture.calls, ["refresh", "reveal"]);
});

nodeTest.test("group creation and background configuration changes never reveal or focus a terminal", async (testContext) => {
  const fixture = await createFixture(testContext);

  await fixture.controller.createGroup();
  assert.deepEqual(fixture.calls, ["refresh"]);

  await core.mutateTreeConfigFile(fixture.configFilePath, (treeConfig) =>
    core.addTreeTerminal(treeConfig, { name: "Background shell" }),
  );
  await fixture.controller.queueWorkspaceOperation(() =>
    fixture.controller.reconcileWorkspace(fixture.workspaceModel.configFileUri, "config"),
  );
  assert.deepEqual(fixture.calls, ["refresh", "refresh"]);
});

async function createFixture(testContext) {
  const workspaceDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-create-terminal-"));

  testContext.after(() => fs.rm(workspaceDirPath, { recursive: true, force: true }));

  const configFilePath = path.join(workspaceDirPath, "tree.json");
  const treeConfig = core.addTreeGroup(core.createEmptyTreeConfig(), {
    id: "group",
    name: "Project",
    env: { EXAMPLE: "inherited" },
    metadata: { description: "Project terminals" },
  });

  await core.writeTreeConfigFile(configFilePath, treeConfig);

  const calls = [];
  const terminalHost = {
    createSession: async (terminalLaunchRequest) => {
      calls.push("launch");

      return { id: "session", nodeId: terminalLaunchRequest.nodeId };
    },
    revealSession: () => { calls.push("focus"); },
    closeSession() {},
    updateActivity() {},
    dispose() {},
  };
  const resolvedTreeConfig = core.resolveTreeConfig(treeConfig, workspaceDirPath);
  const treeTYEngine = new core.TreeTYEngine(resolvedTreeConfig, terminalHost);

  testContext.after(() => treeTYEngine.dispose());

  const workspaceModel = {
    kind: "configured",
    id: "workspace",
    name: "Workspace",
    configFileUri: createFileUri(configFilePath),
    workspaceDirUri: createFileUri(workspaceDirPath),
    treeConfig,
    treeState: { version: 1, nodes: {} },
    resolvedTreeConfig,
    treeTYEngine,
    vscodeTerminalHost: terminalHost,
  };
  const vscode = {
    workspace: {
      fs: {
        readFile: (uri) => fs.readFile(uri.fsPath),
        stat: (uri) => fs.stat(uri.fsPath),
      },
      getConfiguration: () => ({ get: (_name, defaultValue) => defaultValue }),
    },
    window: { showInputBox: async () => " Shell " },
  };
  const controllerModule = new module.Module(path.join(testDirPath, "controller-fixture.cjs"));
  const require = module.createRequire(import.meta.url);

  controllerModule.require = (name) => name === "vscode" ? vscode : require(name);
  controllerModule._compile(controllerCode, path.join(testDirPath, "controller-fixture.cjs"));

  // Exercise the controller's commands and reconciliation without native watchers.
  const controller = Object.create(controllerModule.exports.TreeTYController.prototype);

  controller.workspaceModels = [workspaceModel];
  controller.workspaceReloadPromise = Promise.resolve();
  controller.workspaceModelChangeEmitter = { fire: () => { calls.push("refresh"); } };
  controller.revealNode = async () => { calls.push("reveal"); };

  return {
    controller,
    workspaceModel,
    terminalHost,
    vscode,
    calls,
    configFilePath,
    groupTreeEntry: { kind: "node", workspaceModel, treeNode: resolvedTreeConfig.tree[0] },
  };
}

function createFileUri(filePath) {
  return { fsPath: filePath, toString: () => url.pathToFileURL(filePath).toString() };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => { resolve = promiseResolve; });

  return { promise, resolve };
}
