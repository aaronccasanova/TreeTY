import type * as vscode from "vscode";

import type { TreeEntry, WorkspaceTreeEntry } from "./tree-provider";

interface TreeCollapseControllerOptions {
  treeView: Pick<vscode.TreeView<TreeEntry>, "onDidCollapseElement" | "reveal">;
  collapseAll: () => PromiseLike<unknown>;
  onDidCollapseAll?: () => PromiseLike<unknown>;
}

export class TreeCollapseController {
  private pendingCollapse: Promise<void> = Promise.resolve();

  public constructor(private readonly options: TreeCollapseControllerOptions) {}

  public collapseAll(): Promise<void> {
    const pendingCollapse = this.pendingCollapse.then(() => this.collapseTree());

    // A failed command must not prevent the next click from trying again.
    this.pendingCollapse = pendingCollapse.catch(() => {});

    return pendingCollapse;
  }

  private async collapseTree(): Promise<void> {
    const collapsedRoots = new Map<string, WorkspaceTreeEntry>();
    const collapsedGroupWorkspaceIds = new Set<string>();
    const collapseSubscription = this.options.treeView.onDidCollapseElement(({ element }) => {
      if (element.kind === "workspace") {
        collapsedRoots.set(element.workspaceModel.id, element);
        return;
      }

      if (
        element.kind === "node" &&
        element.treeNode.kind === "group" &&
        element.treeNode.parentId === undefined
      ) {
        collapsedGroupWorkspaceIds.add(element.workspaceModel.id);
      }
    });

    try {
      // Native collapse events reflect the current UI, including restored state.
      // They arrive before the command completes and determine the progressive step.
      await this.options.collapseAll();
    } finally {
      collapseSubscription.dispose();
    }

    await this.options.onDidCollapseAll?.();

    const hadExpandedRootGroup = [...collapsedRoots.keys()].some((workspaceId) =>
      collapsedGroupWorkspaceIds.has(workspaceId),
    );

    if (!hadExpandedRootGroup) return;

    for (const workspaceTreeEntry of collapsedRoots.values()) {
      await this.options.treeView.reveal(workspaceTreeEntry, {
        expand: true,
        select: false,
        focus: false,
      });
    }
  }
}
