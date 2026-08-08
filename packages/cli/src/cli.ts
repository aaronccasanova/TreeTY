#!/usr/bin/env node

import * as os from "node:os";

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
  setTreeNodeAttention,
  setTreeNodeMetadataPath,
  updateTreeNode,
} from "@treety/core";

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

interface ParsedCommandArguments {
  commandArguments: string[];
  flagNames: Set<string>;
  optionValuesByName: Map<string, string[]>;
  terminalCommandArguments: string[];
}

interface TreeConfigCommandContext {
  parsedCommandArguments: ParsedCommandArguments;
  runCliOptions: Required<RunCliOptions>;
  treeConfigFilePath: string;
}

const cliVersion = "0.0.3";

const optionNameByAlias = new Map([
  ["-c", "--config"],
  ["-g", "--global"],
  ["-h", "--help"],
  ["-v", "--version"],
  ["-y", "--yes"],
]);

const optionNamesWithValues = new Set([
  "--config",
  "--after",
  "--before",
  "--cwd",
  "--env",
  "--id",
  "--metadata",
  "--node",
  "--parent",
  "--project-dir",
  "--restart-policy",
  "--shell",
  "--shell-arg",
  "--unset-env",
  "--delete-env",
]);

export async function runCli(
  cliArguments: string[],
  options: RunCliOptions = {},
): Promise<number> {
  const runCliOptions = getRunCliOptions(options);

  try {
    const parsedCommandArguments = parseCommandArguments(cliArguments);
    const commandName = parsedCommandArguments.commandArguments[0];

    if (commandName === "version" || hasFlag(parsedCommandArguments, "--version")) {
      runCliOptions.output.writeOutput(cliVersion);

      return 0;
    }

    if (!commandName || commandName === "help" || hasFlag(parsedCommandArguments, "--help")) {
      runCliOptions.output.writeOutput(getHelpContent());

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

    if (commandName === "attention") {
      return await runAttentionCommand(treeConfigCommandContext);
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
  assertAllowedOptions(context.parsedCommandArguments, [
    "--config",
    "--force",
    "--global",
  ]);
  assertNoCommandArguments(context.parsedCommandArguments, 1, "init");

  if (
    (await getFileExists(context.treeConfigFilePath)) &&
    !hasFlag(context.parsedCommandArguments, "--force")
  ) {
    throw new Error(
      `Configuration already exists at ${context.treeConfigFilePath}. Use --force to replace it.`,
    );
  }

  await writeTreeConfig(context.treeConfigFilePath, createEmptyTreeConfig());
  context.runCliOptions.output.writeOutput(
    `Initialized ${context.treeConfigFilePath}`,
  );

  return 0;
}

async function runListCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, [
    "--config",
    "--global",
    "--json",
  ]);
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
  assertAllowedOptions(context.parsedCommandArguments, [
    "--config",
    "--cwd",
    "--env",
    "--global",
    "--id",
    "--parent",
    "--project-dir",
    "--restart-policy",
    "--shell",
    "--shell-arg",
    "--unset-env",
    "--metadata",
  ]);

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

  await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) => {
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

  context.runCliOptions.output.writeOutput(
    `Added ${treeNodeKind} "${treeNodeName}" (${addedTreeNodeId}) to ${context.treeConfigFilePath}`,
  );

  return 0;
}

async function runRenameCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, [
    "--config",
    "--global",
    "--node",
  ]);

  const renameArguments = context.parsedCommandArguments.commandArguments.slice(1);
  const explicitNodeId =
    renameArguments.length === 2 ? renameArguments[0] : undefined;
  const treeNodeName = renameArguments.at(-1);

  if (!treeNodeName || renameArguments.length > 2) {
    throw new Error("Usage: treety rename [node-id] <name> [--node <node-id>]");
  }

  const nodeId = getTargetNodeId(context, explicitNodeId);

  await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) =>
    renameTreeNode(treeConfig, nodeId, treeNodeName),
  );
  context.runCliOptions.output.writeOutput(
    `Renamed ${nodeId} to "${treeNodeName}" in ${context.treeConfigFilePath}`,
  );

  return 0;
}

