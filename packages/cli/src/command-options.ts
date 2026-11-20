import * as util from "node:util";

export interface ParsedCommandArguments {
  commandArguments: string[];
  flagNames: Set<string>;
  optionValuesByName: Map<string, string[]>;
  terminalCommandArguments: string[];
}

interface CommandDefinition {
  usage: string[];
  optionNames: string[];
  notes?: string;
}

interface OptionDefinition {
  valueName?: string;
  description: string;
  short?: string;
}

const optionDefinitions: Record<string, OptionDefinition> = {
  config: { valueName: "path", description: "Use a specific configuration file", short: "c" },
  global: { description: "Use the global TreeTY configuration", short: "g" },
  help: { description: "Show help for this command", short: "h" },
  version: { description: "Print the CLI version", short: "v" },
  yes: { description: "Confirm removal of the node and all descendants", short: "y" },
  json: { description: "Print JSON output" },
  force: { description: "Replace an existing configuration" },
  root: { description: "Move the node to the root" },
  id: { valueName: "id", description: "Set an explicit stable node ID" },
  node: { valueName: "node-id", description: "Target a node explicitly" },
  parent: { valueName: "group-id", description: "Place the node beneath a group" },
  after: { valueName: "sibling-id", description: "Move after a sibling" },
  before: { valueName: "sibling-id", description: "Move before a sibling" },
  cwd: { valueName: "path", description: "Set the inherited working directory" },
  "project-dir": { valueName: "path", description: "Set the inherited project directory" },
  env: { valueName: "NAME=value", description: "Add an environment value (repeatable)" },
  "unset-env": { valueName: "NAME", description: "Remove an inherited environment value (repeatable)" },
  "delete-env": { valueName: "NAME", description: "Delete a node environment override (repeatable)" },
  metadata: { valueName: "json", description: "Set freeform JSON metadata" },
  shell: { valueName: "path", description: "Set a shell executable" },
  "shell-arg": { valueName: "value", description: "Add a shell argument (repeatable)" },
  "restart-policy": { valueName: "manual|onOpen", description: "Set the inherited restart policy" },
  "activity-animation": { valueName: "on|off", description: "Set activity animation for a terminal" },
  "if-node": { valueName: "json", description: "Configure only if the node matches this snapshot" },
  "clear-activity-animation": { description: "Restore the default activity animation" },
  "clear-cwd": { description: "Restore the inherited working directory" },
  "clear-project-dir": { description: "Restore the inherited project directory" },
  "clear-shell": { description: "Restore the inherited shell" },
  "clear-restart-policy": { description: "Restore the inherited restart policy" },
  "clear-metadata": { description: "Remove node metadata" },
  "clear-command": { description: "Remove a terminal startup command" },
  reporter: { valueName: "id", description: "Identify the reporting integration instance" },
  pid: { valueName: "process-id", description: "PID of the process reporting work" },
  session: { valueName: "host-session-id", description: "Target a runtime session (defaults to TREETY_SESSION_ID)" },
  "metadata-path": { valueName: "pointer", description: "Require metadata at this JSON Pointer to equal reporter ID" },
  attention: { valueName: "set|clear", description: "Change attention atomically with register or idle" },
};

const commandDefinitions: Record<string, CommandDefinition> = {
  init: {
    usage: ["init [--global|--config <path>] [--force] [--json]"],
    optionNames: ["--config", "--force", "--global", "--json"],
    notes: "Replaces an existing configuration only with --force.",
  },
  list: {
    usage: ["list [--json]"],
    optionNames: ["--config", "--global", "--json"],
    notes: "Alias: ls. JSON output contains the complete configuration.",
  },
  add: {
    usage: ["add group <name> [options]", "add terminal <name> [options] [-- <command> [args...]]"],
    optionNames: [
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
      "--json",
    ],
    notes: "Only terminals accept a startup command after --. These arguments pass through unchanged.",
  },
  rename: {
    usage: ["rename [node-id] <name> [--node <node-id>] [--json]"],
    optionNames: ["--config", "--global", "--node", "--json"],
  },
  show: {
    usage: ["show [node-id] [--node <node-id>]"],
    optionNames: ["--config", "--global", "--node"],
    notes: "Prints the stored node as JSON.",
  },
  configure: {
    usage: ["configure [node-id] [options] [-- <command> [args...]]"],
    optionNames: [
      "--activity-animation",
      "--clear-activity-animation",
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
      "--if-node",
      "--metadata",
      "--node",
      "--project-dir",
      "--restart-policy",
      "--shell",
      "--shell-arg",
      "--unset-env",
      "--json",
    ],
    notes: "A command after -- sets the terminal startup command. These arguments pass through unchanged.",
  },
  metadata: {
    usage: [
      "metadata get [node-id]",
      "metadata set [node-id] <json>",
      "metadata clear [node-id]",
      "metadata set-path [node-id] <json-pointer> <json>",
      "metadata clear-path [node-id] <json-pointer>",
    ],
    optionNames: ["--config", "--global", "--node", "--json"],
    notes: "get always prints JSON. Mutation commands accept --json for a receipt.",
  },
  activity: {
    usage: ["activity <register|busy|idle|unregister> --reporter <id> --pid <pid> [options]"],
    optionNames: [
      "--attention",
      "--config",
      "--global",
      "--metadata-path",
      "--node",
      "--reporter",
      "--pid",
      "--session",
      "--json",
    ],
    notes: "Register starts idle. Busy clears attention. Unregister preserves attention. Node and session default to terminal context.",
  },
  attention: {
    usage: ["attention <set|clear> [node-id] [--node <node-id>] [--json]"],
    optionNames: ["--config", "--global", "--node", "--json"],
  },
  uri: {
    usage: ["uri"],
    optionNames: [],
    notes: "Prints TREETY_SESSION_URI unchanged without opening it. Requires host context and accepts no target selectors.",
  },
  current: {
    usage: ["current"],
    optionNames: ["--config", "--global"],
    notes: "Prints the current terminal node and runtime context as JSON.",
  },
  move: {
    usage: [
      "move [node-id] (--parent <group-id> | --root | --before <sibling-id> | --after <sibling-id>) [--node <node-id>] [--json]",
    ],
    optionNames: ["--after", "--before", "--config", "--global", "--node", "--parent", "--root", "--json"],
  },
  remove: {
    usage: ["remove [node-id] --yes [--node <node-id>] [--json]"],
    optionNames: ["--config", "--global", "--node", "--yes", "--json"],
    notes: "Alias: rm. Requires --yes and removes descendants too.",
  },
  config: {
    usage: ["config path"],
    optionNames: ["--config", "--global"],
  },
  version: {
    usage: ["version"],
    optionNames: [],
  },
  help: {
    usage: ["help [command]"],
    optionNames: [],
  },
};

