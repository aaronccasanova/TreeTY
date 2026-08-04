import * as path from "node:path";

import {
  ResolvedTreeNode,
  TerminalSessionState,
  TerminalStatus,
} from "@treety/core";
import * as vscode from "vscode";

import {
  ConfiguredWorkspaceModel,
  WorkspaceModel,
  WorkspaceModelSource,
} from "./workspace-model";

export interface WorkspaceTreeEntry {
  kind: "workspace";
  workspaceModel: WorkspaceModel;
}

export interface NodeTreeEntry {
  kind: "node";
  workspaceModel: ConfiguredWorkspaceModel;
  treeNode: ResolvedTreeNode;
}

interface MessageTreeEntry {
  kind: "message";
  workspaceModel: Exclude<WorkspaceModel, ConfiguredWorkspaceModel>;
}

export type TreeEntry = WorkspaceTreeEntry | NodeTreeEntry | MessageTreeEntry;

export class TreeTYTreeProvider implements vscode.TreeDataProvider<TreeEntry> {
  private readonly treeDataChangeEmitter = new vscode.EventEmitter<
    TreeEntry | undefined
  >();

  private readonly workspaceModelChangeSubscription: vscode.Disposable;

  public readonly onDidChangeTreeData = this.treeDataChangeEmitter.event;

  public constructor(private readonly workspaceModelSource: WorkspaceModelSource) {
    this.workspaceModelChangeSubscription =
      workspaceModelSource.onDidChangeWorkspaceModels(() =>
        this.treeDataChangeEmitter.fire(undefined),
      );
  }

  public getTreeItem(treeEntry: TreeEntry): vscode.TreeItem {
    if (treeEntry.kind === "workspace") {
      return buildWorkspaceTreeItem(treeEntry);
    }

    if (treeEntry.kind === "message") {
      return buildMessageTreeItem(treeEntry);
    }

    if (treeEntry.treeNode.kind === "group") {
      return buildGroupTreeItem(treeEntry);
    }

    const terminalSessionState =
      this.workspaceModelSource.getTerminalSessionState(
        treeEntry.workspaceModel,
        treeEntry.treeNode.id,
      );

    return buildTerminalTreeItem(treeEntry, terminalSessionState);
  }

  public getChildren(treeEntry?: TreeEntry): TreeEntry[] {
    const workspaceModels = this.workspaceModelSource.getWorkspaceModels();

    if (!treeEntry) {
      return workspaceModels.map((workspaceModel) => ({
        kind: "workspace",
        workspaceModel,
      }));
    }

    if (treeEntry.kind === "workspace") {
      return getWorkspaceChildren(treeEntry.workspaceModel);
    }

    if (treeEntry.kind === "message" || treeEntry.treeNode.kind === "terminal") {
      return [];
    }

    return treeEntry.treeNode.children.map((treeNode) => ({
      kind: "node",
      workspaceModel: treeEntry.workspaceModel,
      treeNode,
    }));
  }

  public dispose(): void {
    this.workspaceModelChangeSubscription.dispose();
    this.treeDataChangeEmitter.dispose();
  }
}

function getWorkspaceChildren(workspaceModel: WorkspaceModel): TreeEntry[] {
  if (workspaceModel.kind !== "configured") {
    return [
      {
        kind: "message",
        workspaceModel,
      },
    ];
  }

  return workspaceModel.resolvedTreeConfig.tree.map((treeNode) => ({
    kind: "node",
    workspaceModel,
    treeNode,
  }));
}

function buildWorkspaceTreeItem(
  workspaceTreeEntry: WorkspaceTreeEntry,
): vscode.TreeItem {
  const workspaceTreeItem = new vscode.TreeItem(
    workspaceTreeEntry.workspaceModel.name,
    vscode.TreeItemCollapsibleState.Expanded,
  );

  workspaceTreeItem.id = workspaceTreeEntry.workspaceModel.id;
  workspaceTreeItem.iconPath = new vscode.ThemeIcon(
    workspaceTreeEntry.workspaceModel.configSource === "global"
      ? "globe"
      : "root-folder",
  );
  workspaceTreeItem.description =
    workspaceTreeEntry.workspaceModel.configSource === "global"
      ? "global"
      : "workspace";
  workspaceTreeItem.tooltip =
    workspaceTreeEntry.workspaceModel.configFileUri.fsPath;
  workspaceTreeItem.contextValue = `treetyWorkspace.${workspaceTreeEntry.workspaceModel.kind}.${workspaceTreeEntry.workspaceModel.configSource}`;

  return workspaceTreeItem;
}

