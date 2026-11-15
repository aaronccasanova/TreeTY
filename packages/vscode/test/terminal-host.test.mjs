import * as assert from "node:assert/strict";
import * as module from "node:module";
import * as path from "node:path";
import * as nodeTest from "node:test";
import * as url from "node:url";

import { buildSync } from "esbuild";

const testDirPath = path.dirname(url.fileURLToPath(import.meta.url));
const hostCode = buildSync({
  entryPoints: [path.join(testDirPath, "../src/vscode-terminal-host.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode", "@treety/core"],
  write: false,
}).outputFiles[0].text;

nodeTest.test("revealing a native session requests keyboard focus", async () => {
  const fixture = createFixture();
  const showOptions = [];

  fixture.terminals[0].show = (preserveFocus) => { showOptions.push(preserveFocus); };

  await fixture.host.getSessions();
  fixture.host.revealSession("session-first");

  assert.deepEqual(showOptions, [false]);
  fixture.host.dispose();
});

nodeTest.test("does not recover a terminal that closes while its registration waits", async () => {
  const fixture = createFixture();
  const registration = createDeferred();
  fixture.core.registerTreeNodeSession = () => registration.promise;

  const sessionsPromise = fixture.host.getSessions();
  fixture.close(fixture.terminals[0]);
  registration.resolve({ version: 1, nodes: {} });

  assert.deepEqual(await sessionsPromise, [{ id: "session-second", nodeId: "second" }]);
  assert.ok(fixture.clearedSessions.includes("session-first"));
  fixture.host.dispose();
});

nodeTest.test("does not recover an earlier terminal closed while a later registration waits", async () => {
  const fixture = createFixture();
  const registration = createDeferred();
  const secondRegistrationStarted = createDeferred();
  fixture.core.registerTreeNodeSession = async (_config, nodeId) => {
    if (nodeId === "first") return { version: 1, nodes: {} };

    secondRegistrationStarted.resolve();

    return registration.promise;
  };

  const sessionsPromise = fixture.host.getSessions();
  await secondRegistrationStarted.promise;
  fixture.close(fixture.terminals[0]);
  registration.resolve({ version: 1, nodes: {} });

  assert.deepEqual(await sessionsPromise, [{ id: "session-second", nodeId: "second" }]);
  fixture.host.dispose();
});

nodeTest.test("ignores a surviving terminal whose definition was removed", async () => {
  const fixture = createFixture();
  fixture.host.updateActivity({ tree: [] }, { version: 1, nodes: {} });

  assert.deepEqual(await fixture.host.getSessions(), []);
  assert.deepEqual(fixture.registeredSessions, []);
  fixture.host.dispose();
});

nodeTest.test("a late shell completion cannot clear a newer command's reporter", async () => {
  const fixture = createFixture();
  await fixture.host.getSessions();
  const terminal = fixture.terminals[0];
  const previousExecution = {};
  const currentExecution = {};
  const stateRead = createDeferred();
  fixture.core.loadTreeStateFile = () => stateRead.promise;

  fixture.events.start({ terminal, execution: previousExecution });
  fixture.events.end({ terminal, execution: previousExecution, exitCode: 0 });
  fixture.events.start({ terminal, execution: currentExecution });
  stateRead.resolve({ version: 1, nodes: {} });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fixture.host.getSessionActivity("session-first").state, "busy");
  assert.deepEqual(fixture.activityClears, []);
  fixture.host.dispose();
});

function createFixture() {
  const events = {};
  const registeredSessions = [];
  const clearedSessions = [];
  const activityClears = [];
  const terminals = ["first", "second"].map(nodeId => ({
    creationOptions: { env: {
      TREETY_NODE_ID: nodeId,
      TREETY_SESSION_ID: `session-${nodeId}`,
      TREETY_WORKSPACE_ID: "workspace",
    } },
  }));
  const core = {
    treeTYNodeIdEnvironmentName: "TREETY_NODE_ID",
    treeTYSessionIdEnvironmentName: "TREETY_SESSION_ID",
    registerTreeNodeSession: async (_config, _nodeId, sessionId) => {
      registeredSessions.push(sessionId);

      return { version: 1, nodes: {} };
    },
    clearTreeNodeSession: async (_config, _nodeId, sessionId) => {
      clearedSessions.push(sessionId);

      return { version: 1, nodes: {} };
    },
    getTreeNodeActivity: () => undefined,
    loadTreeStateFile: async () => ({ version: 1, nodes: {} }),
    setTreeNodeActivity: async (...arguments_) => { activityClears.push(arguments_); },
  };
  const vscode = {
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    window: {
      terminals,
      onDidCloseTerminal: callback => { events.close = callback; return { dispose() {} }; },
      onDidStartTerminalShellExecution: callback => { events.start = callback; return { dispose() {} }; },
      onDidEndTerminalShellExecution: callback => { events.end = callback; return { dispose() {} }; },
    },
  };
  const hostModule = new module.Module(path.join(testDirPath, "host-fixture.cjs"));
  const require = module.createRequire(import.meta.url);
  hostModule.require = name => name === "vscode" ? vscode : name === "@treety/core" ? core : require(name);
  hostModule._compile(hostCode, path.join(testDirPath, "host-fixture.cjs"));
  const host = new hostModule.exports.VscodeTerminalHost("workspace", "/tmp/tree.json", "workspace", {});
  host.updateActivity({ tree: ["first", "second"].map(id => ({ id, kind: "terminal" })) }, { version: 1, nodes: {} });

  return {
    host, core, events, terminals, registeredSessions, clearedSessions, activityClears,
    close(terminal) {
      vscode.window.terminals = vscode.window.terminals.filter(candidate => candidate !== terminal);
      terminal.exitStatus = { code: 0 };
      events.close(terminal);
    },
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise(promiseResolve => { resolve = promiseResolve; });

  return { promise, resolve };
}
