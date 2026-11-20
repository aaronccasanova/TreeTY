#!/usr/bin/env node

import * as os from "node:os";
import * as util from "node:util";

import {
  addTreeGroup,
  addTreeTerminal,
  clearTreeNodeMetadataPath,
  createEmptyTreeConfig,
  getTreeNode,
  JsonValue,
  moveTreeNode,
  removeTreeNode,
  renameTreeNode,
  RestartPolicy,
  TerminalEnvironment,
  TreeConfig,
  TreeNodeConfig,
  TreeNodeDefaults,
  UpdateTreeNodeOptions,
  treeTYConfigSourceEnvironmentName,
  treeTYNodeIdEnvironmentName,
  treeTYSessionIdEnvironmentName,
  treeTYSessionUriEnvironmentName,
  setTreeNodeAttention,
  setTreeNodeActivity,
  setTreeNodeMetadataPath,
  updateTreeNode,
} from "@treety/core";

import {
  getCommandDefinition,
  getHelpContent,
  parseCommandArguments,
  ParsedCommandArguments,
} from "./command-options";
import {
  getFileExists,
  loadTreeConfig,
  mutateTreeConfigFile,
  resolveTreeConfigFilePath,
  writeTreeConfig,
} from "./config-store";

interface CliOutput {
  writeError(message: string): void;
  writeOutput(message: string): void;
}

export interface RunCliOptions {
  currentDirPath?: string;
  environment?: NodeJS.ProcessEnv;
  homeDirPath?: string;
  output?: CliOutput;
}

interface TreeConfigCommandContext {
  parsedCommandArguments: ParsedCommandArguments;
  runCliOptions: Required<RunCliOptions>;
  treeConfigFilePath: string;
}

const cliPackageConfig = require("../package.json") as { version: string };

export async function runCli(
  cliArguments: string[],
  options: RunCliOptions = {},
): Promise<number> {
  const runCliOptions = getRunCliOptions(options);

  try {
    const parsedCommandArguments = parseCommandArguments(cliArguments);
    const commandName = parsedCommandArguments.commandArguments[0];

    if (
      (commandName === "version" || hasFlag(parsedCommandArguments, "--version")) &&
      commandName !== "help" &&
      !hasFlag(parsedCommandArguments, "--help")
    ) {
      runCliOptions.output.writeOutput(cliPackageConfig.version);

      return 0;
    }

    if (commandName === undefined || commandName === "help" || hasFlag(parsedCommandArguments, "--help")) {
      const helpCommandName = commandName === "help"
        ? parsedCommandArguments.commandArguments[1]
        : commandName;

      runCliOptions.output.writeOutput(getHelpContent(cliPackageConfig.version, helpCommandName));

      return 0;
    }

    if (
      hasFlag(parsedCommandArguments, "--global") &&
      getOptionValue(parsedCommandArguments, "--config")
    ) {
      throw new Error("Use either --global or --config, not both.");
    }

    const treeConfigFilePath = await resolveTreeConfigFilePath({
      configFileName: getOptionValue(parsedCommandArguments, "--config"),
      currentDirPath: runCliOptions.currentDirPath,
      environment: runCliOptions.environment,
      homeDirPath: runCliOptions.homeDirPath,
      initialize: commandName === "init",
      useGlobal: hasFlag(parsedCommandArguments, "--global"),
    });
    const treeConfigCommandContext: TreeConfigCommandContext = {
      parsedCommandArguments,
      runCliOptions,
      treeConfigFilePath,
    };

    if (commandName === "init") {
      return await runInitCommand(treeConfigCommandContext);
    }

    if (commandName === "list" || commandName === "ls") {
      return await runListCommand(treeConfigCommandContext);
    }

    if (commandName === "add") {
      return await runAddCommand(treeConfigCommandContext);
    }

    if (commandName === "rename") {
      return await runRenameCommand(treeConfigCommandContext);
    }

    if (commandName === "show") {
      return await runShowCommand(treeConfigCommandContext);
    }

    if (commandName === "configure") {
      return await runConfigureCommand(treeConfigCommandContext);
    }

    if (commandName === "metadata") {
      return await runMetadataCommand(treeConfigCommandContext);
    }

    if (commandName === "activity") {
      return await runActivityCommand(treeConfigCommandContext);
    }

    if (commandName === "attention") {
      return await runAttentionCommand(treeConfigCommandContext);
    }

    if (commandName === "uri") {
      return runUriCommand(treeConfigCommandContext);
    }

    if (commandName === "current") {
      return await runCurrentCommand(treeConfigCommandContext);
    }

    if (commandName === "move") {
      return await runMoveCommand(treeConfigCommandContext);
    }

    if (commandName === "remove" || commandName === "rm") {
      return await runRemoveCommand(treeConfigCommandContext);
    }

    if (commandName === "config") {
      return await runConfigCommand(treeConfigCommandContext);
    }

    throw new Error(`Unknown command "${commandName}". Run "treety help" for usage.`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    runCliOptions.output.writeError(`TreeTY: ${errorMessage}`);

    return 1;
  }
}

async function runInitCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, getCommandDefinition("init").optionNames);
  assertNoCommandArguments(context.parsedCommandArguments, 1, "init");

  if (
    (await getFileExists(context.treeConfigFilePath)) &&
    !hasFlag(context.parsedCommandArguments, "--force")
  ) {
    throw new Error(
      `Configuration already exists at ${context.treeConfigFilePath}. Use --force to replace it.`,
    );
  }

  const treeConfig = createEmptyTreeConfig();

  await writeTreeConfig(context.treeConfigFilePath, treeConfig);
  writeMutationOutput(context, `Initialized ${context.treeConfigFilePath}`, { config: treeConfig });

  return 0;
}

