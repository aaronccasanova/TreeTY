import * as path from "node:path";

import { getTreeNodeNeedsAttention } from "@treety/core";
import type {
  ResolvedTreeNode,
  TerminalSessionState,
  TerminalStatus,
} from "@treety/core";
import * as vscode from "vscode";

import type {
  ConfiguredWorkspaceModel,
  WorkspaceModel,
  WorkspaceModelChange,
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

export class TreeTYTreeProvider
  implements
    vscode.TreeDataProvider<TreeEntry>,
    vscode.FileDecorationProvider
{
  private readonly treeDataChangeEmitter = new vscode.EventEmitter<
    TreeEntry | undefined
  >();

  private readonly workspaceModelChangeSubscription: vscode.Disposable;

  private readonly fileDecorationChangeEmitter = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();

  private readonly nodeTreeEntryByWorkspaceId = new Map<
    string,
    Map<string, NodeTreeEntry>
  >();

  public readonly onDidChangeTreeData = this.treeDataChangeEmitter.event;

  public readonly onDidChangeFileDecorations =
    this.fileDecorationChangeEmitter.event;

  public constructor(private readonly workspaceModelSource: WorkspaceModelSource) {
    this.workspaceModelChangeSubscription =
      workspaceModelSource.onDidChangeWorkspaceModels((workspaceModelChange) =>
        this.handleWorkspaceModelChange(workspaceModelChange),
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
      const workspaceChildren = getWorkspaceChildren(treeEntry.workspaceModel);

      this.storeNodeTreeEntries(workspaceChildren);

      return workspaceChildren;
    }

    if (treeEntry.kind === "message" || treeEntry.treeNode.kind === "terminal") {
      return [];
    }

    const childTreeEntries: NodeTreeEntry[] = treeEntry.treeNode.children.map(
      (treeNode) => ({
        kind: "node",
        workspaceModel: treeEntry.workspaceModel,
        treeNode,
      }),
    );

    this.storeNodeTreeEntries(childTreeEntries);

    return childTreeEntries;
  }

  public provideFileDecoration(
    uri: vscode.Uri,
  ): vscode.FileDecoration | undefined {
    const nodeDecorationTarget = parseNodeDecorationUri(uri);

    if (!nodeDecorationTarget) return undefined;

    const workspaceModel = this.workspaceModelSource
      .getWorkspaceModels()
      .find(
        (candidateWorkspaceModel) =>
          candidateWorkspaceModel.id === nodeDecorationTarget.workspaceId,
      );

    if (!workspaceModel || workspaceModel.kind !== "configured") {
      return undefined;
    }

    const treeNode = getResolvedTreeNode(
      workspaceModel.resolvedTreeConfig.tree,
      nodeDecorationTarget.nodeId,
    );

    if (!treeNode || !getTreeNodeNeedsAttention(treeNode)) return undefined;

    return new vscode.FileDecoration(
      "!",
      "Needs attention",
      new vscode.ThemeColor("notificationsWarningIcon.foreground"),
    );
  }

  public dispose(): void {
    this.workspaceModelChangeSubscription.dispose();
    this.treeDataChangeEmitter.dispose();
    this.fileDecorationChangeEmitter.dispose();
  }

  private handleWorkspaceModelChange(
    workspaceModelChange: WorkspaceModelChange,
  ): void {
    if (workspaceModelChange.kind === "attention") {
      this.fileDecorationChangeEmitter.fire(
        workspaceModelChange.nodeIds.map((nodeId) =>
          getNodeDecorationUri(workspaceModelChange.workspaceId, nodeId),
        ),
      );

      return;
    }

    if (workspaceModelChange.kind === "terminal") {
      for (const nodeId of workspaceModelChange.nodeIds) {
        const nodeTreeEntry = this.nodeTreeEntryByWorkspaceId
          .get(workspaceModelChange.workspaceId)
          ?.get(nodeId);

        if (nodeTreeEntry) this.treeDataChangeEmitter.fire(nodeTreeEntry);
      }

      return;
    }

    if (workspaceModelChange.kind === "workspace") {
      this.nodeTreeEntryByWorkspaceId.clear();
    }

    this.treeDataChangeEmitter.fire(undefined);

    if (workspaceModelChange.kind === "workspace") {
      this.fileDecorationChangeEmitter.fire(undefined);
    }
  }

  private storeNodeTreeEntries(treeEntries: readonly TreeEntry[]): void {
    for (const treeEntry of treeEntries) {
      if (treeEntry.kind !== "node") continue;

      let nodeTreeEntryById = this.nodeTreeEntryByWorkspaceId.get(
        treeEntry.workspaceModel.id,
      );

      if (!nodeTreeEntryById) {
        nodeTreeEntryById = new Map<string, NodeTreeEntry>();

        this.nodeTreeEntryByWorkspaceId.set(
          treeEntry.workspaceModel.id,
          nodeTreeEntryById,
        );
      }

      nodeTreeEntryById.set(treeEntry.treeNode.id, treeEntry);
    }
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
  groupTreeItem.resourceUri = getNodeDecorationUri(
    nodeTreeEntry.workspaceModel.id,
    nodeTreeEntry.treeNode.id,
  );
  groupTreeItem.iconPath = new vscode.ThemeIcon("folder");
  groupTreeItem.contextValue = "treetyGroup";
  groupTreeItem.tooltip = buildNodeTooltip(nodeTreeEntry);

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
  terminalTreeItem.resourceUri = getNodeDecorationUri(
    nodeTreeEntry.workspaceModel.id,
    nodeTreeEntry.treeNode.id,
  );
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
    `Working directory: ${nodeTreeEntry.treeNode.cwd}`,
    `Relative directory: ${terminalDirName}`,
    `Node ID: ${nodeTreeEntry.treeNode.id}`,
  ];

  if (nodeTreeEntry.treeNode.projectDir) {
    tooltipLines.push(
      `Project directory: ${nodeTreeEntry.treeNode.projectDir}`,
    );
  }

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

  if (nodeTreeEntry.treeNode.metadata !== undefined) {
    tooltipLines.push(
      `Metadata: ${JSON.stringify(nodeTreeEntry.treeNode.metadata)}`,
    );
  }

  return tooltipLines.join("\n");
}

function buildNodeTooltip(nodeTreeEntry: NodeTreeEntry): string {
  const tooltipLines = [
    `Working directory: ${nodeTreeEntry.treeNode.cwd}`,
    `Node ID: ${nodeTreeEntry.treeNode.id}`,
  ];

  if (nodeTreeEntry.treeNode.projectDir) {
    tooltipLines.push(
      `Project directory: ${nodeTreeEntry.treeNode.projectDir}`,
    );
  }

  if (nodeTreeEntry.treeNode.metadata !== undefined) {
    tooltipLines.push(
      `Metadata: ${JSON.stringify(nodeTreeEntry.treeNode.metadata)}`,
    );
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

function getNodeDecorationUri(workspaceId: string, nodeId: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: "treety",
    path: `/${encodeURIComponent(workspaceId)}/${encodeURIComponent(nodeId)}`,
  });
}

function parseNodeDecorationUri(
  uri: vscode.Uri,
): { nodeId: string; workspaceId: string } | undefined {
  if (uri.scheme !== "treety") return undefined;

  const uriPathSegments = uri.path.slice(1).split("/");
  const workspaceId = uriPathSegments[0];
  const nodeId = uriPathSegments[1];

  if (!workspaceId || !nodeId) return undefined;

  return {
    workspaceId: decodeURIComponent(workspaceId),
    nodeId: decodeURIComponent(nodeId),
  };
}

function getResolvedTreeNode(
  treeNodes: ResolvedTreeNode[],
  nodeId: string,
): ResolvedTreeNode | undefined {
  for (const treeNode of treeNodes) {
    if (treeNode.id === nodeId) return treeNode;

    if (treeNode.kind !== "group") continue;

    const descendantTreeNode = getResolvedTreeNode(treeNode.children, nodeId);

    if (descendantTreeNode) return descendantTreeNode;
  }

  return undefined;
}
