#!/usr/bin/env node

import * as os from "node:os";

import {
  addTreeGroup,
  addTreeTerminal,
  createEmptyTreeConfig,
  moveTreeNode,
  removeTreeNode,
  renameTreeNode,
  RestartPolicy,
  TerminalEnvironment,
  TreeConfig,
  TreeNodeConfig,
  TreeNodeDefaults,
} from "@treety/core";

import {
  getFileExists,
  loadTreeConfig,
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

const cliVersion = "0.0.0";

const optionNameByAlias = new Map([
  ["-c", "--config"],
  ["-g", "--global"],
  ["-h", "--help"],
  ["-v", "--version"],
  ["-y", "--yes"],
]);

const optionNamesWithValues = new Set([
  "--config",
  "--cwd",
  "--env",
  "--id",
  "--parent",
  "--restart-policy",
  "--shell",
  "--shell-arg",
  "--unset-env",
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
    "--restart-policy",
    "--shell",
    "--shell-arg",
    "--unset-env",
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

  const treeConfig = await loadTreeConfig(context.treeConfigFilePath);
  const treeNodeDefaults = getTreeNodeDefaults(
    context.parsedCommandArguments,
  );
  const treeNodeOptions = {
    ...treeNodeDefaults,
    id: getOptionValue(context.parsedCommandArguments, "--id"),
    name: treeNodeName,
    parentId: getOptionValue(context.parsedCommandArguments, "--parent"),
  };
  const updatedTreeConfig =
    treeNodeKind === "group"
      ? addTreeGroup(treeConfig, treeNodeOptions)
      : addTreeTerminal(treeConfig, {
          ...treeNodeOptions,
          command: getTerminalCommand(context.parsedCommandArguments),
        });

  await writeTreeConfig(context.treeConfigFilePath, updatedTreeConfig);

  const addedTreeNodeId = getAddedTreeNodeId(treeConfig, updatedTreeConfig);

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
  ]);

  const nodeId = context.parsedCommandArguments.commandArguments[1];
  const treeNodeName = context.parsedCommandArguments.commandArguments[2];

  if (!nodeId || !treeNodeName) {
    throw new Error("Usage: treety rename <node-id> <name>");
  }

  assertNoCommandArguments(context.parsedCommandArguments, 3, "rename");

  const treeConfig = await loadTreeConfig(context.treeConfigFilePath);
  const updatedTreeConfig = renameTreeNode(treeConfig, nodeId, treeNodeName);

  await writeTreeConfig(context.treeConfigFilePath, updatedTreeConfig);
  context.runCliOptions.output.writeOutput(
    `Renamed ${nodeId} to "${treeNodeName}" in ${context.treeConfigFilePath}`,
  );

  return 0;
}

async function runMoveCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, [
    "--config",
    "--global",
    "--parent",
    "--root",
  ]);

  const nodeId = context.parsedCommandArguments.commandArguments[1];

  if (!nodeId) throw new Error("Usage: treety move <node-id> [--parent <group-id>|--root]");

  assertNoCommandArguments(context.parsedCommandArguments, 2, "move");

  const parentId = getOptionValue(context.parsedCommandArguments, "--parent");
  const moveToRoot = hasFlag(context.parsedCommandArguments, "--root");

  if (parentId && moveToRoot) {
    throw new Error("Use either --parent or --root, not both.");
  }

  if (!parentId && !moveToRoot) {
    throw new Error("Move requires --parent <group-id> or --root.");
  }

  const treeConfig = await loadTreeConfig(context.treeConfigFilePath);
  const updatedTreeConfig = moveTreeNode(treeConfig, { nodeId, parentId });

  await writeTreeConfig(context.treeConfigFilePath, updatedTreeConfig);
  context.runCliOptions.output.writeOutput(
    `Moved ${nodeId} ${parentId ? `under ${parentId}` : "to the root"} in ${context.treeConfigFilePath}`,
  );

  return 0;
}

async function runRemoveCommand(
  context: TreeConfigCommandContext,
): Promise<number> {
  assertAllowedOptions(context.parsedCommandArguments, [
    "--config",
    "--global",
    "--yes",
  ]);

  const nodeId = context.parsedCommandArguments.commandArguments[1];

  if (!nodeId) throw new Error("Usage: treety remove <node-id> --yes");

  assertNoCommandArguments(context.parsedCommandArguments, 2, "remove");

  if (!hasFlag(context.parsedCommandArguments, "--yes")) {
    throw new Error(
      `Removing "${nodeId}" also removes its descendants. Re-run with --yes to confirm.`,
    );
  }

  const treeConfig = await loadTreeConfig(context.treeConfigFilePath);
  const updatedTreeConfig = removeTreeNode(treeConfig, nodeId);

  await writeTreeConfig(context.treeConfigFilePath, updatedTreeConfig);
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
  const restartPolicy = getRestartPolicy(parsedCommandArguments);
  const terminalEnvironment = getTerminalEnvironment(parsedCommandArguments);
  const terminalShellPath = getOptionValue(parsedCommandArguments, "--shell");

  if (cwd) treeNodeDefaults.cwd = cwd;
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
  treety rename <node-id> <name>
  treety move <node-id> (--parent <group-id> | --root)
  treety remove <node-id> --yes
  treety config path

Node options:
  --id <id>                    Set an explicit stable node ID
  --parent <group-id>          Add the node beneath a group
  --cwd <path>                 Set the node's inherited working directory
  --env <NAME=value>           Add an environment value (repeatable)
  --unset-env <NAME>           Remove an inherited value (repeatable)
  --shell <path>               Set a shell executable
  --shell-arg <value>          Add a shell argument (repeatable)
  --restart-policy <policy>    Use manual or onOpen

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