async function runListCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, getCommandDefinition("list").optionNames);
  assertNoCommandArguments(context.parsedCommandArguments, 1, "list");

  const treeConfig = await loadTreeConfig(context.treeConfigFilePath);

  if (hasFlag(context.parsedCommandArguments, "--json")) {
    context.runCliOptions.output.writeOutput(
      JSON.stringify(treeConfig, null, 2),
    );

    return 0;
  }

  const treeLines = renderTreeLines(treeConfig);

  context.runCliOptions.output.writeOutput(
    [`TreeTY: ${context.treeConfigFilePath}`, ...treeLines].join("\n"),
  );

  return 0;
}

async function runAddCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, getCommandDefinition("add").optionNames);

  const treeNodeKind = context.parsedCommandArguments.commandArguments[1];
  const treeNodeName = context.parsedCommandArguments.commandArguments[2];

  if (treeNodeKind !== "group" && treeNodeKind !== "terminal") {
    throw new Error('Usage: treety add <group|terminal> <name> [options]');
  }

  if (!treeNodeName) {
    throw new Error(`A name is required for the new ${treeNodeKind}.`);
  }

  assertNoCommandArguments(context.parsedCommandArguments, 3, "add");

  if (
    treeNodeKind === "group" &&
    context.parsedCommandArguments.terminalCommandArguments.length > 0
  ) {
    throw new Error("Only terminal nodes can define a startup command.");
  }

  const treeNodeDefaults = getTreeNodeDefaults(
    context.parsedCommandArguments,
  );
  const treeNodeOptions = {
    ...treeNodeDefaults,
    id: getOptionValue(context.parsedCommandArguments, "--id"),
    name: treeNodeName,
    metadata: getMetadataOption(context.parsedCommandArguments),
    parentId: getOptionValue(context.parsedCommandArguments, "--parent"),
  };
  let addedTreeNodeId = "";

  const treeConfig = await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) => {
    const updatedTreeConfig =
      treeNodeKind === "group"
        ? addTreeGroup(treeConfig, treeNodeOptions)
        : addTreeTerminal(treeConfig, {
            ...treeNodeOptions,
            command: getTerminalCommand(context.parsedCommandArguments),
          });

    addedTreeNodeId = getAddedTreeNodeId(treeConfig, updatedTreeConfig);

    return updatedTreeConfig;
  });

  writeMutationOutput(
    context,
    `Added ${treeNodeKind} "${treeNodeName}" (${addedTreeNodeId}) to ${context.treeConfigFilePath}`,
    { node: getTreeNode(treeConfig, addedTreeNodeId) },
  );

  return 0;
}

async function runRenameCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, getCommandDefinition("rename").optionNames);

  const renameArguments = context.parsedCommandArguments.commandArguments.slice(1);
  const explicitNodeId =
    renameArguments.length === 2 ? renameArguments[0] : undefined;
  const treeNodeName = renameArguments.at(-1);

  if (!treeNodeName || renameArguments.length > 2) {
    throw new Error("Usage: treety rename [node-id] <name> [--node <node-id>]");
  }

  const nodeId = getTargetNodeId(context, explicitNodeId);

  const treeConfig = await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) =>
    renameTreeNode(treeConfig, nodeId, treeNodeName),
  );
  writeMutationOutput(
    context,
    `Renamed ${nodeId} to "${treeNodeName}" in ${context.treeConfigFilePath}`,
    { node: getTreeNode(treeConfig, nodeId) },
  );

  return 0;
}

