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

const recoveryCode = buildSync({
  entryPoints: [path.join(testDirPath, "../src/terminal-recovery.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
}).outputFiles[0].text;

const engineCode = buildSync({
  entryPoints: [path.join(testDirPath, "../../core/src/engine.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
}).outputFiles[0].text;

const recoveryModule = new module.Module(path.join(testDirPath, "recovery-fixture.cjs"));
recoveryModule._compile(recoveryCode, path.join(testDirPath, "recovery-fixture.cjs"));

const engineModule = new module.Module(path.join(testDirPath, "engine-fixture.cjs"));
engineModule._compile(engineCode, path.join(testDirPath, "engine-fixture.cjs"));

nodeTest.test("revealing a native session requests keyboard focus", async (testContext) => {
  const fixture = createFixture();
  testContext.after(() => fixture.host.dispose());
  const showOptions = [];

  fixture.terminals[0].show = (preserveFocus) => { showOptions.push(preserveFocus); };

  await fixture.host.getSessions();
  fixture.host.revealSession("session-first");

  assert.deepEqual(showOptions, [false]);
});

nodeTest.test("does not recover a terminal that closes while its registration waits", async (testContext) => {
  const fixture = createFixture();
  testContext.after(() => fixture.host.dispose());
  const registration = createDeferred();
  const registrationStarted = createDeferred();
  fixture.core.registerTreeNodeSession = () => {
    registrationStarted.resolve();

    return registration.promise;
  };

  const sessionsPromise = fixture.host.getSessions();
  await registrationStarted.promise;
  fixture.close(fixture.terminals[0]);
  registration.resolve({ version: 1, nodes: {} });

  assert.deepEqual(await sessionsPromise, [{ id: "session-second", nodeId: "second" }]);
  assert.ok(fixture.clearedSessions.includes("session-first"));
});

nodeTest.test("does not recover an earlier terminal closed while a later registration waits", async (testContext) => {
  const fixture = createFixture();
  testContext.after(() => fixture.host.dispose());
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
});

nodeTest.test("ignores a surviving terminal whose definition was removed", async (testContext) => {
  const fixture = createFixture();
  testContext.after(() => fixture.host.dispose());
  fixture.host.updateActivity({ tree: [] }, { version: 1, nodes: {} });

  assert.deepEqual(await fixture.host.getSessions(), []);
  assert.deepEqual(fixture.registeredSessions, []);
});

nodeTest.test("a late shell completion cannot clear a newer command's reporter", async (testContext) => {
  const fixture = createFixture();
  testContext.after(() => fixture.host.dispose());
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
});

nodeTest.test("recovers a reconnected terminal from its registered title with an empty creation environment", async (testContext) => {
  const fixture = createFixture();
  testContext.after(() => fixture.host.dispose());
  const recoveryRecord = await markRestoredTerminal(fixture, fixture.terminals[0], "first");

  assert.deepEqual(await fixture.host.getSessions(), [
    { id: "session-first", nodeId: "first" },
    { id: "session-second", nodeId: "second" },
  ]);
  assert.ok(fixture.registeredSessions.includes(recoveryRecord.sessionId));
});

nodeTest.test("creation persists a recovery marker without changing the configured terminal name", async (testContext) => {
  const fixture = createFixture({ terminals: [] });
  testContext.after(() => fixture.host.dispose());
  const terminalLaunchRequest = { nodeId: "first", name: "Service logs", cwd: "/tmp", env: {} };

  const hostedTerminalSession = await fixture.host.createSession(terminalLaunchRequest);
  const createdTerminal = fixture.createdTerminals[0];
  const titleMatch = /^TreeTY: Service logs \[treety:([A-Za-z0-9_-]{22})\]$/.exec(createdTerminal.name);

  assert.ok(titleMatch);
  assert.equal(terminalLaunchRequest.name, "Service logs");
  assert.equal(fixture.resolvedTreeConfig.tree[0].name, "first");
  assert.equal(fixture.registry.getRecord(titleMatch[1]).sessionId, hostedTerminalSession.id);
  assert.equal(fixture.recordAtCreation.sessionId, hostedTerminalSession.id);
});

nodeTest.test("recovers identity across registry and host replacement after the configured name changes", async (testContext) => {
  const storage = createStorage();
  const fixture = createFixture({ storage, terminals: [] });
  testContext.after(() => fixture.host.dispose());
  const hostedTerminalSession = await fixture.host.createSession({
    nodeId: "first", name: "Original name", cwd: "/tmp", env: {},
  });
  const restoredTerminal = fixture.createdTerminals[0];
  restoredTerminal.creationOptions = { env: {} };
  fixture.host.dispose();

  const restoredFixture = createFixture({ storage, terminals: [restoredTerminal] });
  testContext.after(() => restoredFixture.host.dispose());
  restoredFixture.resolvedTreeConfig.tree[0].name = "Renamed terminal";
  restoredFixture.host.updateActivity(restoredFixture.resolvedTreeConfig, { version: 1, nodes: {} });

  assert.deepEqual(await restoredFixture.host.getSessions(), [hostedTerminalSession]);
  assert.equal(restoredFixture.resolvedTreeConfig.tree[0].name, "Renamed terminal");
  assert.equal(restoredFixture.createdTerminals.length, 0);
});

nodeTest.test("environment recovery after a native rename keeps the exact record available for close cleanup", async (testContext) => {
  const storage = createStorage();
  const fixture = createFixture({ storage, terminals: [] });
  testContext.after(() => fixture.host.dispose());
  const hostedTerminalSession = await fixture.host.createSession({
    nodeId: "first", name: "Original name", cwd: "/tmp", env: {},
  });
  const recoveryRecord = fixture.recordAtCreation;
  const otherSessionRecord = await fixture.registry.createRecord({
    configFilePath: "/tmp/tree.json", workspaceId: "workspace", sessionId: "another-session", nodeId: "first",
  });
  const terminal = fixture.createdTerminals[0];
  terminal.name = "User renamed the terminal";
  fixture.host.dispose();

  const refreshedFixture = createFixture({ storage, terminals: [terminal] });
  testContext.after(() => refreshedFixture.host.dispose());

  assert.deepEqual(await refreshedFixture.host.getSessions(), [hostedTerminalSession]);
  refreshedFixture.close(terminal);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(refreshedFixture.clearedSessions, [hostedTerminalSession.id]);
  assert.equal(refreshedFixture.registry.getRecord(recoveryRecord.token), undefined);
  assert.ok(refreshedFixture.registry.getRecord(otherSessionRecord.token));
});

nodeTest.test("rejects title markers without a matching registry record or scope", async (testContext) => {
  const fixture = createFixture({ terminals: [] });
  testContext.after(() => fixture.host.dispose());
  const otherWorkspaceRecord = await fixture.registry.createRecord({
    configFilePath: "/tmp/tree.json", workspaceId: "other-workspace", sessionId: "session-first", nodeId: "first",
  });
  const otherConfigRecord = await fixture.registry.createRecord({
    configFilePath: "/tmp/other-tree.json", workspaceId: "workspace", sessionId: "session-first", nodeId: "first",
  });
  const otherHostRegistry = new recoveryModule.exports.TerminalRecoveryRegistry(fixture.storage, "other-host");
  const otherHostRecord = await otherHostRegistry.createRecord({
    configFilePath: "/tmp/tree.json", workspaceId: "workspace", sessionId: "session-first", nodeId: "first",
  });

  for (const token of ["A".repeat(22), otherWorkspaceRecord.token, otherConfigRecord.token, otherHostRecord.token]) {
    const terminal = createTerminal({ name: `TreeTY: first [treety:${token}]`, env: {} });
    fixture.vscode.window.terminals = [terminal];

    assert.deepEqual(await fixture.host.getSessions(), []);
    assert.deepEqual(fixture.registeredSessions, []);
  }
});

nodeTest.test("rejects a registered marker when present creation metadata conflicts or is malformed", async (testContext) => {
  for (const terminalEnvironment of [
    { TREETY_WORKSPACE_ID: "other-workspace" },
    { TREETY_SESSION_ID: "other-session" },
    { TREETY_NODE_ID: "second" },
    { TREETY_SESSION_ID: null },
    { TREETY_SESSION_ID: "" },
    { TREETY_NODE_ID: 12 },
    { TREETY_CONFIG_SOURCE: "global" },
    { TREETY_NODE_ID: "first", TREETY_SESSION_ID: "session-first", TREETY_WORKSPACE_ID: "other-workspace" },
    { TREETY_NODE_ID: "second", TREETY_SESSION_ID: "session-first", TREETY_WORKSPACE_ID: "workspace" },
    { TREETY_NODE_ID: "first", TREETY_SESSION_ID: "other-session", TREETY_WORKSPACE_ID: "workspace" },
    { TREETY_NODE_ID: "first", TREETY_SESSION_ID: "session-first", TREETY_WORKSPACE_ID: "workspace", TREETY_CONFIG_FILE: "/tmp/other-tree.json" },
  ]) {
    const fixture = createFixture({ terminals: [createTerminal({ name: "TreeTY: first", env: {} })] });
    testContext.after(() => fixture.host.dispose());
    await markRestoredTerminal(fixture, fixture.terminals[0], "first");
    fixture.terminals[0].creationOptions.env = terminalEnvironment;

    assert.deepEqual(await fixture.host.getSessions(), [], JSON.stringify(terminalEnvironment));
    assert.deepEqual(fixture.registeredSessions, []);
  }
});

nodeTest.test("accepts partial creation metadata when every present identity field agrees with the record", async (testContext) => {
  const fixture = createFixture({ terminals: [createTerminal({ name: "TreeTY: first", env: {} })] });
  testContext.after(() => fixture.host.dispose());
  await markRestoredTerminal(fixture, fixture.terminals[0], "first");
  fixture.terminals[0].creationOptions.env = { TREETY_NODE_ID: "first", TREETY_CONFIG_FILE: "/tmp/tree.json" };

  assert.deepEqual(await fixture.host.getSessions(), [{ id: "session-first", nodeId: "first" }]);
});

nodeTest.test("rejects both terminals when a recovery marker is duplicated", async (testContext) => {
  const fixture = createFixture({ terminals: [createTerminal({ name: "TreeTY: first", env: {} })] });
  testContext.after(() => fixture.host.dispose());
  await markRestoredTerminal(fixture, fixture.terminals[0], "first");
  fixture.terminals.push(createTerminal({ name: fixture.terminals[0].name, env: {} }));

  assert.deepEqual(await fixture.host.getSessions(), []);
  assert.deepEqual(fixture.registeredSessions, []);
});

nodeTest.test("rejects duplicate session and node claims even when the title tokens differ", async (testContext) => {
  for (const secondSessionId of ["session-first", "other-session"]) {
    const fixture = createFixture({ terminals: [createTerminal({ name: "TreeTY: first", env: {} })] });
    testContext.after(() => fixture.host.dispose());
    await markRestoredTerminal(fixture, fixture.terminals[0], "first");
    const recoveryRecord = await fixture.registry.createRecord({
      configFilePath: "/tmp/tree.json", workspaceId: "workspace", sessionId: secondSessionId, nodeId: "first",
    });
    fixture.terminals.push(createTerminal({ name: `TreeTY: first [treety:${recoveryRecord.token}]`, env: {} }));

    assert.deepEqual(await fixture.host.getSessions(), []);
    assert.deepEqual(fixture.registeredSessions, []);
  }
});

nodeTest.test("uses the bound terminal object for shell and close events after a native rename", async (testContext) => {
  const fixture = createFixture();
  testContext.after(() => fixture.host.dispose());
  const terminal = fixture.terminals[0];
  const recoveryRecord = await markRestoredTerminal(fixture, terminal, "first");
  const terminalHostEvents = [];
  await fixture.host.getSessions();
  fixture.host.subscribe(terminalHostEvent => terminalHostEvents.push(terminalHostEvent));
  terminal.name = "User renamed the terminal";
  const execution = {};

  fixture.events.start({ terminal, execution });
  assert.equal(fixture.host.getSessionActivity("session-first").state, "busy");
  fixture.events.end({ terminal, execution, exitCode: 0 });
  await new Promise(resolve => setImmediate(resolve));
  fixture.close(terminal);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(terminalHostEvents.map(terminalHostEvent => terminalHostEvent.type), ["started", "idle", "closed"]);
  assert.ok(terminalHostEvents.every(terminalHostEvent => terminalHostEvent.sessionId === "session-first"));
  assert.ok(fixture.clearedSessions.includes("session-first"));
  assert.equal(fixture.registry.getRecord(recoveryRecord.token), undefined);
});

nodeTest.test("an unbound terminal cannot emit events for a recovered session by copying its identity", async (testContext) => {
  const fixture = createFixture();
  testContext.after(() => fixture.host.dispose());
  const terminal = fixture.terminals[0];
  await markRestoredTerminal(fixture, terminal, "first");
  await fixture.host.getSessions();
  const terminalHostEvents = [];
  fixture.host.subscribe(terminalHostEvent => terminalHostEvents.push(terminalHostEvent));
  const copiedTerminal = createTerminal({
    name: terminal.name,
    env: { TREETY_NODE_ID: "first", TREETY_SESSION_ID: "session-first", TREETY_WORKSPACE_ID: "workspace" },
  });
  const execution = {};

  fixture.events.start({ terminal: copiedTerminal, execution });
  fixture.events.end({ terminal: copiedTerminal, execution, exitCode: 0 });
  fixture.close(copiedTerminal);

  assert.deepEqual(terminalHostEvents, []);
  assert.deepEqual(fixture.clearedSessions, []);
  fixture.host.revealSession("session-first");
  assert.deepEqual(terminal.showOptions, [false]);
});

nodeTest.test("the production engine recovers onOpen terminals, reveals the original, and closes it on removal", async (testContext) => {
  const fixture = createFixture();
  const restoredTerminal = fixture.terminals[0];
  await markRestoredTerminal(fixture, restoredTerminal, "first");
  fixture.resolvedTreeConfig.tree[0].restartPolicy = "onOpen";
  const treeTYEngine = new engineModule.exports.TreeTYEngine(fixture.resolvedTreeConfig, fixture.host);
  testContext.after(() => treeTYEngine.dispose());

  await treeTYEngine.start();
  await treeTYEngine.openTerminal("first");

  assert.equal(fixture.createdTerminals.length, 0);
  assert.equal(treeTYEngine.getTerminalSessionState("first").hostSessionId, "session-first");
  assert.deepEqual(restoredTerminal.showOptions, [false]);

  await treeTYEngine.reconcile({ ...fixture.resolvedTreeConfig, tree: [fixture.resolvedTreeConfig.tree[1]] });

  assert.equal(restoredTerminal.wasDisposed, true);
  assert.ok(fixture.clearedSessions.includes("session-first"));
});

nodeTest.test("an unresolved recorded session prevents automatic replacement when its title marker is missing", async (testContext) => {
  const fixture = createFixture();
  const restoredTerminal = fixture.terminals[0];
  const recoveryRecord = await markRestoredTerminal(fixture, restoredTerminal, "first");
  restoredTerminal.name = "User renamed the terminal";
  fixture.resolvedTreeConfig.tree[0].restartPolicy = "onOpen";
  const treeTYEngine = new engineModule.exports.TreeTYEngine(fixture.resolvedTreeConfig, fixture.host);
  testContext.after(() => treeTYEngine.dispose());

  await treeTYEngine.start();

  assert.equal(fixture.createdTerminals.length, 0);
  assert.equal(treeTYEngine.getTerminalSessionState("first").hostSessionId, undefined);
  assert.ok(fixture.registry.getRecord(recoveryRecord.token));
  assert.equal(restoredTerminal.wasDisposed, false);
});

nodeTest.test("absence from the current window preserves recorded sessions without launching replacements", async (testContext) => {
  const fixture = createFixture({ terminals: [] });
  testContext.after(() => fixture.host.dispose());
  const recoveryRecord = await fixture.registry.createRecord({
    configFilePath: "/tmp/tree.json", workspaceId: "workspace", sessionId: "session-first", nodeId: "first",
  });

  assert.deepEqual(await fixture.host.getSessions(), []);
  await assert.rejects(fixture.host.createSession({ nodeId: "first", name: "first", cwd: "/tmp", env: {} }));
  assert.equal(fixture.createdTerminals.length, 0);
  assert.ok(fixture.registry.getRecord(recoveryRecord.token));
});

nodeTest.test("window shutdown preserves a bound terminal's record and persistent session", async (testContext) => {
  const fixture = createFixture();
  testContext.after(() => fixture.host.dispose());
  const terminal = fixture.terminals[0];
  const recoveryRecord = await markRestoredTerminal(fixture, terminal, "first");
  await fixture.host.getSessions();

  fixture.close(terminal, fixture.vscode.TerminalExitReason.Shutdown);
  await new Promise(resolve => setImmediate(resolve));

  assert.ok(fixture.registry.getRecord(recoveryRecord.token));
  assert.deepEqual(fixture.clearedSessions, []);
  await assert.rejects(
    fixture.host.createSession({ nodeId: "first", name: "first", cwd: "/tmp", env: {} }),
    /previous terminal session could not be recovered/,
  );
  assert.equal(fixture.createdTerminals.length, 0);
});

nodeTest.test("normal close removes only its bound record and preserves records absent from this window", async (testContext) => {
  const fixture = createFixture();
  testContext.after(() => fixture.host.dispose());
  const terminal = fixture.terminals[0];
  const recoveryRecord = await markRestoredTerminal(fixture, terminal, "first");
  const absentRecord = await fixture.registry.createRecord({
    configFilePath: "/tmp/tree.json", workspaceId: "workspace", sessionId: "other-session", nodeId: "first",
  });
  const otherScopeRecord = await fixture.registry.createRecord({
    configFilePath: "/tmp/other-tree.json", workspaceId: "other-workspace", sessionId: "session-first", nodeId: "first",
  });
  await fixture.host.getSessions();

  fixture.close(terminal, fixture.vscode.TerminalExitReason.User);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fixture.registry.getRecord(recoveryRecord.token), undefined);
  assert.ok(fixture.registry.getRecord(absentRecord.token));
  assert.ok(fixture.registry.getRecord(otherScopeRecord.token));
  assert.deepEqual(fixture.clearedSessions, ["session-first"]);
});

nodeTest.test("recovery retries session registration after a storage failure", async (testContext) => {
  const fixture = createFixture({ terminals: [createTerminal({ name: "TreeTY: first", env: {} })] });
  testContext.after(() => fixture.host.dispose());
  await markRestoredTerminal(fixture, fixture.terminals[0], "first");
  let registrationAttempts = 0;
  fixture.core.registerTreeNodeSession = async () => {
    registrationAttempts += 1;

    if (registrationAttempts === 1) throw new Error("Temporary state write failure");

    return { version: 1, nodes: {} };
  };

  await assert.rejects(fixture.host.getSessions(), /Temporary state write failure/);
  assert.deepEqual(await fixture.host.getSessions(), [{ id: "session-first", nodeId: "first" }]);
  assert.equal(registrationAttempts, 2);
});

nodeTest.test("explicit replacement leaves an unresolved original terminal and its record intact", async (testContext) => {
  const fixture = createFixture();
  testContext.after(() => fixture.host.dispose());
  const restoredTerminal = fixture.terminals[0];
  const recoveryRecord = await markRestoredTerminal(fixture, restoredTerminal, "first");
  restoredTerminal.name = "User renamed the terminal";

  fixture.host.allowNextSessionCreation("first");
  const hostedTerminalSession = await fixture.host.createSession({ nodeId: "first", name: "first", cwd: "/tmp", env: {} });

  assert.equal(fixture.createdTerminals.length, 1);
  assert.notEqual(hostedTerminalSession.id, "session-first");
  assert.ok(fixture.registry.getRecord(recoveryRecord.token));
  assert.equal(restoredTerminal.wasDisposed, false);
});

nodeTest.test("late title restoration reconnects the production engine without another launch", { timeout: 2_000 }, async (testContext) => {
  const fixture = createFixture();
  const restoredTerminal = fixture.terminals[0];
  await markRestoredTerminal(fixture, restoredTerminal, "first");
  const restoredTitle = restoredTerminal.name;
  restoredTerminal.name = "shell";
  fixture.resolvedTreeConfig.tree[0].restartPolicy = "onOpen";
  const treeTYEngine = new engineModule.exports.TreeTYEngine(fixture.resolvedTreeConfig, fixture.host);
  testContext.after(() => treeTYEngine.dispose());
  const recoveredSession = createDeferred();
  fixture.host.subscribe(terminalHostEvent => {
    if (terminalHostEvent.type !== "recovered" || terminalHostEvent.nodeId !== "first") return;

    recoveredSession.resolve(terminalHostEvent);
  });

  await treeTYEngine.start();
  assert.equal(fixture.createdTerminals.length, 0);
  restoredTerminal.name = restoredTitle;
  await recoveredSession.promise;
  await treeTYEngine.openTerminal("first");

  assert.equal(treeTYEngine.getTerminalSessionState("first").hostSessionId, "session-first");
  assert.equal(fixture.createdTerminals.length, 0);
  assert.deepEqual(restoredTerminal.showOptions, [false]);
});

nodeTest.test("a late native open event recovers the matching terminal for an existing engine", { timeout: 2_000 }, async (testContext) => {
  const fixture = createFixture({ terminals: [] });
  const recoveryRecord = await fixture.registry.createRecord({
    configFilePath: "/tmp/tree.json", workspaceId: "workspace", sessionId: "session-first", nodeId: "first",
  });
  fixture.resolvedTreeConfig.tree[0].restartPolicy = "onOpen";
  const treeTYEngine = new engineModule.exports.TreeTYEngine(fixture.resolvedTreeConfig, fixture.host);
  testContext.after(() => treeTYEngine.dispose());
  const recoveredSession = createDeferred();
  fixture.host.subscribe(terminalHostEvent => {
    if (terminalHostEvent.type !== "recovered" || terminalHostEvent.nodeId !== "first") return;

    recoveredSession.resolve(terminalHostEvent);
  });

  await treeTYEngine.start();
  const restoredTerminal = createTerminal({ name: `TreeTY: first [treety:${recoveryRecord.token}]`, env: {} });
  fixture.terminals.push(restoredTerminal);
  fixture.events.open(restoredTerminal);
  await recoveredSession.promise;

  assert.equal(treeTYEngine.getTerminalSessionState("first").hostSessionId, "session-first");
  assert.equal(fixture.createdTerminals.length, 0);
});

for (const interruption of ["cancellation", "host disposal"]) {
  nodeTest.test(`${interruption} during final session discovery prevents native terminal creation`, { timeout: 2_000 }, async (testContext) => {
    const fixture = createFixture({ terminals: [] });
    testContext.after(() => fixture.host.dispose());
    const registration = createDeferred();
    const secondRegistrationStarted = createDeferred();
    testContext.after(() => registration.resolve({ version: 1, nodes: {} }));
    const abortController = new AbortController();
    fixture.core.registerTreeNodeSession = async (_config, nodeId, sessionId) => {
      fixture.registeredSessions.push(sessionId);

      if (nodeId === "second") {
        secondRegistrationStarted.resolve();

        return registration.promise;
      }

      const restoredTerminal = createTerminal({
        name: "TreeTY: second",
        env: { TREETY_NODE_ID: "second", TREETY_SESSION_ID: "session-second", TREETY_WORKSPACE_ID: "workspace" },
      });
      fixture.terminals.push(restoredTerminal);
      fixture.events.open(restoredTerminal);

      return { version: 1, nodes: {} };
    };

    const sessionCreation = fixture.host.createSession({
      nodeId: "first", name: "first", cwd: "/tmp", env: {}, signal: abortController.signal,
    });
    await secondRegistrationStarted.promise;

    if (interruption === "cancellation") abortController.abort();
    if (interruption === "host disposal") fixture.host.dispose();

    registration.resolve({ version: 1, nodes: {} });

    await assert.rejects(sessionCreation, interruption === "cancellation" ? /aborted/ : /disposed before launch/);
    assert.equal(fixture.createdTerminals.length, 0);
    assert.deepEqual(fixture.registry.getRecords({ configFilePath: "/tmp/tree.json", workspaceId: "workspace" }), []);
  });
}

nodeTest.test("restart replaces a confirmed closed terminal while persistent cleanup is still pending", { timeout: 2_000 }, async (testContext) => {
  const fixture = createFixture();
  const terminal = fixture.terminals[0];
  const recoveryRecord = await markRestoredTerminal(fixture, terminal, "first");
  const treeTYEngine = new engineModule.exports.TreeTYEngine(fixture.resolvedTreeConfig, fixture.host);
  testContext.after(() => treeTYEngine.dispose());
  const sessionClear = createDeferred();
  testContext.after(() => sessionClear.resolve({ version: 1, nodes: {} }));
  const updateStorage = fixture.storage.update;
  fixture.storage.update = async (key, value) => {
    if (key.endsWith(recoveryRecord.token) && value === undefined) await sessionClear.promise;

    await updateStorage(key, value);
  };
  fixture.core.clearTreeNodeSession = async (_config, _nodeId, sessionId) => {
    fixture.clearedSessions.push(sessionId);

    if (sessionId === "session-first") return sessionClear.promise;

    return { version: 1, nodes: {} };
  };

  await treeTYEngine.start();
  await treeTYEngine.restartTerminal("first");

  assert.equal(terminal.wasDisposed, true);
  assert.ok(fixture.clearedSessions.includes("session-first"));
  assert.ok(fixture.registry.getRecord(recoveryRecord.token));
  assert.equal(fixture.createdTerminals.length, 1);
  assert.notEqual(treeTYEngine.getTerminalSessionState("first").hostSessionId, "session-first");

  sessionClear.resolve({ version: 1, nodes: {} });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fixture.registry.getRecord(recoveryRecord.token), undefined);
  assert.equal(fixture.registry.getRecords({ configFilePath: "/tmp/tree.json", workspaceId: "workspace" }).length, 1);
});

nodeTest.test("a duplicate token arriving during registration prevents either terminal from being recovered", { timeout: 2_000 }, async (testContext) => {
  const fixture = createFixture({ terminals: [createTerminal({ name: "TreeTY: first", env: {} })] });
  testContext.after(() => fixture.host.dispose());
  const terminal = fixture.terminals[0];
  const recoveryRecord = await markRestoredTerminal(fixture, terminal, "first");
  const registration = createDeferred();
  const registrationStarted = createDeferred();
  testContext.after(() => registration.resolve({ version: 1, nodes: {} }));
  fixture.core.registerTreeNodeSession = () => {
    registrationStarted.resolve();

    return registration.promise;
  };
  const terminalHostEvents = [];
  fixture.host.subscribe(terminalHostEvent => terminalHostEvents.push(terminalHostEvent));

  const sessionsPromise = fixture.host.getSessions();
  await registrationStarted.promise;
  const copiedTerminal = createTerminal({ name: terminal.name, env: {} });
  fixture.terminals.push(copiedTerminal);
  fixture.events.open(copiedTerminal);
  registration.resolve({ version: 1, nodes: {} });

  assert.deepEqual(await sessionsPromise, []);
  assert.deepEqual(await fixture.host.getSessions(), []);
  assert.deepEqual(terminalHostEvents, []);
  assert.throws(() => fixture.host.revealSession("session-first"), /was not found/);
  assert.ok(fixture.registry.getRecord(recoveryRecord.token));
  assert.equal(terminal.wasDisposed, false);
  assert.equal(copiedTerminal.wasDisposed, false);
});

nodeTest.test("new unresolved identity during launch preparation prevents native terminal creation", { timeout: 2_000 }, async (testContext) => {
  for (const arrival of ["ambiguous native terminals", "another recovery record"]) {
    const fixture = createFixture({ terminals: [] });
    testContext.after(() => fixture.host.dispose());
    const registration = createDeferred();
    const registrationStarted = createDeferred();
    testContext.after(() => registration.resolve({ version: 1, nodes: {} }));
    fixture.core.registerTreeNodeSession = () => {
      registrationStarted.resolve();

      return registration.promise;
    };

    const sessionCreation = fixture.host.createSession({ nodeId: "first", name: "first", cwd: "/tmp", env: {} });
    await registrationStarted.promise;

    if (arrival === "ambiguous native terminals") {
      for (const sessionId of ["restored-session-one", "restored-session-two"]) {
        fixture.terminals.push(createTerminal({
          name: "TreeTY: first",
          env: { TREETY_NODE_ID: "first", TREETY_SESSION_ID: sessionId, TREETY_WORKSPACE_ID: "workspace" },
        }));
      }
    }

    if (arrival === "another recovery record") {
      await fixture.registry.createRecord({
        configFilePath: "/tmp/tree.json", workspaceId: "workspace", sessionId: "restored-session", nodeId: "first",
      });
    }

    registration.resolve({ version: 1, nodes: {} });

    await assert.rejects(sessionCreation, /previous terminal session could not be recovered/, arrival);
    assert.equal(fixture.createdTerminals.length, 0, arrival);
    assert.equal(fixture.registry.getRecords({ configFilePath: "/tmp/tree.json", workspaceId: "workspace" }).length,
      arrival === "another recovery record" ? 1 : 0);
    assert.ok(fixture.terminals.every(terminal => !terminal.wasDisposed));
  }
});

nodeTest.test("normal close removes the recovery record even when persistent session cleanup fails", { timeout: 2_000 }, async (testContext) => {
  const fixture = createFixture();
  testContext.after(() => fixture.host.dispose());
  const terminal = fixture.terminals[0];
  const recoveryRecord = await markRestoredTerminal(fixture, terminal, "first");
  await fixture.host.getSessions();
  const stateError = new Error("State file cannot be written");
  fixture.core.clearTreeNodeSession = async () => { throw stateError; };
  const errorReport = createDeferred();
  testContext.mock.method(console, "error", (...arguments_) => errorReport.resolve(arguments_));

  fixture.close(terminal);
  const errorArguments = await errorReport.promise;

  assert.equal(fixture.registry.getRecord(recoveryRecord.token), undefined);
  assert.equal(errorArguments[1] instanceof AggregateError, true);
  assert.deepEqual(errorArguments[1].errors, [stateError]);
});

function createFixture(options = {}) {
  const events = {};
  const registeredSessions = [];
  const clearedSessions = [];
  const activityClears = [];
  const createdTerminals = [];
  const storage = options.storage ?? createStorage();
  const registry = new recoveryModule.exports.TerminalRecoveryRegistry(storage, "host");
  const terminals = options.terminals ?? ["first", "second"].map(nodeId => createTerminal({
    name: `TreeTY: ${nodeId}`,
    env: {
      TREETY_NODE_ID: nodeId,
      TREETY_SESSION_ID: `session-${nodeId}`,
      TREETY_WORKSPACE_ID: "workspace",
    },
  }));
  const core = {
    treeTYNodeIdEnvironmentName: "TREETY_NODE_ID",
    treeTYSessionIdEnvironmentName: "TREETY_SESSION_ID",
    treeTYConfigFileEnvironmentName: "TREETY_CONFIG_FILE",
    buildTreeTYTerminalEnvironment: terminalContext => ({
      TREETY_NODE_ID: terminalContext.nodeId,
      TREETY_SESSION_ID: terminalContext.sessionId,
      TREETY_CONFIG_FILE: terminalContext.configFilePath,
    }),
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
    TerminalExitReason: { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 },
    Uri: { file: filePath => ({ toString: () => filePath }) },
    ThemeIcon: class {},
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    window: {
      terminals,
      onDidOpenTerminal: callback => { events.open = callback; return { dispose() {} }; },
      onDidCloseTerminal: callback => { events.close = callback; return { dispose() {} }; },
      onDidStartTerminalShellExecution: callback => { events.start = callback; return { dispose() {} }; },
      onDidEndTerminalShellExecution: callback => { events.end = callback; return { dispose() {} }; },
    },
  };
  const hostModule = new module.Module(path.join(testDirPath, "host-fixture.cjs"));
  const require = module.createRequire(import.meta.url);
  hostModule.require = name => name === "vscode" ? vscode : name === "@treety/core" ? core : require(name);
  hostModule._compile(hostCode, path.join(testDirPath, "host-fixture.cjs"));
  const host = new hostModule.exports.VscodeTerminalHost("workspace", "/tmp/tree.json", "workspace", {}, registry);
  const resolvedTreeConfig = {
    version: 1,
    workspaceDirPath: "/tmp",
    tree: ["first", "second"].map(id => ({
      id, kind: "terminal", name: id, cwd: "/tmp", env: {}, needsAttention: false, restartPolicy: "manual",
    })),
  };
  host.updateActivity(resolvedTreeConfig, { version: 1, nodes: {} });

  const fixture = {
    host, core, vscode, events, createdTerminals, registry, storage, resolvedTreeConfig,
    registeredSessions, clearedSessions, activityClears,
    get terminals() { return vscode.window.terminals; },
    close(terminal, reason = vscode.TerminalExitReason.Process) {
      vscode.window.terminals = vscode.window.terminals.filter(candidate => candidate !== terminal);
      terminal.exitStatus = { code: 0, reason };
      events.close(terminal);
    },
  };

  for (const terminal of terminals) {
    terminal.dispose = () => {
      terminal.wasDisposed = true;
      fixture.close(terminal);
    };
  }

  vscode.window.createTerminal = terminalOptions => {
    const terminal = createTerminal(terminalOptions);
    const titleMatch = /\[treety:([A-Za-z0-9_-]{22})\]$/.exec(terminal.name);
    fixture.recordAtCreation = titleMatch ? registry.getRecord(titleMatch[1]) : undefined;
    terminal.dispose = () => {
      terminal.wasDisposed = true;
      fixture.close(terminal);
    };
    vscode.window.terminals.push(terminal);
    createdTerminals.push(terminal);
    events.open?.(terminal);

    return terminal;
  };

  return fixture;
}

function createTerminal(terminalOptions) {
  return {
    name: terminalOptions.name,
    creationOptions: terminalOptions,
    showOptions: [],
    wasDisposed: false,
    show(preserveFocus) { this.showOptions.push(preserveFocus); },
    dispose() { this.wasDisposed = true; },
  };
}

function createStorage() {
  const values = new Map();

  return {
    keys: () => [...values.keys()],
    get: (key, defaultValue) => structuredClone(values.get(key) ?? defaultValue),
    async update(key, value) {
      if (value === undefined) {
        values.delete(key);

        return;
      }

      values.set(key, structuredClone(value));
    },
  };
}

async function markRestoredTerminal(fixture, terminal, nodeId) {
  const recoveryRecord = await fixture.registry.createRecord({
    configFilePath: "/tmp/tree.json", workspaceId: "workspace", sessionId: `session-${nodeId}`, nodeId,
  });
  terminal.name = `TreeTY: ${nodeId} [treety:${recoveryRecord.token}]`;
  terminal.creationOptions = { env: {} };

  return recoveryRecord;
}

function createDeferred() {
  let resolve;
  const promise = new Promise(promiseResolve => { resolve = promiseResolve; });

  return { promise, resolve };
}
