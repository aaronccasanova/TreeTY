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
import { buildTerminalTitle, getTerminalRecoveryToken } from "./terminal-recovery";
import type { TerminalRecoveryRecord, TerminalRecoveryRegistry } from "./terminal-recovery";

interface TerminalMetadata {
  sessionId: string;
  nodeId: string;
  workspaceId: string;
  recoveryToken?: string;
}

interface SessionActivity {
  nodeId: string;
  tracker: TerminalActivityTracker;
  explicitActivity?: TreeNodeActivity;
}

const workspaceIdEnvironmentName = "TREETY_WORKSPACE_ID";

export class TerminalRecoveryError extends Error {}

export class VscodeTerminalHost implements TerminalHost {
  private readonly terminalBySessionId = new Map<string, vscode.Terminal>();

  private readonly metadataByTerminal = new Map<vscode.Terminal, TerminalMetadata>();

  private readonly closingTerminals = new Set<vscode.Terminal>();

  private readonly closedSessionIds = new Set<string>();

  private readonly allowedSessionCreations = new Set<string>();

  private readonly recoveryMessageByNodeId = new Map<string, string>();

  private sessionDiscovery: Promise<HostedTerminalSession[]> | undefined;

  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;

  private recoveryAttempts = 0;

  private disposed = false;

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
    private readonly terminalRecovery: TerminalRecoveryRegistry,
  ) {
    this.vscodeDisposables = [
      vscode.window.onDidOpenTerminal(() => this.scheduleRecovery()),
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

    this.scheduleRecovery();
  }

  public getSessions(): Promise<HostedTerminalSession[]> {
    this.sessionDiscovery ??= this.discoverSessions().finally(() => {
      this.sessionDiscovery = undefined;
    });

    return this.sessionDiscovery;
  }

  public allowNextSessionCreation(nodeId: string): void {
    this.allowedSessionCreations.add(nodeId);
  }

  public revokeSessionCreation(nodeId: string): void {
    this.allowedSessionCreations.delete(nodeId);
  }

  public getSessionRecoveryMessage(nodeId: string): string | undefined {
    return this.recoveryMessageByNodeId.get(nodeId);
  }

  public async createSession(
    terminalLaunchRequest: TerminalLaunchRequest,
  ): Promise<HostedTerminalSession> {
    const sessionCreationAllowed = this.allowedSessionCreations.delete(terminalLaunchRequest.nodeId);
    const hostedTerminalSessions = await this.getSessions();
    const existingSession = hostedTerminalSessions.find((session) => session.nodeId === terminalLaunchRequest.nodeId);

    terminalLaunchRequest.signal?.throwIfAborted();

    if (existingSession) return { ...existingSession, recovered: true };

    this.assertSessionCreationAllowed(terminalLaunchRequest.nodeId, sessionCreationAllowed);

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

    const recoveryRecord = await this.terminalRecovery.createRecord({
      configFilePath: this.configFilePath,
      workspaceId: this.workspaceId,
      sessionId,
      nodeId: terminalLaunchRequest.nodeId,
    });
    const terminalOptions = buildTerminalOptions(
      terminalLaunchRequest,
      recoveryRecord,
      this.configFilePath,
      this.configSource,
      sessionUri,
    );
    const terminalMetadata: TerminalMetadata = { ...recoveryRecord, recoveryToken: recoveryRecord.token };

    try {
      this.treeState = await registerTreeNodeSession(
        this.configFilePath, terminalLaunchRequest.nodeId, sessionId,
      );
      terminalLaunchRequest.signal?.throwIfAborted();

      if (this.disposed) throw new Error("The terminal host was disposed before launch.");

      // A restored handle may arrive while persistence waits. Recheck before spawning a process.
      const recoveredSessions = await this.getSessions();
      const recoveredSession = recoveredSessions.find((session) => session.nodeId === terminalLaunchRequest.nodeId);

      if (recoveredSession) {
        await this.clearSession(terminalMetadata);

        terminalLaunchRequest.signal?.throwIfAborted();

        return { ...recoveredSession, recovered: true };
      }

      terminalLaunchRequest.signal?.throwIfAborted();

      if (this.disposed) throw new Error("The terminal host was disposed before launch.");

      this.assertSessionCreationAllowed(terminalLaunchRequest.nodeId, sessionCreationAllowed, recoveryRecord.token);

      const terminal = vscode.window.createTerminal(terminalOptions);
      this.metadataByTerminal.set(terminal, terminalMetadata);
      this.terminalBySessionId.set(sessionId, terminal);
      this.createSessionActivity(sessionId, terminalLaunchRequest.nodeId);
      this.recoveryMessageByNodeId.delete(terminalLaunchRequest.nodeId);

      return { id: sessionId, nodeId: terminalLaunchRequest.nodeId };
    } catch (error) {
      await this.clearSession(terminalMetadata);

      throw error;
    }
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

    this.closingTerminals.add(terminal);
    this.removeSessionActivity(hostSessionId);

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
    this.disposed = true;
    clearTimeout(this.recoveryTimer);

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
    this.metadataByTerminal.clear();
    this.closingTerminals.clear();
  }

  private assertSessionCreationAllowed(
    nodeId: string,
    sessionCreationAllowed: boolean,
    pendingToken?: string,
  ): void {
    if (sessionCreationAllowed) return;

    const unresolvedRecords = this.terminalRecovery.getRecords({
      configFilePath: this.configFilePath, workspaceId: this.workspaceId,
    }).filter((record) => record.nodeId === nodeId && record.token !== pendingToken &&
      !this.closedSessionIds.has(record.sessionId) &&
      ![...this.closingTerminals].some((terminal) =>
        this.metadataByTerminal.get(terminal)?.recoveryToken === record.token,
      ),
    );

    const hasUnresolvedTerminal = vscode.window.terminals.some((terminal) =>
      terminal.exitStatus === undefined && !this.closingTerminals.has(terminal) &&
      this.resolveTerminalMetadata(terminal)?.nodeId === nodeId,
    );

    if (unresolvedRecords.length > 0 || hasUnresolvedTerminal) {
      const message = "A previous terminal session could not be recovered. It may still be restoring, have a renamed title, or be open in another window. Refresh TreeTY to retry recovery, or open this leaf to choose whether to start a new terminal.";
      this.recoveryMessageByNodeId.set(nodeId, message);
      this.activityChangeEmitter.fire(nodeId);

      throw new TerminalRecoveryError(message);
    }
  }

  private async discoverSessions(): Promise<HostedTerminalSession[]> {
    await this.terminalRecovery.refresh();

    if (this.disposed) return [];

    const liveTerminals = vscode.window.terminals.filter((terminal) =>
      terminal.exitStatus === undefined && !this.closingTerminals.has(terminal),
    );
    const terminalCandidates = liveTerminals.map((terminal) => ({
      terminal,
      metadata: this.resolveTerminalMetadata(terminal),
    }));
    const hostedTerminalSessions: HostedTerminalSession[] = [];

    for (const candidate of terminalCandidates) {
      const terminalMetadata = candidate.metadata;

      if (this.disposed) break;
      if (!terminalMetadata) continue;
      if (!getTerminalNode(this.treeNodes, terminalMetadata.nodeId)) continue;

      const alreadyBound = this.metadataByTerminal.has(candidate.terminal);
      const hasDuplicateIdentity = terminalCandidates.some((otherCandidate) =>
        otherCandidate.terminal !== candidate.terminal && otherCandidate.metadata &&
        (otherCandidate.metadata.nodeId === terminalMetadata.nodeId ||
          otherCandidate.metadata.sessionId === terminalMetadata.sessionId),
      );
      const hasDuplicateToken = terminalMetadata.recoveryToken && liveTerminals.some((terminal) =>
        terminal !== candidate.terminal &&
        getTerminalRecoveryToken(terminal.name) === terminalMetadata.recoveryToken,
      );

      // An existing object binding remains authoritative. Never choose between new ambiguous handles.
      if (!alreadyBound && (hasDuplicateIdentity || hasDuplicateToken)) continue;

      if (!alreadyBound) {
        this.metadataByTerminal.set(candidate.terminal, terminalMetadata);

        try {
          this.treeState = await registerTreeNodeSession(
            this.configFilePath, terminalMetadata.nodeId, terminalMetadata.sessionId,
          );
        } catch (error) {
          this.metadataByTerminal.delete(candidate.terminal);

          throw error;
        }
      }

      if (this.disposed) break;

      // Registration can wait for a file lock while the native terminal closes.
      if (!vscode.window.terminals.includes(candidate.terminal) || candidate.terminal.exitStatus !== undefined) {
        this.metadataByTerminal.delete(candidate.terminal);

        if (candidate.terminal.exitStatus?.reason !== vscode.TerminalExitReason.Shutdown) {
          await this.clearSession(terminalMetadata);
        }

        continue;
      }

      if (!alreadyBound && vscode.window.terminals.some((terminal) => {
        if (terminal === candidate.terminal || terminal.exitStatus !== undefined || this.closingTerminals.has(terminal)) {
          return false;
        }

        const otherMetadata = this.resolveTerminalMetadata(terminal);

        return (terminalMetadata.recoveryToken !== undefined &&
          getTerminalRecoveryToken(terminal.name) === terminalMetadata.recoveryToken) ||
          (otherMetadata !== undefined &&
            (otherMetadata.sessionId === terminalMetadata.sessionId || otherMetadata.nodeId === terminalMetadata.nodeId));
      })) {
        this.metadataByTerminal.delete(candidate.terminal);

        continue;
      }

      this.terminalBySessionId.set(terminalMetadata.sessionId, candidate.terminal);
      this.createSessionActivity(terminalMetadata.sessionId, terminalMetadata.nodeId);
      this.recoveryMessageByNodeId.delete(terminalMetadata.nodeId);
      hostedTerminalSessions.push({ id: terminalMetadata.sessionId, nodeId: terminalMetadata.nodeId });

      if (!alreadyBound) {
        this.emitTerminalHostEvent({
          type: "recovered", sessionId: terminalMetadata.sessionId, nodeId: terminalMetadata.nodeId,
        });
      }
    }

    return hostedTerminalSessions.filter((hostedTerminalSession) => {
      const terminal = this.terminalBySessionId.get(hostedTerminalSession.id);

      return terminal !== undefined && vscode.window.terminals.includes(terminal) &&
        terminal.exitStatus === undefined && !this.closingTerminals.has(terminal);
    });
  }

  private resolveTerminalMetadata(terminal: vscode.Terminal): TerminalMetadata | undefined {
    const boundMetadata = this.metadataByTerminal.get(terminal);

    if (boundMetadata) return boundMetadata;

    const recoveryToken = getTerminalRecoveryToken(terminal.name);
    const terminalEnvironment = "env" in terminal.creationOptions ? terminal.creationOptions.env : undefined;

    if (recoveryToken) {
      const recoveryRecord = this.terminalRecovery.getRecord(recoveryToken);

      if (!recoveryRecord || recoveryRecord.workspaceId !== this.workspaceId ||
        recoveryRecord.configFilePath !== this.configFilePath) return undefined;

      const expectedEnvironment = {
        [treeTYSessionIdEnvironmentName]: recoveryRecord.sessionId,
        [treeTYNodeIdEnvironmentName]: recoveryRecord.nodeId,
        [workspaceIdEnvironmentName]: this.workspaceId,
        TREETY_CONFIG_FILE: this.configFilePath,
        TREETY_CONFIG_SOURCE: this.configSource,
      };

      for (const [name, value] of Object.entries(expectedEnvironment)) {
        if (terminalEnvironment && name in terminalEnvironment && terminalEnvironment[name] !== value) {
          return undefined;
        }
      }

      return { ...recoveryRecord, recoveryToken };
    }

    const terminalMetadata = getTerminalMetadata(terminal);

    if (!terminalMetadata || terminalMetadata.workspaceId !== this.workspaceId) return undefined;
    if (terminalEnvironment?.TREETY_CONFIG_FILE !== undefined &&
      terminalEnvironment.TREETY_CONFIG_FILE !== this.configFilePath) return undefined;

    const matchingRecords = this.terminalRecovery.getRecords({
      configFilePath: this.configFilePath, workspaceId: this.workspaceId,
    }).filter((record) => record.nodeId === terminalMetadata.nodeId &&
      record.sessionId === terminalMetadata.sessionId,
    );

    if (matchingRecords.length > 1) return undefined;

    return { ...terminalMetadata, recoveryToken: matchingRecords[0]?.token };
  }

  private scheduleRecovery(): void {
    if (this.disposed) return;

    this.recoveryAttempts = 20;
    this.scheduleRecoveryAttempt();
  }

  private scheduleRecoveryAttempt(): void {
    if (this.disposed || this.recoveryTimer || this.recoveryAttempts === 0) return;

    // The public API has no title-change event. Retry briefly, then allow Refresh/open to retry.
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      this.recoveryAttempts -= 1;
      void this.getSessions().catch(reportActivityError).finally(() => this.scheduleRecoveryAttempt());
    }, 250);
  }

  private handleClosedTerminal(terminal: vscode.Terminal): void {
    const terminalMetadata = this.metadataByTerminal.get(terminal);

    if (!terminalMetadata) return;

    this.metadataByTerminal.delete(terminal);
    this.closingTerminals.delete(terminal);
    this.terminalBySessionId.delete(terminalMetadata.sessionId);
    this.removeSessionActivity(terminalMetadata.sessionId);

    if (terminal.exitStatus?.reason !== vscode.TerminalExitReason.Shutdown) {
      void this.clearSession(terminalMetadata).catch(reportActivityError);
    }

    this.emitTerminalHostEvent({
      type: "closed",
      sessionId: terminalMetadata.sessionId,
      nodeId: terminalMetadata.nodeId,
      exitCode: terminal.exitStatus?.code,
    });
  }

  private async clearSession(terminalMetadata: TerminalMetadata): Promise<void> {
    this.closedSessionIds.add(terminalMetadata.sessionId);

    const cleanupResults = await Promise.allSettled([
      clearTreeNodeSession(this.configFilePath, terminalMetadata.nodeId, terminalMetadata.sessionId),
      terminalMetadata.recoveryToken
        ? this.terminalRecovery.removeRecord(terminalMetadata.recoveryToken)
        : Promise.resolve(),
    ]);
    const cleanupErrors = cleanupResults.flatMap((cleanupResult) =>
      cleanupResult.status === "rejected" ? [cleanupResult.reason] : [],
    );

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Could not finish terminal session cleanup.");
    }
  }

  private handleStartedTerminalShellExecution(
    terminalShellEvent: vscode.TerminalShellExecutionStartEvent,
  ): void {
    const terminalMetadata = this.metadataByTerminal.get(terminalShellEvent.terminal);

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
    const terminalMetadata = this.metadataByTerminal.get(terminalShellEvent.terminal);

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
  recoveryRecord: TerminalRecoveryRecord,
  configFilePath: string,
  configSource: "global" | "workspace",
  sessionUri?: string,
): vscode.TerminalOptions {
  const terminalOptions: vscode.TerminalOptions = {
    name: buildTerminalTitle(terminalLaunchRequest.name, recoveryRecord.token),
    cwd: terminalLaunchRequest.cwd,
    env: {
      ...terminalLaunchRequest.env,
      ...buildTreeTYTerminalEnvironment({
        configFilePath,
        configSource,
        nodeId: terminalLaunchRequest.nodeId,
        metadata: terminalLaunchRequest.metadata,
        sessionId: recoveryRecord.sessionId,
        sessionUri,
      }),
      [workspaceIdEnvironmentName]: recoveryRecord.workspaceId,
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
