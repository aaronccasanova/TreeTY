import * as vscode from "vscode";

import { showCommandError, TreeTYController } from "./controller";
import { resolveNodeSearchEntry } from "./node-search";
import { NodeSearchPicker } from "./node-search-picker";
import type { NodeSearchQuickPickItem } from "./node-search-picker";
import { configureTerminalEnvironment } from "./terminal-environment";
import { handleTerminalLink, TerminalLinkManager } from "./terminal-links";
import { TreeTYTreeProvider } from "./tree-provider";
import type { NodeTreeEntry, TreeEntry } from "./tree-provider";

export async function activate(
  extensionContext: vscode.ExtensionContext,
): Promise<void> {
  configureTerminalEnvironment(extensionContext);

  const terminalLinks = new TerminalLinkManager({
    extensionId: extensionContext.extension.id,
    uriScheme: vscode.env.uriScheme,
    remoteName: vscode.env.remoteName,
    resolveExternalUri: async (uri) =>
      (await vscode.env.asExternalUri(vscode.Uri.from(uri))).toString(),
  });
  const treeTYController = new TreeTYController(terminalLinks);
  const treeTYTreeProvider = new TreeTYTreeProvider(treeTYController);
  const treeTYTreeView = vscode.window.createTreeView("treety.terminals", {
    treeDataProvider: treeTYTreeProvider,
  });

  const nodeSearchPicker = new NodeSearchPicker({
    workspaceModelSource: treeTYController,
    createQuickPick: () => vscode.window.createQuickPick<NodeSearchQuickPickItem>(),
    openNode: async (nodeTreeEntry) => {
      await treeTYTreeView.reveal(nodeTreeEntry, {
        select: true,
        focus: nodeTreeEntry.treeNode.kind === "group",
        expand: nodeTreeEntry.treeNode.kind === "group",
      });

      if (nodeTreeEntry.treeNode.kind !== "terminal") return;

      const currentNodeTreeEntry = resolveNodeSearchEntry(
        treeTYController.getWorkspaceModels(),
        { workspaceId: nodeTreeEntry.workspaceModel.id, nodeId: nodeTreeEntry.treeNode.id },
      );

      if (!currentNodeTreeEntry) {
        throw new Error("The selected terminal is no longer available.");
      }

      await treeTYController.openTerminal(currentNodeTreeEntry);
    },
    showError: showCommandError,
  });

  extensionContext.subscriptions.push(
    treeTYController,
    treeTYTreeProvider,
    treeTYTreeView,
    nodeSearchPicker,
    vscode.commands.registerCommand("treety.searchNodes", () => nodeSearchPicker.show()),
    vscode.window.registerFileDecorationProvider(treeTYTreeProvider),
    registerAsyncCommand("treety.refresh", () => treeTYController.refresh()),
    registerAsyncCommand("treety.collapseAll", async () => {
      await vscode.commands.executeCommand(
        "workbench.actions.treeView.treety.terminals.collapseAll",
      );
    }),
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
      "treety.showNodeActions",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.showNodeActions(nodeTreeEntry),
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
      "treety.copyTerminalLink",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.copyTerminalLink(nodeTreeEntry),
    ),
    registerAsyncCommand(
      "treety.restartTerminal",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.restartTerminal(nodeTreeEntry),
    ),
    registerAsyncCommand(
      "treety.restartGroupTerminals",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.restartGroupTerminals(nodeTreeEntry),
    ),
    registerAsyncCommand(
      "treety.stopTerminal",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.stopTerminal(nodeTreeEntry),
    ),
    registerAsyncCommand(
      "treety.markTerminalAttention",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.setTerminalAttention(nodeTreeEntry, true),
    ),
    registerAsyncCommand(
      "treety.clearTerminalAttention",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.setTerminalAttention(nodeTreeEntry, false),
    ),
    registerAsyncCommand(
      "treety.addDirectoryToWorkspace",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.addNodeDirectoryToWorkspace(nodeTreeEntry),
    ),
  );

  const startup = treeTYController.start();

  extensionContext.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        try {
          await handleTerminalLink({
            startup,
            terminalLinks,
            uri,
            revealTerminalLink: (target) =>
              treeTYController.revealTerminalLink(target),
          });
        } catch (error) {
          showCommandError(error);
        }
      },
    }),
  );

  await startup;
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
