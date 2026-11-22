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
  const persistedSessionIds = new Set();
  fixture.core.registerTreeNodeSession = async (_config, _nodeId, sessionId) => {
    registrationStarted.resolve();
    await registration.promise;
    persistedSessionIds.add(sessionId);

    return { version: 1, nodes: {} };
  };
  fixture.core.clearTreeNodeSession = async (_config, _nodeId, sessionId) => {
    fixture.clearedSessions.push(sessionId);
    persistedSessionIds.delete(sessionId);

    return { version: 1, nodes: {} };
  };

  const sessionsPromise = fixture.host.getSessions();
  await registrationStarted.promise;
  fixture.close(fixture.terminals[0]);
  registration.resolve({ version: 1, nodes: {} });

  assert.deepEqual(await sessionsPromise, [{ id: "session-second", nodeId: "second" }]);
  assert.ok(fixture.clearedSessions.includes("session-first"));
  assert.deepEqual([...persistedSessionIds], ["session-second"]);
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

nodeTest.test("public lookups recover empty-environment terminals and fence exact session identity", async (testContext) => {
  const fixture = createFixture();

  testContext.after(() => fixture.host.dispose());
  await markRestoredTerminal(fixture, fixture.terminals[0], "first");

  const terminal = fixture.terminals[0];
  const terminalIdentity = await fixture.host.getTerminalIdentity(terminal);

  assert.deepEqual(terminalIdentity, {
    configFile: "/tmp/tree.json", nodeId: "first", sessionId: "session-first",
  });
  assert.equal(await fixture.host.getTerminal(terminalIdentity), terminal);
  assert.equal(await fixture.host.getTerminal({ ...terminalIdentity, sessionId: "stale" }), undefined);
  assert.equal(await fixture.host.getTerminal({ ...terminalIdentity, configFile: "/other/tree.json" }), undefined);
  assert.equal(await fixture.host.getTerminalIdentity({ ...terminal }), undefined);

  fixture.host.closeSession("session-first");
  assert.equal(await fixture.host.getTerminalIdentity(terminal), undefined);
  assert.equal(await fixture.host.getTerminal(terminalIdentity), undefined);
});