export function parseCommandArguments(cliArguments: string[]): ParsedCommandArguments {
  const commandSeparatorIndex = cliArguments.indexOf("--");
  const treeCommandArguments = commandSeparatorIndex === -1
    ? cliArguments
    : cliArguments.slice(0, commandSeparatorIndex);
  const terminalCommandArguments = commandSeparatorIndex === -1
    ? []
    : cliArguments.slice(commandSeparatorIndex + 1);
  const parsedArguments = util.parseArgs({
    args: treeCommandArguments,
    options: Object.fromEntries(Object.entries(optionDefinitions).map(([name, definition]) => [
      name,
      {
        type: definition.valueName ? "string" : "boolean",
        multiple: definition.valueName !== undefined,
        ...(definition.short ? { short: definition.short } : {}),
      },
    ])),
    strict: true,
    allowPositionals: true,
    tokens: true,
  });
  const parsedCommandArguments: ParsedCommandArguments = {
    commandArguments: parsedArguments.positionals,
    flagNames: new Set<string>(),
    optionValuesByName: new Map<string, string[]>(),
    terminalCommandArguments,
  };

  for (const token of parsedArguments.tokens) {
    if (token.kind !== "option") continue;

    const optionName = `--${token.name}`;

    if (token.value === undefined) {
      parsedCommandArguments.flagNames.add(optionName);

      continue;
    }

    if (token.value === "") {
      throw new Error(`Option ${optionName} requires a non-empty value.`);
    }

    const optionValues = parsedCommandArguments.optionValuesByName.get(optionName) ?? [];

    optionValues.push(token.value);
    parsedCommandArguments.optionValuesByName.set(optionName, optionValues);
  }

  return parsedCommandArguments;
}

export function getCommandDefinition(commandName: string): CommandDefinition {
  const canonicalCommandName = commandName === "ls" ? "list" : commandName === "rm" ? "remove" : commandName;
  const commandDefinition = Object.hasOwn(commandDefinitions, canonicalCommandName)
    ? commandDefinitions[canonicalCommandName]
    : undefined;

  if (commandDefinition) return commandDefinition;

  throw new Error(`Unknown command "${commandName}". Run "treety help" for usage.`);
}

export function getHelpContent(version: string, commandName?: string): string {
  if (commandName !== undefined) {
    const commandDefinition = getCommandDefinition(commandName);
    const optionHelpLines = [...commandDefinition.optionNames, "--help"].map((optionName) => {
      const optionDefinition = optionDefinitions[optionName.slice(2)]!;
      const optionUsage = [
        optionDefinition.short ? `-${optionDefinition.short}, ` : "",
        optionName,
        optionDefinition.valueName ? ` <${optionDefinition.valueName}>` : "",
      ].join("");

      return `  ${optionUsage.padEnd(34)} ${optionDefinition.description}`;
    });
    const notes = [commandDefinition.notes];

    if (commandDefinition.optionNames.includes("--node")) {
      notes.push("An omitted node ID defaults to TREETY_NODE_ID. An explicit empty ID is rejected.");
    }

    if (commandDefinition.optionNames.some((optionName) => optionDefinitions[optionName.slice(2)]?.valueName)) {
      notes.push("Use --option=value when a value starts with a dash.");
    }

    return [
      "Usage:",
      ...commandDefinition.usage.map((usage) => `  treety ${usage}`),
      "",
      "Options:",
      ...optionHelpLines,
      ...notes.filter(Boolean).flatMap((note) => ["", note]),
    ].join("\n");
  }

  return [
    `TreeTY ${version}`,
    "",
    "Manage hierarchical terminal workspaces.",
    "",
    "Usage:",
    ...Object.values(commandDefinitions).flatMap((definition) => definition.usage.map((usage) => `  treety ${usage}`)),
    "",
    "Run treety <command> --help or treety help <command> for command options.",
    "",
    "Configuration: --global selects $XDG_CONFIG_HOME/treety/tree.json or ~/.config/treety/tree.json.",
    "Use --config <path> for a specific file. TreeTY terminals infer configuration and node context.",
  ].join("\n");
}
