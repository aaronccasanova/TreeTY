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
import type {
  TerminalRecoveryRecord,
  TerminalRecoveryRecordUpdate,
  TerminalRecoveryRegistry,
} from "./terminal-recovery";

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

interface TerminalCandidate {
  terminal: vscode.Terminal;
  metadata: TerminalMetadata | undefined;
  token: string | undefined;
}

interface TerminalIdentityCounts {
  nodes: Map<string, number>;
  sessions: Map<string, number>;
  tokens: Map<string, number>;
}

const workspaceIdEnvironmentName = "TREETY_WORKSPACE_ID";

export class TerminalRecoveryError extends Error {
  public constructor(message: string, public readonly canForget = false) {
    super(message);
  }
}

export class VscodeTerminalHost implements TerminalHost {
  private readonly ownerBindingId = crypto.randomUUID();

  private readonly pendingSessionTokens = new Set<string>();

  private readonly sessionOperationCompletions = new Set<Promise<void>>();

  private readonly terminalBySessionId = new Map<string, vscode.Terminal>();

  private readonly metadataByTerminal = new Map<vscode.Terminal, TerminalMetadata>();

  private readonly closingTerminals = new Set<vscode.Terminal>();

  private readonly closedSessionIds = new Set<string>();

  private readonly allowedSessionCreations = new Set<string>();

  private readonly recoveryMessageByNodeId = new Map<string, string>();

  private sessionDiscovery: Promise<HostedTerminalSession[]> | undefined;

  private terminalChangeVersion = 0;

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
      vscode.window.onDidOpenTerminal((terminal) => this.handleOpenedTerminal(terminal)),
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

