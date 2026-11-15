import * as crypto from "node:crypto";

import {
  buildTreeTYTerminalEnvironment,
  clearTreeNodeSession,
  getTreeNodeActivity,
  loadTreeStateFile,
  registerTreeNodeSession,
  setTreeNodeActivity,
  setTreeNodeAttention,
  treeTYNodeIdEnvironmentName,
  treeTYSessionIdEnvironmentName,
} from "@treety/core";
import type {
  Disposable,
  HostedTerminalSession,
  TerminalHost,
  TerminalHostEvent,
  TerminalHostEventListener,
  TerminalLaunchRequest,
  ResolvedTreeConfig,
  ResolvedTreeNode,
  TreeNodeActivity,
  TreeState,
} from "@treety/core";
import * as vscode from "vscode";

import { TerminalActivityTracker } from "./terminal-activity";
import type { TerminalActivity } from "./terminal-activity";
import type { TerminalLinkManager } from "./terminal-links";

interface TerminalMetadata {
  sessionId: string;
  nodeId: string;
  workspaceId: string;
}

interface SessionActivity {
  nodeId: string;
  tracker: TerminalActivityTracker;
  explicitActivity?: TreeNodeActivity;
}

const workspaceIdEnvironmentName = "TREETY_WORKSPACE_ID";

export class VscodeTerminalHost implements TerminalHost {
  private readonly terminalBySessionId = new Map<string, vscode.Terminal>();

  private readonly terminalHostEventListeners = new Set<TerminalHostEventListener>();

  private readonly activityBySessionId = new Map<string, SessionActivity>();

  private readonly activityChangeEmitter = new vscode.EventEmitter<string>();

  public readonly onDidChangeActivity = this.activityChangeEmitter.event;

  private treeNodes: ResolvedTreeNode[] = [];

  private treeState: TreeState = { version: 1, nodes: {} };

  private readonly reporterSessionIds = new Set<string>();

  private reporterCheckTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly vscodeDisposables: vscode.Disposable[];

  public constructor(
    private readonly workspaceId: string,
    private readonly configFilePath: string,
    private readonly configSource: "global" | "workspace",
    private readonly terminalLinks: TerminalLinkManager,
  ) {
    this.vscodeDisposables = [
      vscode.window.onDidCloseTerminal((terminal) =>
        this.handleClosedTerminal(terminal),
      ),
      vscode.window.onDidStartTerminalShellExecution((terminalShellEvent) =>
        this.handleStartedTerminalShellExecution(terminalShellEvent),
      ),
      vscode.window.onDidEndTerminalShellExecution((terminalShellEvent) =>
        this.handleEndedTerminalShellExecution(terminalShellEvent),
      ),
    ];
  }

  public async getSessions(): Promise<HostedTerminalSession[]> {
    const hostedTerminalSessions: HostedTerminalSession[] = [];

    for (const terminal of vscode.window.terminals) {
      const terminalMetadata = getTerminalMetadata(terminal);

      if (!terminalMetadata || terminalMetadata.workspaceId !== this.workspaceId) {
        continue;
      }

      if (!getTerminalNode(this.treeNodes, terminalMetadata.nodeId)) continue;

      this.treeState = await registerTreeNodeSession(
        this.configFilePath, terminalMetadata.nodeId, terminalMetadata.sessionId,
      );
      // Registration can wait for a file lock while the native terminal closes.
      if (!vscode.window.terminals.includes(terminal) || terminal.exitStatus !== undefined) {
        await clearTreeNodeSession(
          this.configFilePath, terminalMetadata.nodeId, terminalMetadata.sessionId,
        );

        continue;
      }

      this.terminalBySessionId.set(terminalMetadata.sessionId, terminal);
      this.createSessionActivity(terminalMetadata.sessionId, terminalMetadata.nodeId);
      hostedTerminalSessions.push({
        id: terminalMetadata.sessionId,
        nodeId: terminalMetadata.nodeId,
      });
    }

    return hostedTerminalSessions.filter((hostedTerminalSession) => {
      const terminal = this.terminalBySessionId.get(hostedTerminalSession.id);

      return terminal !== undefined && vscode.window.terminals.includes(terminal) &&
        terminal.exitStatus === undefined;
    });
  }