async function runShowCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, [
    "--config",
    "--global",
    "--node",
  ]);

  const explicitNodeId = context.parsedCommandArguments.commandArguments[1];

  assertNoCommandArguments(context.parsedCommandArguments, explicitNodeId ? 2 : 1, "show");

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
  assertAllowedOptions(context.parsedCommandArguments, [
    "--clear-cwd",
    "--clear-command",
    "--clear-metadata",
    "--clear-project-dir",
    "--clear-restart-policy",
    "--clear-shell",
    "--config",
    "--cwd",
    "--delete-env",
    "--env",
    "--global",
    "--metadata",
    "--node",
    "--project-dir",
    "--restart-policy",
    "--shell",
    "--shell-arg",
    "--unset-env",
  ]);

  const explicitNodeId = context.parsedCommandArguments.commandArguments[1];

  assertNoCommandArguments(
    context.parsedCommandArguments,
    explicitNodeId ? 2 : 1,
    "configure",
  );

  const nodeId = getTargetNodeId(context, explicitNodeId);
  const updateTreeNodeOptions = {
    nodeId,
    ...getTreeNodeUpdate(context.parsedCommandArguments),
  };

  await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) =>
    updateTreeNode(treeConfig, updateTreeNodeOptions),
  );
  context.runCliOptions.output.writeOutput(
    `Configured ${nodeId} in ${context.treeConfigFilePath}`,
  );

  return 0;
}

async function runMetadataCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, [
    "--config",
    "--global",
    "--node",
  ]);

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
    await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) =>
      updateTreeNode(treeConfig, {
        nodeId,
        metadata: parseMetadataContent(metadataContent),
        metadataAction: "replace",
      }),
    );
    context.runCliOptions.output.writeOutput(
      `Set metadata for ${nodeId} in ${context.treeConfigFilePath}`,
    );

    return 0;
  }

  if (metadataCommandName === "clear") {
    const explicitNodeId = metadataCommandArguments[0];

    if (metadataCommandArguments.length > 1) {
      throw new Error("Usage: treety metadata clear [node-id]");
    }

    const nodeId = getTargetNodeId(context, explicitNodeId);
    await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) =>
      updateTreeNode(treeConfig, {
        nodeId,
        metadataAction: "remove",
      }),
    );
    context.runCliOptions.output.writeOutput(
      `Cleared metadata for ${nodeId} in ${context.treeConfigFilePath}`,
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

    await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) =>
      setTreeNodeMetadataPath(
        treeConfig,
        nodeId,
        metadataPath,
        parseMetadataContent(metadataContent),
      ),
    );
    context.runCliOptions.output.writeOutput(
      `Set metadata path ${metadataPath} for ${nodeId} in ${context.treeConfigFilePath}`,
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

    await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) =>
      clearTreeNodeMetadataPath(treeConfig, nodeId, metadataPath),
    );
    context.runCliOptions.output.writeOutput(
      `Cleared metadata path ${metadataPath} for ${nodeId} in ${context.treeConfigFilePath}`,
    );

    return 0;
  }

  throw new Error(
    "Usage: treety metadata <get|set|clear|set-path|clear-path> [node-id] [path] [json]",
  );
}

async function runAttentionCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, [
    "--config",
    "--global",
    "--node",
  ]);

  const attentionCommandName =
    context.parsedCommandArguments.commandArguments[1];
  const explicitNodeId = context.parsedCommandArguments.commandArguments[2];

  if (attentionCommandName !== "set" && attentionCommandName !== "clear") {
    throw new Error("Usage: treety attention <set|clear> [node-id]");
  }

  assertNoCommandArguments(
    context.parsedCommandArguments,
    explicitNodeId ? 3 : 2,
    `attention ${attentionCommandName}`,
  );

  const nodeId = getTargetNodeId(context, explicitNodeId);

  await setTreeNodeAttention(
    context.treeConfigFilePath,
    nodeId,
    attentionCommandName === "set",
  );
  context.runCliOptions.output.writeOutput(
    `${attentionCommandName === "set" ? "Set" : "Cleared"} attention for ${nodeId} in ${context.treeConfigFilePath}`,
  );

  return 0;
}

async function runCurrentCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, [
    "--config",
    "--global",
  ]);
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
  assertAllowedOptions(context.parsedCommandArguments, [
    "--after",
    "--before",
    "--config",
    "--global",
    "--node",
    "--parent",
    "--root",
  ]);

  const explicitNodeId = context.parsedCommandArguments.commandArguments[1];

  assertNoCommandArguments(
    context.parsedCommandArguments,
    explicitNodeId ? 2 : 1,
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

  await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) =>
    moveTreeNode(treeConfig, { nodeId, parentId, beforeId, afterId }),
  );
  context.runCliOptions.output.writeOutput(
    `Moved ${nodeId} in ${context.treeConfigFilePath}`,
  );

  return 0;
}

async function runRemoveCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, [
    "--config",
    "--global",
    "--node",
    "--yes",
  ]);

  const explicitNodeId = context.parsedCommandArguments.commandArguments[1];

  assertNoCommandArguments(
    context.parsedCommandArguments,
    explicitNodeId ? 2 : 1,
    "remove",
  );

  const nodeId = getTargetNodeId(context, explicitNodeId);

  if (!hasFlag(context.parsedCommandArguments, "--yes")) {
    throw new Error(
      `Removing "${nodeId}" also removes its descendants. Re-run with --yes to confirm.`,
    );
  }

  await mutateTreeConfigFile(context.treeConfigFilePath, (treeConfig) =>
    removeTreeNode(treeConfig, nodeId),
  );
  context.runCliOptions.output.writeOutput(
    `Removed ${nodeId} from ${context.treeConfigFilePath}`,
  );

  return 0;
}