async function runShowCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, getCommandDefinition("show").optionNames);

  const explicitNodeId = context.parsedCommandArguments.commandArguments[1];

  assertNoCommandArguments(context.parsedCommandArguments, explicitNodeId !== undefined ? 2 : 1, "show");

  const nodeId = getTargetNodeId(context, explicitNodeId);
  const treeConfig = await loadTreeConfig(context.treeConfigFilePath);
  const treeNodeConfig = getTreeNode(treeConfig, nodeId);

  if (!treeNodeConfig) {
    throw new Error(`Tree node "${nodeId}" does not exist.`);
  }

  context.runCliOptions.output.writeOutput(
    JSON.stringify(treeNodeConfig, null, 2),
  );

  return 0;
}

async function runConfigureCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, getCommandDefinition("configure").optionNames);

  const explicitNodeId = context.parsedCommandArguments.commandArguments[1];

  assertNoCommandArguments(
    context.parsedCommandArguments,
    explicitNodeId !== undefined ? 2 : 1,
    "configure",
  );

  const nodeId = getTargetNodeId(context, explicitNodeId);
  const updateTreeNodeOptions = {
    nodeId,
    ...getTreeNodeUpdate(context.parsedCommandArguments),
  };

  const expectedTreeNodeContent = getOptionValue(
    context.parsedCommandArguments,
    "--if-node",
  );
  let expectedTreeNode: unknown;

  if (expectedTreeNodeContent !== undefined) {
    try {
      expectedTreeNode = JSON.parse(expectedTreeNodeContent) as unknown;
    } catch {
      throw new Error("--if-node must contain valid JSON from treety show.");
    }
  }

  const treeConfig = await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) => {
    if (expectedTreeNodeContent !== undefined) {
      const treeNode = getTreeNode(treeConfig, nodeId);
      const treeNodeSnapshot = treeNode
        ? JSON.parse(JSON.stringify(treeNode)) as unknown
        : undefined;

      if (!util.isDeepStrictEqual(treeNodeSnapshot, expectedTreeNode)) {
        throw new Error(
          `Tree node "${nodeId}" changed since it was read. Read it again before configuring.`,
        );
      }
    }

    return updateTreeNode(treeConfig, updateTreeNodeOptions);
  });
  writeMutationOutput(
    context,
    `Configured ${nodeId} in ${context.treeConfigFilePath}`,
    { node: getTreeNode(treeConfig, nodeId) },
  );

  return 0;
}

async function runMetadataCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, getCommandDefinition("metadata").optionNames);

  const metadataCommandName =
    context.parsedCommandArguments.commandArguments[1];
  const metadataCommandArguments =
    context.parsedCommandArguments.commandArguments.slice(2);

  if (metadataCommandName === "get") {
    const nodeId = getTargetNodeId(context, metadataCommandArguments[0]);

    if (metadataCommandArguments.length > 1) {
      throw new Error("Usage: treety metadata get [node-id]");
    }

    const treeConfig = await loadTreeConfig(context.treeConfigFilePath);
    const treeNodeConfig = getTreeNode(treeConfig, nodeId);

    if (!treeNodeConfig) {
      throw new Error(`Tree node "${nodeId}" does not exist.`);
    }

    context.runCliOptions.output.writeOutput(
      JSON.stringify(treeNodeConfig.metadata ?? null, null, 2),
    );

    return 0;
  }

  if (metadataCommandName === "set") {
    const explicitNodeId =
      metadataCommandArguments.length === 2
        ? metadataCommandArguments[0]
        : undefined;
    const metadataContent = metadataCommandArguments.at(-1);

    if (!metadataContent || metadataCommandArguments.length > 2) {
      throw new Error("Usage: treety metadata set [node-id] <json>");
    }

    const nodeId = getTargetNodeId(context, explicitNodeId);
    const treeConfig = await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) =>
      updateTreeNode(treeConfig, {
        nodeId,
        metadata: parseMetadataContent(metadataContent),
        metadataAction: "replace",
      }),
    );
    writeMutationOutput(
      context,
      `Set metadata for ${nodeId} in ${context.treeConfigFilePath}`,
      { node: getTreeNode(treeConfig, nodeId) },
    );

    return 0;
  }

  if (metadataCommandName === "clear") {
    const explicitNodeId = metadataCommandArguments[0];

    if (metadataCommandArguments.length > 1) {
      throw new Error("Usage: treety metadata clear [node-id]");
    }

    const nodeId = getTargetNodeId(context, explicitNodeId);
    const treeConfig = await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) =>
      updateTreeNode(treeConfig, {
        nodeId,
        metadataAction: "remove",
      }),
    );
    writeMutationOutput(
      context,
      `Cleared metadata for ${nodeId} in ${context.treeConfigFilePath}`,
      { node: getTreeNode(treeConfig, nodeId) },
    );

    return 0;
  }

  if (metadataCommandName === "set-path") {
    const explicitNodeId =
      metadataCommandArguments.length === 3
        ? metadataCommandArguments[0]
        : undefined;
    const metadataPath = metadataCommandArguments.at(-2);
    const metadataContent = metadataCommandArguments.at(-1);

    if (
      metadataPath === undefined ||
      metadataContent === undefined ||
      metadataCommandArguments.length > 3
    ) {
      throw new Error(
        "Usage: treety metadata set-path [node-id] <json-pointer> <json>",
      );
    }

    const nodeId = getTargetNodeId(context, explicitNodeId);

    const treeConfig = await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) =>
      setTreeNodeMetadataPath(
        treeConfig,
        nodeId,
        metadataPath,
        parseMetadataContent(metadataContent),
      ),
    );
    writeMutationOutput(
      context,
      `Set metadata path ${metadataPath} for ${nodeId} in ${context.treeConfigFilePath}`,
      { node: getTreeNode(treeConfig, nodeId) },
    );

    return 0;
  }

  if (metadataCommandName === "clear-path") {
    const explicitNodeId =
      metadataCommandArguments.length === 2
        ? metadataCommandArguments[0]
        : undefined;
    const metadataPath = metadataCommandArguments.at(-1);

    if (metadataPath === undefined || metadataCommandArguments.length > 2) {
      throw new Error(
        "Usage: treety metadata clear-path [node-id] <json-pointer>",
      );
    }

    const nodeId = getTargetNodeId(context, explicitNodeId);

    const treeConfig = await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) =>
      clearTreeNodeMetadataPath(treeConfig, nodeId, metadataPath),
    );
    writeMutationOutput(
      context,
      `Cleared metadata path ${metadataPath} for ${nodeId} in ${context.treeConfigFilePath}`,
      { node: getTreeNode(treeConfig, nodeId) },
    );

    return 0;
  }

  throw new Error(
    "Usage: treety metadata <get|set|clear|set-path|clear-path> [node-id] [path] [json]",
  );
}

