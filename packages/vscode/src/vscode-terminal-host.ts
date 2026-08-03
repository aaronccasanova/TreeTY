import * as crypto from "node:crypto";

import {
  Disposable,
  HostedTerminalSession,
  TerminalHost,
  TerminalHostEvent,
  TerminalHostEventListener,
  TerminalLaunchRequest,
} from "@treety/core";
import * as vscode from "vscode";

interface TerminalMetadata {
  sessionId: string;
  nodeId: string;
  workspaceId: string;
}

const sessionIdEnvironmentName = "TREETY_SESSION_ID";
const nodeIdEnvironmentName = "TREETY_NODE_ID";
const workspaceIdEnvironmentName = "TREETY_WORKSPACE_ID";

export class VscodeTerminalHost implements TerminalHost {
  private readonly terminalBySessionId = new Map<string, vscode.Terminal>();

  private readonly terminalHostEventListeners = new Set<TerminalHostEventListener>();

  private readonly vscodeDisposables: vscode.Disposable[];

  public constructor(private readonly workspaceId: string) {
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

      this.terminalBySessionId.set(terminalMetadata.sessionId, terminal);
      hostedTerminalSessions.push({
        id: terminalMetadata.sessionId,
        nodeId: terminalMetadata.nodeId,
      });
    }

    return hostedTerminalSessions;
  }

  public async createSession(
    terminalLaunchRequest: TerminalLaunchRequest,
  ): Promise<HostedTerminalSession> {
    const sessionId = crypto.randomUUID();
    const terminalOptions = buildTerminalOptions(
      terminalLaunchRequest,
      sessionId,
      this.workspaceId,
    );
    const terminal = vscode.window.createTerminal(terminalOptions);

    this.terminalBySessionId.set(sessionId, terminal);

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

    terminal.show();
  }

  public closeSession(hostSessionId: string): void {
    const terminal = this.terminalBySessionId.get(hostSessionId);

    if (!terminal) return;

    terminal.dispose();
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

    this.terminalHostEventListeners.clear();
    this.terminalBySessionId.clear();
  }

  private handleClosedTerminal(terminal: vscode.Terminal): void {
    const terminalMetadata = getTerminalMetadata(terminal);

    if (!terminalMetadata || terminalMetadata.workspaceId !== this.workspaceId) {
      return;
    }

    this.terminalBySessionId.delete(terminalMetadata.sessionId);
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

    this.emitTerminalHostEvent({
      type: "idle",
      sessionId: terminalMetadata.sessionId,
      nodeId: terminalMetadata.nodeId,
      exitCode: terminalShellEvent.exitCode,
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
): vscode.TerminalOptions {
  const terminalOptions: vscode.TerminalOptions = {
    name: `TreeTY: ${terminalLaunchRequest.name}`,
    cwd: terminalLaunchRequest.cwd,
    env: {
      ...terminalLaunchRequest.env,
      [sessionIdEnvironmentName]: sessionId,
      [nodeIdEnvironmentName]: terminalLaunchRequest.nodeId,
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

  const sessionId = terminalEnvironment[sessionIdEnvironmentName];
  const nodeId = terminalEnvironment[nodeIdEnvironmentName];
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
