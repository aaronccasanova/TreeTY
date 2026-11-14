import * as assert from "node:assert/strict";
import * as nodeTest from "node:test";

import { resolveTreeConfig } from "@treety/core";
import type { HostedTerminalSession, TreeTYEngine } from "@treety/core";
import type * as vscode from "vscode";

import {
  handleTerminalLink,
  revealTerminalLink,
  TerminalLinkManager,
} from "./terminal-links";
import type { TerminalLinkTarget, TerminalLinkUri } from "./terminal-links";
import type { VscodeTerminalHost } from "./vscode-terminal-host";
import type { ConfiguredWorkspaceModel, WorkspaceModel } from "./workspace-model";

nodeTest.test("resolves the complete link and preserves opaque external URI serialization", async () => {
  const target = {
    configUri: "file:///tmp/a%20%26%2B%25%23%E6%BC%A2/.treety/tree.json",
    nodeId: "leaf & + % # / 漢字",
    sessionId: "session-123",
  };
  let resolvedUri: TerminalLinkUri | undefined;
  const terminalLinks = new TerminalLinkManager({
    extensionId: "TreeTY.treety",
    uriScheme: "vscode-insiders",
    resolveExternalUri: async (uri) => {
      resolvedUri = uri;

      return `vscode-insiders://treety.treety/open?${encodeURIComponent(`${uri.query}&windowId=17`)}`;
    },
  });
  const terminalLink = await terminalLinks.createTerminalLink(target);

  assert.ok(resolvedUri);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(resolvedUri.query)), target);
  assert.equal(resolvedUri.scheme, "vscode-insiders");
  assert.equal(resolvedUri.authority, "treety.treety");
  assert.equal(
    terminalLink,
    `vscode-insiders://treety.treety/open?${encodeURIComponent(`${resolvedUri.query}&windowId=17`)}`,
  );
  assert.deepEqual(
    terminalLinks.parseTerminalLink({
      ...resolvedUri,
      query: decodeURIComponent(new URL(terminalLink).search.slice(1)),
    }),
    target,
  );
});

nodeTest.test("rejects malformed and unsupported incoming links", () => {
  const terminalLinks = createTerminalLinks();
  const uri = createTerminalLinkUri();

  for (const changedUri of [
    { ...uri, scheme: "https" },
    { ...uri, authority: "other.extension" },
    { ...uri, path: "/execute" },
    { ...uri, fragment: "command" },
    { ...uri, query: `${uri.query}&nodeId=other` },
    { ...uri, query: "configUri=%ZZ&nodeId=leaf&sessionId=session-123" },
    { ...uri, query: "configUri=file%3A%2F%2F%2Ftmp%2Ftree.json&nodeId=leaf" },
    { ...uri, query: new URLSearchParams({ configUri: "https://example.com/tree.json", nodeId: "leaf", sessionId: "session-123" }).toString() },
    { ...uri, query: new URLSearchParams({ configUri: "file:///tmp/tree.json", nodeId: "leaf\n", sessionId: "session-123" }).toString() },
  ]) {
    assert.throws(() => terminalLinks.parseTerminalLink(changedUri));
  }
});

nodeTest.test("local links cannot be created or consumed in a remote window", async () => {
  const terminalLinks = new TerminalLinkManager({
    extensionId: "TreeTY.treety",
    uriScheme: "vscode",
    remoteName: "ssh-remote",
    resolveExternalUri: async () => {
      throw new Error("must not resolve");
    },
  });

  await assert.rejects(terminalLinks.createTerminalLink(createTarget()), /local desktop/);
  assert.throws(() => terminalLinks.parseTerminalLink(createTerminalLinkUri()), /local desktop/);
});

nodeTest.test("URI handling waits for startup before revealing and propagates initialization failure", async () => {
  const calls: string[] = [];
  let finishStartup: (() => void) | undefined;
  const startup = new Promise<void>((resolve) => {
    finishStartup = resolve;
  });
  const handling = handleTerminalLink({
    startup,
    terminalLinks: createTerminalLinks(),
    uri: createTerminalLinkUri(),
    revealTerminalLink: async () => {
      calls.push("reveal");
    },
  });

  await Promise.resolve();
  assert.deepEqual(calls.slice(), []);
  finishStartup?.();
  await handling;
  assert.deepEqual(calls.slice(), ["reveal"]);

  await assert.rejects(
    handleTerminalLink({
      startup: Promise.reject(new Error("startup failed")),
      terminalLinks: createTerminalLinks(),
      uri: createTerminalLinkUri(),
      revealTerminalLink: async () => {
        calls.push("must not reveal");
      },
    }),
    /startup failed/,
  );
  assert.deepEqual(calls.slice(), ["reveal"]);
});