async function runActivityCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, getCommandDefinition("activity").optionNames);
  assertNoCommandArguments(context.parsedCommandArguments, 2, "activity");

  if (context.parsedCommandArguments.terminalCommandArguments.length > 0) {
    throw new Error("Activity does not accept terminal command arguments.");
  }

  const action = context.parsedCommandArguments.commandArguments[1];

  if (action !== "register" && action !== "busy" && action !== "idle" && action !== "unregister") {
    throw new Error("Usage: treety activity <register|busy|idle|unregister> --reporter <id> --pid <pid>");
  }

  const sessionId = getOptionValue(context.parsedCommandArguments, "--session") ??
    context.runCliOptions.environment[treeTYSessionIdEnvironmentName];
  const reporterId = getOptionValue(context.parsedCommandArguments, "--reporter");
  const processIdContent = getOptionValue(context.parsedCommandArguments, "--pid");
  const attention = getOptionValue(context.parsedCommandArguments, "--attention");

  if (!sessionId) {
    throw new Error("Activity requires TREETY_SESSION_ID or --session <host-session-id>.");
  }

  if (!reporterId) throw new Error("Activity requires --reporter <id>.");
  if (!processIdContent || !/^[1-9][0-9]*$/.test(processIdContent)) {
    throw new Error("Activity --pid must be a positive integer.");
  }

  if (attention !== undefined && attention !== "set" && attention !== "clear") {
    throw new Error('Activity --attention must be "set" or "clear".');
  }

  const nodeId = getTargetNodeId(context);

  const treeState = await setTreeNodeActivity(context.treeConfigFilePath, nodeId, {
    action,
    sessionId,
    reporterId,
    processId: Number(processIdContent),
    metadataPath: getOptionValue(context.parsedCommandArguments, "--metadata-path"),
    needsAttention: attention === undefined ? undefined : attention === "set",
  });
  writeMutationOutput(context, `Updated activity for ${nodeId} in ${context.treeConfigFilePath}`, {
    nodeId,
    state: Object.hasOwn(treeState.nodes, nodeId) ? treeState.nodes[nodeId] : {},
  });

  return 0;
}

async function runAttentionCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, getCommandDefinition("attention").optionNames);

  const attentionCommandName =
    context.parsedCommandArguments.commandArguments[1];
  const explicitNodeId = context.parsedCommandArguments.commandArguments[2];

  if (attentionCommandName !== "set" && attentionCommandName !== "clear") {
    throw new Error("Usage: treety attention <set|clear> [node-id]");
  }

  assertNoCommandArguments(
    context.parsedCommandArguments,
    explicitNodeId !== undefined ? 3 : 2,
    `attention ${attentionCommandName}`,
  );

  const nodeId = getTargetNodeId(context, explicitNodeId);

  const treeState = await setTreeNodeAttention(
    context.treeConfigFilePath,
    nodeId,
    attentionCommandName === "set",
  );
  writeMutationOutput(context, `${attentionCommandName === "set" ? "Set" : "Cleared"} attention for ${nodeId} in ${context.treeConfigFilePath}`, {
    nodeId,
    state: Object.hasOwn(treeState.nodes, nodeId) ? treeState.nodes[nodeId] : {},
  });

  return 0;
}

