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
      needsAttention: false,
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
      needsAttention: false,
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

test.test("reconciles node changes without replacing live sessions", async () => {
  const terminalHost = new FakeTerminalHost();
  const initialResolvedTreeConfig: ResolvedTreeConfig = {
    version: 1,
    workspaceDirPath: "/workspace",
    tree: [
      {
        kind: "terminal",
        id: "shell",
        name: "Shell",
        cwd: "/workspace",
        env: {},
        needsAttention: false,
        restartPolicy: "manual",
      },
    ],
  };
  const treeTYEngine = new TreeTYEngine(
    initialResolvedTreeConfig,
    terminalHost,
  );

  await treeTYEngine.start();
  await treeTYEngine.openTerminal("shell");

  const shellSessionId =
    treeTYEngine.getTerminalSessionState("shell").hostSessionId;
  const reconciledTreeConfig: ResolvedTreeConfig = {
    ...initialResolvedTreeConfig,
    tree: [
      {
        ...initialResolvedTreeConfig.tree[0]!,
        name: "Renamed shell",
      },
      {
        kind: "terminal",
        id: "worker",
        name: "Worker",
        cwd: "/workspace/worker",
        env: {},
        needsAttention: false,
        restartPolicy: "onOpen",
      },
    ],
  };

  await treeTYEngine.reconcile(reconciledTreeConfig);

  assert.equal(
    treeTYEngine.getTerminalSessionState("shell").hostSessionId,
    shellSessionId,
  );
  assert.equal(terminalHost.closedSessionIds.length, 0);
  assert.equal(terminalHost.terminalLaunchRequests.at(-1)?.nodeId, "worker");

  const workerSessionId =
    treeTYEngine.getTerminalSessionState("worker").hostSessionId;

  await treeTYEngine.reconcile({
    ...reconciledTreeConfig,
    tree: [reconciledTreeConfig.tree[0]!],
  });

  assert.deepEqual(terminalHost.closedSessionIds, [workerSessionId]);
  assert.equal(
    treeTYEngine.getTerminalSessionState("shell").hostSessionId,
    shellSessionId,
  );
});

test.test("concurrent opens share one pending native terminal launch", async () => {
  let finishCreation: (() => void) | undefined;
  const creationReady = new Promise<void>((resolve) => {
    finishCreation = resolve;
  });
  let creationCount = 0;

  class DeferredTerminalHost extends FakeTerminalHost {
    public override async createSession(
      terminalLaunchRequest: TerminalLaunchRequest,
    ): Promise<HostedTerminalSession> {
      creationCount += 1;
      await creationReady;

      return await super.createSession(terminalLaunchRequest);
    }
  }

  const terminalHost = new DeferredTerminalHost();
  const treeTYEngine = new TreeTYEngine({
    ...resolvedTreeConfig,
    tree: resolvedTreeConfig.tree.filter((treeNode) => treeNode.id === "shell"),
  }, terminalHost);

  await treeTYEngine.start();

  const firstOpen = treeTYEngine.openTerminal("shell");
  const secondOpen = treeTYEngine.openTerminal("shell");

  await Promise.resolve();

  assert.equal(creationCount, 1);
  assert.equal(treeTYEngine.getTerminalSessionState("shell").status, "starting");
  finishCreation?.();
  await Promise.all([firstOpen, secondOpen]);

  assert.equal(terminalHost.terminalLaunchRequests.length, 1);
  assert.deepEqual(terminalHost.revealedSessionIds, ["session-1", "session-1"]);
});

test.test("failed concurrent creation releases the pending launch for retry", async () => {
  let creationCount = 0;

  class FailingTerminalHost extends FakeTerminalHost {
    public override async createSession(
      terminalLaunchRequest: TerminalLaunchRequest,
    ): Promise<HostedTerminalSession> {
      creationCount += 1;

      if (creationCount === 1) throw new Error("launch failed");

      return await super.createSession(terminalLaunchRequest);
    }
  }

  const terminalHost = new FailingTerminalHost();
  const treeTYEngine = new TreeTYEngine({
    ...resolvedTreeConfig,
    tree: resolvedTreeConfig.tree.filter((treeNode) => treeNode.id === "shell"),
  }, terminalHost);

  await treeTYEngine.start();
  await assert.rejects(Promise.all([
    treeTYEngine.openTerminal("shell"),
    treeTYEngine.openTerminal("shell"),
  ]), /launch failed/);
  assert.equal(creationCount, 1);

  await treeTYEngine.openTerminal("shell");

  assert.equal(creationCount, 2);
  assert.equal(treeTYEngine.getTerminalSessionState("shell").hostSessionId, "session-1");
});

