import * as os from "node:os";
import * as path from "node:path";

import {
  addTreeGroup,
  addTreeTerminal,
  createEmptyTreeConfig,
  formatTreeConfigContent,
  moveTreeNode,
  parseTreeConfigContent,
  removeTreeNode,
  renameTreeNode,
  resolveTreeConfig,
  ResolvedTreeNode,
  TerminalSessionState,
  TreeConfig,
  TreeTYEngine,
} from "@treety/core";
import * as vscode from "vscode";

import { NodeTreeEntry, TreeEntry } from "./tree-provider";
import { VscodeTerminalHost } from "./vscode-terminal-host";
import {
  ConfiguredWorkspaceModel,
  TreeConfigSource,
  WorkspaceModel,
  WorkspaceModelSource,
} from "./workspace-model";

interface WorkspaceModelLocation {
  id: string;
  name: string;
  workspaceDirUri: vscode.Uri;
  workspaceFolder?: vscode.WorkspaceFolder;
  configFileUri: vscode.Uri;
  configSource: TreeConfigSource;
}

interface MoveDestinationQuickPickItem extends vscode.QuickPickItem {
  parentId?: string;
}

type ExplorerDirectorySyncMode = "always" | "never" | "prompt";
type GlobalTreeVisibility = "always" | "fallback" | "never";

const configDirName = ".treety";
const configFileName = "tree.json";

export class TreeTYController implements WorkspaceModelSource, vscode.Disposable {
  private readonly workspaceModelChangeEmitter = new vscode.EventEmitter<void>();

  private readonly globalConfigFileUri = getGlobalConfigFileUri();

  private readonly vscodeDisposables: vscode.Disposable[];

  private workspaceModels: WorkspaceModel[] = [];

  private workspaceReloadPromise: Promise<void> = Promise.resolve();

  public readonly onDidChangeWorkspaceModels =
    this.workspaceModelChangeEmitter.event;

