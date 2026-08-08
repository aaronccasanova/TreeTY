const piSessionIdEnvironmentName = "PI_SESSION_ID";
const treeTYConfigFileEnvironmentName = "TREETY_CONFIG_FILE";
const treeTYNodeIdEnvironmentName = "TREETY_NODE_ID";
const treeTYNodeMetadataEnvironmentName = "TREETY_NODE_METADATA";

interface PiCommandContext {
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

interface PiExtensionAPI {
  exec(command: string, commandArguments: string[]): Promise<PiCommandResult>;
  on(
    eventName: "agent_settled" | "agent_start",
    eventHandler: () => Promise<void>,
  ): void;
  registerCommand(commandName: string, command: PiCommand): void;
}

export default function registerTreeTYExtension(
  extensionAPI: PiExtensionAPI,
): void {
  let attentionSignalingEnabled = getSessionIsLinked(process.env);

  extensionAPI.registerCommand("treety-setup", {
    description: "Link this Pi session to the current TreeTY terminal",
    handler: async (_commandArguments, commandContext) => {
      const piSessionId = getRequiredSetupEnvironment(process.env);

      await runTreeTYCommand(extensionAPI, [
        "metadata",
        "set-path",
        "/integrations/pi/sessionId",
        JSON.stringify(piSessionId),
      ]);
      await runTreeTYCommand(extensionAPI, [
        "configure",
        "--",
        "pi",
        "--session",
        piSessionId,
      ]);

      attentionSignalingEnabled = true;
      commandContext.ui.notify(
        "TreeTY will resume this Pi session and signal when it needs attention.",
        "info",
      );
    },
  });

  extensionAPI.on("agent_start", async () => {
    if (!attentionSignalingEnabled) return;

    await runTreeTYCommand(extensionAPI, ["attention", "clear"]);
  });

  extensionAPI.on("agent_settled", async () => {
    if (!attentionSignalingEnabled) return;

    await runTreeTYCommand(extensionAPI, ["attention", "set"]);
  });
}

export function getRequiredSetupEnvironment(
  environment: NodeJS.ProcessEnv,
): string {
  if (
    !environment[treeTYConfigFileEnvironmentName] ||
    !environment[treeTYNodeIdEnvironmentName]
  ) {
    throw new Error("/treety-setup must run inside a TreeTY terminal.");
  }

  const piSessionId = environment[piSessionIdEnvironmentName];

  if (!piSessionId) {
    throw new Error("PI_SESSION_ID is not available for this Pi session.");
  }

  return piSessionId;
}

export function getSessionIsLinked(environment: NodeJS.ProcessEnv): boolean {
  const piSessionId = environment[piSessionIdEnvironmentName];
  const treeTYNodeMetadataContent =
    environment[treeTYNodeMetadataEnvironmentName];

  if (!piSessionId || !treeTYNodeMetadataContent) return false;

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

async function runTreeTYCommand(
  extensionAPI: PiExtensionAPI,
  treeTYArguments: string[],
): Promise<void> {
  const treeTYCommandResult = await extensionAPI.exec(
    "treety",
    treeTYArguments,
  );

  if (treeTYCommandResult.code === 0) return;

  const errorMessage =
    treeTYCommandResult.stderr.trim() ||
    treeTYCommandResult.stdout.trim() ||
    `treety exited with status ${treeTYCommandResult.code}`;

  throw new Error(errorMessage);
}

function getValueIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