function runUriCommand(context: TreeConfigCommandContext): number {
  assertAllowedOptions(context.parsedCommandArguments, getCommandDefinition("uri").optionNames);
  assertNoCommandArguments(context.parsedCommandArguments, 1, "uri");

  if (context.parsedCommandArguments.terminalCommandArguments.length > 0) {
    throw new Error("The uri command does not accept terminal command arguments.");
  }

  const sessionUri =
    context.runCliOptions.environment[treeTYSessionUriEnvironmentName];

  if (!sessionUri) {
    throw new Error(
      "This terminal has no session URI. Run this command inside a TreeTY terminal whose host provides TREETY_SESSION_URI. Recreate terminals after updating the host.",
    );
  }

  context.runCliOptions.output.writeOutput(sessionUri);

  return 0;
}

async function runCurrentCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, getCommandDefinition("current").optionNames);
  assertNoCommandArguments(context.parsedCommandArguments, 1, "current");

  const nodeId = getTargetNodeId(context);
  const treeConfig = await loadTreeConfig(context.treeConfigFilePath);
  const treeNodeConfig = getTreeNode(treeConfig, nodeId);

  if (!treeNodeConfig) {
    throw new Error(`Tree node "${nodeId}" does not exist.`);
  }

  let configSource =
    context.runCliOptions.environment[treeTYConfigSourceEnvironmentName];

  if (hasFlag(context.parsedCommandArguments, "--global")) {
    configSource = "global";
  } else if (getOptionValue(context.parsedCommandArguments, "--config")) {
    configSource = "explicit";
  }

  context.runCliOptions.output.writeOutput(
    JSON.stringify(
      {
        configFilePath: context.treeConfigFilePath,
        configSource,
        node: treeNodeConfig,
        terminalSessionId:
          context.runCliOptions.environment[treeTYSessionIdEnvironmentName],
      },
      null,
      2,
    ),
  );

  return 0;
}

async function runMoveCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, getCommandDefinition("move").optionNames);

  const explicitNodeId = context.parsedCommandArguments.commandArguments[1];

  assertNoCommandArguments(
    context.parsedCommandArguments,
    explicitNodeId !== undefined ? 2 : 1,
    "move",
  );

  const nodeId = getTargetNodeId(context, explicitNodeId);

  const parentId = getOptionValue(context.parsedCommandArguments, "--parent");
  const moveToRoot = hasFlag(context.parsedCommandArguments, "--root");
  const beforeId = getOptionValue(context.parsedCommandArguments, "--before");
  const afterId = getOptionValue(context.parsedCommandArguments, "--after");
  const placementOptionCount = [
    parentId,
    moveToRoot ? "root" : undefined,
    beforeId,
    afterId,
  ].filter((placementOption) => placementOption !== undefined).length;

  if (placementOptionCount !== 1) {
    throw new Error(
      "Move requires exactly one of --parent, --root, --before, or --after.",
    );
  }

  const treeConfig = await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) =>
    moveTreeNode(treeConfig, { nodeId, parentId, beforeId, afterId }),
  );
  writeMutationOutput(
    context,
    `Moved ${nodeId} in ${context.treeConfigFilePath}`,
    { node: getTreeNode(treeConfig, nodeId) },
  );

  return 0;
}

async function runRemoveCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, getCommandDefinition("remove").optionNames);

  const explicitNodeId = context.parsedCommandArguments.commandArguments[1];

  assertNoCommandArguments(
    context.parsedCommandArguments,
    explicitNodeId !== undefined ? 2 : 1,
    "remove",
  );

  const nodeId = getTargetNodeId(context, explicitNodeId);

  if (!hasFlag(context.parsedCommandArguments, "--yes")) {
    throw new Error(
      `Removing "${nodeId}" also removes its descendants. Re-run with --yes to confirm.`,
    );
  }

  let removedNodeIds: string[] = [];

  await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) => {
    const updatedTreeConfig = removeTreeNode(treeConfig, nodeId);
    const retainedNodeIds = new Set(getTreeNodeIds(updatedTreeConfig.tree));

    removedNodeIds = getTreeNodeIds(treeConfig.tree).filter((treeNodeId) => !retainedNodeIds.has(treeNodeId));

    return updatedTreeConfig;
  });
  writeMutationOutput(context, `Removed ${nodeId} from ${context.treeConfigFilePath}`, { removedNodeIds });

  return 0;
}