  public constructor() {
    const workspaceConfigFileWatcher = vscode.workspace.createFileSystemWatcher(
      `**/${configDirName}/${configFileName}`,
    );
    const globalConfigFileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        getParentUri(this.globalConfigFileUri),
        configFileName,
      ),
    );

    this.vscodeDisposables = [
      workspaceConfigFileWatcher,
      globalConfigFileWatcher,
      ...this.getConfigFileWatcherSubscriptions(workspaceConfigFileWatcher),
      ...this.getConfigFileWatcherSubscriptions(globalConfigFileWatcher),
      vscode.workspace.onDidChangeWorkspaceFolders(() =>
        this.scheduleWorkspaceReload(),
      ),
      vscode.workspace.onDidChangeConfiguration((configurationChangeEvent) => {
        if (
          configurationChangeEvent.affectsConfiguration(
            "treety.showStatusDescriptions",
          )
        ) {
          this.workspaceModelChangeEmitter.fire();
        }

        if (
          configurationChangeEvent.affectsConfiguration(
            "treety.globalTreeVisibility",
          )
        ) {
          this.scheduleWorkspaceReload();
        }
      }),
    ];
  }

  public async start(): Promise<void> {
    await this.queueWorkspaceReload();
  }

  public getWorkspaceModels(): readonly WorkspaceModel[] {
    return this.workspaceModels;
  }

  public getTerminalSessionState(
    workspaceModel: ConfiguredWorkspaceModel,
    nodeId: string,
  ): TerminalSessionState {
    return workspaceModel.treeTYEngine.getTerminalSessionState(nodeId);
  }

  public async refresh(): Promise<void> {
    await this.queueWorkspaceReload();
  }

  public async initializeWorkspace(treeEntry?: TreeEntry): Promise<void> {
    const workspaceModel = await this.getTargetWorkspaceModel(treeEntry);

    if (!workspaceModel) return;

    await this.initializeWorkspaceModel(workspaceModel);
  }

  public async initializeGlobalTree(): Promise<void> {
    const globalWorkspaceModelLocation = getGlobalWorkspaceModelLocation(
      this.globalConfigFileUri,
    );

    await this.initializeWorkspaceModel({
      kind: "unconfigured",
      ...globalWorkspaceModelLocation,
    });
  }

  public async openConfig(treeEntry?: TreeEntry): Promise<void> {
    const workspaceModel = await this.getTargetWorkspaceModel(treeEntry);

    if (!workspaceModel) return;

    if (!(await getFileExists(workspaceModel.configFileUri))) {
      await this.initializeWorkspaceModel(workspaceModel);

      return;
    }

    await this.showConfigFile(workspaceModel.configFileUri);
  }

  public async createGroup(treeEntry?: TreeEntry): Promise<void> {
    const workspaceModel = await this.getConfiguredWorkspaceModel(treeEntry);

    if (!workspaceModel) return;

    const groupName = await getTreeNodeName("Group name");

    if (!groupName) return;

    const parentId = getTargetParentId(treeEntry);
    const treeConfig = addTreeGroup(workspaceModel.treeConfig, {
      name: groupName,
      parentId,
    });

    await this.writeWorkspaceTreeConfig(workspaceModel, treeConfig);
  }

  public async createTerminal(treeEntry?: TreeEntry): Promise<void> {
    const workspaceModel = await this.getConfiguredWorkspaceModel(treeEntry);

    if (!workspaceModel) return;

    const terminalName = await getTreeNodeName("Terminal name");

    if (!terminalName) return;

    const parentId = getTargetParentId(treeEntry);
    const treeConfig = addTreeTerminal(workspaceModel.treeConfig, {
      name: terminalName,
      parentId,
    });

    await this.writeWorkspaceTreeConfig(workspaceModel, treeConfig);
  }

  public async renameNode(nodeTreeEntry: NodeTreeEntry): Promise<void> {
    const treeNodeName = await vscode.window.showInputBox({
      prompt: "Tree node name",
      value: nodeTreeEntry.treeNode.name,
      validateInput: validateTreeNodeName,
    });

    if (!treeNodeName) return;

    const treeConfig = renameTreeNode(
      nodeTreeEntry.workspaceModel.treeConfig,
      nodeTreeEntry.treeNode.id,
      treeNodeName.trim(),
    );

    await this.writeWorkspaceTreeConfig(
      nodeTreeEntry.workspaceModel,
      treeConfig,
    );
  }

  public async moveNode(nodeTreeEntry: NodeTreeEntry): Promise<void> {
    const moveDestinationQuickPickItems = getMoveDestinationQuickPickItems(
      nodeTreeEntry,
    );

    if (moveDestinationQuickPickItems.length === 0) {
      void vscode.window.showInformationMessage(
        `There is no valid destination for "${nodeTreeEntry.treeNode.name}".`,
      );

      return;
    }

    const moveDestinationQuickPickItem = await vscode.window.showQuickPick(
      moveDestinationQuickPickItems,
      {
        placeHolder: `Move "${nodeTreeEntry.treeNode.name}" to...`,
        matchOnDescription: true,
      },
    );

    if (!moveDestinationQuickPickItem) return;

    const treeConfig = moveTreeNode(nodeTreeEntry.workspaceModel.treeConfig, {
      nodeId: nodeTreeEntry.treeNode.id,
      parentId: moveDestinationQuickPickItem.parentId,
    });

    await this.writeWorkspaceTreeConfig(
      nodeTreeEntry.workspaceModel,
      treeConfig,
    );
  }

  public async deleteNode(nodeTreeEntry: NodeTreeEntry): Promise<void> {
    const terminalNodeIds = getTerminalNodeIds(nodeTreeEntry.treeNode);
    const descendantCount = getDescendantCount(nodeTreeEntry.treeNode);
    const confirmationMessage =
      nodeTreeEntry.treeNode.kind === "group"
        ? getGroupDeletionConfirmationMessage(
            nodeTreeEntry.treeNode.name,
            descendantCount,
          )
        : `Delete "${nodeTreeEntry.treeNode.name}"?`;
    const confirmation = await vscode.window.showWarningMessage(
      confirmationMessage,
      {
        modal: true,
        detail:
          terminalNodeIds.length > 0
            ? "Any running terminals in this selection will be closed. This cannot be undone."
            : "This cannot be undone.",
      },
      "Delete",
    );

    if (confirmation !== "Delete") return;

    for (const terminalNodeId of terminalNodeIds) {
      nodeTreeEntry.workspaceModel.treeTYEngine.stopTerminal(terminalNodeId);
    }

    const treeConfig = removeTreeNode(
      nodeTreeEntry.workspaceModel.treeConfig,
      nodeTreeEntry.treeNode.id,
    );

    await this.writeWorkspaceTreeConfig(
      nodeTreeEntry.workspaceModel,
      treeConfig,
    );
  }

  public async openTerminal(nodeTreeEntry: NodeTreeEntry): Promise<void> {
    if (nodeTreeEntry.treeNode.kind !== "terminal") return;

    await nodeTreeEntry.workspaceModel.treeTYEngine.openTerminal(
      nodeTreeEntry.treeNode.id,
    );
    await this.syncTerminalDirectory(nodeTreeEntry, false);
  }

  public async restartTerminal(nodeTreeEntry: NodeTreeEntry): Promise<void> {
    if (nodeTreeEntry.treeNode.kind !== "terminal") return;

    await nodeTreeEntry.workspaceModel.treeTYEngine.restartTerminal(
      nodeTreeEntry.treeNode.id,
    );
    await this.syncTerminalDirectory(nodeTreeEntry, false);
  }

  public async addTerminalDirectoryToWorkspace(
    nodeTreeEntry: NodeTreeEntry,
  ): Promise<void> {
    if (nodeTreeEntry.treeNode.kind !== "terminal") return;

    await this.syncTerminalDirectory(nodeTreeEntry, true);
  }

  public async stopTerminal(nodeTreeEntry: NodeTreeEntry): Promise<void> {
    if (nodeTreeEntry.treeNode.kind !== "terminal") return;

    const confirmBeforeStopping = vscode.workspace
      .getConfiguration("treety")
      .get<boolean>("confirmBeforeStopping", true);

    if (confirmBeforeStopping) {
      const confirmation = await vscode.window.showWarningMessage(
        `Stop "${nodeTreeEntry.treeNode.name}"?`,
        { modal: true },
        "Stop terminal",
      );

      if (confirmation !== "Stop terminal") return;
    }

    nodeTreeEntry.workspaceModel.treeTYEngine.stopTerminal(
      nodeTreeEntry.treeNode.id,
    );
  }

  public dispose(): void {
    for (const workspaceModel of this.workspaceModels) {
      if (workspaceModel.kind === "configured") {
        workspaceModel.treeTYEngine.dispose();
      }
    }

    for (const vscodeDisposable of this.vscodeDisposables) {
      vscodeDisposable.dispose();
    }

    this.workspaceModelChangeEmitter.dispose();
  }

  private getConfigFileWatcherSubscriptions(
    configFileWatcher: vscode.FileSystemWatcher,
  ): vscode.Disposable[] {
    return [
      configFileWatcher.onDidCreate(() => this.scheduleWorkspaceReload()),
      configFileWatcher.onDidChange(() => this.scheduleWorkspaceReload()),
      configFileWatcher.onDidDelete(() => this.scheduleWorkspaceReload()),
    ];
  }

  private scheduleWorkspaceReload(): void {
    void this.queueWorkspaceReload().catch((error: unknown) =>
      showCommandError(error),
    );
  }

  private queueWorkspaceReload(): Promise<void> {
    const workspaceReloadPromise = this.workspaceReloadPromise.then(() =>
      this.reloadWorkspaces(),
    );

    this.workspaceReloadPromise = workspaceReloadPromise.catch(() => undefined);

    return workspaceReloadPromise;
  }

  private async reloadWorkspaces(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const globalConfigExists = await getFileExists(this.globalConfigFileUri);
    const globalTreeVisibility = vscode.workspace
      .getConfiguration("treety")
      .get<GlobalTreeVisibility>("globalTreeVisibility", "fallback");
    const workspaceModelLocations = await getWorkspaceModelLocations(
      workspaceFolders,
      this.globalConfigFileUri,
      globalConfigExists,
      globalTreeVisibility,
    );
    const nextWorkspaceModels = await Promise.all(
      workspaceModelLocations.map((workspaceModelLocation) =>
        this.loadWorkspaceModel(workspaceModelLocation),
      ),
    );
    const previousWorkspaceModels = this.workspaceModels;

    this.workspaceModels = nextWorkspaceModels;

    for (const previousWorkspaceModel of previousWorkspaceModels) {
      if (previousWorkspaceModel.kind === "configured") {
        previousWorkspaceModel.treeTYEngine.dispose();
      }
    }

    this.workspaceModelChangeEmitter.fire();
  }

  private async loadWorkspaceModel(
    workspaceModelLocation: WorkspaceModelLocation,
  ): Promise<WorkspaceModel> {
    let configFileContent: Uint8Array;

    try {
      configFileContent = await vscode.workspace.fs.readFile(
        workspaceModelLocation.configFileUri,
      );
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return {
          kind: "unconfigured",
          ...workspaceModelLocation,
        };
      }

      return {
        kind: "invalid",
        ...workspaceModelLocation,
        errorMessage: getErrorMessage(error),
      };
    }

    try {
      const treeConfigFileContent = new TextDecoder().decode(configFileContent);
      const treeConfig = parseTreeConfigContent(treeConfigFileContent);
      const resolvedTreeConfig = resolveTreeConfig(
        treeConfig,
        workspaceModelLocation.workspaceDirUri.fsPath,
      );
      const vscodeTerminalHost = new VscodeTerminalHost(
        workspaceModelLocation.id,
      );
      const treeTYEngine = new TreeTYEngine(
        resolvedTreeConfig,
        vscodeTerminalHost,
      );

      treeTYEngine.subscribe(() => this.workspaceModelChangeEmitter.fire());
      await treeTYEngine.start();

      return {
        kind: "configured",
        ...workspaceModelLocation,
        treeConfig,
        resolvedTreeConfig,
        treeTYEngine,
      };
    } catch (error) {
      return {
        kind: "invalid",
        ...workspaceModelLocation,
        errorMessage: getErrorMessage(error),
      };
    }
  }

  private async getTargetWorkspaceModel(
    treeEntry?: TreeEntry,
  ): Promise<WorkspaceModel | undefined> {
    if (treeEntry) return treeEntry.workspaceModel;

    if (this.workspaceModels.length === 1) return this.workspaceModels[0];

    const workspaceModelQuickPickItems = this.workspaceModels.map(
      (workspaceModel) => ({
        label: workspaceModel.name,
        description:
          workspaceModel.configSource === "global" ? "Global tree" : undefined,
        workspaceModel,
      }),
    );
    const workspaceModelQuickPickItem = await vscode.window.showQuickPick(
      workspaceModelQuickPickItems,
      {
        placeHolder: "Select the TreeTY workspace",
      },
    );

    return workspaceModelQuickPickItem?.workspaceModel;
  }

  private async getConfiguredWorkspaceModel(
    treeEntry?: TreeEntry,
  ): Promise<ConfiguredWorkspaceModel | undefined> {
    const workspaceModel = await this.getTargetWorkspaceModel(treeEntry);

    if (!workspaceModel) return undefined;

    if (workspaceModel.kind === "configured") return workspaceModel;

    void vscode.window.showInformationMessage(
      "Initialize a valid TreeTY configuration before changing the tree.",
    );

    return undefined;
  }

  private async initializeWorkspaceModel(
    workspaceModel: WorkspaceModel,
  ): Promise<void> {
    if (await getFileExists(workspaceModel.configFileUri)) {
      await this.showConfigFile(workspaceModel.configFileUri);

      return;
    }

    await vscode.workspace.fs.createDirectory(
      getParentUri(workspaceModel.configFileUri),
    );
    await vscode.workspace.fs.writeFile(
      workspaceModel.configFileUri,
      new TextEncoder().encode(getStarterConfigFileContent()),
    );
    await this.queueWorkspaceReload();
    await this.showConfigFile(workspaceModel.configFileUri);
  }

  private async writeWorkspaceTreeConfig(
    workspaceModel: ConfiguredWorkspaceModel,
    treeConfig: TreeConfig,
  ): Promise<void> {
    const temporaryConfigFileUri = vscode.Uri.joinPath(
      getParentUri(workspaceModel.configFileUri),
      `.tree-${process.pid}-${Date.now()}.json`,
    );

    await vscode.workspace.fs.writeFile(
      temporaryConfigFileUri,
      new TextEncoder().encode(formatTreeConfigContent(treeConfig)),
    );
    await vscode.workspace.fs.rename(
      temporaryConfigFileUri,
      workspaceModel.configFileUri,
      { overwrite: true },
    );
    await this.queueWorkspaceReload();
  }

  private async syncTerminalDirectory(
    nodeTreeEntry: NodeTreeEntry,
    forceSync: boolean,
  ): Promise<void> {
    const explorerDirectorySyncMode = vscode.workspace
      .getConfiguration("treety")
      .get<ExplorerDirectorySyncMode>("explorerDirectorySync", "prompt");

    if (!forceSync && explorerDirectorySyncMode === "never") return;

    const terminalDirUri = getTerminalDirUri(nodeTreeEntry);

    if (getUriIsInWorkspace(terminalDirUri)) return;

    const terminalDirectoryExists = await getDirectoryExists(terminalDirUri);

    if (!terminalDirectoryExists) {
      if (forceSync) {
        void vscode.window.showWarningMessage(
          `TreeTY directory does not exist: ${terminalDirUri.fsPath}`,
        );
      }

      return;
    }

    if (!forceSync && explorerDirectorySyncMode === "prompt") {
      const confirmation = await vscode.window.showInformationMessage(
        `Add "${path.basename(terminalDirUri.fsPath)}" to the VS Code workspace?`,
        "Add folder",
        "Not now",
      );

      if (confirmation !== "Add folder") return;
    }

    const workspaceFolderCount = vscode.workspace.workspaceFolders?.length ?? 0;
    const workspaceUpdated = vscode.workspace.updateWorkspaceFolders(
      workspaceFolderCount,
      null,
      { uri: terminalDirUri },
    );

    if (!workspaceUpdated) {
      throw new Error(
        `Could not add "${terminalDirUri.fsPath}" to the VS Code workspace.`,
      );
    }
  }

  private async showConfigFile(configFileUri: vscode.Uri): Promise<void> {
    const configDocument = await vscode.workspace.openTextDocument(configFileUri);

    await vscode.window.showTextDocument(configDocument);
  }
}

