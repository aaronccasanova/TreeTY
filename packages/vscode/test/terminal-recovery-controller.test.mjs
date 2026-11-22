import * as assert from "node:assert/strict";
import * as module from "node:module";
import * as path from "node:path";
import * as nodeTest from "node:test";
import * as url from "node:url";

import { buildSync } from "esbuild";

const testDirPath = path.dirname(url.fileURLToPath(import.meta.url));
const controllerBundle = buildSync({
  stdin: {
    contents: [
      'export { TreeTYController } from "./controller";',
      'export { TerminalRecoveryError } from "./vscode-terminal-host";',
    ].join("\n"),
    resolveDir: path.join(testDirPath, "../src"),
    sourcefile: "terminal-recovery-controller-fixture.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode", "@treety/core"],
  write: false,
});

nodeTest.test("opening an unresolved session explains recovery and cancellation never permits creation", async () => {
  const fixture = createFixture();

  await fixture.controller.openTerminal(fixture.nodeTreeEntry);

  assert.deepEqual(fixture.calls, ["attention", "open", "warning"]);
  assert.equal(fixture.warnings.length, 1);
  assert.match(fixture.warnings[0][0], /Could not recover the previous session for "Shell"/);
  assert.equal(fixture.warnings[0][1].modal, true);
  assert.match(fixture.warnings[0][1].detail, /including in other windows/);
  assert.match(fixture.warnings[0][1].detail, /without closing any existing terminal/);
  assert.match(fixture.warnings[0][1].detail, /VS Code may still restore the old terminal later/);
  assert.equal(fixture.warnings[0][2], "Forget previous session and start");
  assert.equal(fixture.allowedNodeIds.size, 0);
});

nodeTest.test("opening a session with a known conflict never offers to forget it", async () => {
  const fixture = createFixture(false);

  fixture.warningChoice = "Forget previous session and start";

  await assert.rejects(fixture.controller.openTerminal(fixture.nodeTreeEntry), /unresolved session/);

  assert.deepEqual(fixture.calls, ["attention", "open"]);
  assert.equal(fixture.warnings.length, 0);
  assert.equal(fixture.allowedNodeIds.size, 0);
});

nodeTest.test("restarting a session with a known conflict never offers to forget it", async () => {
  const fixture = createFixture(false);

  fixture.warningChoice = "Forget previous session and start";

  await assert.rejects(fixture.controller.restartTerminal(fixture.nodeTreeEntry), /unresolved session/);

  assert.deepEqual(fixture.calls, ["attention", "restart"]);
  assert.equal(fixture.warnings.length, 0);
  assert.equal(fixture.allowedNodeIds.size, 0);
});

nodeTest.test("confirmation allows one new launch and revokes the permission afterward", async () => {
  const fixture = createFixture();

  fixture.warningChoice = "Forget previous session and start";
  await fixture.controller.openTerminal(fixture.nodeTreeEntry);

  assert.deepEqual(fixture.calls, [
    "attention", "open", "warning", "allow", "open", "create", "revoke", "sync",
  ]);
  assert.equal(fixture.allowedNodeIds.size, 0);

  await assert.rejects(fixture.workspaceModel.treeTYEngine.openTerminal("shell"), /unresolved session/);
  assert.equal(fixture.calls.filter((call) => call === "create").length, 1);
});

nodeTest.test("confirmation revokes unused permission when the session recovers during the prompt", async () => {
  const fixture = createFixture();

  fixture.vscode.window.showWarningMessage = async () => {
    fixture.workspaceModel.treeTYEngine.openTerminal = async () => {
      fixture.calls.push("reveal recovered");

      return true;
    };

    return "Forget previous session and start";
  };

  await fixture.controller.openTerminal(fixture.nodeTreeEntry);

  assert.deepEqual(fixture.calls, ["attention", "open", "allow", "reveal recovered", "revoke", "sync"]);
  assert.equal(fixture.allowedNodeIds.size, 0);
});

nodeTest.test("confirmation revokes permission after a failed retry and skips Explorer sync", async () => {
  const fixture = createFixture();

  fixture.vscode.window.showWarningMessage = async () => {
    fixture.workspaceModel.treeTYEngine.openTerminal = async () => {
      fixture.calls.push("failed retry");
      throw new Error("launch failed");
    };

    return "Forget previous session and start";
  };

  await assert.rejects(fixture.controller.openTerminal(fixture.nodeTreeEntry), /launch failed/);

  assert.deepEqual(fixture.calls, ["attention", "open", "allow", "failed retry", "revoke"]);
  assert.equal(fixture.allowedNodeIds.size, 0);
});

