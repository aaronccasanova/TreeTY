import * as path from "node:path";

import * as vscode from "vscode";

import { createAsyncCommandHandler } from "./async-command";
import { parseNodeCommandTarget } from "./node-command-target";
import type { TreeTYApi } from "./public-api";
import { showCommandError, TreeTYController } from "./controller";
import { resolveNodeSearchEntry } from "./node-search";
import { NodeSearchPicker } from "./node-search-picker";
import type { NodeSearchQuickPickItem } from "./node-search-picker";
import { configureTerminalEnvironment } from "./terminal-environment";
import { handleTerminalLink, TerminalLinkManager } from "./terminal-links";
import { TerminalRecoveryFileStorage, TerminalRecoveryRegistry } from "./terminal-recovery";
import { TreeCollapseController } from "./tree-collapse-controller";
import { TreeTYTreeProvider } from "./tree-provider";
import type { NodeTreeEntry, TreeEntry } from "./tree-provider";

let activeTreeTYController: TreeTYController | undefined;

export async function activate(
  extensionContext: vscode.ExtensionContext,
): Promise<TreeTYApi> {
  try {
    await configureTerminalEnvironment(extensionContext);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    void vscode.window.showWarningMessage(
      `TreeTY couldn't update its bundled terminal CLI. ${errorMessage}`,
    );
  }

  const terminalLinks = new TerminalLinkManager({
    extensionId: extensionContext.extension.id,
    uriScheme: vscode.env.uriScheme,
    remoteName: vscode.env.remoteName,
    resolveExternalUri: async (uri) =>
      (await vscode.env.asExternalUri(vscode.Uri.from(uri))).toString(),
  });
  const remoteAuthority = vscode.workspace.workspaceFile?.authority ||
    vscode.workspace.workspaceFolders?.find((folder) => folder.uri.authority)?.uri.authority || "";
  const terminalRecoveryHostId = JSON.stringify([
    vscode.env.machineId,
    vscode.env.remoteName ?? "local",
    remoteAuthority,
    extensionContext.globalStorageUri.toString(),
  ]);
  // The Node host's filesystem path also covers desktop vscode-userdata: storage URIs.
  const globalStorageDirPath = extensionContext.globalStoragePath;
  const terminalRecovery = path.isAbsolute(globalStorageDirPath)
    ? new TerminalRecoveryRegistry(
      new TerminalRecoveryFileStorage(path.join(globalStorageDirPath, "terminal-recovery-v1")),
      terminalRecoveryHostId,
    )
    : TerminalRecoveryRegistry.createUnavailable(
      terminalRecoveryHostId,
      "TreeTY needs extension storage on the extension host filesystem to coordinate terminal sessions across windows. The tree remains available, but new terminal launches are disabled.",
    );

  if (terminalRecovery.unavailableReason) {
    void vscode.window.showWarningMessage(terminalRecovery.unavailableReason);
  }

  const treeTYController = new TreeTYController(
    terminalLinks,
    (nodeTreeEntry) =>
      treeTYTreeView.reveal(nodeTreeEntry, { select: true, focus: false }),
    terminalRecovery,
  );
  activeTreeTYController = treeTYController;

  const treeTYTreeProvider = new TreeTYTreeProvider(treeTYController, extensionContext.workspaceState);
  const treeTYTreeView: vscode.TreeView<TreeEntry> = vscode.window.createTreeView(
    "treety.terminals",
    { treeDataProvider: treeTYTreeProvider },
  );

  const treeCollapseController = new TreeCollapseController({
    treeView: treeTYTreeView,
    onDidCollapseAll: () => treeTYTreeProvider.collapseAll(),
    collapseAll: () => vscode.commands.executeCommand(
      "workbench.actions.treeView.treety.terminals.collapseAll",
    ),
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

  function registerNodeCommand<Result>(
    commandName: string,
    commandHandler: (nodeTreeEntry: NodeTreeEntry, argument: unknown) => Promise<Result>,
  ): vscode.Disposable {
    return registerAsyncCommand(commandName, async (argument: unknown) => {
      const nodeTreeEntry = await treeTYController.resolveCommandNodeEntry(argument);

      return commandHandler(nodeTreeEntry, argument);
    });
  }

  extensionContext.subscriptions.push(
    treeTYController,
    treeTYTreeProvider,
    treeTYTreeView,
    treeTYTreeView.onDidExpandElement(({ element }) => {
      void treeTYTreeProvider.setExpanded(element, true).catch(showCommandError);
    }),
    treeTYTreeView.onDidCollapseElement(({ element }) => {
      void treeTYTreeProvider.setExpanded(element, false).catch(showCommandError);
    }),
    nodeSearchPicker,
    vscode.commands.registerCommand("treety.searchNodes", () => nodeSearchPicker.show()),
    vscode.window.registerFileDecorationProvider(treeTYTreeProvider),
    registerAsyncCommand("treety.refresh", () => treeTYController.refresh()),
    registerAsyncCommand("treety.collapseAll", () => treeCollapseController.collapseAll()),
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
    registerNodeCommand(
      "treety.renameNode",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.renameNode(nodeTreeEntry),
    ),
    registerNodeCommand(
      "treety.configureNode",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.configureNode(nodeTreeEntry),
    ),
    registerNodeCommand(
      "treety.moveNode",
      (nodeTreeEntry: NodeTreeEntry) => treeTYController.moveNode(nodeTreeEntry),
    ),
    registerNodeCommand(
      "treety.showNodeActions",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.showNodeActions(nodeTreeEntry),
    ),
    registerNodeCommand(
      "treety.deleteNode",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.deleteNode(nodeTreeEntry),
    ),
    registerNodeCommand(
      "treety.openTerminal",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.openTerminal(nodeTreeEntry),
    ),
    registerNodeCommand(
      "treety.copyTerminalLink",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.copyTerminalLink(nodeTreeEntry),
    ),
    registerNodeCommand(
      "treety.restartTerminal",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.restartTerminal(nodeTreeEntry),
    ),
    registerNodeCommand(
      "treety.restartGroupTerminals",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.restartGroupTerminals(nodeTreeEntry),
    ),
    registerNodeCommand(
      "treety.stopTerminal",
      (nodeTreeEntry: NodeTreeEntry, argument: unknown) =>
        treeTYController.stopTerminal(nodeTreeEntry,
          typeof argument === "object" && argument !== null && "nodeId" in argument
            ? parseNodeCommandTarget(argument).confirm
            : undefined),
    ),
    registerNodeCommand(
      "treety.markTerminalAttention",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.setTerminalAttention(nodeTreeEntry, true),
    ),
    registerNodeCommand(
      "treety.clearTerminalAttention",
      (nodeTreeEntry: NodeTreeEntry) =>
        treeTYController.setTerminalAttention(nodeTreeEntry, false),
    ),
    registerNodeCommand(
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
              treeTYController.revealTerminalLink(target, (nodeTreeEntry) =>
                treeTYTreeView.reveal(nodeTreeEntry, { select: true, focus: false }),
              ),
          });
        } catch (error) {
          showCommandError(error);
        }
      },
    }),
  );

  await startup;

  return {
    apiVersion: 1,
    getTerminalIdentity: (terminal) => treeTYController.getTerminalIdentity(terminal),
    getTerminal: (target) => treeTYController.getTerminal(target),
  };
}

export async function deactivate(): Promise<void> {
  const treeTYController = activeTreeTYController;

  try {
    await treeTYController?.deactivate();
  } finally {
    if (activeTreeTYController === treeTYController) activeTreeTYController = undefined;
  }
}

function getCommandTreeEntry(
  treeEntry: TreeEntry | undefined,
  treeTYTreeView: vscode.TreeView<TreeEntry>,
): TreeEntry | undefined {
  return treeEntry ?? treeTYTreeView.selection[0];
}

function registerAsyncCommand<Arguments extends unknown[], Result>(
  commandName: string,
  commandHandler: (...commandArguments: Arguments) => Promise<Result>,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    commandName,
    createAsyncCommandHandler(commandHandler, showCommandError),
  );
}