export function showCommandError(error: unknown): void {
  void vscode.window.showErrorMessage(`TreeTY: ${getErrorMessage(error)}`);
}

async function getWorkspaceModelLocations(
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  globalConfigFileUri: vscode.Uri,
  globalConfigExists: boolean,
  globalTreeVisibility: GlobalTreeVisibility,
): Promise<WorkspaceModelLocation[]> {
  if (workspaceFolders.length === 0) {
    return [getGlobalWorkspaceModelLocation(globalConfigFileUri)];
  }

  const workspaceModelLocations: WorkspaceModelLocation[] = [];
  let shouldAddGlobalWorkspaceModel = false;

  for (const workspaceFolder of workspaceFolders) {
    const workspaceModelLocation = getWorkspaceModelLocation(workspaceFolder);
    const workspaceConfigExists = await getFileExists(
      workspaceModelLocation.configFileUri,
    );

    if (workspaceConfigExists) {
      workspaceModelLocations.push(workspaceModelLocation);

      continue;
    }

    if (globalConfigExists && globalTreeVisibility !== "never") {
      shouldAddGlobalWorkspaceModel = true;

      continue;
    }

    workspaceModelLocations.push(workspaceModelLocation);
  }

  if (globalTreeVisibility === "always") {
    shouldAddGlobalWorkspaceModel = true;
  }

  if (shouldAddGlobalWorkspaceModel) {
    workspaceModelLocations.push(
      getGlobalWorkspaceModelLocation(globalConfigFileUri),
    );
  }

  return workspaceModelLocations;
}

