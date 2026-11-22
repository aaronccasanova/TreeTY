import * as assert from "node:assert/strict";
import * as module from "node:module";
import * as path from "node:path";
import * as nodeTest from "node:test";
import * as url from "node:url";

import { buildSync } from "esbuild";

const testDirPath = path.dirname(url.fileURLToPath(import.meta.url));
const extensionCode = buildSync({
  stdin: {
    contents: [
      'export { activate, deactivate } from "./extension";',
      'export { resolveCommandNodeEntry } from "./node-command-target";',
    ].join("\n"),
    resolveDir: path.join(testDirPath, "../src"),
    sourcefile: "extension-commands-fixture.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  external: [
    "vscode",
    "./controller",
    "./node-search-picker",
    "./terminal-environment",
    "./terminal-links",
    "./terminal-recovery",
    "./tree-collapse-controller",
    "./tree-provider",
  ],
  write: false,
}).outputFiles[0].text;

nodeTest.test("activation waits for startup and exports the versioned terminal lookup API", async (testContext) => {
  const startup = createDeferred();
  const fixture = createFixture(startup.promise);

  testContext.after(() => fixture.extension.deactivate());

  let activated = false;
  const activation = fixture.extension.activate(fixture.context).then((api) => {
    activated = true;

    return api;
  });

  await fixture.startupStarted.promise;
  await Promise.resolve();

  assert.equal(activated, false);
  assert.equal(fixture.commands.has("treety.openTerminal"), true);
  startup.resolve();

  const api = await activation;
  const terminal = {};
  const identity = { configFile: fixture.workspaceModel.configFileUri.fsPath, nodeId: "shell", sessionId: "session" };
  const target = { ...identity };
  const lookupArguments = [];

  fixture.controller.getTerminalIdentity = async (argument) => {
    lookupArguments.push(argument);

    return identity;
  };
  fixture.controller.getTerminal = async (argument) => {
    lookupArguments.push(argument);

    return terminal;
  };

  assert.equal(api.apiVersion, 1);
  assert.equal(await api.getTerminalIdentity(terminal), identity);
  assert.equal(await api.getTerminal(target), terminal);
  assert.equal(lookupArguments[0], terminal);
  assert.equal(lookupArguments[1], target);
});

nodeTest.test("registered node commands resolve raw targets and await their boolean outcomes", async (testContext) => {
  const fixture = createFixture();

  testContext.after(() => fixture.extension.deactivate());
  await fixture.extension.activate(fixture.context);

  const commandStarted = createDeferred();
  const commandCompletion = createDeferred();
  const commandEntries = [];

  fixture.controller.openTerminal = async (nodeTreeEntry) => {
    commandEntries.push(nodeTreeEntry);
    commandStarted.resolve();

    return commandCompletion.promise;
  };

  let commandSettled = false;
  const commandResult = fixture.vscode.commands.executeCommand("treety.openTerminal", "shell").then((result) => {
    commandSettled = true;

    return result;
  });

  await commandStarted.promise;
  await Promise.resolve();

  assert.equal(commandSettled, false);
  assert.deepEqual(fixture.rawTargets, ["shell"]);
  assert.equal(commandEntries[0].workspaceModel, fixture.workspaceModel);
  assert.equal(commandEntries[0].treeNode.id, "shell");
  commandCompletion.resolve(false);
  assert.equal(await commandResult, false);

  fixture.controller.restartTerminal = async (nodeTreeEntry) => {
    commandEntries.push(nodeTreeEntry);

    return true;
  };

  const target = { nodeId: "shell", configFile: fixture.workspaceModel.configFileUri.fsPath };

  assert.equal(await fixture.vscode.commands.executeCommand("treety.restartTerminal", target), true);
  assert.equal(fixture.rawTargets[1], target);
  assert.equal(commandEntries[1].workspaceModel, fixture.workspaceModel);
  assert.equal(await fixture.vscode.commands.executeCommand("treety.restartTerminal", commandEntries[0]), true);
  assert.equal(fixture.rawTargets[2], commandEntries[0]);
  assert.deepEqual(fixture.errors, []);
});

nodeTest.test("stop registration preserves default confirmation and forwards explicit overrides", async (testContext) => {
  const fixture = createFixture();

  testContext.after(() => fixture.extension.deactivate());
  await fixture.extension.activate(fixture.context);

  const confirmations = [];

  fixture.controller.stopTerminal = async (_nodeTreeEntry, confirm) => {
    confirmations.push(confirm);

    return confirm === false;
  };

  assert.equal(await fixture.vscode.commands.executeCommand("treety.stopTerminal", "shell"), false);
  assert.equal(await fixture.vscode.commands.executeCommand("treety.stopTerminal", { nodeId: "shell", confirm: false }), true);
  assert.equal(await fixture.vscode.commands.executeCommand("treety.stopTerminal", { nodeId: "shell", confirm: true }), false);

  const nodeTreeEntry = fixture.extension.resolveCommandNodeEntry([fixture.workspaceModel], "shell");

  assert.equal(await fixture.vscode.commands.executeCommand("treety.stopTerminal", nodeTreeEntry), false);
  assert.deepEqual(confirmations, [undefined, false, true, undefined]);
  await assert.rejects(
    fixture.vscode.commands.executeCommand("treety.stopTerminal", { nodeId: "shell", confirm: "false" }),
    /confirm must be a boolean/,
  );
  assert.equal(confirmations.length, 4);
  assert.equal(fixture.errors.length, 1);
});

