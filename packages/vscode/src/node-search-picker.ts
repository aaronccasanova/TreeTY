import type * as vscode from "vscode";

import { buildNodeSearchEntries, resolveNodeSearchEntry, searchNodeEntries } from "./node-search";
import type { NodeSearchEntry } from "./node-search";
import type { NodeTreeEntry } from "./tree-provider";
import type { WorkspaceModelSource } from "./workspace-model";

export interface NodeSearchQuickPickItem extends vscode.QuickPickItem {
  nodeSearchEntry: NodeSearchEntry;
}

interface NodeSearchPickerOptions {
  workspaceModelSource: WorkspaceModelSource;
  createQuickPick: () => vscode.QuickPick<NodeSearchQuickPickItem>;
  openNode: (nodeTreeEntry: NodeTreeEntry) => Promise<void>;
  showError: (error: unknown) => void;
}

export class NodeSearchPicker implements vscode.Disposable {
  private quickPick: vscode.QuickPick<NodeSearchQuickPickItem> | undefined;
  private subscriptions: vscode.Disposable[] = [];
  private nodeSearchEntries: NodeSearchEntry[] = [];

  public constructor(private readonly options: NodeSearchPickerOptions) {}

  public show(): void {
    if (this.quickPick) {
      this.quickPick.show();
      return;
    }

    const quickPick = this.options.createQuickPick();

    this.quickPick = quickPick;
    quickPick.title = "Search TreeTY";
    quickPick.placeholder = "Names, groups, folders, tags, or owners (abbreviations and typos supported)";
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    this.subscriptions = [
      quickPick.onDidChangeValue(() => this.updateMatches(false)),
      quickPick.onDidAccept(() => this.acceptSelection()),
      quickPick.onDidHide(() => this.dispose()),
      this.options.workspaceModelSource.onDidChangeWorkspaceModels((workspaceModelChange) => {
        if (workspaceModelChange.kind !== "tree" && workspaceModelChange.kind !== "workspace") return;

        this.refreshEntries();
      }),
    ];

    this.refreshEntries();
    quickPick.show();
  }

  public dispose(): void {
    const quickPick = this.quickPick;

    this.quickPick = undefined;
    this.nodeSearchEntries = [];

    for (const subscription of this.subscriptions) subscription.dispose();

    this.subscriptions = [];
    quickPick?.dispose();
  }

  private refreshEntries(): void {
    this.nodeSearchEntries = buildNodeSearchEntries(this.options.workspaceModelSource.getWorkspaceModels());
    this.updateMatches(true);
  }

  private updateMatches(preserveActiveItem: boolean): void {
    const quickPick = this.quickPick;

    if (!quickPick) return;

    const activeKey = preserveActiveItem ? quickPick.activeItems[0]?.nodeSearchEntry.key : undefined;
    const matches = searchNodeEntries(this.nodeSearchEntries, quickPick.value);
    const quickPickItems = matches.map((nodeSearchEntry): NodeSearchQuickPickItem => ({
      label: `$(${nodeSearchEntry.kind === "group" ? "folder" : "terminal"}) ${nodeSearchEntry.name}`,
      description: nodeSearchEntry.description,
      detail: nodeSearchEntry.detail,
      // Keep typo-only matches visible when VS Code applies its own text filter.
      alwaysShow: true,
      nodeSearchEntry,
    }));
    const activeItem = quickPickItems.find((quickPickItem) => quickPickItem.nodeSearchEntry.key === activeKey) ?? quickPickItems[0];

    quickPick.items = quickPickItems;
    quickPick.activeItems = activeItem ? [activeItem] : [];
    quickPick.title = `Search TreeTY (${matches.length} of ${this.nodeSearchEntries.length})`;

    if (this.nodeSearchEntries.length === 0) {
      quickPick.placeholder = "No configured groups or terminals. Initialize a TreeTY tree to get started.";
      return;
    }

    quickPick.placeholder = "Names, groups, folders, tags, or owners (abbreviations and typos supported)";
  }

  private acceptSelection(): void {
    const quickPickItem = this.quickPick?.selectedItems[0] ?? this.quickPick?.activeItems[0];

    if (!quickPickItem || !this.quickPick?.items.some(
      (currentQuickPickItem) => currentQuickPickItem.nodeSearchEntry.key === quickPickItem.nodeSearchEntry.key,
    )) return;

    const nodeTreeEntry = resolveNodeSearchEntry(
      this.options.workspaceModelSource.getWorkspaceModels(),
      quickPickItem.nodeSearchEntry,
    );

    if (!nodeTreeEntry) {
      this.refreshEntries();

      if (this.quickPick) this.quickPick.title = "That node is no longer available. Choose another result.";

      return;
    }

    this.dispose();
    void this.options.openNode(nodeTreeEntry).catch(this.options.showError);
  }
}