function getWorkspaceModelLocation(
  workspaceFolder: vscode.WorkspaceFolder,
): WorkspaceModelLocation {
  const configFileUri = vscode.Uri.joinPath(
    workspaceFolder.uri,
    configDirName,
    configFileName,
  );

  return {
    id: `workspace:${configFileUri.toString()}`,
    name: workspaceFolder.name,
    workspaceDirUri: workspaceFolder.uri,
    workspaceFolder,
    configFileUri,
    configSource: "workspace",
  };
}

function getGlobalWorkspaceModelLocation(
  globalConfigFileUri: vscode.Uri,
): WorkspaceModelLocation {
  return {
    id: `global:${globalConfigFileUri.toString()}`,
    name: "Global",
    workspaceDirUri: vscode.Uri.file(os.homedir()),
    configFileUri: globalConfigFileUri,
    configSource: "global",
  };
}

function getGlobalConfigFileUri(): vscode.Uri {
  const globalConfigDirPath = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");

  return vscode.Uri.file(
    path.join(globalConfigDirPath, "treety", configFileName),
  );
}

function getParentUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ path: path.posix.dirname(uri.path) });
}

async function getTreeNodeName(prompt: string): Promise<string | undefined> {
  const treeNodeName = await vscode.window.showInputBox({
    prompt,
    validateInput: validateTreeNodeName,
  });

  return treeNodeName?.trim();
}

