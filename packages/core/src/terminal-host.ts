import {
  Disposable,
  JsonValue,
  TerminalCommandConfig,
  TerminalEnvironment,
  TerminalShellConfig,
} from "./model";

export interface TerminalLaunchRequest {
  nodeId: string;
  name: string;
  cwd: string;
  env: TerminalEnvironment;
  metadata?: JsonValue;
  shell?: TerminalShellConfig;
  command?: TerminalCommandConfig;
  signal?: AbortSignal;
}

export interface HostedTerminalSession {
  id: string;
  nodeId: string;
  /** A pre-existing session returned by createSession must survive launch cancellation. */
  recovered?: boolean;
}

export type TerminalHostEvent =
  | {
      type: "recovered";
      sessionId: string;
      nodeId: string;
    }
  | {
      type: "started";
      sessionId: string;
      nodeId: string;
    }
  | {
      type: "idle";
      sessionId: string;
      nodeId: string;
      exitCode?: number;
    }
  | {
      type: "closed";
      sessionId: string;
      nodeId: string;
      exitCode?: number;
    };

export type TerminalHostEventListener = (
  terminalHostEvent: TerminalHostEvent,
) => void;

export interface TerminalHost extends Disposable {
  getSessions(): Promise<HostedTerminalSession[]>;
  createSession(
    terminalLaunchRequest: TerminalLaunchRequest,
  ): Promise<HostedTerminalSession>;
  revealSession(hostSessionId: string): void;
  closeSession(hostSessionId: string): void;
  subscribe(terminalHostEventListener: TerminalHostEventListener): Disposable;
}
