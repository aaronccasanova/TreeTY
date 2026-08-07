import * as vscode from "vscode";

import { showCommandError, TreeTYController } from "./controller";
import { NodeTreeEntry, TreeEntry, TreeTYTreeProvider } from "./tree-provider";

export async function activate(
  extensionContext: vscode.ExtensionContext,
): Promise<void> {
  const treeTYController = new TreeTYController();
  const treeTYTreeProvider = new TreeTYTreeProvider(treeTYController);
  const treeTYTreeView = vscode.window.createTreeView("treety.terminals", {
    treeDataProvider: treeTYTreeProvider,
  });

  extensionContext.subscriptions.push(
    treeTYController,
    treeTYTreeProvider,
    treeTYTreeView,
    vscode.window.registerFileDecorationProvider(treeTYTreeProvider),
    registerAsyncCommand("treety.refresh", () => treeTYController.refresh()),
    registerAsyncCommand(
      "treety.initializeWorkspace",
      (treeEntry?: TreeEntry) =>
        treeTYController.initializeWorkspace(
          getCommandTreeEntry(treeEntry, treeTYTreeView),
        ),
    ),
    registerAsyncCommand("treety.initializeGlobalTree", () =>
      treeTYController.initializeGlobalTree(),
    ),
    registerAsyncCommand("treety.openConfig", (treeEntry?: TreeEntry) =>
      treeTYController.openConfig(
        getCommandTreeEntry(treeEntry, treeTYTreeView),
      ),
    ),
    registerAsyncCommand("treety.createGroup", (treeEntry?: TreeEntry) =>
      treeTYController.createGroup(
        getCommandTreeEntry(treeEntry, treeTYTreeView),
      ),
    ),
    registerAsyncCommand("treety.createTerminal", (treeEntry?: TreeEntry) =>
      treeTYController.createTerminal(
        getCommandTreeEntry(treeEntry, treeTYTreeView),
      ),
    ),
    registerAsyncCommand(
      "treety.renameNode",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.renameNode(nodeTreeEntry),
    ),
    registerAsyncCommand(
      "treety.configureNode",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.configureNode(nodeTreeEntry),
    ),
    registerAsyncCommand(
      "treety.moveNode",
      (nodeTreeEntry: NodeTreeEntry) => treeTYController.moveNode(nodeTreeEntry),
    ),
    registerAsyncCommand(
      "treety.deleteNode",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.deleteNode(nodeTreeEntry),
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
    registerAsyncCommand(
      "treety.addTerminalDirectoryToWorkspace",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.addTerminalDirectoryToWorkspace(nodeTreeEntry),
    ),
  );

  await treeTYController.start();
}

export function deactivate(): void {}

function getCommandTreeEntry(
  treeEntry: TreeEntry | undefined,
  treeTYTreeView: vscode.TreeView<TreeEntry>,
): TreeEntry | undefined {
  return treeEntry ?? treeTYTreeView.selection[0];
}

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
