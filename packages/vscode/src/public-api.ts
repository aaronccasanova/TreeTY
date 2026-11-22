import type * as vscode from "vscode";

export interface TerminalIdentity {
  configFile: string;
  nodeId: string;
  sessionId: string;
}

export interface TerminalTarget {
  configFile: string;
  nodeId: string;
  sessionId?: string;
}

export interface NodeCommandTarget {
  nodeId: string;
  configFile?: string;
  confirm?: boolean;
}

export interface TreeTYApi {
  readonly apiVersion: 1;
  getTerminalIdentity(terminal: vscode.Terminal): Promise<TerminalIdentity | undefined>;
  getTerminal(target: TerminalTarget): Promise<vscode.Terminal | undefined>;
}
