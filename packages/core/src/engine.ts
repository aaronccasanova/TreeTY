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

export class TreeTYEngine implements Disposable {
  private terminalNodeById: Map<string, ResolvedTreeTerminal>;

  private readonly terminalSessionStore = new TerminalSessionStore();

  private terminalHostSubscription: Disposable | undefined;

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
    this.terminalHostSubscription?.dispose();
    this.terminalHost.dispose();
  }

  private async createTerminalSession(
    terminalNode: ResolvedTreeTerminal,
    revealTerminal: boolean,
  ): Promise<void> {
    this.terminalSessionStore.setTerminalSessionState(
      terminalNode.id,
      "starting",
    );

    try {
      const hostedTerminalSession = await this.terminalHost.createSession({
        nodeId: terminalNode.id,
        name: terminalNode.name,
        cwd: terminalNode.cwd,
        env: terminalNode.env,
        metadata: terminalNode.metadata,
        shell: terminalNode.shell,
        command: terminalNode.command,
      });
      const terminalStatus = terminalNode.command ? "running" : "idle";

      this.terminalSessionStore.setTerminalSessionState(
        terminalNode.id,
        terminalStatus,
        hostedTerminalSession.id,
      );

      if (revealTerminal) {
        this.terminalHost.revealSession(hostedTerminalSession.id);
      }
    } catch (error) {
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
