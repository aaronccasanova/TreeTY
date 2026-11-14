import {
  Disposable,
  ResolvedTreeConfig,
  ResolvedTreeNode,
  ResolvedTreeTerminal,
  TerminalSessionState,
} from "./model";

import { TerminalSessionStateListener, TerminalSessionStore } from "./session-store";
import {
  HostedTerminalSession,
  TerminalHost,
  TerminalHostEvent,
} from "./terminal-host";

interface TerminalSessionCreation {
  abortController: AbortController;
  promise: Promise<HostedTerminalSession | undefined>;
}

export class TreeTYEngine implements Disposable {
  private terminalNodeById: Map<string, ResolvedTreeTerminal>;

  private readonly terminalSessionStore = new TerminalSessionStore();

  private readonly terminalSessionCreationByNodeId = new Map<
    string,
    TerminalSessionCreation
  >();

  private terminalHostSubscription: Disposable | undefined;

  private disposed = false;

  public constructor(
    public resolvedTreeConfig: ResolvedTreeConfig,
    private readonly terminalHost: TerminalHost,
  ) {
    this.terminalNodeById = getTerminalNodeById(resolvedTreeConfig.tree);
  }

  public async start(): Promise<void> {
    this.terminalHostSubscription = this.terminalHost.subscribe(
      (terminalHostEvent) => this.handleTerminalHostEvent(terminalHostEvent),
    );

    const hostedTerminalSessions = await this.terminalHost.getSessions();

    for (const hostedTerminalSession of hostedTerminalSessions) {
      const terminalNode = this.terminalNodeById.get(hostedTerminalSession.nodeId);

      if (!terminalNode) continue;

      const terminalStatus = terminalNode.command ? "running" : "idle";

      this.terminalSessionStore.setTerminalSessionState(
        hostedTerminalSession.nodeId,
        terminalStatus,
        hostedTerminalSession.id,
      );
    }

    for (const terminalNode of this.terminalNodeById.values()) {
      if (terminalNode.restartPolicy !== "onOpen") continue;

      const terminalSessionState = this.getTerminalSessionState(terminalNode.id);

      if (terminalSessionState.hostSessionId) continue;

      try {
        await this.createTerminalSession(terminalNode, false);
      } catch {
        continue;
      }
    }
  }

  public async openTerminal(nodeId: string): Promise<void> {
    const terminalNode = this.getTerminalNode(nodeId);
    const terminalSessionState = this.getTerminalSessionState(nodeId);

    if (terminalSessionState.hostSessionId) {
      this.terminalHost.revealSession(terminalSessionState.hostSessionId);

      return;
    }

    await this.createTerminalSession(terminalNode, true);
  }

  public async reconcile(
    resolvedTreeConfig: ResolvedTreeConfig,
  ): Promise<void> {
    const nextTerminalNodeById = getTerminalNodeById(resolvedTreeConfig.tree);

    for (const previousTerminalNodeId of this.terminalNodeById.keys()) {
      if (nextTerminalNodeById.has(previousTerminalNodeId)) continue;

      this.cancelTerminalSessionCreation(previousTerminalNodeId);

      const terminalSessionState =
        this.terminalSessionStore.getTerminalSessionState(previousTerminalNodeId);

      if (terminalSessionState.hostSessionId) {
        this.terminalHost.closeSession(terminalSessionState.hostSessionId);
      }

      this.terminalSessionStore.deleteTerminalSessionState(
        previousTerminalNodeId,
      );
    }

    this.resolvedTreeConfig = resolvedTreeConfig;
    this.terminalNodeById = nextTerminalNodeById;

    for (const terminalNode of nextTerminalNodeById.values()) {
      if (terminalNode.restartPolicy !== "onOpen") continue;

      const terminalSessionState =
        this.terminalSessionStore.getTerminalSessionState(terminalNode.id);

      if (terminalSessionState.hostSessionId) continue;

      try {
        await this.createTerminalSession(terminalNode, false);
      } catch {
        continue;
      }
    }
  }

  public async restartTerminal(nodeId: string): Promise<void> {
    const terminalNode = this.getTerminalNode(nodeId);

    this.cancelTerminalSessionCreation(nodeId);
    const terminalSessionState = this.getTerminalSessionState(nodeId);

    if (terminalSessionState.hostSessionId) {
      this.terminalHost.closeSession(terminalSessionState.hostSessionId);
    }

    this.terminalSessionStore.setTerminalSessionState(nodeId, "stopped");

    await this.createTerminalSession(terminalNode, true);
  }

  public stopTerminal(nodeId: string): void {
    this.getTerminalNode(nodeId);

    const terminalSessionState = this.getTerminalSessionState(nodeId);

    if (this.cancelTerminalSessionCreation(nodeId)) {
      this.terminalSessionStore.setTerminalSessionState(nodeId, "stopped");
    }

    if (!terminalSessionState.hostSessionId) return;

    this.terminalHost.closeSession(terminalSessionState.hostSessionId);
  }

  public getTerminalSessionState(nodeId: string): TerminalSessionState {
    this.getTerminalNode(nodeId);

    return this.terminalSessionStore.getTerminalSessionState(nodeId);
  }

  public subscribe(
    terminalSessionStateListener: TerminalSessionStateListener,
  ): Disposable {
    return this.terminalSessionStore.subscribe(terminalSessionStateListener);
  }

