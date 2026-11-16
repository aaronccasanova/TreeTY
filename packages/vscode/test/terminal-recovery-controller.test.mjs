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
  assert.match(fixture.warnings[0][1].detail, /another window/);
  assert.match(fixture.warnings[0][1].detail, /leaves every existing terminal untouched/);
  assert.equal(fixture.warnings[0][2], "Start a new terminal");
  assert.equal(fixture.allowedNodeIds.size, 0);
});

nodeTest.test("confirmation allows one new launch and revokes the permission afterward", async () => {
  const fixture = createFixture();

  fixture.warningChoice = "Start a new terminal";
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
    };

    return "Start a new terminal";
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

    return "Start a new terminal";
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

    return "Start a new terminal";
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

    return "Start a new terminal";
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

function createFixture() {
  const fixture = {
    calls: [],
    warnings: [],
    warningChoice: undefined,
    allowedNodeIds: new Set(),
  };
  const vscode = {
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
      async openTerminal(nodeId) {
        fixture.calls.push("open");

        if (!fixture.allowedNodeIds.delete(nodeId)) {
          throw new controllerModule.exports.TerminalRecoveryError("unresolved session");
        }

        fixture.calls.push("create");
      },
      async restartTerminal() {
        fixture.calls.push("restart");

        throw new controllerModule.exports.TerminalRecoveryError("unresolved session");
      },
    },
  };
  const controller = Object.create(controllerModule.exports.TreeTYController.prototype);

  controller.workspaceModels = [workspaceModel];
  controller.setTerminalAttention = async () => { fixture.calls.push("attention"); };
  controller.syncExplorerDirectory = async () => { fixture.calls.push("sync"); };

  return Object.assign(fixture, {
    controller,
    workspaceModel,
    vscode,
    nodeTreeEntry: { kind: "node", workspaceModel, treeNode },
  });
}
