const piSessionIdEnvironmentName = "PI_SESSION_ID";
const treeTYConfigFileEnvironmentName = "TREETY_CONFIG_FILE";
const treeTYNodeIdEnvironmentName = "TREETY_NODE_ID";
const treeTYNodeMetadataEnvironmentName = "TREETY_NODE_METADATA";

module.exports = function registerTreeTYExtension(extensionAPI) {
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
};

function getRequiredSetupEnvironment(environment) {
  if (
    !environment[treeTYConfigFileEnvironmentName] ||
    !environment[treeTYNodeIdEnvironmentName]
  ) {
    throw new Error(
      "/treety-setup must run inside a TreeTY terminal.",
    );
  }

  const piSessionId = environment[piSessionIdEnvironmentName];

  if (!piSessionId) {
    throw new Error("PI_SESSION_ID is not available for this Pi session.");
  }

  return piSessionId;
}

function getSessionIsLinked(environment) {
  const piSessionId = environment[piSessionIdEnvironmentName];
  const treeTYNodeMetadataContent =
    environment[treeTYNodeMetadataEnvironmentName];

  if (!piSessionId || !treeTYNodeMetadataContent) return false;

  try {
    const treeTYNodeMetadata = JSON.parse(treeTYNodeMetadataContent);

    return (
      typeof treeTYNodeMetadata === "object" &&
      treeTYNodeMetadata !== null &&
      treeTYNodeMetadata.integrations?.pi?.sessionId === piSessionId
    );
  } catch {
    return false;
  }
}

async function runTreeTYCommand(extensionAPI, treeTYArguments) {
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

module.exports.getRequiredSetupEnvironment = getRequiredSetupEnvironment;
module.exports.getSessionIsLinked = getSessionIsLinked;