function validateTreeNodeName(treeNodeName: string): string | undefined {
  return treeNodeName.trim() ? undefined : "Enter a name.";
}

function getTargetParentId(treeEntry?: TreeEntry): string | undefined {
  if (treeEntry?.kind !== "node") return undefined;
  if (treeEntry.treeNode.kind !== "group") return undefined;

  return treeEntry.treeNode.id;
}

function getMoveDestinationQuickPickItems(
  nodeTreeEntry: NodeTreeEntry,
): MoveDestinationQuickPickItem[] {
  const moveDestinationQuickPickItems: MoveDestinationQuickPickItem[] = [];

  if (nodeTreeEntry.treeNode.parentId !== undefined) {
    moveDestinationQuickPickItems.push({
      label: "$(root-folder) Root",
      description: nodeTreeEntry.workspaceModel.name,
    });
  }

  const pendingTreeGroups = nodeTreeEntry.workspaceModel.resolvedTreeConfig.tree
    .filter((treeNode) => treeNode.kind === "group")
    .map((treeNode) => ({ treeNode, depth: 0 }));

  while (pendingTreeGroups.length > 0) {
    const pendingTreeGroup = pendingTreeGroups.shift();

    if (!pendingTreeGroup) continue;

    if (
      pendingTreeGroup.treeNode.id !== nodeTreeEntry.treeNode.id &&
      !getTreeNodeContainsId(
        nodeTreeEntry.treeNode,
        pendingTreeGroup.treeNode.id,
      ) &&
      pendingTreeGroup.treeNode.id !== nodeTreeEntry.treeNode.parentId
    ) {
      moveDestinationQuickPickItems.push({
        label: `$(folder) ${pendingTreeGroup.treeNode.name}`,
        description: `${"  ".repeat(pendingTreeGroup.depth)}${pendingTreeGroup.treeNode.cwd}`,
        parentId: pendingTreeGroup.treeNode.id,
      });
    }

    pendingTreeGroups.unshift(
      ...pendingTreeGroup.treeNode.children
        .filter((treeNode) => treeNode.kind === "group")
        .map((treeNode) => ({
          treeNode,
          depth: pendingTreeGroup.depth + 1,
        })),
    );
  }

  return moveDestinationQuickPickItems;
}