test.test("stop, removal, and disposal cancel pending launches and close late host sessions", async () => {
  for (const cancellationAction of ["stop", "remove", "dispose"] as const) {
    let finishCreation: (() => void) | undefined;
    const creationReady = new Promise<void>((resolve) => {
      finishCreation = resolve;
    });
    let launchSignal: AbortSignal | undefined;

    class DeferredTerminalHost extends FakeTerminalHost {
      public override async createSession(
        terminalLaunchRequest: TerminalLaunchRequest,
      ): Promise<HostedTerminalSession> {
        launchSignal = terminalLaunchRequest.signal;
        await creationReady;

        // A host may not support cancellation. The engine must close its late session.
        return await super.createSession(terminalLaunchRequest);
      }
    }

    const terminalHost = new DeferredTerminalHost();
    const treeTYEngine = new TreeTYEngine({
      ...resolvedTreeConfig,
      tree: resolvedTreeConfig.tree.filter((treeNode) => treeNode.id === "shell"),
    }, terminalHost);

    await treeTYEngine.start();

    const terminalOpen = treeTYEngine.openTerminal("shell");

    await Promise.resolve();

    if (cancellationAction === "stop") treeTYEngine.stopTerminal("shell");
    if (cancellationAction === "remove") {
      await treeTYEngine.reconcile({ ...resolvedTreeConfig, tree: [] });
    }
    if (cancellationAction === "dispose") treeTYEngine.dispose();

    assert.equal(launchSignal?.aborted, true);
    finishCreation?.();
    await terminalOpen;

    assert.deepEqual(terminalHost.closedSessionIds, ["session-1"]);
    assert.deepEqual(terminalHost.revealedSessionIds, []);

    if (cancellationAction === "stop") {
      assert.equal(treeTYEngine.getTerminalSessionState("shell").status, "stopped");
    }
    if (cancellationAction === "remove") {
      assert.throws(() => treeTYEngine.getTerminalSessionState("shell"), /does not exist/);
    }
  }
});

test.test("restart replaces a pending generation without reattaching its late session", async () => {
  let finishFirstCreation: (() => void) | undefined;
  const firstCreationReady = new Promise<void>((resolve) => {
    finishFirstCreation = resolve;
  });
  let creationCount = 0;

  class DeferredTerminalHost extends FakeTerminalHost {
    public override async createSession(
      terminalLaunchRequest: TerminalLaunchRequest,
    ): Promise<HostedTerminalSession> {
      creationCount += 1;

      if (creationCount === 1) await firstCreationReady;

      return await super.createSession(terminalLaunchRequest);
    }
  }

  const terminalHost = new DeferredTerminalHost();
  const treeTYEngine = new TreeTYEngine({
    ...resolvedTreeConfig,
    tree: resolvedTreeConfig.tree.filter((treeNode) => treeNode.id === "shell"),
  }, terminalHost);

  await treeTYEngine.start();

  const terminalOpen = treeTYEngine.openTerminal("shell");

  await Promise.resolve();
  await treeTYEngine.restartTerminal("shell");
  finishFirstCreation?.();
  await terminalOpen;

  assert.equal(creationCount, 2);
  assert.deepEqual(terminalHost.revealedSessionIds, ["session-1"]);
  assert.deepEqual(terminalHost.closedSessionIds, ["session-2"]);
  assert.equal(treeTYEngine.getTerminalSessionState("shell").hostSessionId, "session-1");
});

test.test("stop after native creation closes the session before pending launch reveals it", async () => {
  const terminalHost = new FakeTerminalHost();
  const treeTYEngine = new TreeTYEngine({
    ...resolvedTreeConfig,
    tree: resolvedTreeConfig.tree.filter((treeNode) => treeNode.id === "shell"),
  }, terminalHost);

  await treeTYEngine.start();

  treeTYEngine.subscribe((terminalSessionState) => {
    if (terminalSessionState.status !== "idle") return;

    treeTYEngine.stopTerminal(terminalSessionState.nodeId);
  });

  await treeTYEngine.openTerminal("shell");

  assert.deepEqual(terminalHost.closedSessionIds, ["session-1"]);
  assert.deepEqual(terminalHost.revealedSessionIds, []);
  assert.equal(treeTYEngine.getTerminalSessionState("shell").status, "stopped");
});
