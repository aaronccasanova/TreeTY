interface PiSessionManager {
  getSessionId(): string;
}

interface PiExtensionContext {
  cwd: string;
  isIdle(): boolean;
  sessionManager: PiSessionManager;
}

interface PiCommandContext extends PiExtensionContext {
  ui: {
    notify(message: string, level: "info"): void;
  };
}

interface PiCommand {
  description: string;
  handler(commandArguments: string, commandContext: PiCommandContext): Promise<void>;
}

interface PiCommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

interface PiSessionUnlinkResult {
  changed: boolean;
  preservedCommand: boolean;
}

type PiEventName =
  | "agent_settled"
  | "agent_start"
  | "before_agent_start"
  | "session_before_compact"
  | "session_compact"
  | "session_compact_failed"
  | "session_shutdown"
  | "session_start"
  | "ui_prompt_end"
  | "ui_prompt_start";

interface PiExtensionAPI {
  exec(command: string, commandArguments: string[]): Promise<PiCommandResult>;
  on(
    eventName: PiEventName,
    eventHandler: (
      event: unknown,
      extensionContext: PiExtensionContext,
    ) => Promise<void>,
  ): void;
  registerCommand(commandName: string, command: PiCommand): void;
}

const treeTYConfigFileEnvironmentName = "TREETY_CONFIG_FILE";
const treeTYNodeIdEnvironmentName = "TREETY_NODE_ID";
const treeTYSessionIdEnvironmentName = "TREETY_SESSION_ID";
const piSessionMetadataPath = "/integrations/pi/sessionId";