  public getSessions(): Promise<HostedTerminalSession[]> {
    this.sessionDiscovery ??= this.trackSessionOperation(this.discoverSessions().finally(() => {
      this.sessionDiscovery = undefined;
    }));

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

  public createSession(terminalLaunchRequest: TerminalLaunchRequest): Promise<HostedTerminalSession> {
    return this.trackSessionOperation(this.createNativeSession(terminalLaunchRequest));
  }

  private async createNativeSession(
    terminalLaunchRequest: TerminalLaunchRequest,
  ): Promise<HostedTerminalSession> {
    const forgetPreviousSession = this.allowedSessionCreations.delete(terminalLaunchRequest.nodeId);
    const hostedTerminalSessions = await this.getSessions();
    const existingHostedTerminalSession = hostedTerminalSessions.find((hostedTerminalSession) =>
      hostedTerminalSession.nodeId === terminalLaunchRequest.nodeId,
    );

    terminalLaunchRequest.signal?.throwIfAborted();

    if (existingHostedTerminalSession) return { ...existingHostedTerminalSession, recovered: true };

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

    let reservedTerminalRecoveryRecord: TerminalRecoveryRecord | undefined;
    let terminalRecoveryRecord: TerminalRecoveryRecord;
    const retiredTerminalRecoveryRecords: TerminalRecoveryRecord[] = [];

    try {
      terminalRecoveryRecord = await this.terminalRecovery.runWithNodeLock({
        configFilePath: this.configFilePath, nodeId: terminalLaunchRequest.nodeId,
      }, async () => {
        await this.terminalRecovery.refresh(true);

        terminalLaunchRequest.signal?.throwIfAborted();

        if (this.disposed) throw new Error("The terminal host was disposed before launch.");

        const closedTerminalRecoveryRecords = await this.terminalRecovery.retireClosedRecordsForNode({
          configFilePath: this.configFilePath, nodeId: terminalLaunchRequest.nodeId,
        });

        await Promise.all(closedTerminalRecoveryRecords.map((terminalRecoveryRecord) =>
          clearTreeNodeSession(this.configFilePath, terminalRecoveryRecord.nodeId, terminalRecoveryRecord.sessionId),
        )).catch(reportActivityError);

        const unresolvedRecords = this.assertSessionCreationAllowed(
          terminalLaunchRequest.nodeId, forgetPreviousSession,
        );

        for (const terminalRecoveryRecord of unresolvedRecords) {
          await this.terminalRecovery.updateRecord(terminalRecoveryRecord.token, {
            retired: true, ownerId: undefined, ownerProcessId: undefined, ownerBindingId: undefined,
          });
          retiredTerminalRecoveryRecords.push(terminalRecoveryRecord);
        }

        const terminalRecoveryRecord = await this.terminalRecovery.createRecord({
          configFilePath: this.configFilePath,
          workspaceId: this.workspaceId,
          sessionId,
          nodeId: terminalLaunchRequest.nodeId,
          ownerBindingId: this.ownerBindingId,
        });
        reservedTerminalRecoveryRecord = terminalRecoveryRecord;
        this.pendingSessionTokens.add(terminalRecoveryRecord.token);

        return terminalRecoveryRecord;
      });
    } catch (error) {
      if (reservedTerminalRecoveryRecord) {
        this.pendingSessionTokens.delete(reservedTerminalRecoveryRecord.token);
        await this.clearSession({
          ...reservedTerminalRecoveryRecord, recoveryToken: reservedTerminalRecoveryRecord.token,
        }).catch(reportActivityError);
      }

      throw error;
    }

    // Retired identities remain readable if VS Code revives an old tab later.
    await Promise.all(retiredTerminalRecoveryRecords.map((terminalRecoveryRecord) =>
      clearTreeNodeSession(this.configFilePath, terminalRecoveryRecord.nodeId, terminalRecoveryRecord.sessionId),
    )).catch(reportActivityError);
    const terminalOptions = buildTerminalOptions(
      terminalLaunchRequest,
      terminalRecoveryRecord,
      this.configFilePath,
      this.configSource,
      sessionUri,
    );
    const terminalMetadata: TerminalMetadata = { ...terminalRecoveryRecord, recoveryToken: terminalRecoveryRecord.token };

    try {
      this.treeState = await registerTreeNodeSession(
        this.configFilePath, terminalLaunchRequest.nodeId, sessionId,
      );
      terminalLaunchRequest.signal?.throwIfAborted();

      if (this.disposed) throw new Error("The terminal host was disposed before launch.");

      // A restored handle may arrive while persistence waits. Recheck before spawning a process.
      const recoveredHostedTerminalSessions = await this.getSessions();
      const recoveredHostedTerminalSession = recoveredHostedTerminalSessions.find((hostedTerminalSession) =>
        hostedTerminalSession.nodeId === terminalLaunchRequest.nodeId,
      );

      if (recoveredHostedTerminalSession) {
        await this.clearSession(terminalMetadata);

        terminalLaunchRequest.signal?.throwIfAborted();

        return { ...recoveredHostedTerminalSession, recovered: true };
      }

      terminalLaunchRequest.signal?.throwIfAborted();

      if (this.disposed) throw new Error("The terminal host was disposed before launch.");

      this.assertSessionCreationAllowed(terminalLaunchRequest.nodeId, false, terminalRecoveryRecord.token);

      const terminal = vscode.window.createTerminal(terminalOptions);
      this.metadataByTerminal.set(terminal, terminalMetadata);
      this.terminalBySessionId.set(sessionId, terminal);
      this.createSessionActivity(sessionId, terminalLaunchRequest.nodeId);
      this.recoveryMessageByNodeId.delete(terminalLaunchRequest.nodeId);
      this.trackTerminalProcess(terminal, terminalMetadata);

      return { id: sessionId, nodeId: terminalLaunchRequest.nodeId };
    } catch (error) {
      await this.clearSession(terminalMetadata);

      throw error;
    } finally {
      this.pendingSessionTokens.delete(terminalRecoveryRecord.token);
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
    if (this.disposed) return;

    this.disposed = true;

    for (const terminalMetadata of this.metadataByTerminal.values()) {
      void this.trackSessionOperation(this.releaseSessionOwnership(terminalMetadata).catch(reportActivityError));
    }

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

  public async flushSessionCleanup(): Promise<void> {
    while (this.sessionOperationCompletions.size > 0) {
      await Promise.all(this.sessionOperationCompletions);
    }
  }

  private trackSessionOperation<Result>(sessionOperation: Promise<Result>): Promise<Result> {
    const sessionOperationCompletion = sessionOperation.then(() => {}, () => {}).finally(() => {
      this.sessionOperationCompletions.delete(sessionOperationCompletion);
    });

    this.sessionOperationCompletions.add(sessionOperationCompletion);

    return sessionOperation;
  }

  private assertSessionCreationAllowed(
    nodeId: string,
    forgetPreviousSession: boolean,
    pendingToken?: string,
  ): TerminalRecoveryRecord[] {
    const terminalCandidates = this.getTerminalCandidates();
    const matchingTerminals = terminalCandidates.filter((terminalCandidate) =>
      terminalCandidate.metadata?.nodeId === nodeId,
    );

    if (matchingTerminals.length > 0) {
      this.throwRecoveryError(nodeId,
        matchingTerminals.length > 1
          ? "Multiple terminals claim this leaf. Close the extra terminal tabs, then refresh TreeTY. A new terminal cannot be started while these tabs exist."
          : "A terminal for this leaf is already open or being recovered. Refresh TreeTY to attach to it.",
      );
    }

    const terminalRecoveryRecords = this.terminalRecovery.getRecordsForNode({
      configFilePath: this.configFilePath, nodeId,
    }).filter((terminalRecoveryRecord) => terminalRecoveryRecord.token !== pendingToken &&
      !this.closedSessionIds.has(terminalRecoveryRecord.sessionId),
    );

    for (const terminalRecoveryRecord of terminalRecoveryRecords) {
      const recordLiveness = this.terminalRecovery.getRecordLiveness(terminalRecoveryRecord);

      if (recordLiveness === "other-window") {
        this.throwRecoveryError(nodeId,
          "This leaf is open or starting in another VS Code window. Use or close its terminal in that window, then refresh TreeTY.",
        );
      }

      if (recordLiveness === "owned") {
        this.throwRecoveryError(nodeId,
          "This leaf already has a running or starting terminal. Its tab may be restoring or have a renamed title. Close that terminal before starting another, or refresh TreeTY to retry attachment.",
        );
      }
    }

    const unresolvedRecords = terminalRecoveryRecords.filter((terminalRecoveryRecord) =>
      !terminalRecoveryRecord.retired,
    );

    if (unresolvedRecords.length > 0 && !forgetPreviousSession) {
      const hasRunningProcess = unresolvedRecords.some((terminalRecoveryRecord) =>
        this.terminalRecovery.getRecordLiveness(terminalRecoveryRecord) === "running",
      );

      this.throwRecoveryError(nodeId,
        hasRunningProcess
          ? "A saved terminal process may still be running, but its terminal could not be recovered. Refresh TreeTY to retry. If you have closed the old terminal in every window, open this leaf to forget its saved session and start again."
          : "A previous terminal session could not be recovered. Refresh TreeTY to retry. If you have closed the old terminal in every window, open this leaf to forget its saved session and start again.", true,
      );
    }

    return unresolvedRecords;
  }

  private throwRecoveryError(nodeId: string, recoveryMessage: string, canForget = false): never {
    this.recoveryMessageByNodeId.set(nodeId, recoveryMessage);
    this.activityChangeEmitter.fire(nodeId);

    throw new TerminalRecoveryError(recoveryMessage, canForget);
  }

  private getTerminalCandidates(): TerminalCandidate[] {
    const terminalRecoveryRecords = this.terminalRecovery.getRecords({
      configFilePath: this.configFilePath, workspaceId: this.workspaceId,
    });
    const recoveryRecordsBySessionId = new Map<string, TerminalRecoveryRecord[]>();

    for (const terminalRecoveryRecord of terminalRecoveryRecords) {
      const sessionRecoveryRecords = recoveryRecordsBySessionId.get(terminalRecoveryRecord.sessionId) ?? [];

      sessionRecoveryRecords.push(terminalRecoveryRecord);
      recoveryRecordsBySessionId.set(terminalRecoveryRecord.sessionId, sessionRecoveryRecords);
    }

    return vscode.window.terminals.filter((terminal) =>
      terminal.exitStatus === undefined && !this.closingTerminals.has(terminal),
    ).map((terminal) => ({
      terminal,
      metadata: this.resolveTerminalMetadata(terminal, recoveryRecordsBySessionId),
      token: getTerminalRecoveryToken(terminal.name),
    }));
  }

  private async discoverSessions(): Promise<HostedTerminalSession[]> {
    await this.terminalRecovery.refresh();

    if (this.disposed) return [];

    // Resolve each handle and count identities once per pass, rather than once per candidate.
    let terminalCandidates = this.getTerminalCandidates();
    let identityCounts = buildTerminalIdentityCounts(terminalCandidates);
    let terminalChangeVersion = this.terminalChangeVersion;
    const hostedTerminalSessions: HostedTerminalSession[] = [];

    for (const terminalCandidate of terminalCandidates) {
      const terminalMetadata = terminalCandidate.metadata;

      if (this.disposed) break;
      if (!terminalMetadata) continue;
      if (getTerminalNode(this.treeNodes, terminalMetadata.nodeId)?.kind !== "terminal") continue;

      const alreadyBound = this.metadataByTerminal.has(terminalCandidate.terminal);

      if (!alreadyBound && getHasDuplicateIdentity(terminalMetadata, identityCounts)) {
        this.recoveryMessageByNodeId.set(terminalMetadata.nodeId,
          "Multiple terminals claim this leaf. Close the extra terminal tabs, then refresh TreeTY.",
        );

        continue;
      }

      if (!alreadyBound) {
        if (!(await this.claimSessionOwnership(terminalMetadata))) continue;

        if (this.disposed) {
          await this.releaseSessionOwnership(terminalMetadata);

          break;
        }

        if (!vscode.window.terminals.includes(terminalCandidate.terminal) ||
          terminalCandidate.terminal.exitStatus !== undefined) {
          await this.finishClosedSession(terminalCandidate.terminal, terminalMetadata);

          continue;
        }

        this.metadataByTerminal.set(terminalCandidate.terminal, terminalMetadata);

        try {
          this.treeState = await registerTreeNodeSession(
            this.configFilePath, terminalMetadata.nodeId, terminalMetadata.sessionId,
          );
        } catch (error) {
          this.metadataByTerminal.delete(terminalCandidate.terminal);
          await this.releaseSessionOwnership(terminalMetadata);

          throw error;
        }
      }

      if (this.disposed) break;

      if (!vscode.window.terminals.includes(terminalCandidate.terminal) || terminalCandidate.terminal.exitStatus !== undefined) {
        this.metadataByTerminal.delete(terminalCandidate.terminal);

        // Registration may finish after the close callback cleared the old state.
        await this.finishClosedSession(terminalCandidate.terminal, terminalMetadata);

        continue;
      }

      if (terminalChangeVersion !== this.terminalChangeVersion) {
        terminalCandidates = this.getTerminalCandidates();
        identityCounts = buildTerminalIdentityCounts(terminalCandidates);
        terminalChangeVersion = this.terminalChangeVersion;
      }

      if (!alreadyBound && getHasDuplicateIdentity(terminalMetadata, identityCounts)) {
        this.metadataByTerminal.delete(terminalCandidate.terminal);
        await this.releaseSessionOwnership(terminalMetadata);

        continue;
      }

      this.terminalBySessionId.set(terminalMetadata.sessionId, terminalCandidate.terminal);
      this.createSessionActivity(terminalMetadata.sessionId, terminalMetadata.nodeId);
      this.recoveryMessageByNodeId.delete(terminalMetadata.nodeId);
      hostedTerminalSessions.push({ id: terminalMetadata.sessionId, nodeId: terminalMetadata.nodeId });

      if (!alreadyBound) {
        this.trackTerminalProcess(terminalCandidate.terminal, terminalMetadata);
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

  private async claimSessionOwnership(terminalMetadata: TerminalMetadata): Promise<boolean> {
    if (!terminalMetadata.recoveryToken) return true;

    return this.terminalRecovery.runWithNodeLock({
      configFilePath: this.configFilePath, nodeId: terminalMetadata.nodeId,
    }, async () => {
      await this.terminalRecovery.refreshRecord(terminalMetadata.recoveryToken!);

      const terminalRecoveryRecord = this.terminalRecovery.getRecord(terminalMetadata.recoveryToken!);

      if (!terminalRecoveryRecord || this.disposed) return false;

      // Retirement allows a later launch, so a revived retired token needs a fresh cross-window check.
      if (terminalRecoveryRecord.retired) await this.terminalRecovery.refresh(true);

      const otherRecoveryRecords = this.terminalRecovery.getRecordsForNode({
        configFilePath: this.configFilePath, nodeId: terminalMetadata.nodeId,
      }).filter((otherRecoveryRecord) => otherRecoveryRecord.token !== terminalRecoveryRecord.token);
      const hasOtherLiveSession = otherRecoveryRecords.some((otherRecoveryRecord) => {
        const recordLiveness = this.terminalRecovery.getRecordLiveness(otherRecoveryRecord);

        return recordLiveness === "other-window" ||
          (recordLiveness === "owned" && !this.pendingSessionTokens.has(otherRecoveryRecord.token));
      });

      if (hasOtherLiveSession) {
        this.recoveryMessageByNodeId.set(terminalMetadata.nodeId,
          "Another terminal already owns this leaf. Close the extra terminal tabs, then refresh TreeTY.",
        );

        return false;
      }

      if (this.terminalRecovery.getRecordLiveness(terminalRecoveryRecord) === "other-window") {
        this.recoveryMessageByNodeId.set(terminalMetadata.nodeId,
          "This leaf is owned by another VS Code window. Close the duplicate tab or its terminal in the other window, then refresh TreeTY.",
        );

        return false;
      }

      await this.terminalRecovery.updateRecord(terminalRecoveryRecord.token, {
        ownerId: this.terminalRecovery.ownerId,
        ownerProcessId: this.terminalRecovery.ownerProcessId,
        ownerBindingId: this.ownerBindingId,
        retired: false,
        closeReason: undefined,
        persistence: undefined,
      });

      return true;
    });
  }

  private trackTerminalProcess(terminal: vscode.Terminal, terminalMetadata: TerminalMetadata): void {
    if (!terminalMetadata.recoveryToken) return;

    void Promise.resolve(terminal.processId).then(async (terminalProcessId) => {
      if (!terminalProcessId || this.disposed || this.metadataByTerminal.get(terminal) !== terminalMetadata) return;

      await this.terminalRecovery.runWithNodeLock({
        configFilePath: this.configFilePath, nodeId: terminalMetadata.nodeId,
      }, async () => {
        await this.terminalRecovery.refreshRecord(terminalMetadata.recoveryToken!);

        const terminalRecoveryRecord = this.terminalRecovery.getRecord(terminalMetadata.recoveryToken!);

        if (!terminalRecoveryRecord || this.disposed || this.metadataByTerminal.get(terminal) !== terminalMetadata ||
          terminalRecoveryRecord.ownerId !== this.terminalRecovery.ownerId) return;

        await this.terminalRecovery.updateRecord(terminalRecoveryRecord.token, { terminalProcessId });
      });
    }).catch(reportActivityError);
  }

  private async releaseSessionOwnership(
    terminalMetadata: TerminalMetadata,
    clearState = false,
    terminalRecoveryRecordUpdate: TerminalRecoveryRecordUpdate = {},
  ): Promise<void> {
    if (!terminalMetadata.recoveryToken) {
      if (clearState) {
        await clearTreeNodeSession(this.configFilePath, terminalMetadata.nodeId, terminalMetadata.sessionId);
      }

      return;
    }

    await this.terminalRecovery.runWithNodeLock({
      configFilePath: this.configFilePath, nodeId: terminalMetadata.nodeId,
    }, async () => {
      await this.terminalRecovery.refreshRecord(terminalMetadata.recoveryToken!);

      const terminalRecoveryRecord = this.terminalRecovery.getRecord(terminalMetadata.recoveryToken!);

      if (terminalRecoveryRecord?.ownerId !== undefined &&
        (terminalRecoveryRecord.ownerId !== this.terminalRecovery.ownerId ||
          terminalRecoveryRecord.ownerBindingId !== this.ownerBindingId)) return;

      // A transferred session must not have its new window's state cleared after that window claims it.
      const cleanupResults = await Promise.allSettled([
        clearState
          ? clearTreeNodeSession(this.configFilePath, terminalMetadata.nodeId, terminalMetadata.sessionId)
          : Promise.resolve(),
        terminalRecoveryRecord
          ? this.terminalRecovery.updateRecord(terminalRecoveryRecord.token, {
            ...terminalRecoveryRecordUpdate,
            ownerId: undefined, ownerProcessId: undefined, ownerBindingId: undefined,
          })
          : Promise.resolve(),
      ]);
      const cleanupErrors = cleanupResults.flatMap((cleanupResult) =>
        cleanupResult.status === "rejected" ? [cleanupResult.reason] : [],
      );

      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Could not finish terminal session cleanup.");
      }
    });
  }

  private resolveTerminalMetadata(
    terminal: vscode.Terminal,
    recoveryRecordsBySessionId: Map<string, TerminalRecoveryRecord[]>,
  ): TerminalMetadata | undefined {
    const boundTerminalMetadata = this.metadataByTerminal.get(terminal);

    if (boundTerminalMetadata) return boundTerminalMetadata;

    const recoveryToken = getTerminalRecoveryToken(terminal.name);
    const terminalEnvironment = "env" in terminal.creationOptions ? terminal.creationOptions.env : undefined;

    if (recoveryToken && this.terminalRecovery.isAvailable) {
      const terminalRecoveryRecord = this.terminalRecovery.getRecord(recoveryToken);

      if (!terminalRecoveryRecord || terminalRecoveryRecord.workspaceId !== this.workspaceId ||
        terminalRecoveryRecord.configFilePath !== this.configFilePath) return undefined;

      const expectedEnvironment = {
        [treeTYSessionIdEnvironmentName]: terminalRecoveryRecord.sessionId,
        [treeTYNodeIdEnvironmentName]: terminalRecoveryRecord.nodeId,
        [workspaceIdEnvironmentName]: this.workspaceId,
        TREETY_CONFIG_FILE: this.configFilePath,
        TREETY_CONFIG_SOURCE: this.configSource,
      };

      for (const [name, value] of Object.entries(expectedEnvironment)) {
        if (terminalEnvironment && name in terminalEnvironment && terminalEnvironment[name] !== value) {
          return undefined;
        }
      }

      return { ...terminalRecoveryRecord, recoveryToken };
    }

    const terminalMetadata = getTerminalMetadata(terminal);

    if (!terminalMetadata || terminalMetadata.workspaceId !== this.workspaceId) return undefined;
    if (terminalEnvironment?.TREETY_CONFIG_FILE !== undefined &&
      terminalEnvironment.TREETY_CONFIG_FILE !== this.configFilePath) return undefined;

    const matchingTerminalRecoveryRecords = (recoveryRecordsBySessionId.get(terminalMetadata.sessionId) ?? [])
      .filter((terminalRecoveryRecord) => terminalRecoveryRecord.nodeId === terminalMetadata.nodeId);

    if (matchingTerminalRecoveryRecords.length > 1) return undefined;

    return { ...terminalMetadata, recoveryToken: matchingTerminalRecoveryRecords[0]?.token };
  }

  private handleOpenedTerminal(terminal: vscode.Terminal): void {
    this.terminalChangeVersion += 1;

    const recoveryToken = getTerminalRecoveryToken(terminal.name);
    const terminalMetadata = getTerminalMetadata(terminal);

    // Unrelated terminal opens never start polling or disk scans for every tree.
    if (!recoveryToken && terminalMetadata?.workspaceId !== this.workspaceId) return;

    void (async () => {
      if (recoveryToken && !this.terminalRecovery.getRecord(recoveryToken)) {
        await this.terminalRecovery.refreshRecord(recoveryToken);
      }

      if (this.disposed) return;

      const terminalRecoveryRecord = recoveryToken ? this.terminalRecovery.getRecord(recoveryToken) : undefined;

      if (recoveryToken && (terminalRecoveryRecord?.configFilePath !== this.configFilePath ||
        terminalRecoveryRecord.workspaceId !== this.workspaceId)) return;

      await this.getSessions();
    })().catch(reportActivityError);
  }

  private handleClosedTerminal(terminal: vscode.Terminal): void {
    this.terminalChangeVersion += 1;

    const terminalMetadata = this.metadataByTerminal.get(terminal);

    if (!terminalMetadata) return;

    const requestedClose = this.closingTerminals.has(terminal);

    this.metadataByTerminal.delete(terminal);
    this.closingTerminals.delete(terminal);
    this.terminalBySessionId.delete(terminalMetadata.sessionId);
    this.removeSessionActivity(terminalMetadata.sessionId);

    void this.trackSessionOperation(
      this.finishClosedSession(terminal, terminalMetadata, requestedClose).catch(reportActivityError),
    );

    this.emitTerminalHostEvent({
      type: "closed",
      sessionId: terminalMetadata.sessionId,
      nodeId: terminalMetadata.nodeId,
      exitCode: terminal.exitStatus?.code,
    });
  }

  private async finishClosedSession(
    terminal: vscode.Terminal,
    terminalMetadata: TerminalMetadata,
    requestedClose = false,
  ): Promise<void> {
    if (requestedClose || terminal.exitStatus?.reason === vscode.TerminalExitReason.Process ||
      terminal.exitStatus?.reason === vscode.TerminalExitReason.Extension) {
      await this.clearSession(terminalMetadata);

      return;
    }

    const terminalRecoveryRecordUpdate: TerminalRecoveryRecordUpdate = {};

    if (terminal.exitStatus?.reason === vscode.TerminalExitReason.User) {
      // VS Code also reports User when transferring a still-persisted terminal to another window.
      terminalRecoveryRecordUpdate.closeReason = "user";
    }

    if (terminal.exitStatus?.reason === vscode.TerminalExitReason.Shutdown) {
      const terminalConfiguration = vscode.workspace.getConfiguration("terminal.integrated");

      terminalRecoveryRecordUpdate.closeReason = "shutdown";
      terminalRecoveryRecordUpdate.persistence = !terminalConfiguration.get("enablePersistentSessions", true)
        ? "disabled"
        : terminalConfiguration.get<string>("persistentSessionReviveProcess", "onExit") === "never"
          ? "reconnect"
          : "revive";
    }

    await this.releaseSessionOwnership(terminalMetadata, true, terminalRecoveryRecordUpdate);
  }

  private async clearSession(terminalMetadata: TerminalMetadata): Promise<void> {
    this.closedSessionIds.add(terminalMetadata.sessionId);

    if (!terminalMetadata.recoveryToken) {
      await clearTreeNodeSession(this.configFilePath, terminalMetadata.nodeId, terminalMetadata.sessionId);

      return;
    }

    await this.terminalRecovery.removeRecord(terminalMetadata.recoveryToken, {
      ownerId: this.terminalRecovery.ownerId, ownerBindingId: this.ownerBindingId,
    }, async () => {
      await clearTreeNodeSession(this.configFilePath, terminalMetadata.nodeId, terminalMetadata.sessionId);
    });
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

function buildTerminalIdentityCounts(terminalCandidates: TerminalCandidate[]): TerminalIdentityCounts {
  const identityCounts: TerminalIdentityCounts = {
    nodes: new Map(), sessions: new Map(), tokens: new Map(),
  };

  for (const terminalCandidate of terminalCandidates) {
    if (terminalCandidate.token) {
      identityCounts.tokens.set(terminalCandidate.token,
        (identityCounts.tokens.get(terminalCandidate.token) ?? 0) + 1,
      );
    }

    if (!terminalCandidate.metadata) continue;

    const { nodeId, sessionId } = terminalCandidate.metadata;

    identityCounts.nodes.set(nodeId, (identityCounts.nodes.get(nodeId) ?? 0) + 1);
    identityCounts.sessions.set(sessionId, (identityCounts.sessions.get(sessionId) ?? 0) + 1);
  }

  return identityCounts;
}

function getHasDuplicateIdentity(terminalMetadata: TerminalMetadata, identityCounts: TerminalIdentityCounts): boolean {
  return (identityCounts.nodes.get(terminalMetadata.nodeId) ?? 0) > 1 ||
    (identityCounts.sessions.get(terminalMetadata.sessionId) ?? 0) > 1 ||
    (terminalMetadata.recoveryToken !== undefined &&
      (identityCounts.tokens.get(terminalMetadata.recoveryToken) ?? 0) > 1);
}

function buildTerminalOptions(
  terminalLaunchRequest: TerminalLaunchRequest,
  terminalRecoveryRecord: TerminalRecoveryRecord,
  configFilePath: string,
  configSource: "global" | "workspace",
  sessionUri?: string,
): vscode.TerminalOptions {
  const terminalOptions: vscode.TerminalOptions = {
    name: buildTerminalTitle(terminalLaunchRequest.name, terminalRecoveryRecord.token),
    cwd: terminalLaunchRequest.cwd,
    env: {
      ...terminalLaunchRequest.env,
      ...buildTreeTYTerminalEnvironment({
        configFilePath,
        configSource,
        nodeId: terminalLaunchRequest.nodeId,
        metadata: terminalLaunchRequest.metadata,
        sessionId: terminalRecoveryRecord.sessionId,
        sessionUri,
      }),
      [workspaceIdEnvironmentName]: terminalRecoveryRecord.workspaceId,
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
