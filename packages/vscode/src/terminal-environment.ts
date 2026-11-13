import * as path from "node:path";

import type * as vscode from "vscode";

export function configureTerminalEnvironment(
  extensionContext: vscode.ExtensionContext,
): void {
  const environmentVariables = extensionContext.environmentVariableCollection;
  const cliBinDirPath = path.join(extensionContext.extensionPath, "bin");

  environmentVariables.clear();
  environmentVariables.persistent = false;
  environmentVariables.description =
    "TreeTY adds its bundled CLI to new terminals. Recreate terminals opened before TreeTY activated or updated.";
  environmentVariables.prepend("PATH", `${cliBinDirPath}${path.delimiter}`);

  extensionContext.subscriptions.push({
    dispose: () => environmentVariables.clear(),
  });
}