  public async createSession(
    terminalLaunchRequest: TerminalLaunchRequest,
  ): Promise<HostedTerminalSession> {
    const sessionId = crypto.randomUUID();
    let sessionUri: string | undefined;

    try {
      sessionUri = await this.terminalLinks.createSessionUri({
        configUri: vscode.Uri.file(this.configFilePath).toString(),
        nodeId: terminalLaunchRequest.nodeId,
        sessionId,
      });
    } catch {
      // Link resolution is optional. An unavailable link must not prevent terminal launch.
    }

    terminalLaunchRequest.signal?.throwIfAborted();

    const terminalOptions = buildTerminalOptions(
      terminalLaunchRequest,
      sessionId,
      this.workspaceId,
      this.configFilePath,
      this.configSource,
      sessionUri,
    );
    this.treeState = await registerTreeNodeSession(
      this.configFilePath, terminalLaunchRequest.nodeId, sessionId,
    );

    let terminal: vscode.Terminal;

    try {
      terminalLaunchRequest.signal?.throwIfAborted();
      terminal = vscode.window.createTerminal(terminalOptions);
    } catch (error) {
      await clearTreeNodeSession(this.configFilePath, terminalLaunchRequest.nodeId, sessionId);

      throw error;
    }

    this.terminalBySessionId.set(sessionId, terminal);
    this.createSessionActivity(sessionId, terminalLaunchRequest.nodeId);

    return {
      id: sessionId,
      nodeId: terminalLaunchRequest.nodeId,
    };
  }

  public revealSession(hostSessionId: string): void {
    const terminal = this.terminalBySessionId.get(hostSessionId);

    if (!terminal) {
      throw new Error(`VS Code terminal session "${hostSessionId}" was not found.`);
    }

    terminal.show(false);
  }

  public closeSession(hostSessionId: string): void {
    const terminal = this.terminalBySessionId.get(hostSessionId);

    if (!terminal) return;

    const terminalMetadata = getTerminalMetadata(terminal);

    this.removeSessionActivity(hostSessionId);

    if (terminalMetadata) {
      void clearTreeNodeSession(this.configFilePath, terminalMetadata.nodeId, hostSessionId)
        .catch(reportActivityError);
    }

    terminal.dispose();
  }

