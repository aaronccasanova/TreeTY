export interface TerminalActivity {
  state: "busy" | "idle" | "unknown";
  showSpinner: boolean;
}

interface ShellActivity {
  execution: object;
  startedAt: number;
  explicitActivityObserved: boolean;
}

/** Tracks work separately from the lifetime of the terminal process. */
export class TerminalActivityTracker {
  private shellActivity: ShellActivity | undefined;
  private shellIdleObserved = false;
  private explicitActivity: "busy" | "idle" | undefined;
  private activity: TerminalActivity = { state: "unknown", showSpinner: false };
  private spinnerTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(private readonly onChange: () => void) {}

  public getActivity(): TerminalActivity {
    return this.activity;
  }

  public startShellExecution(execution: object, now = Date.now()): void {
    this.shellActivity = {
      execution,
      startedAt: now,
      explicitActivityObserved: this.explicitActivity !== undefined,
    };

    this.updateActivity();
  }

  public hasShellExecution(execution: object): boolean {
    return this.shellActivity?.execution === execution;
  }

  public endShellExecution(execution: object, now = Date.now()): boolean {
    if (this.shellActivity?.execution !== execution) return false;

    const needsAttention = !this.shellActivity.explicitActivityObserved &&
      now - this.shellActivity.startedAt >= 5_000;

    this.shellActivity = undefined;
    this.shellIdleObserved = true;
    this.explicitActivity = undefined;
    this.updateActivity();

    return needsAttention;
  }

  public setExplicitActivity(state: "busy" | "idle" | undefined): void {
    this.explicitActivity = state;

    if (state !== undefined && this.shellActivity) {
      this.shellActivity.explicitActivityObserved = true;
    }

    this.updateActivity();
  }

  public dispose(): void {
    clearTimeout(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  private updateActivity(): void {
    // Once an explicit reporter has reported within a command, losing it
    // must not make its enclosing interactive process look busy again.
    const state = this.explicitActivity ??
      (this.shellActivity
        ? this.shellActivity.explicitActivityObserved ? "unknown" : "busy"
        : this.shellIdleObserved ? "idle" : "unknown");

    if (state === this.activity.state) return;

    clearTimeout(this.spinnerTimer);
    this.spinnerTimer = undefined;
    this.activity = { state, showSpinner: false };
    this.onChange();

    if (state !== "busy") return;

    this.spinnerTimer = setTimeout(() => {
      this.spinnerTimer = undefined;
      this.activity = { state: "busy", showSpinner: true };
      this.onChange();
    }, 1_000);
  }
}
