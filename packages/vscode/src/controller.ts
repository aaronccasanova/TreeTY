import * as os from "node:os";
import * as path from "node:path";

import {
  addTreeGroup,
  addTreeTerminal,
  createEmptyTreeConfig,
  getTreeStateFilePath,
  getTreeNode,
  JsonValue,
  loadTreeStateFile,
  MoveTreeNodeOptions,
  moveTreeNode,
  mutateTreeConfigFile,
  parseTreeConfigContent,
  removeTreeNode,
  renameTreeNode,
  resolveTreeConfig,
  ResolvedTreeNode,
  setTreeNodeAttention,
  TerminalSessionState,
  TreeConfig,
  TreeNodeConfig,
  TreeTYEngine,
  UpdateTreeNodeOptions,
  updateTreeNode,
  writeTreeConfigFile,
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
  stateFileUri: vscode.Uri;
  configSource: TreeConfigSource;
}

type MoveAction = "after" | "before" | "inside";

interface MoveTreeQuickPickButton extends vscode.QuickInputButton {
  action: MoveAction;
}

interface MoveTreeQuickPickItem extends vscode.QuickPickItem {
  buttons?: readonly MoveTreeQuickPickButton[];
  containerId?: string;
  isContainer: boolean;
  treeNode?: ResolvedTreeNode;
}

interface MoveTreeEditorState {
  collapsedGroupIds: ReadonlySet<string>;
  isRootCollapsed: boolean;
  showAllGroups: boolean;
}

interface NodeActionQuickPickItem extends vscode.QuickPickItem {
  execute: () => Promise<void>;
}

type ExplorerDirectorySyncMode = "always" | "never" | "prompt";
type GlobalTreeVisibility = "always" | "fallback" | "never";

const configDirName = ".treety";
const configFileName = "tree.json";
const stateFileName = "state.json";

export class TreeTYController implements WorkspaceModelSource, vscode.Disposable {
  private readonly workspaceModelChangeEmitter = new vscode.EventEmitter<void>();

  private readonly globalConfigFileUri = getGlobalConfigFileUri();