async function runConfigCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, getCommandDefinition("config").optionNames);

  const configCommandName = context.parsedCommandArguments.commandArguments[1];

  if (configCommandName !== "path") {
    throw new Error("Usage: treety config path [--global|--config <path>]");
  }

  assertNoCommandArguments(context.parsedCommandArguments, 2, "config path");
  context.runCliOptions.output.writeOutput(context.treeConfigFilePath);

  return 0;
}

function writeMutationOutput(
  context: TreeConfigCommandContext,
  message: string,
  receipt: Record<string, unknown>,
): void {
  if (!hasFlag(context.parsedCommandArguments, "--json")) {
    context.runCliOptions.output.writeOutput(message);

    return;
  }

  context.runCliOptions.output.writeOutput(JSON.stringify({
    configFilePath: context.treeConfigFilePath,
    ...receipt,
  }, null, 2));
}

function getRunCliOptions(options: RunCliOptions): Required<RunCliOptions> {
  return {
    currentDirPath: options.currentDirPath ?? process.cwd(),
    environment: options.environment ?? process.env,
    homeDirPath: options.homeDirPath ?? os.homedir(),
    output: options.output ?? {
      writeError: (message) => process.stderr.write(`${message}\n`),
      writeOutput: (message) => process.stdout.write(`${message}\n`),
    },
  };
}

function getTreeNodeDefaults(
  parsedCommandArguments: ParsedCommandArguments,
): TreeNodeDefaults {
  const treeNodeDefaults: TreeNodeDefaults = {};
  const cwd = getOptionValue(parsedCommandArguments, "--cwd");
  const projectDir = getOptionValue(parsedCommandArguments, "--project-dir");
  const restartPolicy = getRestartPolicy(parsedCommandArguments);
  const terminalEnvironment = getTerminalEnvironment(parsedCommandArguments);
  const terminalShellPath = getOptionValue(parsedCommandArguments, "--shell");

  if (cwd) treeNodeDefaults.cwd = cwd;
  if (projectDir) treeNodeDefaults.projectDir = projectDir;
  if (restartPolicy) treeNodeDefaults.restartPolicy = restartPolicy;
  if (terminalEnvironment) treeNodeDefaults.env = terminalEnvironment;

  if (terminalShellPath) {
    treeNodeDefaults.shell = {
      path: terminalShellPath,
      args: getOptionValues(parsedCommandArguments, "--shell-arg"),
    };
  } else if (getOptionValues(parsedCommandArguments, "--shell-arg").length > 0) {
    throw new Error("--shell-arg requires --shell.");
  }

  return treeNodeDefaults;
}

