import type { ResolvedTreeNode } from "@treety/core";

export interface MoveTreeEditorState {
  collapsedGroupIds: Set<string>;
  isRootCollapsed: boolean;
  showAllGroups: boolean;
}

export function collapseMoveTree(
  treeNodes: readonly ResolvedTreeNode[],
  moveTreeEditorState: MoveTreeEditorState,
): MoveTreeEditorState {
  const hasExpandedRootGroup =
    (moveTreeEditorState.showAllGroups || !moveTreeEditorState.isRootCollapsed) &&
    treeNodes.some((treeNode) =>
      treeNode.kind === "group" &&
      (moveTreeEditorState.showAllGroups || !moveTreeEditorState.collapsedGroupIds.has(treeNode.id)),
    );
  const collapsedGroupIds = new Set<string>();
  const pendingTreeNodes = [...treeNodes];

  while (pendingTreeNodes.length > 0) {
    const treeNode = pendingTreeNodes.pop();

    if (treeNode?.kind !== "group") continue;

    collapsedGroupIds.add(treeNode.id);
    pendingTreeNodes.push(...treeNode.children);
  }

  return {
    collapsedGroupIds,
    isRootCollapsed: !hasExpandedRootGroup,
    showAllGroups: false,
  };
}
