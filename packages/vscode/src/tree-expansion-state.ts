import type * as vscode from "vscode";

const expansionStateKey = "treety.expandedTreeItems.v1";

export class TreeExpansionState {
  private expandedTreeItemIds: Set<string> | undefined;

  private pendingUpdate: Promise<void> = Promise.resolve();

  public constructor(private readonly workspaceState?: Pick<vscode.Memento, "get" | "update">) {
    const savedExpandedTreeItemIds = workspaceState?.get<unknown>(expansionStateKey);

    if (Array.isArray(savedExpandedTreeItemIds) && savedExpandedTreeItemIds.every((treeItemId) => typeof treeItemId === "string")) {
      this.expandedTreeItemIds = new Set(savedExpandedTreeItemIds);
    }
  }

  public getExpanded(treeItemId: string): boolean {
    return this.expandedTreeItemIds?.has(treeItemId) ?? true;
  }

  public setExpanded(treeItemId: string, expanded: boolean, getInitialTreeItemIds: () => Iterable<string>): Promise<void> {
    this.expandedTreeItemIds ??= new Set(getInitialTreeItemIds());

    if (expanded) this.expandedTreeItemIds.add(treeItemId);
    else this.expandedTreeItemIds.delete(treeItemId);

    return this.persistExpandedTreeItems();
  }

  public collapseAll(): Promise<void> {
    this.expandedTreeItemIds = new Set();

    return this.persistExpandedTreeItems();
  }

  private persistExpandedTreeItems(): Promise<void> {
    const expandedTreeItemIds = [...this.expandedTreeItemIds ?? []];
    const pendingUpdate = this.pendingUpdate.then(async () => {
      await this.workspaceState?.update(expansionStateKey, expandedTreeItemIds);
    });

    this.pendingUpdate = pendingUpdate.catch(() => {});

    return pendingUpdate;
  }
}