async function runConfigCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, [
    "--config",
    "--global",
  ]);

  const configCommandName = context.parsedCommandArguments.commandArguments[1];

  if (configCommandName !== "path") {
    throw new Error("Usage: treety config path [--global|--config <path>]");
  }

  assertNoCommandArguments(context.parsedCommandArguments, 2, "config path");
  context.runCliOptions.output.writeOutput(context.treeConfigFilePath);

  return 0;
}

function parseCommandArguments(cliArguments: string[]): ParsedCommandArguments {
  const commandSeparatorIndex = cliArguments.indexOf("--");
  const treeCommandArguments =
    commandSeparatorIndex === -1
      ? cliArguments
      : cliArguments.slice(0, commandSeparatorIndex);
  const terminalCommandArguments =
    commandSeparatorIndex === -1
      ? []
      : cliArguments.slice(commandSeparatorIndex + 1);
  const parsedCommandArguments: ParsedCommandArguments = {
    commandArguments: [],
    flagNames: new Set<string>(),
    optionValuesByName: new Map<string, string[]>(),
    terminalCommandArguments,
  };

  for (
    let commandArgumentIndex = 0;
    commandArgumentIndex < treeCommandArguments.length;
    commandArgumentIndex += 1
  ) {
    const commandArgument = treeCommandArguments[commandArgumentIndex];

    if (!commandArgument) continue;

    const optionName = optionNameByAlias.get(commandArgument) ?? commandArgument;

    if (!optionName.startsWith("-")) {
      parsedCommandArguments.commandArguments.push(commandArgument);

      continue;
    }

    if (!optionNamesWithValues.has(optionName)) {
      parsedCommandArguments.flagNames.add(optionName);

      continue;
    }

    const optionValue = treeCommandArguments[commandArgumentIndex + 1];

    if (!optionValue) {
      throw new Error(`Option ${optionName} requires a value.`);
    }

    const optionValues = parsedCommandArguments.optionValuesByName.get(optionName) ?? [];

    optionValues.push(optionValue);
    parsedCommandArguments.optionValuesByName.set(optionName, optionValues);
    commandArgumentIndex += 1;
  }

  return parsedCommandArguments;
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
  const nodeId =
    explicitNodeId ??
    getOptionValue(context.parsedCommandArguments, "--node") ??
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

function getHelpContent(): string {
  return `TreeTY ${cliVersion}

Manage hierarchical terminal workspaces.

Usage:
  treety init [--global] [--force]
  treety list [--json]
  treety add group <name> [options]
  treety add terminal <name> [options] [-- <command> [args...]]
  treety show [node-id]
  treety configure [node-id] [options]
  treety rename [node-id] <name>
  treety move [node-id] (--parent <group-id> | --root | --before <sibling-id> | --after <sibling-id>)
  treety remove [node-id] --yes
  treety metadata get [node-id]
  treety metadata set [node-id] <json>
  treety metadata clear [node-id]
  treety metadata set-path [node-id] <json-pointer> <json>
  treety metadata clear-path [node-id] <json-pointer>
  treety attention set [node-id]
  treety attention clear [node-id]
  treety current
  treety config path

Node options:
  --id <id>                    Set an explicit stable node ID
  --parent <group-id>          Add the node beneath a group
  --cwd <path>                 Set the node's inherited working directory
  --project-dir <path>         Set the inherited project directory
  --env <NAME=value>           Add an environment value (repeatable)
  --unset-env <NAME>           Remove an inherited value (repeatable)
  --metadata <json>            Set freeform JSON metadata
  --shell <path>               Set a shell executable
  --shell-arg <value>          Add a shell argument (repeatable)
  --restart-policy <policy>    Use manual or onOpen

Configure-only options:
  --clear-cwd                  Restore the inherited working directory
  --clear-project-dir          Restore the inherited project directory
  --delete-env <NAME>          Delete a node environment override
  --clear-shell                Restore the inherited shell
  --clear-restart-policy       Restore the inherited restart policy
  --clear-metadata             Remove node metadata
  --clear-command              Remove a terminal startup command
  -- <command> [args...]       Set a terminal startup command

Target selection:
  --node <node-id>             Target a node explicitly
  TreeTY terminals infer the node and configuration from their environment.

Config options:
  -g, --global                 Use the global TreeTY configuration
  -c, --config <path>          Use a specific configuration file

Global configuration:
  $XDG_CONFIG_HOME/treety/tree.json, or ~/.config/treety/tree.json`;
}

if (require.main === module) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