nodeTest.test("confirmation resolves the current workspace model before allowing a launch", async () => {
  const fixture = createFixture();
  const replacementFixture = createFixture();

  fixture.vscode.window.showWarningMessage = async () => {
    fixture.controller.workspaceModels = [replacementFixture.workspaceModel];

    return "Forget previous session and start";
  };

  await fixture.controller.openTerminal(fixture.nodeTreeEntry);

  assert.deepEqual(fixture.calls, ["attention", "open", "sync"]);
  assert.deepEqual(replacementFixture.calls, ["allow", "open", "create", "revoke"]);
  assert.equal(fixture.allowedNodeIds.size, 0);
  assert.equal(replacementFixture.allowedNodeIds.size, 0);
});

nodeTest.test("confirmation rejects a node removed while the prompt was open", async () => {
  const fixture = createFixture();

  fixture.vscode.window.showWarningMessage = async () => {
    fixture.workspaceModel.resolvedTreeConfig.tree = [];

    return "Forget previous session and start";
  };

  await assert.rejects(fixture.controller.openTerminal(fixture.nodeTreeEntry), /no longer available/);

  assert.deepEqual(fixture.calls, ["attention", "open"]);
  assert.equal(fixture.allowedNodeIds.size, 0);
});

nodeTest.test("cancelling an unresolved restart skips Explorer sync", async () => {
  const fixture = createFixture();

  await fixture.controller.restartTerminal(fixture.nodeTreeEntry);

  assert.deepEqual(fixture.calls, ["attention", "restart", "warning"]);
  assert.equal(fixture.allowedNodeIds.size, 0);
});

nodeTest.test("deactivation disposes once and waits for every configured host cleanup", async () => {
  const fixture = createFixture();
  const otherFixture = createFixture();
  let finishCleanup;
  const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  let didDeactivate = false;

  fixture.controller.workspaceModels.push({ kind: "unconfigured" }, otherFixture.workspaceModel);
  fixture.controller.vscodeTerminalHosts.add(otherFixture.workspaceModel.vscodeTerminalHost);
  fixture.workspaceModel.vscodeTerminalHost.flushSessionCleanup = async () => {
    fixture.calls.push("flush");
    await cleanup;
  };
  otherFixture.workspaceModel.vscodeTerminalHost.flushSessionCleanup = async () => {
    otherFixture.calls.push("flush");
  };

  const deactivation = fixture.controller.deactivate();

  assert.equal(fixture.controller.deactivate(), deactivation);
  void deactivation.then(() => { didDeactivate = true; });
  fixture.controller.dispose();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(didDeactivate, false);
  assert.deepEqual(fixture.calls, ["dispose engine", "dispose subscriptions", "dispose emitter", "flush"]);
  assert.deepEqual(otherFixture.calls, ["dispose engine", "flush"]);

  finishCleanup();
  await deactivation;
  assert.equal(didDeactivate, true);
  assert.equal(fixture.calls.at(-1), "shutdown recovery");
  assert.equal(fixture.calls.filter(call => call === "shutdown recovery").length, 1);
});