function getTreeNodeContainsId(
  treeNode: ResolvedTreeNode,
  nodeId: string,
): boolean {
  if (treeNode.id === nodeId) return true;
  if (treeNode.kind !== "group") return false;

  return treeNode.children.some((childTreeNode) =>
    getTreeNodeContainsId(childTreeNode, nodeId),
  );
}

function getTerminalNodeIds(treeNode: ResolvedTreeNode): string[] {
  if (treeNode.kind === "terminal") return [treeNode.id];

  return treeNode.children.flatMap((childTreeNode) =>
    getTerminalNodeIds(childTreeNode),
  );
}

function getDescendantCount(treeNode: ResolvedTreeNode): number {
  if (treeNode.kind === "terminal") return 0;

  return treeNode.children.reduce(
    (descendantCount, childTreeNode) =>
      descendantCount + 1 + getDescendantCount(childTreeNode),
    0,
  );
}

function getGroupDeletionConfirmationMessage(
  groupName: string,
  descendantCount: number,
): string {
  if (descendantCount === 0) return `Delete empty group "${groupName}"?`;

  return `Delete "${groupName}" and its ${descendantCount} descendant${descendantCount === 1 ? "" : "s"}?`;
}

function getTerminalDirUri(nodeTreeEntry: NodeTreeEntry): vscode.Uri {
  if (nodeTreeEntry.workspaceModel.workspaceDirUri.scheme === "file") {
    return vscode.Uri.file(nodeTreeEntry.treeNode.cwd);
  }

  return nodeTreeEntry.workspaceModel.workspaceDirUri.with({
    path: nodeTreeEntry.treeNode.cwd,
  });
}

