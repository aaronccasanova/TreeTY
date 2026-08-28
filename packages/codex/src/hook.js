import * as childProcess from "node:child_process";
import * as url from "node:url";

const treeTYConfigFileEnvironmentName = "TREETY_CONFIG_FILE";
const treeTYNodeIdEnvironmentName = "TREETY_NODE_ID";
const treeTYSetupSkillPrompt = "$treety-setup";
const treeTYSetupSlashPrompt = "/treety-setup";

/**
 * @typedef {{ code: number, stderr: string, stdout: string }} CommandResult
 */

/**
 * @typedef {{
 *   cwd: string,
 *   hook_event_name: string,
 *   prompt?: string,
 *   session_id: string,
 * }} CodexHookInput
 */

/**
 * @typedef {{
 *   environment?: NodeJS.ProcessEnv,
 *   runCommand?: (commandName: string, commandArguments: string[]) => CommandResult,
 * }} RunCodexHookOptions
 */

/**
 * @param {CodexHookInput} codexHookInput
 * @param {RunCodexHookOptions} [options]
 * @returns {Record<string, unknown> | undefined}
 */
export function runCodexHook(codexHookInput, options = {}) {
  const environment = options.environment ?? process.env;
  const runCommand = options.runCommand ?? runCommandSynchronously;

  if (codexHookInput.hook_event_name === "UserPromptSubmit") {
    if (getPromptIsTreeTYSetup(codexHookInput.prompt)) {
      return runTreeTYSetup(codexHookInput, environment, runCommand);
    }

    if (!getEnvironmentIsTreeTY(environment)) return undefined;
    if (!getSessionIsLinked(codexHookInput.session_id, runCommand)) {
      return undefined;
    }

    runTreeTYCommand(runCommand, ["attention", "clear"]);

    return undefined;
  }

  if (
    codexHookInput.hook_event_name !== "Stop" &&
    codexHookInput.hook_event_name !== "PostCompact"
  ) {
    return undefined;
  }

  if (
    getEnvironmentIsTreeTY(environment) &&
    getSessionIsLinked(codexHookInput.session_id, runCommand)
  ) {
    runTreeTYCommand(runCommand, ["attention", "set"]);
  }

  if (codexHookInput.hook_event_name === "Stop") return {};

  return undefined;
}

/** @param {string | undefined} prompt */
function getPromptIsTreeTYSetup(prompt) {
  return (
    prompt === treeTYSetupSkillPrompt || prompt === treeTYSetupSlashPrompt
  );
}

/**
 * @param {string} codexSessionId
 * @param {(commandName: string, commandArguments: string[]) => CommandResult} runCommand
 */
export function getSessionIsLinked(codexSessionId, runCommand) {
  const treeTYCommandResult = runTreeTYCommand(runCommand, [
    "metadata",
    "get",
  ]);

  try {
    const treeTYNodeMetadata = JSON.parse(treeTYCommandResult.stdout);

    if (!getValueIsRecord(treeTYNodeMetadata)) return false;

    const integrations = treeTYNodeMetadata["integrations"];

    if (!getValueIsRecord(integrations)) return false;

    const codexIntegration = integrations["codex"];

    if (!getValueIsRecord(codexIntegration)) return false;

    return codexIntegration["sessionId"] === codexSessionId;
  } catch {
    return false;
  }
}

/**
 * @param {CodexHookInput} codexHookInput
 * @param {NodeJS.ProcessEnv} environment
 * @param {(commandName: string, commandArguments: string[]) => CommandResult} runCommand
 * @returns {Record<string, unknown>}
 */
function runTreeTYSetup(codexHookInput, environment, runCommand) {
  if (!getEnvironmentIsTreeTY(environment)) {
    return {
      decision: "block",
      reason: "$treety-setup must run inside a TreeTY terminal.",
    };
  }

  try {
    runTreeTYCommand(runCommand, [
      "configure",
      "--cwd",
      codexHookInput.cwd,
      "--",
      "codex",
      "resume",
      codexHookInput.session_id,
    ]);
    runTreeTYCommand(runCommand, [
      "metadata",
      "set-path",
      "/integrations/codex/sessionId",
      JSON.stringify(codexHookInput.session_id),
    ]);
    runTreeTYCommand(runCommand, ["attention", "clear"]);
  } catch (error) {
    return {
      decision: "block",
      reason: getErrorMessage(error),
    };
  }

  return {
    decision: "block",
    reason:
      "TreeTY will resume this Codex session and signal when it needs attention.",
  };
}

/** @param {NodeJS.ProcessEnv} environment */
function getEnvironmentIsTreeTY(environment) {
  return Boolean(
    environment[treeTYConfigFileEnvironmentName] &&
      environment[treeTYNodeIdEnvironmentName],
  );
}

/**
 * @param {(commandName: string, commandArguments: string[]) => CommandResult} runCommand
 * @param {string[]} treeTYArguments
 */
function runTreeTYCommand(runCommand, treeTYArguments) {
  const treeTYCommandResult = runCommand("treety", treeTYArguments);

  if (treeTYCommandResult.code === 0) return treeTYCommandResult;

  const errorMessage =
    treeTYCommandResult.stderr.trim() ||
    treeTYCommandResult.stdout.trim() ||
    `treety exited with status ${treeTYCommandResult.code}`;

  throw new Error(errorMessage);
}

/**
 * @param {string} commandName
 * @param {string[]} commandArguments
 * @returns {CommandResult}
 */
function runCommandSynchronously(commandName, commandArguments) {
  const commandResult = childProcess.spawnSync(commandName, commandArguments, {
    encoding: "utf8",
  });

  if (commandResult.error) throw commandResult.error;

  return {
    code: commandResult.status ?? 1,
    stderr: commandResult.stderr ?? "",
    stdout: commandResult.stdout ?? "",
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function getValueIsRecord(value) {
  return typeof value === "object" && value !== null;
}

/** @param {unknown} error */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  let codexHookInputContent = "";

  process.stdin.setEncoding("utf8");

  for await (const codexHookInputChunk of process.stdin) {
    codexHookInputContent += codexHookInputChunk;
  }

  const codexHookInput = JSON.parse(codexHookInputContent);

  if (!getValueIsRecord(codexHookInput)) {
    throw new Error("Codex hook input must be a JSON object.");
  }

  const hookOutput = runCodexHook(/** @type {CodexHookInput} */ (codexHookInput));

  if (hookOutput === undefined) return;

  process.stdout.write(`${JSON.stringify(hookOutput)}\n`);
}

const entryPointFilePath = process.argv[1];

if (entryPointFilePath && import.meta.url === url.pathToFileURL(entryPointFilePath).href) {
  await main();
}