nodeTest.test("command target and handler failures reject executeCommand after being reported", async (testContext) => {
  const fixture = createFixture();

  testContext.after(() => fixture.extension.deactivate());
  await fixture.extension.activate(fixture.context);

  const failure = new Error("terminal launch failed");
  let launchCount = 0;

  fixture.controller.openTerminal = async () => {
    launchCount += 1;

    throw failure;
  };

  await assert.rejects(fixture.vscode.commands.executeCommand("treety.openTerminal", "shell"), (error) => error === failure);
  assert.equal(fixture.errors[0], failure);
  await assert.rejects(fixture.vscode.commands.executeCommand("treety.openTerminal", "missing"), /not found/);
  await assert.rejects(fixture.vscode.commands.executeCommand("treety.openTerminal", ""), /nonempty/);
  fixture.workspaceModels.push({ ...fixture.workspaceModel, id: "another-workspace" });
  await assert.rejects(fixture.vscode.commands.executeCommand("treety.openTerminal", "shell"), /ambiguous/);
  assert.equal(launchCount, 1);
  assert.equal(fixture.errors.length, 4);
});

function createFixture(startup = Promise.resolve()) {
  const fixture = {
    commands: new Map(),
    errors: [],
    rawTargets: [],
    startupStarted: createDeferred(),
  };
  const workspaceModel = {
    kind: "configured",
    id: "workspace",
    configFileUri: { fsPath: path.join(testDirPath, "workspace/.treety/tree.json") },
    resolvedTreeConfig: {
      tree: [{ kind: "terminal", id: "shell", name: "Shell" }],
    },
  };

  fixture.workspaceModel = workspaceModel;
  fixture.workspaceModels = [workspaceModel];

  class FixtureController {
    constructor() {
      fixture.controller = this;
    }

    start() {
      fixture.startupStarted.resolve();

      return startup;
    }

    async resolveCommandNodeEntry(argument) {
      fixture.rawTargets.push(argument);

      return fixture.extension.resolveCommandNodeEntry(fixture.workspaceModels, argument);
    }

    async deactivate() {}
    dispose() {}
  }

  class FixtureDisposable {
    dispose() {}
  }

  const vscode = {
    env: { uriScheme: "vscode", machineId: "fixture-machine" },
    workspace: {},
    window: {
      createTreeView: () => ({
        selection: [],
        onDidExpandElement: () => new FixtureDisposable(),
        onDidCollapseElement: () => new FixtureDisposable(),
        dispose() {},
      }),
      registerFileDecorationProvider: () => new FixtureDisposable(),
      registerUriHandler: () => new FixtureDisposable(),
    },
    commands: {
      registerCommand(commandName, commandHandler) {
        fixture.commands.set(commandName, commandHandler);

        return { dispose: () => fixture.commands.delete(commandName) };
      },
      async executeCommand(commandName, ...commandArguments) {
        const commandHandler = fixture.commands.get(commandName);

        assert.ok(commandHandler, `Command ${commandName} was registered`);

        return commandHandler(...commandArguments);
      },
    },
  };
  const mocks = {
    vscode,
    "./controller": { TreeTYController: FixtureController, showCommandError: (error) => fixture.errors.push(error) },
    "./node-search-picker": { NodeSearchPicker: FixtureDisposable },
    "./terminal-environment": { configureTerminalEnvironment: async () => {} },
    "./terminal-links": { TerminalLinkManager: FixtureDisposable },
    "./terminal-recovery": { TerminalRecoveryRegistry: FixtureDisposable, TerminalRecoveryFileStorage: FixtureDisposable },
    "./tree-collapse-controller": { TreeCollapseController: FixtureDisposable },
    "./tree-provider": { TreeTYTreeProvider: FixtureDisposable },
  };
  const extensionFilePath = path.join(testDirPath, "extension-commands-fixture.cjs");
  const extensionModule = new module.Module(extensionFilePath);
  const require = module.createRequire(import.meta.url);

  extensionModule.require = (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name);
  extensionModule._compile(extensionCode, extensionFilePath);
  fixture.extension = extensionModule.exports;
  fixture.vscode = vscode;
  fixture.context = {
    extension: { id: "TreeTY.treety" },
    globalStoragePath: path.join(testDirPath, "storage"),
    globalStorageUri: { toString: () => "fixture-storage" },
    workspaceState: {},
    subscriptions: [],
  };

  return fixture;
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });

  return { promise, resolve };
}
