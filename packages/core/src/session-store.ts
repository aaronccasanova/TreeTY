import {
  Disposable,
  TerminalSessionState,
  TerminalStatus,
} from "./model";

export type TerminalSessionStateListener = (
  terminalSessionState: TerminalSessionState,
) => void;

export class TerminalSessionStore {
  private readonly terminalSessionStates = new Map<
    string,
    TerminalSessionState
  >();

  private readonly terminalSessionStateListeners = new Set<
    TerminalSessionStateListener
  >();

  public getTerminalSessionState(nodeId: string): TerminalSessionState {
    return (
      this.terminalSessionStates.get(nodeId) ?? {
        nodeId,
        status: "stopped",
      }
    );
  }

  public getTerminalSessionStates(): TerminalSessionState[] {
    return [...this.terminalSessionStates.values()];
  }

  public setTerminalSessionState(
    nodeId: string,
    status: TerminalStatus,
    hostSessionId?: string,
    exitCode?: number,
  ): TerminalSessionState {
    const terminalSessionState: TerminalSessionState = {
      nodeId,
      status,
      hostSessionId,
      exitCode,
    };

    this.terminalSessionStates.set(nodeId, terminalSessionState);

    for (const terminalSessionStateListener of this
      .terminalSessionStateListeners) {
      terminalSessionStateListener(terminalSessionState);
    }

    return terminalSessionState;
  }

  public subscribe(
    terminalSessionStateListener: TerminalSessionStateListener,
  ): Disposable {
    this.terminalSessionStateListeners.add(terminalSessionStateListener);

    return {
      dispose: () => {
        this.terminalSessionStateListeners.delete(terminalSessionStateListener);
      },
    };
  }
}