  public getSessionCurrentDirUri(
    hostSessionId: string,
  ): vscode.Uri | undefined {
    return this.terminalBySessionId.get(hostSessionId)?.shellIntegration?.cwd;
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

  public dispose(): void {
    for (const vscodeDisposable of this.vscodeDisposables) {
      vscodeDisposable.dispose();
    }

    clearTimeout(this.reporterCheckTimer);

    for (const sessionActivity of this.activityBySessionId.values()) {
      sessionActivity.tracker.dispose();
    }

    this.activityBySessionId.clear();
    this.activityChangeEmitter.dispose();
    this.terminalHostEventListeners.clear();
    this.terminalBySessionId.clear();
  }

  private handleClosedTerminal(terminal: vscode.Terminal): void {
    const terminalMetadata = getTerminalMetadata(terminal);

    if (!terminalMetadata || terminalMetadata.workspaceId !== this.workspaceId) {
      return;
    }

    this.terminalBySessionId.delete(terminalMetadata.sessionId);
    this.removeSessionActivity(terminalMetadata.sessionId);
    void clearTreeNodeSession(
      this.configFilePath, terminalMetadata.nodeId, terminalMetadata.sessionId,
    ).catch(reportActivityError);
    this.emitTerminalHostEvent({
      type: "closed",
      sessionId: terminalMetadata.sessionId,
      nodeId: terminalMetadata.nodeId,
      exitCode: terminal.exitStatus?.code,
    });
  }

  private handleStartedTerminalShellExecution(
    terminalShellEvent: vscode.TerminalShellExecutionStartEvent,
  ): void {
    const terminalMetadata = getTerminalMetadata(terminalShellEvent.terminal);

    if (!terminalMetadata || terminalMetadata.workspaceId !== this.workspaceId) {
      return;
    }

    this.activityBySessionId.get(terminalMetadata.sessionId)?.tracker
      .startShellExecution(terminalShellEvent.execution);

    this.emitTerminalHostEvent({
      type: "started",
      sessionId: terminalMetadata.sessionId,
      nodeId: terminalMetadata.nodeId,
    });
  }

  private handleEndedTerminalShellExecution(
    terminalShellEvent: vscode.TerminalShellExecutionEndEvent,
  ): void {
    const terminalMetadata = getTerminalMetadata(terminalShellEvent.terminal);

    if (!terminalMetadata || terminalMetadata.workspaceId !== this.workspaceId) {
      return;
    }

    void this.finishShellActivity(terminalMetadata, terminalShellEvent.execution)
      .catch(reportActivityError);

    this.emitTerminalHostEvent({
      type: "idle",
      sessionId: terminalMetadata.sessionId,
      nodeId: terminalMetadata.nodeId,
      exitCode: terminalShellEvent.exitCode,
    });
  }

  public getSessionActivity(sessionId?: string): TerminalActivity {
    return sessionId
      ? this.activityBySessionId.get(sessionId)?.tracker.getActivity() ?? { state: "unknown", showSpinner: false }
      : { state: "unknown", showSpinner: false };
  }

  public updateActivity(resolvedTreeConfig: ResolvedTreeConfig, treeState: TreeState): void {
    this.treeNodes = resolvedTreeConfig.tree;
    this.treeState = treeState;
    this.refreshExplicitActivity();
  }

  private createSessionActivity(sessionId: string, nodeId: string): void {
    if (this.activityBySessionId.has(sessionId)) return;

    this.activityBySessionId.set(sessionId, {
      nodeId,
      tracker: new TerminalActivityTracker(() => this.activityChangeEmitter.fire(nodeId)),
    });
    this.refreshExplicitActivity();
  }

  private removeSessionActivity(sessionId: string): void {
    this.activityBySessionId.get(sessionId)?.tracker.dispose();
    this.activityBySessionId.delete(sessionId);
    this.reporterSessionIds.delete(sessionId);
  }

  private refreshExplicitActivity(): void {
    clearTimeout(this.reporterCheckTimer);
    this.reporterCheckTimer = undefined;
    this.reporterSessionIds.clear();

    for (const [sessionId, sessionActivity] of this.activityBySessionId) {
      const treeNode = getTerminalNode(this.treeNodes, sessionActivity.nodeId);
      const activity = treeNode
        ? getTreeNodeActivity(treeNode, this.treeState.nodes[sessionActivity.nodeId], sessionId)
        : undefined;

      const processIsAlive = activity !== undefined && getProcessIsAlive(activity.processId);

      if (activity && !processIsAlive) {
        void this.clearExplicitActivity(sessionActivity.nodeId, activity).catch(reportActivityError);
      }

      sessionActivity.explicitActivity = processIsAlive ? activity : undefined;
      sessionActivity.tracker.setExplicitActivity(sessionActivity.explicitActivity?.state);
      if (sessionActivity.explicitActivity) this.reporterSessionIds.add(sessionId);
    }

    // Only registered reporters need a liveness check. Shell work is event driven.
    if (this.reporterSessionIds.size === 0) return;

    this.reporterCheckTimer = setTimeout(() => this.checkExplicitReporters(), 5_000);
  }

  private checkExplicitReporters(): void {
    this.reporterCheckTimer = undefined;

    for (const sessionId of this.reporterSessionIds) {
      const sessionActivity = this.activityBySessionId.get(sessionId);
      const activity = sessionActivity?.explicitActivity;

      if (!sessionActivity || !activity) {
        this.reporterSessionIds.delete(sessionId);

        continue;
      }

      if (getProcessIsAlive(activity.processId)) continue;

      sessionActivity.explicitActivity = undefined;
      sessionActivity.tracker.setExplicitActivity(undefined);
      this.reporterSessionIds.delete(sessionId);
      void this.clearExplicitActivity(sessionActivity.nodeId, activity).catch(reportActivityError);
    }

    if (this.reporterSessionIds.size === 0) return;

    this.reporterCheckTimer = setTimeout(() => this.checkExplicitReporters(), 5_000);
  }

  private async finishShellActivity(metadata: TerminalMetadata, execution: object): Promise<void> {
    const endedAt = Date.now();
    const sessionActivity = this.activityBySessionId.get(metadata.sessionId);

    if (!sessionActivity?.tracker.hasShellExecution(execution)) return;

    // A fast final signal can reach disk before the file watcher delivers it.
    this.treeState = await loadTreeStateFile(this.configFilePath);

    if (this.activityBySessionId.get(metadata.sessionId) !== sessionActivity ||
      !sessionActivity.tracker.hasShellExecution(execution)) return;

    this.refreshExplicitActivity();
    const needsAttention = sessionActivity.tracker.endShellExecution(execution, endedAt);
    const explicitActivity = sessionActivity.explicitActivity;

    sessionActivity.explicitActivity = undefined;
    this.reporterSessionIds.delete(metadata.sessionId);

    if (explicitActivity) {
      await this.clearExplicitActivity(metadata.nodeId, explicitActivity);
    }

    if (!needsAttention) return;

    await setTreeNodeAttention(this.configFilePath, metadata.nodeId, true, metadata.sessionId);
  }

  private async clearExplicitActivity(nodeId: string, activity: TreeNodeActivity): Promise<void> {
    await setTreeNodeActivity(this.configFilePath, nodeId, {
      action: "unregister",
      sessionId: activity.sessionId,
      reporterId: activity.reporterId,
      processId: activity.processId,
    });
  }

  private emitTerminalHostEvent(terminalHostEvent: TerminalHostEvent): void {
    for (const terminalHostEventListener of this.terminalHostEventListeners) {
      terminalHostEventListener(terminalHostEvent);
    }
  }
}

function buildTerminalOptions(
  terminalLaunchRequest: TerminalLaunchRequest,
  sessionId: string,
  workspaceId: string,
  configFilePath: string,
  configSource: "global" | "workspace",
  sessionUri?: string,
): vscode.TerminalOptions {
  const terminalOptions: vscode.TerminalOptions = {
    name: `TreeTY: ${terminalLaunchRequest.name}`,
    cwd: terminalLaunchRequest.cwd,
    env: {
      ...terminalLaunchRequest.env,
      ...buildTreeTYTerminalEnvironment({
        configFilePath,
        configSource,
        nodeId: terminalLaunchRequest.nodeId,
        metadata: terminalLaunchRequest.metadata,
        sessionId,
        sessionUri,
      }),
      [workspaceIdEnvironmentName]: workspaceId,
    },
    iconPath: new vscode.ThemeIcon("terminal"),
    isTransient: false,
  };

  if (terminalLaunchRequest.command) {
    terminalOptions.shellPath = terminalLaunchRequest.command.executable;
    terminalOptions.shellArgs = terminalLaunchRequest.command.args;

    return terminalOptions;
  }

  if (terminalLaunchRequest.shell) {
    terminalOptions.shellPath = terminalLaunchRequest.shell.path;
    terminalOptions.shellArgs = terminalLaunchRequest.shell.args;
  }

  return terminalOptions;
}

function getTerminalMetadata(terminal: vscode.Terminal): TerminalMetadata | undefined {
  if (!("env" in terminal.creationOptions)) return undefined;

  const terminalEnvironment = terminal.creationOptions.env;

  if (!terminalEnvironment) return undefined;

  const sessionId = terminalEnvironment[treeTYSessionIdEnvironmentName];
  const nodeId = terminalEnvironment[treeTYNodeIdEnvironmentName];
  const workspaceId = terminalEnvironment[workspaceIdEnvironmentName];

  if (
    typeof sessionId !== "string" ||
    typeof nodeId !== "string" ||
    typeof workspaceId !== "string"
  ) {
    return undefined;
  }

  return {
    sessionId,
    nodeId,
    workspaceId,
  };
}

function getTerminalNode(treeNodes: ResolvedTreeNode[], nodeId: string): ResolvedTreeNode | undefined {
  for (const treeNode of treeNodes) {
    if (treeNode.id === nodeId) return treeNode;
    if (treeNode.kind !== "group") continue;

    const terminalNode = getTerminalNode(treeNode.children, nodeId);

    if (terminalNode) return terminalNode;
  }

  return undefined;
}

function getProcessIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function reportActivityError(error: unknown): void {
  console.error("TreeTY could not update terminal activity:", error);
}
