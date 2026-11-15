import type { TerminalStatus } from "@treety/core";

import type { TerminalActivity } from "./terminal-activity";

interface TerminalPresentationOptions {
  status: TerminalStatus;
  activity: TerminalActivity;
  animationEnabled: boolean;
  terminalAnimationEnabled: boolean;
  reduceMotion: boolean;
}

export function getTerminalPresentation(options: TerminalPresentationOptions): {
  icon: string;
  color?: string;
  description: string;
} {
  const color = {
    stopped: undefined,
    starting: "notificationsWarningIcon.foreground",
    idle: "descriptionForeground",
    running: "testing.iconPassed",
    failed: "problemsErrorIcon.foreground",
  }[options.status];
  const showSpinner = options.activity.state === "busy" && options.activity.showSpinner &&
    options.animationEnabled && options.terminalAnimationEnabled && !options.reduceMotion;

  return {
    icon: showSpinner ? "loading~spin" : options.status === "stopped" ? "circle-outline" : "circle-filled",
    color,
    description: options.activity.state === "busy" ? `${options.status}, busy` : options.status,
  };
}