nodeTest.test("deactivation flushes after subscription disposal and waits for other hosts before reporting errors", async () => {
  const fixture = createFixture();
  const otherFixture = createFixture();
  let finishCleanup;
  const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  let didReject = false;

  fixture.controller.workspaceModels.push(otherFixture.workspaceModel);
  fixture.controller.vscodeTerminalHosts.add(otherFixture.workspaceModel.vscodeTerminalHost);
  fixture.workspaceModel.vscodeTerminalHost.flushSessionCleanup = async () => {
    fixture.calls.push("flush");
    throw new Error("cleanup failed");
  };
  otherFixture.workspaceModel.vscodeTerminalHost.flushSessionCleanup = async () => {
    otherFixture.calls.push("flush");
    await cleanup;
  };
  fixture.controller.dispose();

  const deactivation = fixture.controller.deactivate();

  void deactivation.catch(() => { didReject = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(didReject, false);
  assert.deepEqual(otherFixture.calls, ["dispose engine", "flush"]);

  finishCleanup();
  await assert.rejects(deactivation, error => {
    assert.ok(error instanceof AggregateError);
    assert.match(String(error.errors[0]), /cleanup failed/);

    return true;
  });
  assert.equal(fixture.calls.filter(call => call === "dispose engine").length, 1);
  assert.equal(fixture.calls.at(-1), "shutdown recovery");
});

nodeTest.test("deactivation stops a workspace load paused before host creation and skips queued reloads", async () => {
  const fixture = createFixture();
  let finishReading;
  let didRead = false;
  let loadedWorkspaceModel;
  const fileRead = new Promise(resolve => { finishReading = resolve; });

  fixture.vscode.workspace = { fs: { readFile: async () => { didRead = true; return await fileRead; } } };
  const workspaceModelLocation = {
    id: "loading", configFileUri: { fsPath: "/tmp/tree.json" }, workspaceDirUri: { fsPath: "/tmp" },
  };
  const workspaceLoad = fixture.controller.queueWorkspaceOperation(async () => {
    loadedWorkspaceModel = await fixture.controller.loadWorkspaceModel(workspaceModelLocation);
  });
  const queuedReload = fixture.controller.queueWorkspaceOperation(async () => { fixture.calls.push("unexpected reload"); });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(didRead, true);

  let didDeactivate = false;
  const deactivation = fixture.controller.deactivate().then(() => { didDeactivate = true; });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(didDeactivate, false);
  finishReading(new TextEncoder().encode("{}"));
  await Promise.all([workspaceLoad, queuedReload, deactivation]);

  assert.equal(loadedWorkspaceModel.kind, "unconfigured");
  assert.equal(fixture.calls.includes("unexpected reload"), false);
  await fixture.controller.queueWorkspaceOperation(async () => { fixture.calls.push("unexpected post-disposal work"); });
  assert.equal(fixture.calls.includes("unexpected post-disposal work"), false);
});

nodeTest.test("deactivation disposes and flushes loading and retiring hosts outside installed models", async () => {
  const fixture = createFixture();
  let finishCleanup;
  const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  const loadingHost = {
    dispose() { fixture.calls.push("dispose loading host"); },
    async flushSessionCleanup() { fixture.calls.push("flush loading host"); await cleanup; },
  };
  const retiringHost = {
    dispose() { fixture.calls.push("dispose retiring host"); },
    async flushSessionCleanup() { fixture.calls.push("flush retiring host"); await cleanup; },
  };

  fixture.controller.vscodeTerminalHosts.add(loadingHost);
  fixture.controller.vscodeTerminalHosts.add(retiringHost);
  fixture.controller.disposeTerminalHost(retiringHost);

  let didDeactivate = false;
  const deactivation = fixture.controller.deactivate().then(() => { didDeactivate = true; });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(didDeactivate, false);
  assert.ok(fixture.calls.includes("dispose loading host"));
  assert.ok(fixture.calls.includes("flush loading host"));
  assert.ok(fixture.controller.vscodeTerminalHosts.has(retiringHost));

  finishCleanup();
  await deactivation;
  assert.equal(fixture.controller.vscodeTerminalHosts.has(retiringHost), false);
});

nodeTest.test("scripted stop preserves confirmation and reports cancellation", async () => {
  const fixture = createFixture();

  fixture.vscode.workspace.getConfiguration = () => ({ get: () => true });
  fixture.workspaceModel.treeTYEngine.stopTerminal = () => fixture.calls.push("stop");

  assert.equal(await fixture.controller.stopTerminal(fixture.nodeTreeEntry), false);
  assert.deepEqual(fixture.calls, ["warning"]);
  fixture.warningChoice = "Stop terminal";
  assert.equal(await fixture.controller.stopTerminal(fixture.nodeTreeEntry), true);
  assert.deepEqual(fixture.calls, ["warning", "warning", "stop"]);
});

nodeTest.test("only an explicit false suppresses stop confirmation, and true overrides the setting", async () => {
  const fixture = createFixture();

  fixture.vscode.workspace.getConfiguration = () => ({ get: () => true });
  fixture.workspaceModel.treeTYEngine.stopTerminal = () => fixture.calls.push("stop");

  assert.equal(await fixture.controller.stopTerminal(fixture.nodeTreeEntry, false), true);
  assert.deepEqual(fixture.calls, ["stop"]);
  fixture.vscode.workspace.getConfiguration = () => ({ get: () => false });
  assert.equal(await fixture.controller.stopTerminal(fixture.nodeTreeEntry, true), false);
  assert.deepEqual(fixture.calls, ["stop", "warning"]);
});

nodeTest.test("stop revalidates a node removed during confirmation", async () => {
  const fixture = createFixture();

  fixture.vscode.workspace.getConfiguration = () => ({ get: () => true });
  fixture.workspaceModel.treeTYEngine.stopTerminal = () => fixture.calls.push("stop");
  fixture.vscode.window.showWarningMessage = async () => {
    fixture.workspaceModel.resolvedTreeConfig.tree = [];

    return "Stop terminal";
  };

  await assert.rejects(fixture.controller.stopTerminal(fixture.nodeTreeEntry), /no longer available/);
  assert.equal(fixture.calls.includes("stop"), false);
});

nodeTest.test("public lookup normalizes absolute config paths and validates session fences", async () => {
  const fixture = createFixture();
  const terminal = {};
  const targets = [];

  fixture.workspaceModel.configFileUri = { fsPath: "/tmp/tree.json" };
  fixture.workspaceModel.vscodeTerminalHost.getTerminal = async (target) => {
    targets.push(target);

    return terminal;
  };

  assert.equal(await fixture.controller.getTerminal({
    configFile: "/tmp/./tree.json", nodeId: "shell", sessionId: "session",
  }), terminal);
  assert.deepEqual(targets, [{ configFile: "/tmp/tree.json", nodeId: "shell", sessionId: "session" }]);
  assert.equal(await fixture.controller.getTerminal({ configFile: "/other/tree.json", nodeId: "shell" }), undefined);
  await assert.rejects(fixture.controller.getTerminal({ configFile: "tree.json", nodeId: "shell" }), /absolute/);
  await assert.rejects(fixture.controller.getTerminal({ configFile: "/tmp/tree.json", nodeId: "shell", sessionId: "" }), /nonempty/);
});

nodeTest.test("engine launch cancellation reaches the command caller without Explorer sync", async () => {
  const fixture = createFixture();

  fixture.workspaceModel.treeTYEngine.openTerminal = async () => false;
  fixture.workspaceModel.treeTYEngine.restartTerminal = async () => false;

  assert.equal(await fixture.controller.openTerminal(fixture.nodeTreeEntry), false);
  assert.equal(await fixture.controller.restartTerminal(fixture.nodeTreeEntry), false);
  assert.deepEqual(fixture.calls, ["attention", "attention"]);
});

function createFixture(recoveryCanForget = true) {
  const fixture = {
    calls: [],
    warnings: [],
    warningChoice: undefined,
    allowedNodeIds: new Set(),
  };
  const vscode = {
    workspace: {},
    window: {
      showWarningMessage: async (...warningArguments) => {
        fixture.calls.push("warning");
        fixture.warnings.push(warningArguments);

        return fixture.warningChoice;
      },
    },
  };
  const controllerModule = new module.Module(path.join(testDirPath, "terminal-recovery-controller-fixture.cjs"));
  const require = module.createRequire(import.meta.url);

  controllerModule.require = (name) => name === "vscode" ? vscode : require(name);
  controllerModule._compile(
    controllerBundle.outputFiles[0].text,
    path.join(testDirPath, "terminal-recovery-controller-fixture.cjs"),
  );

  const treeNode = {
    kind: "terminal",
    id: "shell",
    name: "Shell",
    cwd: "/workspace",
    env: {},
    needsAttention: false,
    restartPolicy: "manual",
  };
  const workspaceModel = {
    kind: "configured",
    id: "workspace",
    resolvedTreeConfig: { version: 1, workspaceDirPath: "/workspace", tree: [treeNode] },
    vscodeTerminalHost: {
      dispose() {},
      async flushSessionCleanup() {},
      allowNextSessionCreation(nodeId) {
        fixture.calls.push("allow");
        fixture.allowedNodeIds.add(nodeId);
      },
      revokeSessionCreation(nodeId) {
        fixture.calls.push("revoke");
        fixture.allowedNodeIds.delete(nodeId);
      },
    },
    treeTYEngine: {
      dispose() { fixture.calls.push("dispose engine"); },
      async openTerminal(nodeId) {
        fixture.calls.push("open");

        if (!fixture.allowedNodeIds.delete(nodeId)) {
          throw new controllerModule.exports.TerminalRecoveryError("unresolved session", recoveryCanForget);
        }

        fixture.calls.push("create");

        return true;
      },
      async restartTerminal() {
        fixture.calls.push("restart");

        throw new controllerModule.exports.TerminalRecoveryError("unresolved session", recoveryCanForget);
      },
    },
  };
  const controller = Object.create(controllerModule.exports.TreeTYController.prototype);

  controller.workspaceModels = [workspaceModel];
  controller.vscodeTerminalHosts = new Set([workspaceModel.vscodeTerminalHost]);
  controller.workspaceReloadPromise = Promise.resolve();
  controller.terminalRecovery = { async shutdown() { fixture.calls.push("shutdown recovery"); } };
  controller.vscodeDisposables = [{ dispose() { fixture.calls.push("dispose subscriptions"); } }];
  controller.workspaceModelChangeEmitter = { dispose() { fixture.calls.push("dispose emitter"); } };
  controller.setTerminalAttention = async () => { fixture.calls.push("attention"); };
  controller.syncExplorerDirectory = async () => { fixture.calls.push("sync"); };

  return Object.assign(fixture, {
    controller,
    workspaceModel,
    vscode,
    nodeTreeEntry: { kind: "node", workspaceModel, treeNode },
  });
}
