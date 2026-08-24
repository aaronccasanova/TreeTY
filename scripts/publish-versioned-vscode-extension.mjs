#!/usr/bin/env node

import * as childProcess from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";

const scriptFilePath = url.fileURLToPath(import.meta.url);
const projectRootDirPath = path.resolve(path.dirname(scriptFilePath), "..");

function main() {
  if (!hasVersionedVscodeExtension()) {
    console.log("Skipping VS Code Marketplace publish: extension version is unchanged.");

    return;
  }

  runCommand(
    "node",
    ["scripts/publish-vscode-extension.mjs", ...process.argv.slice(2)],
    projectRootDirPath,
  );
}

function hasVersionedVscodeExtension() {
  const gitDiffResult = childProcess.spawnSync(
    "git",
    ["diff", "--quiet", "HEAD^", "HEAD", "--", "packages/vscode/package.json"],
    {
      cwd: projectRootDirPath,
      stdio: "inherit",
    },
  );

  if (gitDiffResult.error) throw gitDiffResult.error;
  if (gitDiffResult.status === 0) return false;
  if (gitDiffResult.status === 1) return true;

  throw new Error(
    "Could not determine whether the VS Code extension version changed. The release checkout must include HEAD and HEAD^.",
  );
}

function runCommand(commandName, commandArguments, currentDirPath) {
  const executableFileName =
    process.platform === "win32" ? `${commandName}.cmd` : commandName;
  const commandResult = childProcess.spawnSync(
    executableFileName,
    commandArguments,
    {
      cwd: currentDirPath,
      stdio: "inherit",
    },
  );

  if (commandResult.error) throw commandResult.error;
  if (commandResult.status === 0) return;

  process.exit(commandResult.status ?? 1);
}

main();