function getTreeNodeUpdate(
  parsedCommandArguments: ParsedCommandArguments,
): Omit<UpdateTreeNodeOptions, "nodeId"> {
  assertOptionAndClearFlagAreExclusive(
    parsedCommandArguments,
    "--activity-animation",
    "--clear-activity-animation",
  );
  assertOptionAndClearFlagAreExclusive(
    parsedCommandArguments,
    "--cwd",
    "--clear-cwd",
  );
  assertOptionAndClearFlagAreExclusive(
    parsedCommandArguments,
    "--project-dir",
    "--clear-project-dir",
  );
  assertOptionAndClearFlagAreExclusive(
    parsedCommandArguments,
    "--restart-policy",
    "--clear-restart-policy",
  );
  assertOptionAndClearFlagAreExclusive(
    parsedCommandArguments,
    "--shell",
    "--clear-shell",
  );
  assertOptionAndClearFlagAreExclusive(
    parsedCommandArguments,
    "--metadata",
    "--clear-metadata",
  );

  if (
    parsedCommandArguments.terminalCommandArguments.length > 0 &&
    hasFlag(parsedCommandArguments, "--clear-command")
  ) {
    throw new Error("Use either a command after -- or --clear-command, not both.");
  }

  const treeNodeUpdate: Omit<UpdateTreeNodeOptions, "nodeId"> = {};
  const activityAnimation = getOptionValue(parsedCommandArguments, "--activity-animation");

  if (activityAnimation !== undefined) {
    if (activityAnimation !== "on" && activityAnimation !== "off") {
      throw new Error('--activity-animation must be "on" or "off".');
    }

    treeNodeUpdate.activityAnimation = activityAnimation === "on";
  }

  if (hasFlag(parsedCommandArguments, "--clear-activity-animation")) {
    treeNodeUpdate.activityAnimation = null;
  }

  const cwd = getOptionValue(parsedCommandArguments, "--cwd");
  const projectDir = getOptionValue(parsedCommandArguments, "--project-dir");
  const terminalEnvironment = getTerminalEnvironment(parsedCommandArguments);
  const deletedEnvironmentNames = getOptionValues(
    parsedCommandArguments,
    "--delete-env",
  );
  const restartPolicy = getRestartPolicy(parsedCommandArguments);
  const terminalShellPath = getOptionValue(parsedCommandArguments, "--shell");
  const terminalShellArguments = getOptionValues(
    parsedCommandArguments,
    "--shell-arg",
  );
  const metadataContent = getOptionValue(
    parsedCommandArguments,
    "--metadata",
  );
  const terminalCommand = getTerminalCommand(parsedCommandArguments);

  if (cwd) treeNodeUpdate.cwd = cwd;
  if (hasFlag(parsedCommandArguments, "--clear-cwd")) {
    treeNodeUpdate.cwd = null;
  }

  if (projectDir) treeNodeUpdate.projectDir = projectDir;
  if (hasFlag(parsedCommandArguments, "--clear-project-dir")) {
    treeNodeUpdate.projectDir = null;
  }

  if (restartPolicy) treeNodeUpdate.restartPolicy = restartPolicy;
  if (hasFlag(parsedCommandArguments, "--clear-restart-policy")) {
    treeNodeUpdate.restartPolicy = null;
  }

  if (terminalEnvironment || deletedEnvironmentNames.length > 0) {
    treeNodeUpdate.env = {
      delete: deletedEnvironmentNames,
      set: terminalEnvironment,
    };
  }

  if (terminalShellPath) {
    treeNodeUpdate.shell = {
      path: terminalShellPath,
      args:
        terminalShellArguments.length > 0
          ? terminalShellArguments
          : undefined,
    };
  } else if (terminalShellArguments.length > 0) {
    throw new Error("--shell-arg requires --shell.");
  }

  if (hasFlag(parsedCommandArguments, "--clear-shell")) {
    treeNodeUpdate.shell = null;
  }

  if (metadataContent !== undefined) {
    treeNodeUpdate.metadata = parseMetadataContent(metadataContent);
    treeNodeUpdate.metadataAction = "replace";
  }

  if (hasFlag(parsedCommandArguments, "--clear-metadata")) {
    treeNodeUpdate.metadataAction = "remove";
  }

  if (terminalCommand) treeNodeUpdate.command = terminalCommand;
  if (hasFlag(parsedCommandArguments, "--clear-command")) {
    treeNodeUpdate.command = null;
  }

  if (Object.keys(treeNodeUpdate).length === 0) {
    throw new Error("Configure requires at least one node option.");
  }

  return treeNodeUpdate;
}

function getTerminalEnvironment(
  parsedCommandArguments: ParsedCommandArguments,
): TerminalEnvironment | undefined {
  const terminalEnvironment: TerminalEnvironment = {};

  for (const environmentAssignment of getOptionValues(
    parsedCommandArguments,
    "--env",
  )) {
    const assignmentSeparatorIndex = environmentAssignment.indexOf("=");

    if (assignmentSeparatorIndex < 1) {
      throw new Error(`Environment assignment "${environmentAssignment}" must use NAME=value.`);
    }

    const environmentName = environmentAssignment.slice(
      0,
      assignmentSeparatorIndex,
    );

    terminalEnvironment[environmentName] = environmentAssignment.slice(
      assignmentSeparatorIndex + 1,
    );
  }

  for (const environmentName of getOptionValues(
    parsedCommandArguments,
    "--unset-env",
  )) {
    terminalEnvironment[environmentName] = null;
  }

  return Object.keys(terminalEnvironment).length > 0
    ? terminalEnvironment
    : undefined;
}

function getMetadataOption(
  parsedCommandArguments: ParsedCommandArguments,
): JsonValue | undefined {
  const metadataContent = getOptionValue(
    parsedCommandArguments,
    "--metadata",
  );

  return metadataContent === undefined
    ? undefined
    : parseMetadataContent(metadataContent);
}

function parseMetadataContent(metadataContent: string): JsonValue {
  try {
    return JSON.parse(metadataContent) as JsonValue;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    throw new Error(`Metadata is not valid JSON: ${errorMessage}`);
  }
}

function getTargetNodeId(
  context: TreeConfigCommandContext,
  explicitNodeId?: string,
): string {
  const optionNodeId = getOptionValue(context.parsedCommandArguments, "--node");

  if (explicitNodeId === "" || optionNodeId === "") {
    throw new Error("A node ID cannot be empty.");
  }

  const nodeId =
    explicitNodeId ??
    optionNodeId ??
    context.runCliOptions.environment[treeTYNodeIdEnvironmentName];

  if (nodeId) return nodeId;

  throw new Error(
    "A node ID is required outside a TreeTY terminal. Pass it directly or use --node <node-id>.",
  );
}

