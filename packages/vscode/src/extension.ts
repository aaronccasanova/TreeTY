import * as vscode from "vscode";

import { showCommandError, TreeTYController } from "./controller";
import { NodeTreeEntry, TreeEntry, TreeTYTreeProvider } from "./tree-provider";

export async function activate(
  extensionContext: vscode.ExtensionContext,
): Promise<void> {
  const treeTYController = new TreeTYController();
  const treeTYTreeProvider = new TreeTYTreeProvider(treeTYController);

  extensionContext.subscriptions.push(
    treeTYController,
    treeTYTreeProvider,
    vscode.window.registerTreeDataProvider(
      "treety.terminals",
      treeTYTreeProvider,
    ),
    registerAsyncCommand("treety.refresh", () => treeTYController.refresh()),
    registerAsyncCommand(
      "treety.initializeWorkspace",
      (treeEntry?: TreeEntry) => treeTYController.initializeWorkspace(treeEntry),
    ),
    registerAsyncCommand("treety.openConfig", (treeEntry?: TreeEntry) =>
      treeTYController.openConfig(treeEntry),
    ),
    registerAsyncCommand(
      "treety.openTerminal",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.openTerminal(nodeTreeEntry),
    ),
    registerAsyncCommand(
      "treety.restartTerminal",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.restartTerminal(nodeTreeEntry),
    ),
    registerAsyncCommand(
      "treety.stopTerminal",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.stopTerminal(nodeTreeEntry),
    ),
  );

  await treeTYController.start();
}

export function deactivate(): void {}

function registerAsyncCommand<Arguments extends unknown[]>(
  commandName: string,
  commandHandler: (...commandArguments: Arguments) => Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    commandName,
    (...commandArguments: Arguments) => {
      void commandHandler(...commandArguments).catch((error: unknown) =>
        showCommandError(error),
      );
    },
  );
}