nodeTest.test("reveals only the exact configuration and live session, then clears attention", async () => {
  const fixture = createFixture();
  const otherFixture = createFixture("file:///other/.treety/tree.json");

  await revealTerminalLink({
    target: fixture.target,
    workspaceModels: [otherFixture.workspaceModel, fixture.workspaceModel],
    validateTerminal: async () => { fixture.calls.push("validate"); },
    clearAttention: async () => { fixture.calls.push("clear attention"); },
  });

  assert.deepEqual(fixture.calls, ["validate", "sessions", "focus session-123", "clear attention"]);
  assert.deepEqual(otherFixture.calls, []);

  // A new manager after extension reload still recognizes the recovered native session.
  assert.deepEqual(createTerminalLinks().parseTerminalLink(createTerminalLinkUri()), fixture.target);
});

nodeTest.test("wrong window, removed nodes, groups, and stopped or replaced sessions never reveal", async () => {
  const fixture = createFixture();
  const targets = [
    { ...fixture.target, configUri: "file:///other/.treety/tree.json" },
    { ...fixture.target, nodeId: "deleted" },
    { ...fixture.target, nodeId: "group" },
    { ...fixture.target, sessionId: "replaced-session" },
  ];

  for (const target of targets) {
    await assert.rejects(revealTerminalLink({
      target,
      workspaceModels: [fixture.workspaceModel],
      validateTerminal: async () => {},
      clearAttention: async () => { throw new Error("must not clear"); },
    }));
  }

  fixture.sessions.length = 0;

  await assert.rejects(revealTerminalLink({
    target: fixture.target,
    workspaceModels: [fixture.workspaceModel],
    validateTerminal: async () => {},
    clearAttention: async () => { throw new Error("must not clear"); },
  }), /no longer running/);
  assert.equal(fixture.calls.some((call) => call.startsWith("focus")), false);
});

nodeTest.test("latest configuration validation fails before touching any live session", async () => {
  const fixture = createFixture();

  await assert.rejects(revealTerminalLink({
    target: fixture.target,
    workspaceModels: [fixture.workspaceModel],
    validateTerminal: async () => { throw new Error("terminal was deleted from disk"); },
    clearAttention: async () => { throw new Error("must not clear"); },
  }), /deleted from disk/);
  assert.deepEqual(fixture.calls, []);

  for (const kind of ["invalid", "unconfigured"] as const) {
    await assert.rejects(revealTerminalLink({
      target: fixture.target,
      workspaceModels: [{ ...fixture.workspaceModel, kind } as WorkspaceModel],
      validateTerminal: async () => { throw new Error("must not read"); },
      clearAttention: async () => { throw new Error("must not clear"); },
    }), /missing or invalid/);
  }
});

function createTarget(): TerminalLinkTarget {
  return {
    configUri: "file:///tmp/.treety/tree.json",
    nodeId: "leaf",
    sessionId: "session-123",
  };
}

function createTerminalLinkUri(): TerminalLinkUri {
  return {
    scheme: "vscode",
    authority: "treety.treety",
    path: "/open",
    query: new URLSearchParams({ ...createTarget() }).toString(),
    fragment: "",
  };
}

function createTerminalLinks(): TerminalLinkManager {
  return new TerminalLinkManager({
    extensionId: "TreeTY.treety",
    uriScheme: "vscode",
    resolveExternalUri: async (uri) => `vscode://treety.treety/open?${encodeURIComponent(uri.query)}`,
  });
}

function createFixture(configUri = "file:///tmp/.treety/tree.json") {
  const calls: string[] = [];
  const target = { ...createTarget(), configUri };
  const sessions: HostedTerminalSession[] = [{ id: "session-123", nodeId: "leaf" }];
  const workspaceModel: ConfiguredWorkspaceModel = {
    kind: "configured",
    id: configUri,
    name: "Test tree",
    configFileUri: { toString: () => configUri } as vscode.Uri,
    stateFileUri: {} as vscode.Uri,
    workspaceDirUri: {} as vscode.Uri,
    configSource: "workspace",
    treeConfig: { version: 1, tree: [] },
    treeState: { version: 1, nodes: {} },
    treeTYEngine: {} as TreeTYEngine,
    resolvedTreeConfig: resolveTreeConfig({
      version: 1,
      tree: [{ kind: "group", id: "group", name: "Group", children: [
        { kind: "terminal", id: "leaf", name: "Leaf" },
      ] }],
    }, "/tmp"),
    vscodeTerminalHost: {
      getSessions: async () => {
        calls.push("sessions");

        return sessions;
      },
      revealSession: (sessionId: string) => {
        calls.push(`focus ${sessionId}`);
      },
    } as unknown as VscodeTerminalHost,
  };

  return { calls, sessions, target, workspaceModel };
}