function assertOptionAndClearFlagAreExclusive(
  parsedCommandArguments: ParsedCommandArguments,
  optionName: string,
  clearFlagName: string,
): void {
  if (
    getOptionValue(parsedCommandArguments, optionName) === undefined ||
    !hasFlag(parsedCommandArguments, clearFlagName)
  ) {
    return;
  }

  throw new Error(`Use either ${optionName} or ${clearFlagName}, not both.`);
}

function getRestartPolicy(
  parsedCommandArguments: ParsedCommandArguments,
): RestartPolicy | undefined {
  const restartPolicy = getOptionValue(
    parsedCommandArguments,
    "--restart-policy",
  );

  if (!restartPolicy) return undefined;
  if (restartPolicy === "manual" || restartPolicy === "onOpen") {
    return restartPolicy;
  }

  throw new Error('--restart-policy must be "manual" or "onOpen".');
}

function getTerminalCommand(
  parsedCommandArguments: ParsedCommandArguments,
): { executable: string; args?: string[] } | undefined {
  const commandExecutable = parsedCommandArguments.terminalCommandArguments[0];

  if (!commandExecutable) return undefined;

  const commandArguments = parsedCommandArguments.terminalCommandArguments.slice(1);

  return {
    executable: commandExecutable,
    args: commandArguments.length > 0 ? commandArguments : undefined,
  };
}

function renderTreeLines(treeConfig: TreeConfig): string[] {
  if (treeConfig.tree.length === 0) return ["(empty)"];

  return treeConfig.tree.flatMap((treeNodeConfig) =>
    renderTreeNodeLines(treeNodeConfig, 0),
  );
}

function renderTreeNodeLines(
  treeNodeConfig: TreeNodeConfig,
  depth: number,
): string[] {
  const treeNodeMarker = treeNodeConfig.kind === "group" ? "+" : "$";
  const treeNodeLine = `${"  ".repeat(depth)}${treeNodeMarker} ${treeNodeConfig.name} [${treeNodeConfig.id}]`;

  if (treeNodeConfig.kind === "terminal") return [treeNodeLine];

  return [
    treeNodeLine,
    ...treeNodeConfig.children.flatMap((childTreeNodeConfig) =>
      renderTreeNodeLines(childTreeNodeConfig, depth + 1),
    ),
  ];
}

function getAddedTreeNodeId(
  previousTreeConfig: TreeConfig,
  updatedTreeConfig: TreeConfig,
): string {
  const previousNodeIds = new Set(getTreeNodeIds(previousTreeConfig.tree));
  const addedTreeNodeId = getTreeNodeIds(updatedTreeConfig.tree).find(
    (nodeId) => !previousNodeIds.has(nodeId),
  );

  if (addedTreeNodeId) return addedTreeNodeId;

  throw new Error("TreeTY did not add a tree node.");
}

function getTreeNodeIds(treeNodeConfigs: TreeNodeConfig[]): string[] {
  return treeNodeConfigs.flatMap((treeNodeConfig) => {
    if (treeNodeConfig.kind === "terminal") return [treeNodeConfig.id];

    return [treeNodeConfig.id, ...getTreeNodeIds(treeNodeConfig.children)];
  });
}

function assertNoCommandArguments(
  parsedCommandArguments: ParsedCommandArguments,
  expectedArgumentCount: number,
  commandName: string,
): void {
  if (
    parsedCommandArguments.commandArguments.length === expectedArgumentCount
  ) {
    return;
  }

  throw new Error(`Unexpected argument for "treety ${commandName}".`);
}

function assertAllowedOptions(
  parsedCommandArguments: ParsedCommandArguments,
  allowedOptionNames: string[],
): void {
  const allowedOptionNameSet = new Set(allowedOptionNames);
  const suppliedOptionNames = [
    ...parsedCommandArguments.flagNames,
    ...parsedCommandArguments.optionValuesByName.keys(),
  ];

  for (const suppliedOptionName of suppliedOptionNames) {
    if (allowedOptionNameSet.has(suppliedOptionName)) continue;

    throw new Error(`Unknown option ${suppliedOptionName}.`);
  }
}

function hasFlag(
  parsedCommandArguments: ParsedCommandArguments,
  flagName: string,
): boolean {
  return parsedCommandArguments.flagNames.has(flagName);
}

function getOptionValue(
  parsedCommandArguments: ParsedCommandArguments,
  optionName: string,
): string | undefined {
  return getOptionValues(parsedCommandArguments, optionName).at(-1);
}

function getOptionValues(
  parsedCommandArguments: ParsedCommandArguments,
  optionName: string,
): string[] {
  return parsedCommandArguments.optionValuesByName.get(optionName) ?? [];
}

if (require.main === module) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