export default function registerTreeTYExtension(
  extensionAPI: PiExtensionAPI,
): void {
  let linkedPiSessionId: string | undefined;
  let uiPromptActive = false;
  let pendingOperation = Promise.resolve();

  const runSerializedOperation = (operation: () => Promise<void>): Promise<void> => {
    const nextOperation = pendingOperation.then(operation);

    pendingOperation = nextOperation.catch(() => {});

    return nextOperation;
  };

  const runLinkedOperation = (
    extensionContext: PiExtensionContext,
    operation: (piSessionId: string) => Promise<void>,
  ): Promise<void> => {
    // Capture before queueing: Pi can replace its session while an operation waits.
    const piSessionId = extensionContext.sessionManager.getSessionId();

    return runSerializedOperation(async () => {
      if (linkedPiSessionId !== piSessionId) return;

      await operation(piSessionId);
    });
  };

  const linkCommand: PiCommand = {
    description: "Link this Pi session to the current TreeTY terminal",
    handler: (_commandArguments, commandContext) => {
      const piSessionId = commandContext.sessionManager.getSessionId();

      return runSerializedOperation(async () => {
        assertTreeTYEnvironment(process.env);

        await runTreeTYCommand(extensionAPI, [
          "configure",
          "--cwd",
          commandContext.cwd,
          "--",
          "pi",
          "--session",
          piSessionId,
        ]);
        await runTreeTYCommand(extensionAPI, [
          "metadata",
          "set-path",
          piSessionMetadataPath,
          JSON.stringify(piSessionId),
        ]);
        await signalTreeTYActivity(extensionAPI, piSessionId, "claim");

        linkedPiSessionId = piSessionId;

        if (!commandContext.isIdle() && !uiPromptActive) {
          await signalTreeTYActivity(extensionAPI, piSessionId, "busy");
        }

        commandContext.ui.notify(
          "TreeTY will resume this Pi session and show its activity and attention state.",
          "info",
        );
      });
    },
  };

  extensionAPI.registerCommand("treety-link", linkCommand);
  extensionAPI.registerCommand("treety-setup", {
    ...linkCommand,
    description: "Compatibility alias for /treety-link",
  });

  extensionAPI.registerCommand("treety-unlink", {
    description: "Unlink this Pi session while keeping the TreeTY terminal",
    handler: (_commandArguments, commandContext) => {
      const piSessionId = commandContext.sessionManager.getSessionId();

      return runSerializedOperation(async () => {
        assertTreeTYEnvironment(process.env, "/treety-unlink");

        const piSessionUnlinkResult = await unlinkPiSession(extensionAPI, piSessionId);

        linkedPiSessionId = undefined;
        await signalTreeTYActivity(extensionAPI, piSessionId, "clear");

        const notification = piSessionUnlinkResult.changed
          ? "Unlinked this Pi session. The terminal and saved conversation are preserved."
          : "This Pi session is already unlinked from this TreeTY terminal.";

        commandContext.ui.notify(
          piSessionUnlinkResult.preservedCommand
            ? `${notification} The custom startup command was left unchanged.`
            : notification,
          "info",
        );
      });
    },
  });

  extensionAPI.on("session_start", (_event, extensionContext) => {
    const piSessionId = extensionContext.sessionManager.getSessionId();

    return runSerializedOperation(async () => {
      const previousPiSessionId = linkedPiSessionId;

      linkedPiSessionId = undefined;
      uiPromptActive = false;

      if (!getEnvironmentIsTreeTY(process.env)) return;

      if (previousPiSessionId && previousPiSessionId !== piSessionId) {
        await signalTreeTYActivity(extensionAPI, previousPiSessionId, "clear");
      }

      // Launch-time metadata can still describe a link removed in this terminal.
      const treeTYNodeMetadataContent = await getTreeTYNodeMetadataContent(extensionAPI);

      if (!getSessionIsLinked(piSessionId, treeTYNodeMetadataContent)) return;

      await signalTreeTYActivity(extensionAPI, piSessionId, "claim");
      linkedPiSessionId = piSessionId;

      if (!extensionContext.isIdle()) {
        await signalTreeTYActivity(extensionAPI, piSessionId, "busy");
      }
    });
  });

  for (const eventName of ["before_agent_start", "agent_start", "session_before_compact"] as const) {
    extensionAPI.on(eventName, (_event, extensionContext) => runLinkedOperation(extensionContext, async (piSessionId) => {
      if (uiPromptActive) return;

      await signalTreeTYActivity(extensionAPI, piSessionId, "busy");
    }));
  }

  extensionAPI.on("agent_settled", (_event, extensionContext) => runLinkedOperation(extensionContext, async (piSessionId) => {
    // Older Pi releases allow an earlier settled handler to start another run.
    if (!extensionContext.isIdle()) return;

    await signalTreeTYActivity(extensionAPI, piSessionId, "idle", "set");
  }));

  for (const eventName of ["session_compact", "session_compact_failed"] as const) {
    extensionAPI.on(eventName, (event, extensionContext) => runLinkedOperation(extensionContext, async (piSessionId) => {
      // Automatic compaction belongs to the run and must wait for agent_settled.
      if (!getValueIsRecord(event) || event["reason"] !== "manual") return;

      // Failed compaction clears its flag first, so another handler may have started a run.
      if (eventName === "session_compact_failed" && !extensionContext.isIdle()) return;

      // Pi emits manual success before ctx.isIdle() becomes true.
      const attention = eventName === "session_compact" ? "set" : undefined;

      await signalTreeTYActivity(extensionAPI, piSessionId, "idle", attention);
    }));
  }

  extensionAPI.on("ui_prompt_start", (_event, extensionContext) => runLinkedOperation(extensionContext, async (piSessionId) => {
    uiPromptActive = true;
    await signalTreeTYActivity(extensionAPI, piSessionId, "idle");
  }));

  extensionAPI.on("ui_prompt_end", (_event, extensionContext) => runLinkedOperation(extensionContext, async (piSessionId) => {
    uiPromptActive = false;

    if (extensionContext.isIdle()) return;

    await signalTreeTYActivity(extensionAPI, piSessionId, "busy");
  }));

  extensionAPI.on("session_shutdown", (_event, extensionContext) => runLinkedOperation(extensionContext, async (piSessionId) => {
    linkedPiSessionId = undefined;
    uiPromptActive = false;
    await signalTreeTYActivity(extensionAPI, piSessionId, "clear");
  }));
}

export function assertTreeTYEnvironment(
  environment: NodeJS.ProcessEnv,
  commandName = "/treety-link",
): void {
  if (getEnvironmentIsTreeTY(environment)) return;

  throw new Error(`${commandName} must run inside a TreeTY terminal.`);
}

