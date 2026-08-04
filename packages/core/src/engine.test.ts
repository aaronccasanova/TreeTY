import * as assert from "node:assert/strict";
import * as test from "node:test";

import {
  Disposable,
  HostedTerminalSession,
  ResolvedTreeConfig,
  TerminalHost,
  TerminalHostEvent,
  TerminalHostEventListener,
  TerminalLaunchRequest,
  TreeTYEngine,
} from "./index";

class FakeTerminalHost implements TerminalHost {
  public readonly terminalLaunchRequests: TerminalLaunchRequest[] = [];

  public readonly revealedSessionIds: string[] = [];

  public readonly closedSessionIds: string[] = [];

  public hostedTerminalSessions: HostedTerminalSession[] = [];

  private readonly terminalHostEventListeners = new Set<TerminalHostEventListener>();

  public async getSessions(): Promise<HostedTerminalSession[]> {
    return this.hostedTerminalSessions;
  }

  public async createSession(
    terminalLaunchRequest: TerminalLaunchRequest,
  ): Promise<HostedTerminalSession> {
    this.terminalLaunchRequests.push(terminalLaunchRequest);

    const hostedTerminalSession = {
      id: `session-${this.terminalLaunchRequests.length}`,
      nodeId: terminalLaunchRequest.nodeId,
    };

    this.hostedTerminalSessions.push(hostedTerminalSession);

    return hostedTerminalSession;
  }

  public revealSession(hostSessionId: string): void {
    this.revealedSessionIds.push(hostSessionId);
  }

  public closeSession(hostSessionId: string): void {
    this.closedSessionIds.push(hostSessionId);
  }

  public subscribe(
    terminalHostEventListener: TerminalHostEventListener,
  ): Disposable {
    this.terminalHostEventListeners.add(terminalHostEventListener);

    return {
      dispose: () => {
        this.terminalHostEventListeners.delete(terminalHostEventListener);
      },
    };
  }

  public emitHostEvent(terminalHostEvent: TerminalHostEvent): void {
    for (const terminalHostEventListener of this.terminalHostEventListeners) {
      terminalHostEventListener(terminalHostEvent);
    }
  }

  public dispose(): void {
    this.terminalHostEventListeners.clear();
  }
}

const resolvedTreeConfig: ResolvedTreeConfig = {
  version: 1,
  workspaceDirPath: "/workspace",
  tree: [
    {
      kind: "terminal",
      id: "shell",
      name: "Shell",
      cwd: "/workspace",
      env: {},
      restartPolicy: "manual",
    },
    {
      kind: "terminal",
      id: "worker",
      name: "Worker",
      cwd: "/workspace",
      env: {},
      metadata: {
        owner: "platform",
      },
      restartPolicy: "onOpen",
      command: {
        executable: "pnpm",
        args: ["run", "worker"],
      },
    },
  ],
};

test.test("reattaches restored sessions and reveals them without duplication", async () => {
  const terminalHost = new FakeTerminalHost();

  terminalHost.hostedTerminalSessions = [
    {
      id: "restored-shell",
      nodeId: "shell",
    },
  ];

  const treeTYEngine = new TreeTYEngine(resolvedTreeConfig, terminalHost);

  await treeTYEngine.start();
  await treeTYEngine.openTerminal("shell");

  assert.equal(terminalHost.terminalLaunchRequests.length, 1);
  assert.equal(terminalHost.terminalLaunchRequests[0]?.nodeId, "worker");
  assert.deepEqual(terminalHost.terminalLaunchRequests[0]?.metadata, {
    owner: "platform",
  });
  assert.deepEqual(terminalHost.revealedSessionIds, ["restored-shell"]);
  assert.equal(treeTYEngine.getTerminalSessionState("shell").status, "idle");
  assert.equal(treeTYEngine.getTerminalSessionState("worker").status, "running");
});

test.test("marks non-zero terminal exits as failed", async () => {
  const terminalHost = new FakeTerminalHost();
  const treeTYEngine = new TreeTYEngine(resolvedTreeConfig, terminalHost);

  await treeTYEngine.start();
  await treeTYEngine.openTerminal("shell");

  terminalHost.emitHostEvent({
    type: "closed",
    sessionId: "session-2",
    nodeId: "shell",
    exitCode: 1,
  });

  assert.equal(treeTYEngine.getTerminalSessionState("shell").status, "failed");
  assert.equal(treeTYEngine.getTerminalSessionState("shell").exitCode, 1);
});

test.test("ignores a late close event from a replaced session", async () => {
  const terminalHost = new FakeTerminalHost();
  const treeTYEngine = new TreeTYEngine(resolvedTreeConfig, terminalHost);

  await treeTYEngine.start();
  await treeTYEngine.openTerminal("shell");
  await treeTYEngine.restartTerminal("shell");

  terminalHost.emitHostEvent({
    type: "closed",
    sessionId: "session-2",
    nodeId: "shell",
  });

  assert.equal(treeTYEngine.getTerminalSessionState("shell").status, "idle");
  assert.equal(
    treeTYEngine.getTerminalSessionState("shell").hostSessionId,
    "session-3",
  );
});