function getUriIsInWorkspace(uri: vscode.Uri): boolean {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

  return workspaceFolders.some((workspaceFolder) => {
    if (
      workspaceFolder.uri.scheme !== uri.scheme ||
      workspaceFolder.uri.authority !== uri.authority
    ) {
      return false;
    }

    const dirNameFromWorkspace = path.relative(
      workspaceFolder.uri.fsPath,
      uri.fsPath,
    );

    return (
      dirNameFromWorkspace === "" ||
      (!dirNameFromWorkspace.startsWith("..") &&
        !path.isAbsolute(dirNameFromWorkspace))
    );
  });
}

async function getDirectoryExists(dirUri: vscode.Uri): Promise<boolean> {
  try {
    const fileStat = await vscode.workspace.fs.stat(dirUri);

    return (fileStat.type & vscode.FileType.Directory) !== 0;
  } catch (error) {
    if (isFileNotFoundError(error)) return false;

    throw error;
  }
}

async function getFileExists(fileUri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(fileUri);

    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) return false;

    throw error;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getStarterConfigFileContent(): string {
  const treeConfig = createEmptyTreeConfig();

  return formatTreeConfigContent({
    ...treeConfig,
    tree: [
      {
        kind: "group",
        id: "workspace",
        name: "Workspace",
        children: [
          {
            kind: "terminal",
            id: "shell",
            name: "Shell",
          },
        ],
      },
    ],
  });
}