  public dispose(): void {
    this.disposed = true;

    for (const nodeId of this.terminalSessionCreationByNodeId.keys()) {
      this.cancelTerminalSessionCreation(nodeId);
    }

    this.terminalHostSubscription?.dispose();
    this.terminalHost.dispose();
  }

  private async createTerminalSession(
    terminalNode: ResolvedTreeTerminal,
    revealTerminal: boolean,
  ): Promise<void> {
    if (this.disposed) return;

    let terminalSessionCreation = this.terminalSessionCreationByNodeId.get(
      terminalNode.id,
    );

    if (!terminalSessionCreation) {
      const abortController = new AbortController();

      terminalSessionCreation = {
        abortController,
        promise: Promise.resolve().then(() =>
          this.launchTerminalSession(terminalNode, abortController.signal),
        ),
      };
      this.terminalSessionCreationByNodeId.set(
        terminalNode.id,
        terminalSessionCreation,
      );
      this.terminalSessionStore.setTerminalSessionState(terminalNode.id, "starting");
    }

    try {
      const hostedTerminalSession = await terminalSessionCreation.promise;

      if (
        hostedTerminalSession &&
        !terminalSessionCreation.abortController.signal.aborted &&
        revealTerminal
      ) {
        this.terminalHost.revealSession(hostedTerminalSession.id);
      }
    } finally {
      if (
        this.terminalSessionCreationByNodeId.get(terminalNode.id) ===
        terminalSessionCreation
      ) {
        this.terminalSessionCreationByNodeId.delete(terminalNode.id);
      }
    }
  }

  private cancelTerminalSessionCreation(nodeId: string): boolean {
    const terminalSessionCreation = this.terminalSessionCreationByNodeId.get(
      nodeId,
    );

    if (!terminalSessionCreation) return false;

    terminalSessionCreation.abortController.abort();
    this.terminalSessionCreationByNodeId.delete(nodeId);

    return true;
  }

  private async launchTerminalSession(
    terminalNode: ResolvedTreeTerminal,
    signal: AbortSignal,
  ): Promise<HostedTerminalSession | undefined> {
    if (signal.aborted) return undefined;

    try {
      const hostedTerminalSession = await this.terminalHost.createSession({
        nodeId: terminalNode.id,
        name: terminalNode.name,
        cwd: terminalNode.cwd,
        env: terminalNode.env,
        metadata: terminalNode.metadata,
        shell: terminalNode.shell,
        command: terminalNode.command,
        signal,
      });

      if (signal.aborted) {
        this.terminalHost.closeSession(hostedTerminalSession.id);

        return undefined;
      }

      const terminalStatus = terminalNode.command ? "running" : "idle";

      this.terminalSessionStore.setTerminalSessionState(
        terminalNode.id,
        terminalStatus,
        hostedTerminalSession.id,
      );

      return hostedTerminalSession;
    } catch (error) {
      if (signal.aborted) return undefined;

      this.terminalSessionStore.setTerminalSessionState(
        terminalNode.id,
        "failed",
      );

      throw error;
    }
  }

  private getTerminalNode(nodeId: string): ResolvedTreeTerminal {
    const terminalNode = this.terminalNodeById.get(nodeId);

    if (terminalNode) return terminalNode;

    throw new Error(`Terminal node "${nodeId}" does not exist.`);
  }

  private handleTerminalHostEvent(terminalHostEvent: TerminalHostEvent): void {
    if (!this.terminalNodeById.has(terminalHostEvent.nodeId)) return;

    const terminalSessionState = this.getTerminalSessionState(
      terminalHostEvent.nodeId,
    );

    if (terminalSessionState.hostSessionId !== terminalHostEvent.sessionId) {
      return;
    }

    if (terminalHostEvent.type === "started") {
      this.terminalSessionStore.setTerminalSessionState(
        terminalHostEvent.nodeId,
        "running",
        terminalHostEvent.sessionId,
      );

      return;
    }

    if (terminalHostEvent.type === "idle") {
      const terminalStatus =
        terminalHostEvent.exitCode && terminalHostEvent.exitCode !== 0
          ? "failed"
          : "idle";

      this.terminalSessionStore.setTerminalSessionState(
        terminalHostEvent.nodeId,
        terminalStatus,
        terminalHostEvent.sessionId,
        terminalHostEvent.exitCode,
      );

      return;
    }

    const terminalStatus =
      terminalHostEvent.exitCode && terminalHostEvent.exitCode !== 0
        ? "failed"
        : "stopped";

    this.terminalSessionStore.setTerminalSessionState(
      terminalHostEvent.nodeId,
      terminalStatus,
      undefined,
      terminalHostEvent.exitCode,
    );
  }
}

function getTerminalNodeById(
  resolvedTreeNodes: ResolvedTreeNode[],
): Map<string, ResolvedTreeTerminal> {
  const terminalNodeById = new Map<string, ResolvedTreeTerminal>();
  const pendingTreeNodes = [...resolvedTreeNodes];

  while (pendingTreeNodes.length > 0) {
    const treeNode = pendingTreeNodes.shift();

    if (!treeNode) continue;

    if (treeNode.kind === "group") {
      pendingTreeNodes.unshift(...treeNode.children);

      continue;
    }

    terminalNodeById.set(treeNode.id, treeNode);
  }

  return terminalNodeById;
}