function buildMessageTreeItem(messageTreeEntry: MessageTreeEntry): vscode.TreeItem {
  if (messageTreeEntry.workspaceModel.kind === "unconfigured") {
    const isGlobalConfig =
      messageTreeEntry.workspaceModel.configSource === "global";
    const messageTreeItem = new vscode.TreeItem(
      isGlobalConfig ? "Initialize global TreeTY" : "Initialize TreeTY",
    );

    messageTreeItem.iconPath = new vscode.ThemeIcon("add");
    messageTreeItem.description = isGlobalConfig
      ? "Create the global tree"
      : "Create .treety/tree.json";
    messageTreeItem.command = {
      command: isGlobalConfig
        ? "treety.initializeGlobalTree"
        : "treety.initializeWorkspace",
      title: "Initialize TreeTY workspace",
      arguments: [messageTreeEntry],
    };

    return messageTreeItem;
  }

  const messageTreeItem = new vscode.TreeItem("Configuration error");

  messageTreeItem.iconPath = new vscode.ThemeIcon(
    "error",
    new vscode.ThemeColor("problemsErrorIcon.foreground"),
  );
  messageTreeItem.description = messageTreeEntry.workspaceModel.errorMessage;
  messageTreeItem.tooltip = messageTreeEntry.workspaceModel.errorMessage;
  messageTreeItem.command = {
    command: "treety.openConfig",
    title: "Open TreeTY configuration",
    arguments: [messageTreeEntry],
  };

  return messageTreeItem;
}

function buildGroupTreeItem(nodeTreeEntry: NodeTreeEntry): vscode.TreeItem {
  const groupTreeItem = new vscode.TreeItem(
    nodeTreeEntry.treeNode.name,
    vscode.TreeItemCollapsibleState.Expanded,
  );

  groupTreeItem.id = getNodeTreeItemId(nodeTreeEntry);
  groupTreeItem.iconPath = new vscode.ThemeIcon("folder");
  groupTreeItem.contextValue = "treetyGroup";
  groupTreeItem.tooltip = nodeTreeEntry.treeNode.cwd;

  return groupTreeItem;
}

function buildTerminalTreeItem(
  nodeTreeEntry: NodeTreeEntry,
  terminalSessionState: TerminalSessionState,
): vscode.TreeItem {
  const terminalTreeItem = new vscode.TreeItem(
    nodeTreeEntry.treeNode.name,
    vscode.TreeItemCollapsibleState.None,
  );
  const showStatusDescriptions = vscode.workspace
    .getConfiguration("treety")
    .get<boolean>("showStatusDescriptions", true);

  terminalTreeItem.id = getNodeTreeItemId(nodeTreeEntry);
  terminalTreeItem.contextValue = `treetyTerminal.${terminalSessionState.status}`;
  terminalTreeItem.iconPath = getTerminalStatusIcon(terminalSessionState.status);
  terminalTreeItem.description = showStatusDescriptions
    ? terminalSessionState.status
    : undefined;
  terminalTreeItem.tooltip = buildTerminalTooltip(
    nodeTreeEntry,
    terminalSessionState,
  );
  terminalTreeItem.command = {
    command: "treety.openTerminal",
    title: "Open TreeTY terminal",
    arguments: [nodeTreeEntry],
  };

  return terminalTreeItem;
}

function buildTerminalTooltip(
  nodeTreeEntry: NodeTreeEntry,
  terminalSessionState: TerminalSessionState,
): string {
  const workspaceDirPath =
    nodeTreeEntry.workspaceModel.resolvedTreeConfig.workspaceDirPath;
  const terminalDirName =
    path.relative(workspaceDirPath, nodeTreeEntry.treeNode.cwd) || ".";
  const tooltipLines = [
    `Status: ${terminalSessionState.status}`,
    `Directory: ${terminalDirName}`,
  ];

  if (
    nodeTreeEntry.treeNode.kind === "terminal" &&
    nodeTreeEntry.treeNode.command
  ) {
    tooltipLines.push(
      `Command: ${[
        nodeTreeEntry.treeNode.command.executable,
        ...(nodeTreeEntry.treeNode.command.args ?? []),
      ].join(" ")}`,
    );
  }

  if (terminalSessionState.exitCode !== undefined) {
    tooltipLines.push(`Exit code: ${terminalSessionState.exitCode}`);
  }

  return tooltipLines.join("\n");
}

function getTerminalStatusIcon(terminalStatus: TerminalStatus): vscode.ThemeIcon {
  if (terminalStatus === "starting") {
    return new vscode.ThemeIcon("loading~spin");
  }

  if (terminalStatus === "running") {
    return new vscode.ThemeIcon(
      "debug-start",
      new vscode.ThemeColor("testing.iconPassed"),
    );
  }

  if (terminalStatus === "idle") {
    return new vscode.ThemeIcon(
      "terminal",
      new vscode.ThemeColor("charts.green"),
    );
  }

  if (terminalStatus === "failed") {
    return new vscode.ThemeIcon(
      "error",
      new vscode.ThemeColor("problemsErrorIcon.foreground"),
    );
  }

  return new vscode.ThemeIcon("circle-outline");
}

function getNodeTreeItemId(nodeTreeEntry: NodeTreeEntry): string {
  return `${nodeTreeEntry.workspaceModel.id}:${nodeTreeEntry.treeNode.id}`;
}
