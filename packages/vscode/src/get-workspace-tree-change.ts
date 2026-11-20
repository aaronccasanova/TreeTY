import * as util from "node:util";

import type { ResolvedTreeNode } from "@treety/core";

export interface WorkspaceTreeChange {
  parentIds: (string | undefined)[];
  nodeIds: string[];
}

export function getWorkspaceTreeChange(
  previousTreeNodes: readonly ResolvedTreeNode[],
  treeNodes: readonly ResolvedTreeNode[],
): WorkspaceTreeChange {
  const previousTreeNodeById = getTreeNodeById(previousTreeNodes);
  const treeNodeById = getTreeNodeById(treeNodes);
  const parentIds = new Set<string | undefined>();
  const nodeIds: string[] = [];

  if (!util.isDeepStrictEqual(previousTreeNodes.map(getTreeNodeId), treeNodes.map(getTreeNodeId))) {
    parentIds.add(undefined);
  }

  for (const treeNode of treeNodeById.values()) {
    const previousTreeNode = previousTreeNodeById.get(treeNode.id);

    if (!previousTreeNode) continue;

    if (!util.isDeepStrictEqual(getTreeNodePresentation(previousTreeNode), getTreeNodePresentation(treeNode))) {
      nodeIds.push(treeNode.id);
    }

    if (treeNode.kind !== "group" || previousTreeNode.kind !== "group") continue;

    if (!util.isDeepStrictEqual(previousTreeNode.children.map(getTreeNodeId), treeNode.children.map(getTreeNodeId))) {
      parentIds.add(treeNode.id);
    }
  }

  return { parentIds: [...parentIds], nodeIds };
}

function getTreeNodeById(treeNodes: readonly ResolvedTreeNode[]): Map<string, ResolvedTreeNode> {
  const treeNodeById = new Map<string, ResolvedTreeNode>();

  for (const treeNode of treeNodes) {
    treeNodeById.set(treeNode.id, treeNode);

    if (treeNode.kind !== "group") continue;

    for (const descendantTreeNode of getTreeNodeById(treeNode.children).values()) {
      treeNodeById.set(descendantTreeNode.id, descendantTreeNode);
    }
  }

  return treeNodeById;
}

function getTreeNodeId(treeNode: ResolvedTreeNode): string {
  return treeNode.id;
}

function getTreeNodePresentation(treeNode: ResolvedTreeNode): unknown {
  // Compare the row's resolved settings without including its descendants.
  return { ...treeNode, children: undefined, parentId: undefined };
}
