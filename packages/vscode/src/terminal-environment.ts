import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type * as vscode from "vscode";

const cliAssets = [
  { fileName: "dist/cli.js", mode: 0o600 },
  { fileName: "bin/treety", mode: 0o700 },
  { fileName: "bin/treety.cmd", mode: 0o600 },
];

export async function configureTerminalEnvironment(
  extensionContext: vscode.ExtensionContext,
): Promise<void> {
  const cliBinDirPath = await installStoredCli(extensionContext);
  const environmentVariables = extensionContext.environmentVariableCollection;

  environmentVariables.clear();
  environmentVariables.persistent = true;
  environmentVariables.description =
    "TreeTY provides its bundled CLI in new and restored terminals. Recreate terminals opened before this persistent CLI was installed.";
  environmentVariables.prepend("PATH", `${cliBinDirPath}${path.delimiter}`);

  // VS Code caches persistent contributions for terminal revival before activation.
  // Clearing this collection on disposal would remove that cached environment.
}

async function installStoredCli(
  extensionContext: vscode.ExtensionContext,
): Promise<string> {
  // Desktop storage can use vscode-userdata: URIs. Use the host's filesystem path.
  if (!path.isAbsolute(extensionContext.globalStorageUri.fsPath)) {
    throw new Error("TreeTY's bundled CLI needs extension storage on the extension host filesystem.");
  }

  const cliDirPath = path.join(extensionContext.globalStorageUri.fsPath, "cli");
  const cliAssetContents = await Promise.all(cliAssets.map(async (cliAsset) => ({
    ...cliAsset,
    content: await fs.readFile(path.join(extensionContext.extensionPath, cliAsset.fileName)),
  })));

  await fs.mkdir(cliDirPath, { recursive: true, mode: 0o700 });

  // Publish the self-contained bundle first. Existing launchers keep working while
  // activation refreshes it, including when the previous extension was removed.
  for (const cliAsset of cliAssetContents) {
    const cliAssetFilePath = path.join(cliDirPath, cliAsset.fileName);
    const temporaryFilePath = `${cliAssetFilePath}.${crypto.randomUUID()}.tmp`;

    await fs.mkdir(path.dirname(cliAssetFilePath), { recursive: true, mode: 0o700 });

    try {
      await fs.writeFile(temporaryFilePath, cliAsset.content, {
        flag: "wx",
        mode: cliAsset.mode,
      });
      await fs.rename(temporaryFilePath, cliAssetFilePath);
    } finally {
      await fs.rm(temporaryFilePath, { force: true });
    }
  }

  return path.join(cliDirPath, "bin");
}