nodeTest.test("public lookups reject duplicate unbound identities and removed definitions", async (testContext) => {
  const fixture = createFixture();

  testContext.after(() => fixture.host.dispose());
  const terminal = fixture.terminals[0];

  fixture.terminals.push({ ...terminal });
  assert.equal(await fixture.host.getTerminalIdentity(terminal), undefined);
  assert.equal(await fixture.host.getTerminal({ configFile: "/tmp/tree.json", nodeId: "first" }), undefined);

  fixture.terminals.pop();
  const terminalIdentity = await fixture.host.getTerminalIdentity(terminal);

  assert.ok(terminalIdentity);
  fixture.host.updateActivity({ tree: [] }, { version: 1, nodes: {} });
  assert.equal(await fixture.host.getTerminalIdentity(terminal), undefined);
  assert.equal(await fixture.host.getTerminal(terminalIdentity), undefined);
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

nodeTest.test("owner endpoint failure preserves launches, restored recovery, and cross-window exclusion", async (testContext) => {
  const storage = createStorage();
  const registryOptions = {
    owner: {
      start: async () => { throw Object.assign(new Error("Owner endpoint unavailable"), { code: "EACCES" }); },
      shutdown: async () => {},
    },
    getProcessIsAlive: () => true,
    getOwnerLiveness: async () => "dead",
  };
  const fixture = createFixture({ storage, registryOptions, terminals: [] });
  testContext.after(() => fixture.host.dispose());
  const terminalLaunchRequest = { nodeId: "first", name: "first", cwd: "/tmp", env: {} };
  const hostedTerminalSession = await fixture.host.createSession(terminalLaunchRequest);
  const recoveryRecord = fixture.recordAtCreation;

  assert.equal(Object.hasOwn(recoveryRecord, "ownerProtocol"), false);
  assert.equal(recoveryRecord.ownerProcessId, fixture.registry.ownerProcessId);

  const restoredTerminal = fixture.createdTerminals[0];

  restoredTerminal.creationOptions = { env: {} };
  fixture.host.dispose();
  await fixture.host.flushSessionCleanup();

  const restoredFixture = createFixture({ storage, registryOptions, terminals: [restoredTerminal] });

  restoredFixture.resolvedTreeConfig.tree[0].restartPolicy = "onOpen";

  const treeTYEngine = new engineModule.exports.TreeTYEngine(restoredFixture.resolvedTreeConfig, restoredFixture.host);

  testContext.after(() => treeTYEngine.dispose());
  await treeTYEngine.start();
  await treeTYEngine.openTerminal("first");

  assert.equal(treeTYEngine.getTerminalSessionState("first").hostSessionId, hostedTerminalSession.id);
  assert.deepEqual(restoredTerminal.showOptions, [false]);
  assert.equal(restoredFixture.createdTerminals.length, 0);
  assert.equal(restoredFixture.registry.getRecord(recoveryRecord.token).ownerId, restoredFixture.registry.ownerId);
  assert.equal(Object.hasOwn(restoredFixture.registry.getRecord(recoveryRecord.token), "ownerProtocol"), false);

  const otherWindowFixture = createFixture({ storage, registryOptions, terminals: [] });

  testContext.after(() => otherWindowFixture.host.dispose());
  otherWindowFixture.host.allowNextSessionCreation("first");
  await assert.rejects(otherWindowFixture.host.createSession(terminalLaunchRequest),
    error => error.canForget === false && /another VS Code window/.test(error.message));
  assert.equal(otherWindowFixture.createdTerminals.length, 0);
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
  await fixture.registry.updateRecord(otherSessionRecord.token, { ownerId: undefined, ownerProcessId: undefined });
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
  const otherHostRegistry = new recoveryModule.exports.TerminalRecoveryRegistry(fixture.storage, "other-host", {
    owner: { start: async () => {}, shutdown: async () => {} },
    getOwnerLiveness: async () => "alive",
  });
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
  await new Promise(resolve => setImmediate(resolve));

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

nodeTest.test("window shutdown clears active session state while preserving its recovery identity", async (testContext) => {
  const fixture = createFixture();
  testContext.after(() => fixture.host.dispose());
  const terminal = fixture.terminals[0];
  const recoveryRecord = await markRestoredTerminal(fixture, terminal, "first");
  await fixture.host.getSessions();

  fixture.close(terminal, fixture.vscode.TerminalExitReason.Shutdown);
  await new Promise(resolve => setImmediate(resolve));

  assert.ok(fixture.registry.getRecord(recoveryRecord.token));
  assert.deepEqual(fixture.clearedSessions, ["session-first"]);
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
  await fixture.registry.updateRecord(absentRecord.token, { ownerId: undefined, ownerProcessId: undefined });
  const otherScopeRecord = await fixture.registry.createRecord({
    configFilePath: "/tmp/other-tree.json", workspaceId: "other-workspace", sessionId: "session-first", nodeId: "first",
  });
  await fixture.host.getSessions();

  fixture.close(terminal, fixture.vscode.TerminalExitReason.Process);
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

nodeTest.test("forgetting an unknown session retires its identity and does not block again after replacement closes", async (testContext) => {
  const fixture = createFixture({ terminals: [] });
  testContext.after(() => fixture.host.dispose());
  const recoveryRecord = await fixture.registry.createRecord({
    configFilePath: "/tmp/tree.json", workspaceId: "workspace", sessionId: "previous-session", nodeId: "first",
  });
  await fixture.registry.updateRecord(recoveryRecord.token, { ownerId: undefined, ownerProcessId: undefined });
  const terminalLaunchRequest = { nodeId: "first", name: "first", cwd: "/tmp", env: {} };

  await assert.rejects(fixture.host.createSession(terminalLaunchRequest), error => error.canForget === true);

  fixture.host.allowNextSessionCreation("first");
  const hostedTerminalSession = await fixture.host.createSession(terminalLaunchRequest);

  assert.equal(fixture.createdTerminals.length, 1);
  assert.notEqual(hostedTerminalSession.id, "previous-session");
  assert.equal(fixture.registry.getRecord(recoveryRecord.token).retired, true);
  assert.ok(fixture.clearedSessions.includes("previous-session"));

  fixture.close(fixture.createdTerminals[0]);
  await new Promise(resolve => setImmediate(resolve));
  await fixture.host.createSession(terminalLaunchRequest);

  assert.equal(fixture.createdTerminals.length, 2);
});

nodeTest.test("explicit discovery reconnects a late restored title without another launch", { timeout: 2_000 }, async (testContext) => {
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
  await fixture.host.getSessions();
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
  const getSessions = testContext.mock.method(fixture.host, "getSessions");
  const restoredTerminal = createTerminal({ name: `TreeTY: first [treety:${recoveryRecord.token}]`, env: {} });
  fixture.terminals.push(restoredTerminal);
  fixture.events.open(restoredTerminal);
  await recoveredSession.promise;

  assert.equal(treeTYEngine.getTerminalSessionState("first").hostSessionId, "session-first");
  assert.equal(fixture.createdTerminals.length, 0);
  assert.equal(getSessions.mock.callCount(), 1);
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

nodeTest.test("restart waits for serialized cleanup before replacing a confirmed closed terminal", { timeout: 2_000 }, async (testContext) => {
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
  const restart = treeTYEngine.restartTerminal("first");
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(terminal.wasDisposed, true);
  assert.ok(fixture.clearedSessions.includes("session-first"));
  assert.ok(fixture.registry.getRecord(recoveryRecord.token));
  assert.equal(fixture.createdTerminals.length, 0);

  sessionClear.resolve({ version: 1, nodes: {} });
  await restart;

  assert.equal(fixture.createdTerminals.length, 1);
  assert.notEqual(treeTYEngine.getTerminalSessionState("first").hostSessionId, "session-first");
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

    await assert.rejects(sessionCreation, error => error.canForget === false, arrival);
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

nodeTest.test("confirmation cannot create a third terminal when two native terminals claim the leaf", async (testContext) => {
  const fixture = createFixture({ terminals: [createTerminal({ name: "TreeTY: first", env: {} })] });
  testContext.after(() => fixture.host.dispose());
  await markRestoredTerminal(fixture, fixture.terminals[0], "first");
  fixture.terminals.push(createTerminal({ name: fixture.terminals[0].name, env: {} }));
  fixture.host.allowNextSessionCreation("first");

  await assert.rejects(
    fixture.host.createSession({ nodeId: "first", name: "first", cwd: "/tmp", env: {} }),
    error => error.canForget === false && /Multiple terminals/.test(error.message),
  );

  assert.equal(fixture.createdTerminals.length, 0);
  assert.ok(fixture.terminals.every(terminal => !terminal.wasDisposed));
});

nodeTest.test("concurrent launches in independent windows create one terminal for the shared leaf", async (testContext) => {
  const storage = createStorage();
  const firstFixture = createFixture({ storage, terminals: [] });
  const secondFixture = createFixture({ storage, terminals: [] });
  testContext.after(() => firstFixture.host.dispose());
  testContext.after(() => secondFixture.host.dispose());
  const terminalLaunchRequest = { nodeId: "first", name: "first", cwd: "/tmp", env: {} };

  const sessionCreations = await Promise.allSettled([
    firstFixture.host.createSession(terminalLaunchRequest),
    secondFixture.host.createSession(terminalLaunchRequest),
  ]);
  const rejectedCreations = sessionCreations.filter(sessionCreation => sessionCreation.status === "rejected");

  assert.equal(sessionCreations.filter(sessionCreation => sessionCreation.status === "fulfilled").length, 1);
  assert.equal(rejectedCreations.length, 1);
  assert.equal(rejectedCreations[0].reason.canForget, false);
  assert.match(rejectedCreations[0].reason.message, /another VS Code window/);
  assert.equal(firstFixture.createdTerminals.length + secondFixture.createdTerminals.length, 1);
  assert.equal(firstFixture.registry.getRecordsForNode({ configFilePath: "/tmp/tree.json", nodeId: "first" }).length, 1);
});

nodeTest.test("confirmation cannot replace a foreign owner", async (testContext) => {
  const storage = createStorage();
  const ownerFixture = createFixture({ storage, terminals: [] });
  testContext.after(() => ownerFixture.host.dispose());
  const recoveryRecord = await ownerFixture.registry.createRecord({
    configFilePath: "/tmp/tree.json", workspaceId: "workspace", sessionId: "existing-session", nodeId: "first",
  });
  const fixture = createFixture({ storage, terminals: [], registryOptions: { getProcessIsAlive: () => true } });
  testContext.after(() => fixture.host.dispose());
  fixture.host.allowNextSessionCreation("first");

  await assert.rejects(
    fixture.host.createSession({ nodeId: "first", name: "first", cwd: "/tmp", env: {} }),
    error => error.canForget === false && /another VS Code window/.test(error.message),
  );
  assert.equal(fixture.createdTerminals.length, 0);
  assert.notEqual(fixture.registry.getRecord(recoveryRecord.token).retired, true);
});

nodeTest.test("a saved running process without an active window owner allows explicit forgetting", async (testContext) => {
  const fixture = createFixture({ terminals: [], registryOptions: { getProcessIsAlive: () => true } });
  testContext.after(() => fixture.host.dispose());
  const recoveryRecord = await fixture.registry.createRecord({
    configFilePath: "/tmp/tree.json", workspaceId: "workspace", sessionId: "existing-session", nodeId: "first",
  });
  await fixture.registry.updateRecord(recoveryRecord.token, {
    ownerId: undefined, ownerProcessId: undefined, terminalProcessId: 123456,
  });
  const terminalLaunchRequest = { nodeId: "first", name: "first", cwd: "/tmp", env: {} };

  await assert.rejects(fixture.host.createSession(terminalLaunchRequest), error => error.canForget === true);
  fixture.host.allowNextSessionCreation("first");
  await fixture.host.createSession(terminalLaunchRequest);

  assert.equal(fixture.createdTerminals.length, 1);
  assert.equal(fixture.registry.getRecord(recoveryRecord.token).retired, true);
});

nodeTest.test("a retired token restored without another live owner is recovered instead of launching again", async (testContext) => {
  const fixture = createFixture({ terminals: [createTerminal({ name: "TreeTY: first", env: {} })] });
  testContext.after(() => fixture.host.dispose());
  const recoveryRecord = await markRestoredTerminal(fixture, fixture.terminals[0], "first");
  await fixture.registry.updateRecord(recoveryRecord.token, { retired: true });

  const hostedTerminalSession = await fixture.host.createSession({ nodeId: "first", name: "first", cwd: "/tmp", env: {} });

  assert.equal(hostedTerminalSession.id, "session-first");
  assert.equal(hostedTerminalSession.recovered, true);
  assert.equal(fixture.createdTerminals.length, 0);
  assert.equal(fixture.registry.getRecord(recoveryRecord.token).retired, false);
});

nodeTest.test("a retired token returning while another window owns the leaf cannot acquire it or start another terminal", async (testContext) => {
  const storage = createStorage();
  const ownerFixture = createFixture({ storage, terminals: [] });
  testContext.after(() => ownerFixture.host.dispose());
  await ownerFixture.host.createSession({ nodeId: "first", name: "first", cwd: "/tmp", env: {} });
  const fixture = createFixture({ storage, terminals: [createTerminal({ name: "TreeTY: first", env: {} })] });
  testContext.after(() => fixture.host.dispose());
  const recoveryRecord = await markRestoredTerminal(fixture, fixture.terminals[0], "first");
  await fixture.registry.updateRecord(recoveryRecord.token, { retired: true });

  assert.deepEqual(await fixture.host.getSessions(), []);
  fixture.host.allowNextSessionCreation("first");
  await assert.rejects(
    fixture.host.createSession({ nodeId: "first", name: "first", cwd: "/tmp", env: {} }),
    error => error.canForget === false,
  );
  assert.equal(fixture.createdTerminals.length, 0);
  assert.equal(ownerFixture.createdTerminals.length, 1);
  assert.equal(fixture.registry.getRecord(recoveryRecord.token).retired, true);
});

nodeTest.test("native user close preserves the identity until receiving-window state registration follows old state cleanup", { timeout: 2_000 }, async (testContext) => {
  const storage = createStorage();
  const fixture = createFixture({ storage });
  testContext.after(() => fixture.host.dispose());
  const terminal = fixture.terminals[0];
  const recoveryRecord = await markRestoredTerminal(fixture, terminal, "first");
  await fixture.host.getSessions();
  const sessionClear = createDeferred();
  const sessionClearStarted = createDeferred();
  testContext.after(() => sessionClear.resolve());
  const stateOperations = [];
  fixture.core.clearTreeNodeSession = async () => {
    stateOperations.push("old clear started");
    sessionClearStarted.resolve();
    await sessionClear.promise;
    stateOperations.push("old clear completed");

    return { version: 1, nodes: {} };
  };

  fixture.close(terminal, fixture.vscode.TerminalExitReason.User);
  await sessionClearStarted.promise;
  const receivingFixture = createFixture({ storage, terminals: [createTerminal({ name: terminal.name, env: {} })] });
  testContext.after(() => receivingFixture.host.dispose());
  receivingFixture.core.registerTreeNodeSession = async () => {
    stateOperations.push("new registration");

    return { version: 1, nodes: {} };
  };
  const recoveredSessions = receivingFixture.host.getSessions();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(stateOperations, ["old clear started"]);
  assert.ok(fixture.registry.getRecord(recoveryRecord.token));
  sessionClear.resolve();

  assert.deepEqual(await recoveredSessions, [{ id: "session-first", nodeId: "first" }]);
  assert.deepEqual(stateOperations, ["old clear started", "old clear completed", "new registration"]);
  assert.equal(receivingFixture.registry.getRecord(recoveryRecord.token).ownerId, receivingFixture.registry.ownerId);
});

nodeTest.test("a TreeTY-requested close removes identity even when VS Code reports a user close", async (testContext) => {
  const fixture = createFixture();
  testContext.after(() => fixture.host.dispose());
  const terminal = fixture.terminals[0];
  const recoveryRecord = await markRestoredTerminal(fixture, terminal, "first");
  await fixture.host.getSessions();
  terminal.dispose = () => fixture.close(terminal, fixture.vscode.TerminalExitReason.User);

  fixture.host.closeSession("session-first");
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fixture.registry.getRecord(recoveryRecord.token), undefined);
});

nodeTest.test("disposing an old host after Refresh cannot release the new host's binding in a shared registry", async (testContext) => {
  const fixture = createFixture();
  testContext.after(() => fixture.host.dispose());
  const terminal = fixture.terminals[0];
  const recoveryRecord = await markRestoredTerminal(fixture, terminal, "first");
  await fixture.host.getSessions();
  const previousBindingId = fixture.registry.getRecord(recoveryRecord.token).ownerBindingId;
  const refreshedFixture = createFixture({ storage: fixture.storage, registry: fixture.registry, terminals: [terminal] });
  testContext.after(() => refreshedFixture.host.dispose());
  await refreshedFixture.host.getSessions();
  const refreshedBindingId = fixture.registry.getRecord(recoveryRecord.token).ownerBindingId;

  fixture.host.dispose();
  await new Promise(resolve => setImmediate(resolve));

  assert.notEqual(refreshedBindingId, previousBindingId);
  assert.equal(fixture.registry.getRecord(recoveryRecord.token).ownerBindingId, refreshedBindingId);
  assert.equal(fixture.registry.getRecord(recoveryRecord.token).ownerId, fixture.registry.ownerId);
});

nodeTest.test("a terminal closing while its ownership claim waits leaves no record or registered session", async (testContext) => {
  const fixture = createFixture({ terminals: [createTerminal({ name: "TreeTY: first", env: {} })] });
  testContext.after(() => fixture.host.dispose());
  const terminal = fixture.terminals[0];
  const recoveryRecord = await markRestoredTerminal(fixture, terminal, "first");
  const ownershipClaim = createDeferred();
  const ownershipClaimStarted = createDeferred();
  testContext.after(() => ownershipClaim.resolve());
  const updateRecord = fixture.registry.updateRecord.bind(fixture.registry);
  fixture.registry.updateRecord = async (token, recordUpdate) => {
    if (recordUpdate.ownerBindingId) {
      ownershipClaimStarted.resolve();
      await ownershipClaim.promise;
    }

    return updateRecord(token, recordUpdate);
  };

  const hostedTerminalSessions = fixture.host.getSessions();
  await ownershipClaimStarted.promise;
  fixture.close(terminal);
  ownershipClaim.resolve();

  assert.deepEqual(await hostedTerminalSessions, []);
  assert.deepEqual(fixture.registeredSessions, []);
  assert.equal(fixture.registry.getRecord(recoveryRecord.token), undefined);
});

nodeTest.test("unavailable recovery storage still binds valid environment identity but blocks a new native launch", async (testContext) => {
  const registry = recoveryModule.exports.TerminalRecoveryRegistry.createUnavailable("host", "Recovery storage unavailable");
  const fixture = createFixture({ registry });
  testContext.after(() => fixture.host.dispose());
  fixture.vscode.window.terminals = [fixture.terminals[0]];
  fixture.terminals[0].name = `TreeTY: first [treety:${"A".repeat(22)}]`;

  assert.deepEqual(await fixture.host.getSessions(), [{ id: "session-first", nodeId: "first" }]);
  await assert.rejects(
    fixture.host.createSession({ nodeId: "second", name: "second", cwd: "/tmp", env: {} }),
    /Recovery storage unavailable/,
  );
  assert.equal(fixture.createdTerminals.length, 0);
});

nodeTest.test("unknown unrelated terminal opens do not schedule discovery or repeated registry scans", async (testContext) => {
  const scheduleTimeout = testContext.mock.method(globalThis, "setTimeout");
  const fixture = createFixture({ terminals: [] });
  testContext.after(() => fixture.host.dispose());
  const getSessions = testContext.mock.method(fixture.host, "getSessions");
  const refresh = testContext.mock.method(fixture.registry, "refresh");
  const unrelatedTerminal = createTerminal({ name: "Shell", env: {} });
  fixture.terminals.push(unrelatedTerminal);

  fixture.events.open(unrelatedTerminal);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(scheduleTimeout.mock.callCount(), 0);
  assert.equal(getSessions.mock.callCount(), 0);
  assert.equal(refresh.mock.callCount(), 0);
});

nodeTest.test("failure after reservation lock completion removes the saved claim and allows the next launch", async (testContext) => {
  const fixture = createFixture({ terminals: [] });
  testContext.after(() => fixture.host.dispose());
  const runWithNodeLock = fixture.registry.runWithNodeLock.bind(fixture.registry);
  let failLockCompletion = true;
  fixture.registry.runWithNodeLock = async (...arguments_) => {
    const operationResult = await runWithNodeLock(...arguments_);

    if (failLockCompletion) {
      failLockCompletion = false;

      throw new Error("Could not complete reservation lock");
    }

    return operationResult;
  };
  const terminalLaunchRequest = { nodeId: "first", name: "first", cwd: "/tmp", env: {} };

  await assert.rejects(fixture.host.createSession(terminalLaunchRequest), /Could not complete reservation lock/);

  assert.equal(fixture.createdTerminals.length, 0);
  assert.equal(fixture.clearedSessions.length, 1);
  assert.deepEqual(fixture.registry.getRecordsForNode({ configFilePath: "/tmp/tree.json", nodeId: "first" }), []);

  await fixture.host.createSession(terminalLaunchRequest);

  assert.equal(fixture.createdTerminals.length, 1);
});

nodeTest.test("late registration after an ambiguous close clears old state without clearing a receiving owner's state", { timeout: 2_000 }, async (testContext) => {
  for (const closeReason of ["User", "Shutdown"]) {
    for (const transferred of [false, true]) {
      const storage = createStorage();
      const fixture = createFixture({ storage, terminals: [createTerminal({ name: "TreeTY: first", env: {} })] });
      testContext.after(() => fixture.host.dispose());
      const terminal = fixture.terminals[0];
      const recoveryRecord = await markRestoredTerminal(fixture, terminal, "first");
      const registration = createDeferred();
      const registrationStarted = createDeferred();
      testContext.after(() => registration.resolve());
      const persistedSessionIds = new Set();
      fixture.core.registerTreeNodeSession = async (_config, _nodeId, sessionId) => {
        registrationStarted.resolve();
        await registration.promise;
        persistedSessionIds.add(sessionId);

        return { version: 1, nodes: {} };
      };
      fixture.core.clearTreeNodeSession = async (_config, _nodeId, sessionId) => {
        fixture.clearedSessions.push(sessionId);
        persistedSessionIds.delete(sessionId);

        return { version: 1, nodes: {} };
      };

      const hostedTerminalSessions = fixture.host.getSessions();
      await registrationStarted.promise;
      fixture.close(terminal, fixture.vscode.TerminalExitReason[closeReason]);
      await new Promise(resolve => setImmediate(resolve));

      assert.equal(fixture.clearedSessions.length, 1);
      assert.equal(fixture.registry.getRecord(recoveryRecord.token).ownerId, undefined);
      let receivingFixture;

      if (transferred) {
        receivingFixture = createFixture({ storage, terminals: [createTerminal({ name: terminal.name, env: {} })] });
        testContext.after(() => receivingFixture.host.dispose());
        receivingFixture.core.registerTreeNodeSession = async (_config, _nodeId, sessionId) => {
          persistedSessionIds.add(sessionId);

          return { version: 1, nodes: {} };
        };

        assert.deepEqual(await receivingFixture.host.getSessions(), [{ id: "session-first", nodeId: "first" }]);
      }

      registration.resolve();

      assert.deepEqual(await hostedTerminalSessions, []);
      assert.deepEqual([...persistedSessionIds], transferred ? ["session-first"] : []);
      assert.equal(fixture.clearedSessions.length, transferred ? 1 : 2);
      assert.equal(fixture.registry.getRecord(recoveryRecord.token).ownerId, receivingFixture?.registry.ownerId);
    }
  }
});

nodeTest.test("a native user close with a confirmed dead process requires explicit forgetting before reopening", async (testContext) => {
  const terminalProcessId = 123456;
  let terminalProcessIsAlive = true;
  const fixture = createFixture({
    terminals: [],
    terminalProcessId,
    registryOptions: { getProcessIsAlive: processId => processId !== terminalProcessId || terminalProcessIsAlive },
  });
  testContext.after(() => fixture.host.dispose());
  const terminalLaunchRequest = { nodeId: "first", name: "first", cwd: "/tmp", env: {} };
  const originalSession = await fixture.host.createSession(terminalLaunchRequest);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.registry.getRecord(fixture.recordAtCreation.token).terminalProcessId, terminalProcessId);

  fixture.close(fixture.createdTerminals[0], fixture.vscode.TerminalExitReason.User);
  await new Promise(resolve => setImmediate(resolve));
  terminalProcessIsAlive = false;

  await assert.rejects(fixture.host.createSession(terminalLaunchRequest), error => error.canForget === true);
  fixture.host.allowNextSessionCreation("first");
  const reopenedSession = await fixture.host.createSession(terminalLaunchRequest);

  assert.notEqual(reopenedSession.id, originalSession.id);
  assert.equal(fixture.createdTerminals.length, 2);
});

nodeTest.test("a native user close with a live PID and no owner allows explicit forgetting", async (testContext) => {
  const fixture = createFixture({
    terminals: [], terminalProcessId: 123456, registryOptions: { getProcessIsAlive: () => true },
  });
  testContext.after(() => fixture.host.dispose());
  const terminalLaunchRequest = { nodeId: "first", name: "first", cwd: "/tmp", env: {} };
  await fixture.host.createSession(terminalLaunchRequest);
  const recoveryRecord = fixture.recordAtCreation;
  await new Promise(resolve => setImmediate(resolve));
  fixture.close(fixture.createdTerminals[0], fixture.vscode.TerminalExitReason.User);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fixture.registry.getRecord(recoveryRecord.token).ownerId, undefined);
  await assert.rejects(fixture.host.createSession(terminalLaunchRequest), error => error.canForget === true);
  fixture.host.allowNextSessionCreation("first");
  await fixture.host.createSession(terminalLaunchRequest);

  assert.equal(fixture.createdTerminals.length, 2);
  assert.equal(fixture.registry.getRecord(recoveryRecord.token).retired, true);
});

nodeTest.test("a transferred user-closed session with a dead original PID blocks replacement until its revived token recovers", async (testContext) => {
  const storage = createStorage();
  const originalProcessId = 123456;
  const revivedProcessId = 654321;
  let originalProcessIsAlive = true;
  const registryOptions = { getProcessIsAlive: processId => processId !== originalProcessId || originalProcessIsAlive };
  const fixture = createFixture({ storage, registryOptions, terminals: [], terminalProcessId: originalProcessId });
  testContext.after(async () => {
    fixture.host.dispose();
    await fixture.host.flushSessionCleanup();
  });
  const terminalLaunchRequest = { nodeId: "first", name: "first", cwd: "/tmp", env: {} };
  const originalSession = await fixture.host.createSession(terminalLaunchRequest);
  const recoveryRecord = fixture.recordAtCreation;
  const originalTerminal = fixture.createdTerminals[0];
  await new Promise(resolve => setImmediate(resolve));
  fixture.close(originalTerminal, fixture.vscode.TerminalExitReason.User);
  await fixture.host.flushSessionCleanup();
  originalProcessIsAlive = false;

  // The destination can revive the same native tab before TreeTY activates there.
  const revivedTerminal = createTerminal({ name: originalTerminal.name, env: {} });
  revivedTerminal.processId = Promise.resolve(revivedProcessId);

  await assert.rejects(fixture.host.createSession(terminalLaunchRequest), error => error.canForget === true);
  assert.equal(fixture.createdTerminals.length, 1);
  assert.notEqual(fixture.registry.getRecord(recoveryRecord.token).retired, true);

  const receivingFixture = createFixture({ storage, registryOptions, terminals: [revivedTerminal] });
  testContext.after(async () => {
    receivingFixture.host.dispose();
    await receivingFixture.host.flushSessionCleanup();
  });

  assert.deepEqual(await receivingFixture.host.getSessions(), [originalSession]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(receivingFixture.registry.getRecord(recoveryRecord.token).terminalProcessId, revivedProcessId);
  await assert.rejects(fixture.host.createSession(terminalLaunchRequest), error => error.canForget === false);
  assert.equal(fixture.createdTerminals.length, 1);
  assert.equal(receivingFixture.createdTerminals.length, 0);
});

nodeTest.test("a transferred session keeps its active window ownership even when the recorded PID appears dead", async (testContext) => {
  const storage = createStorage();
  const terminalProcessId = 123456;
  let terminalProcessIsAlive = true;
  const registryOptions = { getProcessIsAlive: processId => processId !== terminalProcessId || terminalProcessIsAlive };
  const fixture = createFixture({ storage, terminals: [], terminalProcessId, registryOptions });
  testContext.after(() => fixture.host.dispose());
  const terminalLaunchRequest = { nodeId: "first", name: "first", cwd: "/tmp", env: {} };
  const originalSession = await fixture.host.createSession(terminalLaunchRequest);
  const terminal = fixture.createdTerminals[0];
  await new Promise(resolve => setImmediate(resolve));
  fixture.close(terminal, fixture.vscode.TerminalExitReason.User);
  await new Promise(resolve => setImmediate(resolve));
  const receivingFixture = createFixture({
    storage, registryOptions, terminals: [createTerminal({ name: terminal.name, env: {} })],
  });
  testContext.after(() => receivingFixture.host.dispose());

  assert.deepEqual(await receivingFixture.host.getSessions(), [originalSession]);
  terminalProcessIsAlive = false;
  fixture.host.allowNextSessionCreation("first");

  await assert.rejects(
    fixture.host.createSession(terminalLaunchRequest),
    error => error.canForget === false && /another VS Code window/.test(error.message),
  );
  assert.equal(fixture.createdTerminals.length, 1);
  assert.equal(receivingFixture.createdTerminals.length, 0);
});

nodeTest.test("shutdown reopening respects the originating window's persistence settings and known process state", async (testContext) => {
  const scenarios = [
    { name: "persistence disabled", source: { enablePersistentSessions: false }, destination: { enablePersistentSessions: false }, processId: 123456, shouldReopen: true },
    { name: "source disabled and destination default", source: { enablePersistentSessions: false }, destination: {}, processId: 123456, shouldReopen: true },
    { name: "revival disabled and process dead", source: { persistentSessionReviveProcess: "never" }, destination: {}, processId: 123456, shouldReopen: true },
    { name: "default persistence and process dead", source: {}, destination: {}, processId: 123456, shouldReopen: false },
    { name: "source default and destination disabled", source: {}, destination: { enablePersistentSessions: false }, processId: 123456, shouldReopen: false },
    { name: "revival disabled without a recorded PID", source: { persistentSessionReviveProcess: "never" }, destination: { persistentSessionReviveProcess: "never" }, shouldReopen: false },
  ];

  for (const scenario of scenarios) {
    await testContext.test(scenario.name, async (scenarioContext) => {
      const storage = createStorage();
      let terminalProcessIsAlive = true;
      const registryOptions = { getProcessIsAlive: processId => processId !== scenario.processId || terminalProcessIsAlive };
      const fixture = createFixture({
        storage, registryOptions, terminals: [], terminalProcessId: scenario.processId,
        configuration: Object.fromEntries(Object.entries(scenario.source).map(([name, value]) => [`terminal.integrated.${name}`, value])),
      });
      scenarioContext.after(() => fixture.host.dispose());
      await fixture.host.createSession({ nodeId: "first", name: "first", cwd: "/tmp", env: {} });
      await new Promise(resolve => setImmediate(resolve));
      fixture.close(fixture.createdTerminals[0], fixture.vscode.TerminalExitReason.Shutdown);
      await new Promise(resolve => setImmediate(resolve));
      terminalProcessIsAlive = false;
      fixture.host.dispose();
      const reopenedFixture = createFixture({
        storage, registryOptions, terminals: [],
        configuration: Object.fromEntries(Object.entries(scenario.destination).map(([name, value]) => [`terminal.integrated.${name}`, value])),
      });
      reopenedFixture.resolvedTreeConfig.tree[0].restartPolicy = "onOpen";
      const treeTYEngine = new engineModule.exports.TreeTYEngine(reopenedFixture.resolvedTreeConfig, reopenedFixture.host);
      scenarioContext.after(() => treeTYEngine.dispose());

      await treeTYEngine.start();

      assert.equal(reopenedFixture.createdTerminals.length, scenario.shouldReopen ? 1 : 0, scenario.name);
      assert.equal(Boolean(treeTYEngine.getTerminalSessionState("first").hostSessionId), scenario.shouldReopen, scenario.name);
    });
  }
});

nodeTest.test("a terminal restored during shutdown retirement keeps its identity and prevents a replacement launch", { timeout: 2_000 }, async (testContext) => {
  const fixture = createFixture({ terminals: [] });
  testContext.after(() => fixture.host.dispose());
  const recoveryRecord = await fixture.registry.createRecord({
    configFilePath: "/tmp/tree.json", workspaceId: "workspace", sessionId: "previous-session", nodeId: "first",
  });
  await fixture.registry.updateRecord(recoveryRecord.token, {
    ownerId: undefined, ownerProcessId: undefined, closeReason: "shutdown", persistence: "disabled",
  });
  const recoveryKey = fixture.storage.keys().find(key => fixture.storage.get(key)?.token === recoveryRecord.token);
  const retirementStarted = createDeferred();
  const retirement = createDeferred();
  testContext.after(() => retirement.resolve());
  const updateStorage = fixture.storage.update.bind(fixture.storage);
  let retirementPaused = false;
  fixture.storage.update = async (key, value) => {
    if (key === recoveryKey && (value === undefined || value.retired) && !retirementPaused) {
      retirementPaused = true;
      retirementStarted.resolve();
      await retirement.promise;
    }

    await updateStorage(key, value);
  };
  const sessionCreations = Promise.allSettled([
    fixture.host.createSession({ nodeId: "first", name: "first", cwd: "/tmp", env: {} }),
  ]);
  await retirementStarted.promise;
  const restoredTerminal = createTerminal({ name: `TreeTY: first [treety:${recoveryRecord.token}]`, env: {} });
  fixture.terminals.push(restoredTerminal);
  fixture.events.open(restoredTerminal);
  retirement.resolve();
  const [sessionCreation] = await sessionCreations;

  if (sessionCreation.status === "fulfilled") {
    assert.equal(sessionCreation.value.id, recoveryRecord.sessionId);
  } else {
    assert.equal(sessionCreation.reason.canForget, false);
  }

  assert.equal(fixture.createdTerminals.length, 0);
  assert.ok(fixture.registry.getRecord(recoveryRecord.token));
  assert.deepEqual(await fixture.host.getSessions(), [{ id: recoveryRecord.sessionId, nodeId: "first" }]);
  assert.equal(fixture.registry.getRecord(recoveryRecord.token).retired, false);
});

nodeTest.test("disposal flush waits for a pending launch registration and removes its reservation", { timeout: 2_000 }, async (testContext) => {
  const fixture = createFixture({ terminals: [] });
  const registrationStarted = createDeferred();
  const registration = createDeferred();
  const persistedSessionIds = new Set();
  testContext.after(async () => {
    registration.resolve();
    fixture.host.dispose();
    await fixture.host.flushSessionCleanup();
  });
  fixture.core.registerTreeNodeSession = async (_config, _nodeId, sessionId) => {
    fixture.registeredSessions.push(sessionId);
    registrationStarted.resolve();
    await registration.promise;
    persistedSessionIds.add(sessionId);

    return { version: 1, nodes: {} };
  };
  fixture.core.clearTreeNodeSession = async (_config, _nodeId, sessionId) => {
    fixture.clearedSessions.push(sessionId);
    persistedSessionIds.delete(sessionId);

    return { version: 1, nodes: {} };
  };
  const sessionCreation = fixture.host.createSession({ nodeId: "first", name: "first", cwd: "/tmp", env: {} });
  const rejectedSessionCreation = assert.rejects(sessionCreation, /disposed before launch/);
  await registrationStarted.promise;
  fixture.host.dispose();
  let cleanupFlushed = false;
  const cleanupFlush = fixture.host.flushSessionCleanup().then(() => { cleanupFlushed = true; });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(cleanupFlushed, false);
  assert.equal(fixture.registry.getRecordsForNode({ configFilePath: "/tmp/tree.json", nodeId: "first" }).length, 1);
  registration.resolve();
  await cleanupFlush;
  await rejectedSessionCreation;

  assert.deepEqual(fixture.clearedSessions, fixture.registeredSessions);
  assert.deepEqual([...persistedSessionIds], []);
  assert.deepEqual(fixture.registry.getRecordsForNode({ configFilePath: "/tmp/tree.json", nodeId: "first" }), []);
  assert.equal(fixture.createdTerminals.length, 0);
});

nodeTest.test("disposal flush waits for native close cleanup to persist", { timeout: 2_000 }, async (testContext) => {
  for (const closeReason of ["User", "Shutdown", "Process"]) {
    await testContext.test(closeReason, async (scenarioContext) => {
      const fixture = createFixture({ terminals: [], configuration: { "terminal.integrated.enablePersistentSessions": false } });
      const cleanupStarted = createDeferred();
      const cleanup = createDeferred();
      scenarioContext.after(async () => {
        cleanup.resolve();
        fixture.host.dispose();
        await fixture.host.flushSessionCleanup();
      });
      const hostedTerminalSession = await fixture.host.createSession({ nodeId: "first", name: "first", cwd: "/tmp", env: {} });
      const recoveryRecord = fixture.recordAtCreation;
      const updateStorage = fixture.storage.update.bind(fixture.storage);
      fixture.storage.update = async (key, value) => {
        cleanupStarted.resolve();
        await cleanup.promise;
        await updateStorage(key, value);
      };

      fixture.close(fixture.createdTerminals[0], fixture.vscode.TerminalExitReason[closeReason]);
      fixture.host.dispose();
      let cleanupFlushed = false;
      const cleanupFlush = fixture.host.flushSessionCleanup().then(() => { cleanupFlushed = true; });
      await cleanupStarted.promise;
      await new Promise(resolve => setImmediate(resolve));

      assert.equal(cleanupFlushed, false);
      assert.equal(fixture.registry.getRecord(recoveryRecord.token).ownerId, fixture.registry.ownerId);
      cleanup.resolve();
      await cleanupFlush;

      assert.deepEqual(fixture.clearedSessions, [hostedTerminalSession.id]);

      if (closeReason === "Process") {
        assert.equal(fixture.registry.getRecord(recoveryRecord.token), undefined);

        return;
      }

      const retainedRecoveryRecord = fixture.registry.getRecord(recoveryRecord.token);
      assert.equal(retainedRecoveryRecord.ownerId, undefined);
      assert.equal(retainedRecoveryRecord.ownerBindingId, undefined);
      assert.equal(retainedRecoveryRecord.ownerProcessId, undefined);
      assert.equal(retainedRecoveryRecord.closeReason, closeReason.toLowerCase());
      assert.equal(retainedRecoveryRecord.persistence, closeReason === "Shutdown" ? "disabled" : undefined);
    });
  }
});

nodeTest.test("disposal records an already visible shutdown status before its close event and permits reopening", async (testContext) => {
  const storage = createStorage();
  const fixture = createFixture({ storage, terminals: [], configuration: { "terminal.integrated.enablePersistentSessions": false } });
  testContext.after(async () => {
    fixture.host.dispose();
    await fixture.host.flushSessionCleanup();
  });
  const terminalLaunchRequest = { nodeId: "first", name: "first", cwd: "/tmp", env: {} };
  const originalSession = await fixture.host.createSession(terminalLaunchRequest);
  const recoveryRecord = fixture.recordAtCreation;
  const terminal = fixture.createdTerminals[0];
  terminal.exitStatus = { code: undefined, reason: fixture.vscode.TerminalExitReason.Shutdown };
  fixture.vscode.window.terminals = [];

  fixture.host.dispose();
  await fixture.host.flushSessionCleanup();

  const closedRecoveryRecord = fixture.registry.getRecord(recoveryRecord.token);
  assert.equal(closedRecoveryRecord.closeReason, "shutdown");
  assert.equal(closedRecoveryRecord.persistence, "disabled");
  assert.equal(closedRecoveryRecord.ownerId, undefined);
  assert.deepEqual(fixture.clearedSessions, [originalSession.id]);
  assert.equal(terminal.wasDisposed, false);
  const reopenedFixture = createFixture({ storage, terminals: [] });
  testContext.after(async () => {
    reopenedFixture.host.dispose();
    await reopenedFixture.host.flushSessionCleanup();
  });
  const reopenedSession = await reopenedFixture.host.createSession(terminalLaunchRequest);

  assert.notEqual(reopenedSession.id, originalSession.id);
  assert.equal(reopenedFixture.createdTerminals.length, 1);
  assert.equal(reopenedFixture.registry.getRecord(recoveryRecord.token).retired, true);
});

nodeTest.test("disposal flush releases a live terminal's owner once without closing it or marking shutdown", { timeout: 2_000 }, async (testContext) => {
  const fixture = createFixture({
    terminals: [], terminalProcessId: 123456, configuration: { "terminal.integrated.enablePersistentSessions": false },
  });
  const cleanupStarted = createDeferred();
  const cleanup = createDeferred();
  testContext.after(async () => {
    cleanup.resolve();
    fixture.host.dispose();
    await fixture.host.flushSessionCleanup();
  });
  await fixture.host.createSession({ nodeId: "first", name: "first", cwd: "/tmp", env: {} });
  await new Promise(resolve => setImmediate(resolve));
  const recoveryRecord = fixture.recordAtCreation;
  const terminal = fixture.createdTerminals[0];
  const updateStorage = fixture.storage.update.bind(fixture.storage);
  let cleanupWrites = 0;
  fixture.storage.update = async (key, value) => {
    cleanupWrites += 1;
    cleanupStarted.resolve();
    await cleanup.promise;
    await updateStorage(key, value);
  };

  fixture.host.dispose();
  fixture.host.dispose();
  let cleanupFlushed = false;
  const cleanupFlush = fixture.host.flushSessionCleanup().then(() => { cleanupFlushed = true; });
  await cleanupStarted.promise;
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(cleanupFlushed, false);
  cleanup.resolve();
  await cleanupFlush;

  const retainedRecoveryRecord = fixture.registry.getRecord(recoveryRecord.token);
  assert.equal(cleanupWrites, 1);
  assert.equal(retainedRecoveryRecord.ownerId, undefined);
  assert.equal(retainedRecoveryRecord.ownerBindingId, undefined);
  assert.equal(retainedRecoveryRecord.ownerProcessId, undefined);
  assert.equal(retainedRecoveryRecord.terminalProcessId, 123456);
  assert.equal(retainedRecoveryRecord.closeReason, undefined);
  assert.equal(retainedRecoveryRecord.persistence, undefined);
  assert.deepEqual(fixture.clearedSessions, []);
  assert.equal(terminal.wasDisposed, false);
  assert.deepEqual(fixture.terminals, [terminal]);
  const reopenedFixture = createFixture({ storage: fixture.storage, terminals: [], registryOptions: { getProcessIsAlive: () => false } });
  testContext.after(async () => {
    reopenedFixture.host.dispose();
    await reopenedFixture.host.flushSessionCleanup();
  });

  await assert.rejects(
    reopenedFixture.host.createSession({ nodeId: "first", name: "first", cwd: "/tmp", env: {} }),
    error => error.canForget === true,
  );
  assert.equal(reopenedFixture.createdTerminals.length, 0);
});

nodeTest.test("disposal flush reports failed close cleanup and settles without an unhandled rejection", { timeout: 2_000 }, async (testContext) => {
  const fixture = createFixture({ terminals: [] });
  testContext.after(async () => {
    fixture.host.dispose();
    await fixture.host.flushSessionCleanup();
  });
  const hostedTerminalSession = await fixture.host.createSession({ nodeId: "first", name: "first", cwd: "/tmp", env: {} });
  const stateError = new Error("Could not clear session state");
  const storageError = new Error("Could not release session owner");
  const reportError = testContext.mock.method(console, "error", () => {});
  fixture.core.clearTreeNodeSession = async (_config, _nodeId, sessionId) => {
    fixture.clearedSessions.push(sessionId);

    throw stateError;
  };
  fixture.storage.update = async () => { throw storageError; };

  fixture.close(fixture.createdTerminals[0], fixture.vscode.TerminalExitReason.User);
  fixture.host.dispose();
  await fixture.host.flushSessionCleanup();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(fixture.clearedSessions, [hostedTerminalSession.id]);
  assert.equal(reportError.mock.callCount(), 1);
  const cleanupError = reportError.mock.calls[0].arguments[1];
  assert.equal(cleanupError instanceof AggregateError, true);
  assert.deepEqual(cleanupError.errors, [stateError, storageError]);
  await fixture.host.flushSessionCleanup();
});

function createFixture(options = {}) {
  const events = {};
  const registeredSessions = [];
  const clearedSessions = [];
  const activityClears = [];
  const createdTerminals = [];
  const storage = options.storage ?? createStorage();
  const registry = options.registry ?? new recoveryModule.exports.TerminalRecoveryRegistry(storage, "host", {
    owner: { start: async () => {}, shutdown: async () => {} },
    getOwnerLiveness: async () => "alive",
    ...options.registryOptions,
  });
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
    workspace: {
      getConfiguration: section => ({
        get: (name, defaultValue) => options.configuration?.[`${section}.${name}`] ?? defaultValue,
      }),
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
    terminal.processId = Promise.resolve(options.terminalProcessId);
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
  await fixture.registry.updateRecord(recoveryRecord.token, { ownerId: undefined, ownerProcessId: undefined });
  terminal.name = `TreeTY: ${nodeId} [treety:${recoveryRecord.token}]`;
  terminal.creationOptions = { env: {} };

  return recoveryRecord;
}

function createDeferred() {
  let resolve;
  const promise = new Promise(promiseResolve => { resolve = promiseResolve; });

  return { promise, resolve };
}
