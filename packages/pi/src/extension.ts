const treeTYConfigFileEnvironmentName = "TREETY_CONFIG_FILE";
const treeTYNodeIdEnvironmentName = "TREETY_NODE_ID";
const treeTYNodeMetadataEnvironmentName = "TREETY_NODE_METADATA";

interface PiSessionManager {
  getSessionId(): string;
}

interface PiExtensionContext {
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

interface PiSessionStartEvent {
  reason: "fork" | "new" | "reload" | "resume" | "startup";
  type: "session_start";
}

type PiEventName = "agent_settled" | "agent_start" | "session_start";

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

  extensionAPI.registerCommand("treety-setup", {
    description: "Link this Pi session to the current TreeTY terminal",
    handler: async (_commandArguments, commandContext) => {
      assertTreeTYEnvironment(process.env);

      const piSessionId = commandContext.sessionManager.getSessionId();

      await runTreeTYCommand(extensionAPI, [
        "configure",
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
    },
  });

  extensionAPI.on("session_start", async (event, extensionContext) => {
    if (!getEnvironmentIsTreeTY(process.env)) {
      attentionSignalingEnabled = false;

      return;
    }

    const sessionStartEvent = event as PiSessionStartEvent;
    const piSessionId = extensionContext.sessionManager.getSessionId();

    if (sessionStartEvent.reason === "startup") {
      attentionSignalingEnabled = getSessionIsLinked(
        piSessionId,
        process.env[treeTYNodeMetadataEnvironmentName],
      );

      return;
    }

    const treeTYNodeMetadataContent = await getTreeTYNodeMetadataContent(
      extensionAPI,
    );

    attentionSignalingEnabled = getSessionIsLinked(
      piSessionId,
      treeTYNodeMetadataContent,
    );
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

export function assertTreeTYEnvironment(environment: NodeJS.ProcessEnv): void {
  if (getEnvironmentIsTreeTY(environment)) return;

  throw new Error("/treety-setup must run inside a TreeTY terminal.");
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
  return typeof value === "object" && value !== null;
}
