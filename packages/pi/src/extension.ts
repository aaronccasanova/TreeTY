const treeTYConfigFileEnvironmentName = "TREETY_CONFIG_FILE";
const treeTYNodeIdEnvironmentName = "TREETY_NODE_ID";

interface PiSessionManager {
  getSessionId(): string;
}

interface PiExtensionContext {
  cwd: string;
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
  | "session_compact"
  | "session_start";

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

export default function registerTreeTYExtension(
  extensionAPI: PiExtensionAPI,
): void {
  let attentionSignalingEnabled = false;
  let pendingOperation = Promise.resolve();

  const runSerializedOperation = (operation: () => Promise<void>): Promise<void> => {
    const nextOperation = pendingOperation.then(operation);

    pendingOperation = nextOperation.catch(() => {});

    return nextOperation;
  };

  const linkCommand: PiCommand = {
    description: "Link this Pi session to the current TreeTY terminal",
    handler: (_commandArguments, commandContext) => runSerializedOperation(async () => {
      assertTreeTYEnvironment(process.env);

      const piSessionId = commandContext.sessionManager.getSessionId();

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
        "/integrations/pi/sessionId",
        JSON.stringify(piSessionId),
      ]);

      attentionSignalingEnabled = true;
      commandContext.ui.notify(
        "TreeTY will resume this Pi session and signal when it needs attention.",
        "info",
      );
    }),
  };

  extensionAPI.registerCommand("treety-link", linkCommand);
  extensionAPI.registerCommand("treety-setup", {
    ...linkCommand,
    description: "Compatibility alias for /treety-link",
  });

  extensionAPI.registerCommand("treety-unlink", {
    description: "Unlink this Pi session while keeping the TreeTY terminal",
    handler: (_commandArguments, commandContext) => runSerializedOperation(async () => {
      assertTreeTYEnvironment(process.env, "/treety-unlink");

      const piSessionUnlinkResult = await unlinkPiSession(extensionAPI, commandContext);

      attentionSignalingEnabled = false;

      const notification = piSessionUnlinkResult.changed
        ? "Unlinked this Pi session. The terminal and saved conversation are preserved."
        : "This Pi session is already unlinked from this TreeTY terminal.";

      commandContext.ui.notify(
        piSessionUnlinkResult.preservedCommand
          ? `${notification} The custom startup command was left unchanged.`
          : notification,
        "info",
      );
    }),
  });

  extensionAPI.on("session_start", (_event, extensionContext) => runSerializedOperation(async () => {
    attentionSignalingEnabled = false;

    if (!getEnvironmentIsTreeTY(process.env)) return;

    const piSessionId = extensionContext.sessionManager.getSessionId();

    // Launch-time metadata can still describe a link removed in this terminal.
    const treeTYNodeMetadataContent = await getTreeTYNodeMetadataContent(extensionAPI);

    attentionSignalingEnabled = getSessionIsLinked(piSessionId, treeTYNodeMetadataContent);
  }));

  extensionAPI.on("agent_start", () => runSerializedOperation(async () => {
    if (!attentionSignalingEnabled) return;

    await runTreeTYCommand(extensionAPI, ["attention", "clear"]);
  }));

  extensionAPI.on("agent_settled", () => runSerializedOperation(async () => {
    if (!attentionSignalingEnabled) return;

    await runTreeTYCommand(extensionAPI, ["attention", "set"]);
  }));

  extensionAPI.on("session_compact", () => runSerializedOperation(async () => {
    if (!attentionSignalingEnabled) return;

    await runTreeTYCommand(extensionAPI, ["attention", "set"]);
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
  commandContext: PiCommandContext,
): Promise<PiSessionUnlinkResult> {
  const treeTYNodeResult = await runTreeTYCommand(extensionAPI, ["show"]);
  const treeTYNode = JSON.parse(treeTYNodeResult.stdout) as unknown;

  if (!getValueIsRecord(treeTYNode) || treeTYNode["kind"] !== "terminal") {
    throw new Error("/treety-unlink requires a TreeTY terminal leaf.");
  }

  const piSessionId = commandContext.sessionManager.getSessionId();
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
      environment[treeTYNodeIdEnvironmentName],
  );
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