  private readonly globalStateFileUri = vscode.Uri.file(
    getTreeStateFilePath(this.globalConfigFileUri.fsPath),
  );

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
    const workspaceStateFileWatcher = vscode.workspace.createFileSystemWatcher(
      `**/${configDirName}/${stateFileName}`,
    );
    const globalStateFileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        getParentUri(this.globalStateFileUri),
        stateFileName,
      ),
    );

    this.vscodeDisposables = [
      workspaceConfigFileWatcher,
      globalConfigFileWatcher,
      workspaceStateFileWatcher,
      globalStateFileWatcher,
      ...this.getConfigFileWatcherSubscriptions(workspaceConfigFileWatcher),
      ...this.getConfigFileWatcherSubscriptions(globalConfigFileWatcher),
      ...this.getStateFileWatcherSubscriptions(workspaceStateFileWatcher),
      ...this.getStateFileWatcherSubscriptions(globalStateFileWatcher),
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

    const groupName = await getTreeNodeName({
      title: "Create TreeTY group",
      prompt: `Create in ${getTargetDescription(treeEntry, workspaceModel)}.`,
      placeHolder: "Group name",
    });

    if (!groupName) return;

    const parentId = getTargetParentId(treeEntry);
    await this.writeWorkspaceTreeConfig(workspaceModel, (treeConfig) =>
      addTreeGroup(treeConfig, {
        name: groupName,
        parentId,
      }),
    );
  }

  public async createTerminal(treeEntry?: TreeEntry): Promise<void> {
    const workspaceModel = await this.getConfiguredWorkspaceModel(treeEntry);

    if (!workspaceModel) return;

    const terminalName = await getTreeNodeName({
      title: "Create TreeTY terminal",
      prompt: `Create in ${getTargetDescription(treeEntry, workspaceModel)}.`,
      placeHolder: "Terminal name",
    });

    if (!terminalName) return;

    const parentId = getTargetParentId(treeEntry);
    await this.writeWorkspaceTreeConfig(workspaceModel, (treeConfig) =>
      addTreeTerminal(treeConfig, {
        name: terminalName,
        parentId,
      }),
    );
  }

  public async renameNode(nodeTreeEntry: NodeTreeEntry): Promise<void> {
    const treeNodeName = await vscode.window.showInputBox({
      prompt: "Tree node name",
      value: nodeTreeEntry.treeNode.name,
      validateInput: validateTreeNodeName,
    });

    if (!treeNodeName) return;

    await this.writeWorkspaceTreeConfig(
      nodeTreeEntry.workspaceModel,
      (treeConfig) =>
        renameTreeNode(
          treeConfig,
          nodeTreeEntry.treeNode.id,
          treeNodeName.trim(),
        ),
    );
  }

  public async configureNode(nodeTreeEntry: NodeTreeEntry): Promise<void> {
    const treeNodeConfig = getTreeNode(
      nodeTreeEntry.workspaceModel.treeConfig,
      nodeTreeEntry.treeNode.id,
    );

    if (!treeNodeConfig) {
      throw new Error(
        `Tree node "${nodeTreeEntry.treeNode.id}" does not exist.`,
      );
    }

    const configurationItem = await vscode.window.showQuickPick(
      [
        {
          label: "$(folder-active) Working directory",
          description: treeNodeConfig.cwd ?? "Inherited",
          propertyName: "cwd",
        },
        {
          label: "$(root-folder) Project directory",
          description: treeNodeConfig.projectDir ?? "Not configured here",
          propertyName: "projectDir",
        },
        {
          label: "$(refresh) Restart policy",
          description: treeNodeConfig.restartPolicy ?? "Inherited",
          propertyName: "restartPolicy",
        },
        {
          label: "$(symbol-variable) Environment",
          description: treeNodeConfig.env
            ? `${Object.keys(treeNodeConfig.env).length} override(s)`
            : "Inherited",
          propertyName: "env",
        },
        {
          label: "$(json) Metadata",
          description:
            treeNodeConfig.metadata === undefined
              ? "Not configured"
              : "Freeform JSON",
          propertyName: "metadata",
        },
      ] as const,
      {
        title: `Configure ${treeNodeConfig.name}`,
        placeHolder: "Choose a property to edit",
      },
    );

    if (!configurationItem) return;

    const treeNodeUpdate = await this.getConfiguredTreeNodeUpdate(
      treeNodeConfig,
      configurationItem.propertyName,
    );

    if (!treeNodeUpdate) return;

    await this.writeWorkspaceTreeConfig(
      nodeTreeEntry.workspaceModel,
      (treeConfig) =>
        updateTreeNode(treeConfig, {
          nodeId: treeNodeConfig.id,
          ...treeNodeUpdate,
        }),
    );
  }

  public async moveNode(nodeTreeEntry: NodeTreeEntry): Promise<void> {
    const moveTreeNodeOptions = await showMoveTreeEditor(nodeTreeEntry);

    if (!moveTreeNodeOptions) return;

    await this.writeWorkspaceTreeConfig(
      nodeTreeEntry.workspaceModel,
      (treeConfig) => moveTreeNode(treeConfig, moveTreeNodeOptions),
    );
  }

  public async showNodeActions(nodeTreeEntry: NodeTreeEntry): Promise<void> {
    const nodeActionQuickPickItems: NodeActionQuickPickItem[] = [
      {
        execute: () => this.renameNode(nodeTreeEntry),
        label: "$(edit) Rename",
      },
      {
        execute: () => this.configureNode(nodeTreeEntry),
        label: "$(settings-gear) Configure...",
      },
      {
        execute: () => this.moveNode(nodeTreeEntry),
        label: "$(type-hierarchy-sub) Move...",
      },
    ];

    if (nodeTreeEntry.treeNode.kind === "terminal") {
      const terminalSessionState = this.getTerminalSessionState(
        nodeTreeEntry.workspaceModel,
        nodeTreeEntry.treeNode.id,
      );

      nodeActionQuickPickItems.push({
        execute: () => this.restartTerminal(nodeTreeEntry),
        label: "$(debug-restart) Restart terminal",
      });

      if (
        terminalSessionState.status === "idle" ||
        terminalSessionState.status === "running" ||
        terminalSessionState.status === "starting"
      ) {
        nodeActionQuickPickItems.push({
          execute: () => this.stopTerminal(nodeTreeEntry),
          label: "$(debug-stop) Stop terminal",
        });
      }

      if (nodeTreeEntry.treeNode.projectDir) {
        nodeActionQuickPickItems.push({
          execute: () =>
            this.addTerminalDirectoryToWorkspace(nodeTreeEntry),
          label: "$(folder-library) Add project directory to workspace...",
        });
      }
    }

    const nodeActionQuickPickItem = await vscode.window.showQuickPick(
      nodeActionQuickPickItems,
      {
        title: nodeTreeEntry.treeNode.name,
        placeHolder: "Choose an action",
      },
    );

    await nodeActionQuickPickItem?.execute();
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

    await this.writeWorkspaceTreeConfig(
      nodeTreeEntry.workspaceModel,
      (treeConfig) => removeTreeNode(treeConfig, nodeTreeEntry.treeNode.id),
    );
  }

  public async openTerminal(nodeTreeEntry: NodeTreeEntry): Promise<void> {
    if (nodeTreeEntry.treeNode.kind !== "terminal") return;

    await this.clearTerminalAttention(nodeTreeEntry);
    await nodeTreeEntry.workspaceModel.treeTYEngine.openTerminal(
      nodeTreeEntry.treeNode.id,
    );
    await this.syncProjectDirectory(nodeTreeEntry, false);
  }

  public async restartTerminal(nodeTreeEntry: NodeTreeEntry): Promise<void> {
    if (nodeTreeEntry.treeNode.kind !== "terminal") return;

    await this.clearTerminalAttention(nodeTreeEntry);
    await nodeTreeEntry.workspaceModel.treeTYEngine.restartTerminal(
      nodeTreeEntry.treeNode.id,
    );
    await this.syncProjectDirectory(nodeTreeEntry, false);
  }

  public async addTerminalDirectoryToWorkspace(
    nodeTreeEntry: NodeTreeEntry,
  ): Promise<void> {
    if (nodeTreeEntry.treeNode.kind !== "terminal") return;

    await this.syncProjectDirectory(nodeTreeEntry, true);
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
      configFileWatcher.onDidCreate((configFileUri) =>
        this.scheduleWorkspaceReconciliation(configFileUri, "config"),
      ),
      configFileWatcher.onDidChange((configFileUri) =>
        this.scheduleWorkspaceReconciliation(configFileUri, "config"),
      ),
      configFileWatcher.onDidDelete((configFileUri) =>
        this.scheduleWorkspaceReconciliation(configFileUri, "config"),
      ),
    ];
  }

  private getStateFileWatcherSubscriptions(
    stateFileWatcher: vscode.FileSystemWatcher,
  ): vscode.Disposable[] {
    return [
      stateFileWatcher.onDidCreate((stateFileUri) =>
        this.scheduleWorkspaceReconciliation(stateFileUri, "state"),
      ),
      stateFileWatcher.onDidChange((stateFileUri) =>
        this.scheduleWorkspaceReconciliation(stateFileUri, "state"),
      ),
      stateFileWatcher.onDidDelete((stateFileUri) =>
        this.scheduleWorkspaceReconciliation(stateFileUri, "state"),
      ),
    ];
  }

  private scheduleWorkspaceReload(): void {
    void this.queueWorkspaceReload().catch((error: unknown) =>
      showCommandError(error),
    );
  }

  private scheduleWorkspaceReconciliation(
    changedFileUri: vscode.Uri,
    changedFileKind: "config" | "state",
  ): void {
    void this.queueWorkspaceOperation(() =>
      this.reconcileWorkspace(changedFileUri, changedFileKind),
    ).catch((error: unknown) => showCommandError(error));
  }

  private queueWorkspaceReload(): Promise<void> {
    return this.queueWorkspaceOperation(() => this.reloadWorkspaces());
  }

  private queueWorkspaceOperation(
    workspaceOperation: () => Promise<void>,
  ): Promise<void> {
    const workspaceReloadPromise = this.workspaceReloadPromise.then(
      workspaceOperation,
    );

    this.workspaceReloadPromise = workspaceReloadPromise.catch(() => undefined);

    return workspaceReloadPromise;
  }

  private async reconcileWorkspace(
    changedFileUri: vscode.Uri,
    changedFileKind: "config" | "state",
  ): Promise<void> {
    const workspaceModel = this.workspaceModels.find((candidateWorkspaceModel) => {
      const targetFileUri =
        changedFileKind === "config"
          ? candidateWorkspaceModel.configFileUri
          : candidateWorkspaceModel.stateFileUri;

      return targetFileUri.toString() === changedFileUri.toString();
    });

    if (!workspaceModel) {
      await this.reloadWorkspaces();

      return;
    }

    if (
      workspaceModel.kind !== "configured" ||
      (changedFileKind === "config" &&
        !(await getFileExists(workspaceModel.configFileUri)))
    ) {
      await this.reloadWorkspaceModel(workspaceModel);

      return;
    }

    const treeConfig =
      changedFileKind === "config"
        ? parseTreeConfigContent(
            new TextDecoder().decode(
              await vscode.workspace.fs.readFile(workspaceModel.configFileUri),
            ),
          )
        : workspaceModel.treeConfig;
    const treeState = await loadTreeStateFile(
      workspaceModel.configFileUri.fsPath,
    );
    const resolvedTreeConfig = resolveTreeConfig(
      treeConfig,
      workspaceModel.workspaceDirUri.fsPath,
      treeState,
    );

    if (changedFileKind === "config") {
      await workspaceModel.treeTYEngine.reconcile(resolvedTreeConfig);
    }

    workspaceModel.treeConfig = treeConfig;
    workspaceModel.treeState = treeState;
    workspaceModel.resolvedTreeConfig = resolvedTreeConfig;

    this.workspaceModelChangeEmitter.fire();
  }

  private async reloadWorkspaceModel(
    previousWorkspaceModel: WorkspaceModel,
  ): Promise<void> {
    const workspaceModelIndex = this.workspaceModels.findIndex(
      (workspaceModel) => workspaceModel.id === previousWorkspaceModel.id,
    );

    if (workspaceModelIndex === -1) {
      await this.reloadWorkspaces();

      return;
    }

    const nextWorkspaceModel = await this.loadWorkspaceModel({
      id: previousWorkspaceModel.id,
      name: previousWorkspaceModel.name,
      workspaceDirUri: previousWorkspaceModel.workspaceDirUri,
      workspaceFolder: previousWorkspaceModel.workspaceFolder,
      configFileUri: previousWorkspaceModel.configFileUri,
      stateFileUri: previousWorkspaceModel.stateFileUri,
      configSource: previousWorkspaceModel.configSource,
    });

    if (previousWorkspaceModel.kind === "configured") {
      if (nextWorkspaceModel.kind !== "configured") {
        for (const treeNode of previousWorkspaceModel.resolvedTreeConfig.tree) {
          for (const terminalNodeId of getTerminalNodeIds(treeNode)) {
            previousWorkspaceModel.treeTYEngine.stopTerminal(terminalNodeId);
          }
        }
      }

      previousWorkspaceModel.treeTYEngine.dispose();
    }

    this.workspaceModels[workspaceModelIndex] = nextWorkspaceModel;
    this.workspaceModelChangeEmitter.fire();
  }

  private async reloadWorkspaces(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const globalConfigExists = await getFileExists(this.globalConfigFileUri);
    const globalTreeVisibility = vscode.workspace
      .getConfiguration("treety")
      .get<GlobalTreeVisibility>("globalTreeVisibility", "always");
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

    closeRemovedTerminalSessions(previousWorkspaceModels, nextWorkspaceModels);

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
      const treeState = await loadTreeStateFile(
        workspaceModelLocation.configFileUri.fsPath,
      );
      const resolvedTreeConfig = resolveTreeConfig(
        treeConfig,
        workspaceModelLocation.workspaceDirUri.fsPath,
        treeState,
      );
      const vscodeTerminalHost = new VscodeTerminalHost(
        workspaceModelLocation.id,
        workspaceModelLocation.configFileUri.fsPath,
        workspaceModelLocation.configSource,
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
        treeState,
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
    if (treeEntry) {
      return this.workspaceModels.find(
        (workspaceModel) => workspaceModel.id === treeEntry.workspaceModel.id,
      );
    }

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

    await writeTreeConfigFile(
      workspaceModel.configFileUri.fsPath,
      getStarterTreeConfig(),
    );
    await this.queueWorkspaceReload();
    await this.showConfigFile(workspaceModel.configFileUri);
  }

  private async writeWorkspaceTreeConfig(
    workspaceModel: ConfiguredWorkspaceModel,
    mutateTreeConfig: (treeConfig: TreeConfig) => TreeConfig,
  ): Promise<void> {
    await mutateTreeConfigFile(
      workspaceModel.configFileUri.fsPath,
      mutateTreeConfig,
    );
    await this.queueWorkspaceOperation(() =>
      this.reconcileWorkspace(workspaceModel.configFileUri, "config"),
    );
  }

  private async clearTerminalAttention(
    nodeTreeEntry: NodeTreeEntry,
  ): Promise<void> {
    await setTreeNodeAttention(
      nodeTreeEntry.workspaceModel.configFileUri.fsPath,
      nodeTreeEntry.treeNode.id,
      false,
    );
    await this.queueWorkspaceOperation(() =>
      this.reconcileWorkspace(
        nodeTreeEntry.workspaceModel.stateFileUri,
        "state",
      ),
    );
  }

  private async syncProjectDirectory(
    nodeTreeEntry: NodeTreeEntry,
    forceSync: boolean,
  ): Promise<void> {
    const explorerDirectorySyncMode = vscode.workspace
      .getConfiguration("treety")
      .get<ExplorerDirectorySyncMode>("explorerDirectorySync", "never");

    if (!forceSync && explorerDirectorySyncMode === "never") return;

    const projectDirUri = getProjectDirUri(nodeTreeEntry);

    if (!projectDirUri) {
      if (forceSync) {
        void vscode.window.showInformationMessage(
          `Configure a project directory for "${nodeTreeEntry.treeNode.name}" before adding it to the VS Code workspace.`,
        );
      }

      return;
    }

    if (getUriIsInWorkspace(projectDirUri)) {
      if (forceSync) {
        void vscode.window.showInformationMessage(
          `${formatDisplayPath(projectDirUri.fsPath)} is already in the VS Code workspace.`,
        );
      }

      return;
    }

    const projectDirectoryExists = await getDirectoryExists(projectDirUri);

    if (!projectDirectoryExists) {
      if (forceSync) {
        void vscode.window.showWarningMessage(
          `TreeTY project directory does not exist: ${projectDirUri.fsPath}`,
        );
      }

      return;
    }

    if (forceSync || explorerDirectorySyncMode === "prompt") {
      const confirmation = await vscode.window.showInformationMessage(
        `Add this project directory to the VS Code workspace?`,
        {
          modal: true,
          detail: projectDirUri.fsPath,
        },
        "Add folder",
      );

      if (confirmation !== "Add folder") return;
    }

    const workspaceFolderCount = vscode.workspace.workspaceFolders?.length ?? 0;
    const workspaceUpdated = vscode.workspace.updateWorkspaceFolders(
      workspaceFolderCount,
      null,
      { uri: projectDirUri },
    );

    if (!workspaceUpdated) {
      throw new Error(
        `Could not add "${projectDirUri.fsPath}" to the VS Code workspace.`,
      );
    }
  }

  private async getConfiguredTreeNodeUpdate(
    treeNodeConfig: TreeNodeConfig,
    propertyName: "cwd" | "env" | "metadata" | "projectDir" | "restartPolicy",
  ): Promise<Omit<UpdateTreeNodeOptions, "nodeId"> | undefined> {
    if (propertyName === "restartPolicy") {
      const restartPolicyItem = await vscode.window.showQuickPick(
        [
          { label: "Inherit", restartPolicy: null },
          { label: "Manual", restartPolicy: "manual" as const },
          { label: "On open", restartPolicy: "onOpen" as const },
        ],
        {
          title: `Restart policy for ${treeNodeConfig.name}`,
        },
      );

      if (!restartPolicyItem) return undefined;

      return {
        restartPolicy: restartPolicyItem.restartPolicy,
      };
    }

    if (propertyName === "env" || propertyName === "metadata") {
      const currentJsonValue =
        propertyName === "env" ? treeNodeConfig.env : treeNodeConfig.metadata;
      const jsonContent = await vscode.window.showInputBox({
        title: `${propertyName === "env" ? "Environment" : "Metadata"} for ${treeNodeConfig.name}`,
        prompt:
          propertyName === "env"
            ? "Enter a JSON object of environment overrides. Use null to unset a variable. Leave empty to inherit."
            : "Enter any JSON value. Leave empty to remove metadata.",
        value:
          currentJsonValue === undefined
            ? ""
            : JSON.stringify(currentJsonValue),
        validateInput: (inputContent) =>
          validateNodeJsonContent(inputContent, propertyName),
      });

      if (jsonContent === undefined) return undefined;

      if (propertyName === "metadata") {
        return {
          metadata:
            jsonContent.trim() === ""
              ? undefined
              : (JSON.parse(jsonContent) as JsonValue),
          metadataAction:
            jsonContent.trim() === "" ? "remove" : "replace",
        };
      }

      const environmentNames = Object.keys(treeNodeConfig.env ?? {});
      const terminalEnvironment =
        jsonContent.trim() === ""
          ? undefined
          : (JSON.parse(jsonContent) as Record<string, string | null>);

      return {
        env: {
          delete: environmentNames,
          set: terminalEnvironment,
        },
      };
    }

    const currentDirName = treeNodeConfig[propertyName];
    const dirName = await vscode.window.showInputBox({
      title: `${propertyName === "cwd" ? "Working" : "Project"} directory for ${treeNodeConfig.name}`,
      prompt:
        propertyName === "cwd"
          ? "Relative paths resolve from the parent working directory. Leave empty to inherit."
          : "Relative paths resolve from this node's working directory. Leave empty to inherit or remain unconfigured.",
      value: currentDirName ?? "",
    });

    if (dirName === undefined) return undefined;

    return {
      [propertyName]: dirName.trim() || null,
    };
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
  let hasUnconfiguredWorkspace = false;

  for (const workspaceFolder of workspaceFolders) {
    const workspaceModelLocation = getWorkspaceModelLocation(workspaceFolder);
    const workspaceConfigExists = await getFileExists(
      workspaceModelLocation.configFileUri,
    );

    workspaceModelLocations.push(workspaceModelLocation);

    if (!workspaceConfigExists) hasUnconfiguredWorkspace = true;
  }

  if (
    globalTreeVisibility === "always" ||
    (globalTreeVisibility === "fallback" &&
      hasUnconfiguredWorkspace &&
      globalConfigExists)
  ) {
    workspaceModelLocations.unshift(
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
  const stateFileUri = vscode.Uri.joinPath(
    workspaceFolder.uri,
    configDirName,
    stateFileName,
  );

  return {
    id: `workspace:${configFileUri.toString()}`,
    name: workspaceFolder.name,
    workspaceDirUri: workspaceFolder.uri,
    workspaceFolder,
    configFileUri,
    stateFileUri,
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
    stateFileUri: vscode.Uri.file(
      getTreeStateFilePath(globalConfigFileUri.fsPath),
    ),
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

async function getTreeNodeName(
  inputBoxOptions: vscode.InputBoxOptions,
): Promise<string | undefined> {
  const treeNodeName = await vscode.window.showInputBox({
    ...inputBoxOptions,
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

function getTargetDescription(
  treeEntry: TreeEntry | undefined,
  workspaceModel: ConfiguredWorkspaceModel,
): string {
  if (treeEntry?.kind !== "node") return `the ${workspaceModel.name} root`;
  if (treeEntry.treeNode.kind !== "group") {
    return `the ${workspaceModel.name} root`;
  }

  return `"${treeEntry.treeNode.name}"`;
}

async function showMoveTreeEditor(
  nodeTreeEntry: NodeTreeEntry,
): Promise<MoveTreeNodeOptions | undefined> {
  const moveTreeQuickPick =
    vscode.window.createQuickPick<MoveTreeQuickPickItem>();
  const groupIds = getGroupIds(
    nodeTreeEntry.workspaceModel.resolvedTreeConfig.tree,
  );
  const collapsedGroupIds = new Set<string>();
  const expandEntireTreeButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("expand-all"),
    tooltip: "Expand entire tree",
  };
  const collapseEntireTreeButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("collapse-all"),
    tooltip: "Collapse entire tree",
  };
  let isRootCollapsed = false;
  let isResolved = false;

  const refreshMoveTreeQuickPickItems = (): void => {
    moveTreeQuickPick.items = getMoveTreeQuickPickItems(nodeTreeEntry, {
      collapsedGroupIds,
      isRootCollapsed,
      showAllGroups: moveTreeQuickPick.value.trim() !== "",
    });
  };

  moveTreeQuickPick.title = `Move ${nodeTreeEntry.treeNode.name}`;
  moveTreeQuickPick.placeholder = "Search the tree";
  moveTreeQuickPick.prompt =
    "Use a row's arrows to insert above, inside, or below. Select a group to expand or collapse it.";
  moveTreeQuickPick.buttons = [
    expandEntireTreeButton,
    collapseEntireTreeButton,
  ];
  moveTreeQuickPick.matchOnDescription = true;

  refreshMoveTreeQuickPickItems();

  return new Promise((resolve) => {
    const resolveMoveTreeEditor = (
      moveTreeNodeOptions?: MoveTreeNodeOptions,
    ): void => {
      if (isResolved) return;

      isResolved = true;
      resolve(moveTreeNodeOptions);
      moveTreeQuickPick.hide();
      moveTreeQuickPick.dispose();
    };

    moveTreeQuickPick.onDidChangeValue(refreshMoveTreeQuickPickItems);

    moveTreeQuickPick.onDidTriggerButton((button) => {
      if (button === expandEntireTreeButton) {
        collapsedGroupIds.clear();
        isRootCollapsed = false;
      } else if (button === collapseEntireTreeButton) {
        for (const groupId of groupIds) collapsedGroupIds.add(groupId);

        isRootCollapsed = true;
      } else {
        return;
      }

      moveTreeQuickPick.value = "";
      refreshMoveTreeQuickPickItems();
    });

    moveTreeQuickPick.onDidAccept(() => {
      const selectedMoveTreeQuickPickItem = moveTreeQuickPick.selectedItems[0];

      if (!selectedMoveTreeQuickPickItem?.isContainer) return;

      if (!selectedMoveTreeQuickPickItem.containerId) {
        isRootCollapsed = !isRootCollapsed;
      } else if (
        collapsedGroupIds.has(selectedMoveTreeQuickPickItem.containerId)
      ) {
        collapsedGroupIds.delete(selectedMoveTreeQuickPickItem.containerId);
      } else {
        collapsedGroupIds.add(selectedMoveTreeQuickPickItem.containerId);
      }

      refreshMoveTreeQuickPickItems();
    });

    moveTreeQuickPick.onDidTriggerItemButton((buttonEvent) => {
      const moveTreeQuickPickButton =
        buttonEvent.button as MoveTreeQuickPickButton;
      const targetTreeNode = buttonEvent.item.treeNode;
      const moveTreeNodeOptions: MoveTreeNodeOptions = {
        nodeId: nodeTreeEntry.treeNode.id,
      };

      if (moveTreeQuickPickButton.action === "inside") {
        moveTreeNodeOptions.parentId = targetTreeNode?.id;
      } else if (
        moveTreeQuickPickButton.action === "before" &&
        targetTreeNode
      ) {
        moveTreeNodeOptions.beforeId = targetTreeNode.id;
      } else if (
        moveTreeQuickPickButton.action === "after" &&
        targetTreeNode
      ) {
        moveTreeNodeOptions.afterId = targetTreeNode.id;
      } else {
        return;
      }

      resolveMoveTreeEditor(moveTreeNodeOptions);
    });

    moveTreeQuickPick.onDidHide(() => resolveMoveTreeEditor());

    moveTreeQuickPick.show();
  });
}

function getMoveTreeQuickPickItems(
  nodeTreeEntry: NodeTreeEntry,
  moveTreeEditorState: MoveTreeEditorState,
): MoveTreeQuickPickItem[] {
  const sourceTreeNodeIds = new Set(getTreeNodeIds(nodeTreeEntry.treeNode));
  const rootName = `${nodeTreeEntry.workspaceModel.name} root`;
  const rootIsExpanded =
    moveTreeEditorState.showAllGroups || !moveTreeEditorState.isRootCollapsed;
  const moveTreeQuickPickItems: MoveTreeQuickPickItem[] = [
    {
      buttons: [getMoveTreeQuickPickButton("inside", rootName)],
      description: "tree root",
      isContainer: true,
      label: `$(${rootIsExpanded ? "chevron-down" : "chevron-right"}) $(root-folder) ${rootName}`,
    },
  ];

  if (!rootIsExpanded) return moveTreeQuickPickItems;

  appendMoveTreeQuickPickItems(
    moveTreeQuickPickItems,
    nodeTreeEntry.workspaceModel.resolvedTreeConfig.tree,
    nodeTreeEntry.treeNode.id,
    sourceTreeNodeIds,
    moveTreeEditorState,
    1,
    rootName,
  );

  return moveTreeQuickPickItems;
}

function appendMoveTreeQuickPickItems(
  moveTreeQuickPickItems: MoveTreeQuickPickItem[],
  treeNodes: readonly ResolvedTreeNode[],
  sourceTreeNodeId: string,
  sourceTreeNodeIds: ReadonlySet<string>,
  moveTreeEditorState: MoveTreeEditorState,
  depth: number,
  parentPath: string,
): void {
  for (const treeNode of treeNodes) {
    const isSourceTreeNode = sourceTreeNodeIds.has(treeNode.id);
    const isGroupExpanded =
      treeNode.kind === "group" &&
      (moveTreeEditorState.showAllGroups ||
        !moveTreeEditorState.collapsedGroupIds.has(treeNode.id));
    const moveTreeQuickPickButtons = isSourceTreeNode
      ? undefined
      : getMoveTreeQuickPickButtons(treeNode);

    moveTreeQuickPickItems.push({
      buttons: moveTreeQuickPickButtons,
      containerId: treeNode.kind === "group" ? treeNode.id : undefined,
      description: treeNode.id === sourceTreeNodeId ? "moving" : parentPath,
      isContainer: treeNode.kind === "group",
      label: `${"  ".repeat(depth)}${getMoveTreeNodeLabelIcon(treeNode, isGroupExpanded)} ${treeNode.name}`,
      treeNode,
    });

    if (treeNode.kind !== "group" || !isGroupExpanded) continue;

    appendMoveTreeQuickPickItems(
      moveTreeQuickPickItems,
      treeNode.children,
      sourceTreeNodeId,
      sourceTreeNodeIds,
      moveTreeEditorState,
      depth + 1,
      `${parentPath} / ${treeNode.name}`,
    );
  }
}

function getMoveTreeQuickPickButtons(
  treeNode: ResolvedTreeNode,
): MoveTreeQuickPickButton[] {
  const moveTreeQuickPickButtons = [
    getMoveTreeQuickPickButton("before", treeNode.name),
  ];

  if (treeNode.kind === "group") {
    moveTreeQuickPickButtons.push(
      getMoveTreeQuickPickButton("inside", treeNode.name),
    );
  }

  moveTreeQuickPickButtons.push(
    getMoveTreeQuickPickButton("after", treeNode.name),
  );

  return moveTreeQuickPickButtons;
}

function getMoveTreeQuickPickButton(
  action: MoveAction,
  targetName: string,
): MoveTreeQuickPickButton {
  const iconNameByAction: Record<MoveAction, string> = {
    after: "arrow-down",
    before: "arrow-up",
    inside: "arrow-right",
  };
  const tooltipByAction: Record<MoveAction, string> = {
    after: `Insert below "${targetName}"`,
    before: `Insert above "${targetName}"`,
    inside: `Move inside "${targetName}" (at the end)`,
  };

  return {
    action,
    iconPath: new vscode.ThemeIcon(iconNameByAction[action]),
    tooltip: tooltipByAction[action],
  };
}

function getMoveTreeNodeLabelIcon(
  treeNode: ResolvedTreeNode,
  isGroupExpanded: boolean,
): string {
  if (treeNode.kind === "terminal") return "$(terminal)";

  return `$(${isGroupExpanded ? "chevron-down" : "chevron-right"}) $(folder)`;
}

function getGroupIds(treeNodes: readonly ResolvedTreeNode[]): string[] {
  return treeNodes.flatMap((treeNode) => {
    if (treeNode.kind === "terminal") return [];

    return [treeNode.id, ...getGroupIds(treeNode.children)];
  });
}

function getTreeNodeIds(treeNode: ResolvedTreeNode): string[] {
  if (treeNode.kind === "terminal") return [treeNode.id];

  return [
    treeNode.id,
    ...treeNode.children.flatMap((childTreeNode) =>
      getTreeNodeIds(childTreeNode),
    ),
  ];
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

function closeRemovedTerminalSessions(
  previousWorkspaceModels: WorkspaceModel[],
  nextWorkspaceModels: WorkspaceModel[],
): void {
  for (const previousWorkspaceModel of previousWorkspaceModels) {
    if (previousWorkspaceModel.kind !== "configured") continue;

    const nextWorkspaceModel = nextWorkspaceModels.find(
      (workspaceModel) => workspaceModel.id === previousWorkspaceModel.id,
    );

    if (nextWorkspaceModel?.kind !== "configured") continue;

    const nextTerminalNodeIds = new Set(
      nextWorkspaceModel.resolvedTreeConfig.tree.flatMap((treeNode) =>
        getTerminalNodeIds(treeNode),
      ),
    );
    const previousTerminalNodeIds =
      previousWorkspaceModel.resolvedTreeConfig.tree.flatMap((treeNode) =>
        getTerminalNodeIds(treeNode),
      );

    for (const previousTerminalNodeId of previousTerminalNodeIds) {
      if (nextTerminalNodeIds.has(previousTerminalNodeId)) continue;

      previousWorkspaceModel.treeTYEngine.stopTerminal(previousTerminalNodeId);
    }
  }
}

function getProjectDirUri(nodeTreeEntry: NodeTreeEntry): vscode.Uri | undefined {
  if (!nodeTreeEntry.treeNode.projectDir) return undefined;

  if (nodeTreeEntry.workspaceModel.workspaceDirUri.scheme === "file") {
    return vscode.Uri.file(nodeTreeEntry.treeNode.projectDir);
  }

  return nodeTreeEntry.workspaceModel.workspaceDirUri.with({
    path: nodeTreeEntry.treeNode.projectDir,
  });
}

function formatDisplayPath(dirPath: string): string {
  const homeDirPath = os.homedir();
  const dirNameFromHome = path.relative(homeDirPath, dirPath);

  if (dirNameFromHome === "") return "~";

  if (
    dirNameFromHome.startsWith("..") ||
    path.isAbsolute(dirNameFromHome)
  ) {
    return dirPath;
  }

  return path.join("~", dirNameFromHome);
}

function validateNodeJsonContent(
  jsonContent: string,
  propertyName: "env" | "metadata",
): string | undefined {
  if (jsonContent.trim() === "") return undefined;

  let jsonValue: unknown;

  try {
    jsonValue = JSON.parse(jsonContent);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  if (propertyName === "metadata") return undefined;

  if (
    typeof jsonValue !== "object" ||
    jsonValue === null ||
    Array.isArray(jsonValue)
  ) {
    return "Environment must be a JSON object.";
  }

  for (const [environmentName, environmentValue] of Object.entries(jsonValue)) {
    if (typeof environmentValue === "string" || environmentValue === null) {
      continue;
    }

    return `Environment value "${environmentName}" must be a string or null.`;
  }

  return undefined;
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

function getStarterTreeConfig(): TreeConfig {
  const treeConfigWithGroup = addTreeGroup(createEmptyTreeConfig(), {
    name: "Workspace",
  });
  const workspaceGroup = treeConfigWithGroup.tree[0];
  const treeConfig = addTreeTerminal(treeConfigWithGroup, {
    name: "Shell",
    parentId: workspaceGroup?.id,
  });

  return treeConfig;
}
