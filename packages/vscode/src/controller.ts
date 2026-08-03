import {
  parseTreeConfigContent,
  resolveTreeConfig,
  TerminalSessionState,
  TreeTYEngine,
} from "@treety/core";
import * as vscode from "vscode";

import { NodeTreeEntry, TreeEntry } from "./tree-provider";
import { VscodeTerminalHost } from "./vscode-terminal-host";
import {
  ConfiguredWorkspaceModel,
  WorkspaceModel,
  WorkspaceModelSource,
} from "./workspace-model";

const configDirName = ".treety";
const configFileName = "tree.json";

export class TreeTYController implements WorkspaceModelSource, vscode.Disposable {
  private readonly workspaceModelChangeEmitter = new vscode.EventEmitter<void>();

  private readonly vscodeDisposables: vscode.Disposable[];

  private workspaceModels: WorkspaceModel[] = [];

  private workspaceReloadPromise: Promise<void> = Promise.resolve();

  public readonly onDidChangeWorkspaceModels =
    this.workspaceModelChangeEmitter.event;

  public constructor() {
    const configFileWatcher = vscode.workspace.createFileSystemWatcher(
      `**/${configDirName}/${configFileName}`,
    );

    this.vscodeDisposables = [
      configFileWatcher,
      configFileWatcher.onDidCreate(() => this.scheduleWorkspaceReload()),
      configFileWatcher.onDidChange(() => this.scheduleWorkspaceReload()),
      configFileWatcher.onDidDelete(() => this.scheduleWorkspaceReload()),
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

    if (await getFileExists(workspaceModel.configFileUri)) {
      await this.showConfigFile(workspaceModel.configFileUri);

      return;
    }

    const configDirUri = vscode.Uri.joinPath(
      workspaceModel.workspaceFolder.uri,
      configDirName,
    );

    await vscode.workspace.fs.createDirectory(configDirUri);
    await vscode.workspace.fs.writeFile(
      workspaceModel.configFileUri,
      new TextEncoder().encode(getStarterConfigFileContent()),
    );
    await this.queueWorkspaceReload();
    await this.showConfigFile(workspaceModel.configFileUri);
  }

  public async openConfig(treeEntry?: TreeEntry): Promise<void> {
    const workspaceModel = await this.getTargetWorkspaceModel(treeEntry);

    if (!workspaceModel) return;

    if (!(await getFileExists(workspaceModel.configFileUri))) {
      await this.initializeWorkspace(treeEntry);

      return;
    }

    await this.showConfigFile(workspaceModel.configFileUri);
  }

  public async openTerminal(nodeTreeEntry: NodeTreeEntry): Promise<void> {
    if (nodeTreeEntry.treeNode.kind !== "terminal") return;

    await nodeTreeEntry.workspaceModel.treeTYEngine.openTerminal(
      nodeTreeEntry.treeNode.id,
    );
  }

  public async restartTerminal(nodeTreeEntry: NodeTreeEntry): Promise<void> {
    if (nodeTreeEntry.treeNode.kind !== "terminal") return;

    await nodeTreeEntry.workspaceModel.treeTYEngine.restartTerminal(
      nodeTreeEntry.treeNode.id,
    );
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
    const nextWorkspaceModels = await Promise.all(
      workspaceFolders.map((workspaceFolder) =>
        this.loadWorkspaceModel(workspaceFolder),
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
    workspaceFolder: vscode.WorkspaceFolder,
  ): Promise<WorkspaceModel> {
    const configFileUri = vscode.Uri.joinPath(
      workspaceFolder.uri,
      configDirName,
      configFileName,
    );
    let configFileContent: Uint8Array;

    try {
      configFileContent = await vscode.workspace.fs.readFile(configFileUri);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return {
          kind: "unconfigured",
          workspaceFolder,
          configFileUri,
        };
      }

      return {
        kind: "invalid",
        workspaceFolder,
        configFileUri,
        errorMessage: getErrorMessage(error),
      };
    }

    try {
      const treeConfigFileContent = new TextDecoder().decode(configFileContent);
      const treeConfig = parseTreeConfigContent(treeConfigFileContent);
      const resolvedTreeConfig = resolveTreeConfig(
        treeConfig,
        workspaceFolder.uri.fsPath,
      );
      const vscodeTerminalHost = new VscodeTerminalHost(
        workspaceFolder.uri.toString(),
      );
      const treeTYEngine = new TreeTYEngine(
        resolvedTreeConfig,
        vscodeTerminalHost,
      );

      treeTYEngine.subscribe(() => this.workspaceModelChangeEmitter.fire());
      await treeTYEngine.start();

      return {
        kind: "configured",
        workspaceFolder,
        configFileUri,
        resolvedTreeConfig,
        treeTYEngine,
      };
    } catch (error) {
      return {
        kind: "invalid",
        workspaceFolder,
        configFileUri,
        errorMessage: getErrorMessage(error),
      };
    }
  }

  private async getTargetWorkspaceModel(
    treeEntry?: TreeEntry,
  ): Promise<WorkspaceModel | undefined> {
    if (treeEntry) return treeEntry.workspaceModel;

    if (this.workspaceModels.length === 1) return this.workspaceModels[0];

    const selectedWorkspaceFolder = await vscode.window.showWorkspaceFolderPick({
      placeHolder: "Select the workspace folder for TreeTY",
    });

    if (!selectedWorkspaceFolder) return undefined;

    return this.workspaceModels.find(
      (workspaceModel) =>
        workspaceModel.workspaceFolder.uri.toString() ===
        selectedWorkspaceFolder.uri.toString(),
    );
  }

  private async showConfigFile(configFileUri: vscode.Uri): Promise<void> {
    const configDocument = await vscode.workspace.openTextDocument(configFileUri);

    await vscode.window.showTextDocument(configDocument);
  }
}

export function showCommandError(error: unknown): void {
  void vscode.window.showErrorMessage(`TreeTY: ${getErrorMessage(error)}`);
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
  return `${JSON.stringify(
    {
      version: 1,
      defaults: {
        restartPolicy: "manual",
      },
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
            {
              kind: "terminal",
              id: "development",
              name: "Development server",
              command: {
                executable: "npm",
                args: ["run", "dev"],
              },
            },
          ],
        },
      ],
    },
    null,
    2,
  )}\n`;
}
