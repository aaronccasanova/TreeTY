#!/usr/bin/env node

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const scriptFilePath = url.fileURLToPath(import.meta.url);
const projectRootDirPath = path.resolve(path.dirname(scriptFilePath), "..");
const extensionDirPath = path.join(projectRootDirPath, "packages", "vscode");
const artifactDirPath = path.join(projectRootDirPath, "artifacts");

function main() {
  const extensionPackageFilePath = path.join(extensionDirPath, "package.json");
  const extensionPackageFileContent = fs.readFileSync(
    extensionPackageFilePath,
    "utf8",
  );
  const extensionPackageConfig = JSON.parse(extensionPackageFileContent);
  const shouldCreateSnapshot = process.argv.includes("--snapshot");
  const shouldInstallExtension = process.argv.includes("--install");
  const artifactFileName = buildArtifactFileName(
    extensionPackageConfig.version,
    shouldCreateSnapshot,
  );
  const artifactFilePath = path.join(artifactDirPath, artifactFileName);

  fs.mkdirSync(artifactDirPath, { recursive: true });

  runCommand("pnpm", ["run", "build"], extensionDirPath);
  runCommand(
    "pnpm",
    [
      "exec",
      "vsce",
      "package",
      "--no-dependencies",
      "--allow-missing-repository",
      "--out",
      artifactFilePath,
    ],
    extensionDirPath,
  );

  console.log(`Created ${artifactFilePath}`);

  if (!shouldInstallExtension) {
    console.log(
      `Install with:\ncode --install-extension ${JSON.stringify(artifactFilePath)} --force`,
    );

    return;
  }

  runCommand(
    "code",
    ["--install-extension", artifactFilePath, "--force"],
    projectRootDirPath,
  );
}

function buildArtifactFileName(extensionVersion, shouldCreateSnapshot) {
  if (!shouldCreateSnapshot) {
    return `treety-vscode-${extensionVersion}.vsix`;
  }

  const snapshotTimestamp = formatSnapshotTimestamp(new Date());

  return `treety-vscode-${extensionVersion}-snapshot.${snapshotTimestamp}.vsix`;
}

function formatSnapshotTimestamp(snapshotDate) {
  return snapshotDate
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".", "");
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
