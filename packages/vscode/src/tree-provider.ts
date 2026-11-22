import * as path from "node:path";

import { getTreeNodeNeedsAttention } from "@treety/core";
import type {
  ResolvedTreeNode,
  TerminalSessionState,
} from "@treety/core";
import * as vscode from "vscode";

import type { TerminalActivity } from "./terminal-activity";
import { getTerminalPresentation } from "./terminal-presentation";
import { TreeExpansionState } from "./tree-expansion-state";
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

  private readonly workspaceTreeEntryById = new Map<string, WorkspaceTreeEntry>();

  private readonly treeExpansionState: TreeExpansionState;

  private attentionDecorationUris = new Map<string, vscode.Uri>();

  public readonly onDidChangeTreeData = this.treeDataChangeEmitter.event;

  public readonly onDidChangeFileDecorations =
    this.fileDecorationChangeEmitter.event;

  public constructor(
    private readonly workspaceModelSource: WorkspaceModelSource,
    workspaceState?: Pick<vscode.Memento, "get" | "update">,
  ) {
    this.treeExpansionState = new TreeExpansionState(workspaceState);
    this.workspaceModelChangeSubscription =
      workspaceModelSource.onDidChangeWorkspaceModels((workspaceModelChange) =>
        this.handleWorkspaceModelChange(workspaceModelChange),
      );
  }

  public getTreeItem(treeEntry: TreeEntry): vscode.TreeItem {
    if (treeEntry.kind === "workspace") {
      return buildWorkspaceTreeItem(treeEntry, this.treeExpansionState.getExpanded(treeEntry.workspaceModel.id));
    }

    if (treeEntry.kind === "message") {
      return buildMessageTreeItem(treeEntry);
    }

    if (treeEntry.treeNode.kind === "group") {
      return buildGroupTreeItem(treeEntry, this.treeExpansionState.getExpanded(getNodeTreeItemId(treeEntry)));
    }

    const terminalSessionState =
      this.workspaceModelSource.getTerminalSessionState(
        treeEntry.workspaceModel,
        treeEntry.treeNode.id,
      );

    return buildTerminalTreeItem(
      treeEntry, terminalSessionState,
      treeEntry.workspaceModel.vscodeTerminalHost.getSessionActivity(terminalSessionState.hostSessionId),
    );
  }

  public getChildren(treeEntry?: TreeEntry): TreeEntry[] {
    const workspaceModels = this.workspaceModelSource.getWorkspaceModels();

    if (!treeEntry) {
      return workspaceModels.map((workspaceModel) => this.getWorkspaceTreeEntry(workspaceModel));
    }

    if (treeEntry.kind === "workspace") {
      return getWorkspaceChildren(treeEntry.workspaceModel).map((workspaceChild) =>
        workspaceChild.kind === "node" ? this.getNodeTreeEntry(workspaceChild) : workspaceChild,
      );
    }

    if (treeEntry.kind === "message" || treeEntry.treeNode.kind === "terminal") {
      return [];
    }

    return treeEntry.treeNode.children.map((treeNode) => this.getNodeTreeEntry({
      kind: "node",
      workspaceModel: treeEntry.workspaceModel,
      treeNode,
    }));
  }

  public getParent(treeEntry: TreeEntry): TreeEntry | undefined {
    if (treeEntry.kind === "workspace") return undefined;

    const workspaceModel = this.workspaceModelSource.getWorkspaceModels().find(
      (candidateWorkspaceModel) => candidateWorkspaceModel.id === treeEntry.workspaceModel.id,
    );

    if (!workspaceModel) return undefined;

    if (treeEntry.kind === "node" && workspaceModel.kind === "configured") {
      const treeNode = getResolvedTreeNode(workspaceModel.resolvedTreeConfig.tree, treeEntry.treeNode.id);

      if (treeNode?.parentId) {
        const parentTreeNode = getResolvedTreeNode(workspaceModel.resolvedTreeConfig.tree, treeNode.parentId);

        if (parentTreeNode) return this.getNodeTreeEntry({ kind: "node", workspaceModel, treeNode: parentTreeNode });
      }
    }

    return this.getWorkspaceTreeEntry(workspaceModel);
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

  public setExpanded(treeEntry: TreeEntry, expanded: boolean): Promise<void> {
    if (treeEntry.kind === "message") return Promise.resolve();
    if (treeEntry.kind === "node" && treeEntry.treeNode.kind !== "group") return Promise.resolve();

    const treeItemId = treeEntry.kind === "workspace" ? treeEntry.workspaceModel.id : getNodeTreeItemId(treeEntry);

    return this.treeExpansionState.setExpanded(treeItemId, expanded, () => {
      const initialTreeItemIds: string[] = [];

      for (const workspaceModel of this.workspaceModelSource.getWorkspaceModels()) {
        initialTreeItemIds.push(workspaceModel.id);

        if (workspaceModel.kind !== "configured") continue;

        for (const treeNode of getTreeNodes(workspaceModel.resolvedTreeConfig.tree)) {
          if (treeNode.kind === "group") initialTreeItemIds.push(`${workspaceModel.id}:${treeNode.id}`);
        }
      }

      return initialTreeItemIds;
    });
  }

  public collapseAll(): Promise<void> {
    return this.treeExpansionState.collapseAll();
  }

  public dispose(): void {
    this.workspaceModelChangeSubscription.dispose();
    this.treeDataChangeEmitter.dispose();
    this.fileDecorationChangeEmitter.dispose();
  }

  private handleWorkspaceModelChange(
    workspaceModelChange: WorkspaceModelChange,
  ): void {
    if (workspaceModelChange.kind === "configuration" || workspaceModelChange.kind === "attention") {
      this.updateNodeTreeEntries(workspaceModelChange.workspaceId);
    }

    if (workspaceModelChange.kind !== "terminal" && workspaceModelChange.kind !== "tree") {
      this.updateFileDecorations();
    }

    if (workspaceModelChange.kind === "configuration") {
      const workspaceModel = this.workspaceModelSource.getWorkspaceModels().find(
        (candidateWorkspaceModel) => candidateWorkspaceModel.id === workspaceModelChange.workspaceId,
      );

      if (!workspaceModel) return;

      const refreshedEntries = new Set<TreeEntry>();

      for (const parentId of workspaceModelChange.parentIds) {
        const treeEntry = parentId === undefined
          ? this.getWorkspaceTreeEntry(workspaceModel)
          : this.nodeTreeEntryByWorkspaceId.get(workspaceModel.id)?.get(parentId);

        if (treeEntry) refreshedEntries.add(treeEntry);
      }

      for (const nodeId of workspaceModelChange.nodeIds) {
        const treeEntry = this.nodeTreeEntryByWorkspaceId.get(workspaceModel.id)?.get(nodeId);

        if (treeEntry) refreshedEntries.add(treeEntry);
      }

      for (const treeEntry of refreshedEntries) this.treeDataChangeEmitter.fire(treeEntry);

      return;
    }

    if (workspaceModelChange.kind === "attention") {
      for (const nodeId of workspaceModelChange.nodeIds) {
        const nodeTreeEntry = this.nodeTreeEntryByWorkspaceId
          .get(workspaceModelChange.workspaceId)
          ?.get(nodeId);

        if (nodeTreeEntry?.treeNode.kind === "terminal") {
          this.treeDataChangeEmitter.fire(nodeTreeEntry);
        }
      }

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
      this.workspaceTreeEntryById.clear();
    }

    this.treeDataChangeEmitter.fire(undefined);
  }

  private getWorkspaceTreeEntry(workspaceModel: WorkspaceModel): WorkspaceTreeEntry {
    let workspaceTreeEntry = this.workspaceTreeEntryById.get(workspaceModel.id);

    if (!workspaceTreeEntry) {
      workspaceTreeEntry = { kind: "workspace", workspaceModel };
      this.workspaceTreeEntryById.set(workspaceModel.id, workspaceTreeEntry);
    }

    workspaceTreeEntry.workspaceModel = workspaceModel;

    return workspaceTreeEntry;
  }

  private getNodeTreeEntry(nodeTreeEntry: NodeTreeEntry): NodeTreeEntry {
    let nodeTreeEntryById = this.nodeTreeEntryByWorkspaceId.get(nodeTreeEntry.workspaceModel.id);

    if (!nodeTreeEntryById) {
      nodeTreeEntryById = new Map();
      this.nodeTreeEntryByWorkspaceId.set(nodeTreeEntry.workspaceModel.id, nodeTreeEntryById);
    }

    const existingNodeTreeEntry = nodeTreeEntryById.get(nodeTreeEntry.treeNode.id);

    if (existingNodeTreeEntry) {
      existingNodeTreeEntry.treeNode = nodeTreeEntry.treeNode;
      existingNodeTreeEntry.workspaceModel = nodeTreeEntry.workspaceModel;

      return existingNodeTreeEntry;
    }

    nodeTreeEntryById.set(nodeTreeEntry.treeNode.id, nodeTreeEntry);

    return nodeTreeEntry;
  }

  private updateNodeTreeEntries(workspaceId: string): void {
    const workspaceModel = this.workspaceModelSource.getWorkspaceModels().find(
      (candidateWorkspaceModel) => candidateWorkspaceModel.id === workspaceId,
    );
    const nodeTreeEntryById = this.nodeTreeEntryByWorkspaceId.get(workspaceId);

    if (!workspaceModel || workspaceModel.kind !== "configured" || !nodeTreeEntryById) return;

    const treeNodeById = new Map(getTreeNodes(workspaceModel.resolvedTreeConfig.tree).map((treeNode) => [treeNode.id, treeNode]));

    for (const [nodeId, nodeTreeEntry] of nodeTreeEntryById) {
      const treeNode = treeNodeById.get(nodeId);

      if (!treeNode) {
        nodeTreeEntryById.delete(nodeId);
        continue;
      }

      nodeTreeEntry.treeNode = treeNode;
      nodeTreeEntry.workspaceModel = workspaceModel;
    }
  }

  private updateFileDecorations(): void {
    const attentionDecorationUris = new Map<string, vscode.Uri>();

    for (const workspaceModel of this.workspaceModelSource.getWorkspaceModels()) {
      if (workspaceModel.kind !== "configured") continue;

      for (const treeNode of getTreeNodes(workspaceModel.resolvedTreeConfig.tree)) {
        if (!getTreeNodeNeedsAttention(treeNode)) continue;

        const decorationUri = getNodeDecorationUri(workspaceModel.id, treeNode.id);

        attentionDecorationUris.set(decorationUri.toString(), decorationUri);
      }
    }

    const changedDecorationUris = [
      ...[...this.attentionDecorationUris].filter(([uri]) => !attentionDecorationUris.has(uri)),
      ...[...attentionDecorationUris].filter(([uri]) => !this.attentionDecorationUris.has(uri)),
    ].map(([, decorationUri]) => decorationUri);

    this.attentionDecorationUris = attentionDecorationUris;

    if (changedDecorationUris.length > 0) this.fileDecorationChangeEmitter.fire(changedDecorationUris);
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
  expanded: boolean,
): vscode.TreeItem {
  const workspaceTreeItem = new vscode.TreeItem(
    workspaceTreeEntry.workspaceModel.name,
    expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
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

function buildGroupTreeItem(nodeTreeEntry: NodeTreeEntry, expanded: boolean): vscode.TreeItem {
  const groupTreeItem = new vscode.TreeItem(
    nodeTreeEntry.treeNode.name,
    expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
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
  terminalActivity: TerminalActivity,
): vscode.TreeItem {
  const terminalTreeItem = new vscode.TreeItem(
    nodeTreeEntry.treeNode.name,
    vscode.TreeItemCollapsibleState.None,
  );
  const terminalAttentionContext = nodeTreeEntry.workspaceModel.treeState.nodes[
    nodeTreeEntry.treeNode.id
  ]?.needsAttention
    ? "needsAttention"
    : "clearAttention";

  terminalTreeItem.id = getNodeTreeItemId(nodeTreeEntry);
  terminalTreeItem.resourceUri = getNodeDecorationUri(
    nodeTreeEntry.workspaceModel.id,
    nodeTreeEntry.treeNode.id,
  );
  terminalTreeItem.contextValue = `treetyTerminal.${terminalSessionState.status}.${terminalAttentionContext}`;
  const terminalPresentation = getTerminalPresentation({
    status: terminalSessionState.status,
    activity: terminalActivity,
    animationEnabled: (nodeTreeEntry.treeNode.kind === "terminal"
      ? nodeTreeEntry.treeNode.activityAnimation : undefined) ??
      vscode.workspace.getConfiguration("treety").get<string>("activityAnimation", "auto") !== "off",
    terminalAnimationEnabled: vscode.workspace.getConfiguration("terminal.integrated.tabs")
      .get("enableAnimation", true),
    reduceMotion: vscode.workspace.getConfiguration("workbench").get<string>("reduceMotion", "auto") === "on",
  });

  terminalTreeItem.iconPath = new vscode.ThemeIcon(
    terminalPresentation.icon,
    terminalPresentation.color ? new vscode.ThemeColor(terminalPresentation.color) : undefined,
  );
  terminalTreeItem.accessibilityInformation = {
    label: `${nodeTreeEntry.treeNode.name}, status: ${terminalSessionState.status}, activity: ${terminalActivity.state}`,
  };
  terminalTreeItem.tooltip = buildTerminalTooltip(
    nodeTreeEntry,
    terminalSessionState,
    terminalActivity,
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
  terminalActivity: TerminalActivity,
): string {
  const workspaceDirPath =
    nodeTreeEntry.workspaceModel.resolvedTreeConfig.workspaceDirPath;
  const terminalDirName =
    path.relative(workspaceDirPath, nodeTreeEntry.treeNode.cwd) || ".";
  const recoveryMessage = nodeTreeEntry.workspaceModel.vscodeTerminalHost.getSessionRecoveryMessage(
    nodeTreeEntry.treeNode.id,
  );
  const tooltipLines = [
    `Status: ${terminalSessionState.status}`,
    `Activity: ${terminalActivity.state}`,
    `Working directory: ${nodeTreeEntry.treeNode.cwd}`,
    `Relative directory: ${terminalDirName}`,
    `Node ID: ${nodeTreeEntry.treeNode.id}`,
    ...(recoveryMessage ? [recoveryMessage] : []),
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

function getTreeNodes(treeNodes: readonly ResolvedTreeNode[]): ResolvedTreeNode[] {
  return treeNodes.flatMap((treeNode) => [
    treeNode,
    ...(treeNode.kind === "group" ? getTreeNodes(treeNode.children) : []),
  ]);
}