export function getSessionIsLinked(
  piSessionId: string,
  treeTYNodeMetadataContent: string | undefined,
): boolean {
  if (!treeTYNodeMetadataContent) return false;

  try {
    const treeTYNodeMetadata = JSON.parse(treeTYNodeMetadataContent) as unknown;

    if (!getValueIsRecord(treeTYNodeMetadata)) return false;

    const integrations = treeTYNodeMetadata["integrations"];

    if (!getValueIsRecord(integrations)) return false;

    const piIntegration = integrations["pi"];

    if (!getValueIsRecord(piIntegration)) return false;

    return piIntegration["sessionId"] === piSessionId;
  } catch {
    return false;
  }
}

async function unlinkPiSession(
  extensionAPI: PiExtensionAPI,
  piSessionId: string,
): Promise<PiSessionUnlinkResult> {
  const treeTYNodeResult = await runTreeTYCommand(extensionAPI, ["show"]);
  const treeTYNode = JSON.parse(treeTYNodeResult.stdout) as unknown;

  if (!getValueIsRecord(treeTYNode) || treeTYNode["kind"] !== "terminal") {
    throw new Error("/treety-unlink requires a TreeTY terminal leaf.");
  }

  const metadata = treeTYNode["metadata"];
  const integrations = getValueIsRecord(metadata) ? metadata["integrations"] : undefined;
  const piIntegration = getValueIsRecord(integrations) ? integrations["pi"] : undefined;
  const linkedSessionId = getValueIsRecord(piIntegration) ? piIntegration["sessionId"] : undefined;

  if (linkedSessionId !== undefined && linkedSessionId !== piSessionId) {
    throw new Error("This terminal is linked to a different Pi session. Resume that session to unlink it.");
  }

  const command = treeTYNode["command"];
  const commandArguments = getValueIsRecord(command) ? command["args"] : undefined;
  const hasMatchingResumeCommand = getValueIsRecord(command) &&
    command["executable"] === "pi" &&
    Array.isArray(commandArguments) &&
    commandArguments.length === 2 &&
    commandArguments[0] === "--session" &&
    commandArguments[1] === piSessionId;
  const hasMatchingMetadata = linkedSessionId === piSessionId;
  const preservedCommand = command !== undefined && !hasMatchingResumeCommand;

  if (!hasMatchingMetadata && !hasMatchingResumeCommand) {
    return { changed: false, preservedCommand };
  }

  // Guard the entire read-modify-write so another setup or edit cannot be erased.
  const configureArguments = ["configure", "--if-node", treeTYNodeResult.stdout];

  if (hasMatchingMetadata && getValueIsRecord(piIntegration)) {
    delete piIntegration["sessionId"];
    configureArguments.push("--metadata", JSON.stringify(metadata));
  }

  if (hasMatchingResumeCommand) configureArguments.push("--clear-command");

  await runTreeTYCommand(extensionAPI, configureArguments);

  return { changed: true, preservedCommand };
}

function getEnvironmentIsTreeTY(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(
    environment[treeTYConfigFileEnvironmentName] &&
      environment[treeTYNodeIdEnvironmentName] &&
      environment[treeTYSessionIdEnvironmentName],
  );
}

async function signalTreeTYActivity(
  extensionAPI: PiExtensionAPI,
  piSessionId: string,
  activity: "claim" | "busy" | "idle" | "clear",
  attention?: "set",
): Promise<void> {
  const activityArguments = [
    "activity",
    activity,
    "--owner",
    piSessionId,
    "--pid",
    String(process.pid),
    "--metadata-path",
    piSessionMetadataPath,
  ];

  if (attention) activityArguments.push("--attention", attention);

  await runTreeTYCommand(extensionAPI, activityArguments);
}

async function getTreeTYNodeMetadataContent(
  extensionAPI: PiExtensionAPI,
): Promise<string> {
  const treeTYCommandResult = await runTreeTYCommand(extensionAPI, [
    "metadata",
    "get",
  ]);

  return treeTYCommandResult.stdout;
}

async function runTreeTYCommand(
  extensionAPI: PiExtensionAPI,
  treeTYArguments: string[],
): Promise<PiCommandResult> {
  const treeTYCommandResult = await extensionAPI.exec(
    "treety",
    treeTYArguments,
  );

  if (treeTYCommandResult.code === 0) return treeTYCommandResult;

  const errorMessage =
    treeTYCommandResult.stderr.trim() ||
    treeTYCommandResult.stdout.trim() ||
    `treety exited with status ${treeTYCommandResult.code}`;

  throw new Error(errorMessage);
}

function getValueIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
