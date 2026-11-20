import * as path from "node:path";

import { resolveNodeSearchEntry } from "./node-search";
import type { NodeCommandTarget } from "./public-api";
import type { NodeTreeEntry } from "./tree-provider";
import type { WorkspaceModel } from "./workspace-model";

export function resolveCommandNodeEntry(
  workspaceModels: readonly WorkspaceModel[],
  argument: unknown,
): NodeTreeEntry {
  if (isNodeTreeEntry(argument)) {
    const nodeTreeEntry = resolveNodeSearchEntry(workspaceModels, {
      workspaceId: argument.workspaceModel.id,
      nodeId: argument.treeNode.id,
    });

    if (!nodeTreeEntry) throw new Error("The selected node is no longer available.");

    return nodeTreeEntry;
  }

  const nodeCommandTarget = parseNodeCommandTarget(argument);
  const nodeTreeEntries: NodeTreeEntry[] = [];

  for (const workspaceModel of workspaceModels) {
    if (workspaceModel.kind !== "configured") continue;
    if (nodeCommandTarget.configFile !== undefined &&
      path.normalize(workspaceModel.configFileUri.fsPath) !== path.normalize(nodeCommandTarget.configFile)) continue;

    const nodeTreeEntry = resolveNodeSearchEntry(workspaceModels, {
      workspaceId: workspaceModel.id,
      nodeId: nodeCommandTarget.nodeId,
    });

    if (nodeTreeEntry) nodeTreeEntries.push(nodeTreeEntry);
  }

  if (nodeTreeEntries.length > 1) {
    throw new Error(`Node "${nodeCommandTarget.nodeId}" is ambiguous. Supply its absolute configFile path.`);
  }

  const nodeTreeEntry = nodeTreeEntries[0];

  if (!nodeTreeEntry) throw new Error(`Node "${nodeCommandTarget.nodeId}" was not found in this window.`);

  return nodeTreeEntry;
}

export function parseNodeCommandTarget(argument: unknown): NodeCommandTarget {
  const nodeCommandTarget = typeof argument === "string" ? { nodeId: argument } : argument;

  if (!nodeCommandTarget || typeof nodeCommandTarget !== "object" ||
    !("nodeId" in nodeCommandTarget) || typeof nodeCommandTarget.nodeId !== "string" ||
    nodeCommandTarget.nodeId.trim() === "") {
    throw new Error("Supply a nonempty node ID or { nodeId, configFile } target.");
  }

  if ("configFile" in nodeCommandTarget && (typeof nodeCommandTarget.configFile !== "string" ||
    !path.isAbsolute(nodeCommandTarget.configFile))) {
    throw new Error("configFile must be an absolute configuration file path.");
  }

  if ("confirm" in nodeCommandTarget && typeof nodeCommandTarget.confirm !== "boolean") {
    throw new Error("confirm must be a boolean when supplied.");
  }

  return nodeCommandTarget as NodeCommandTarget;
}

function isNodeTreeEntry(argument: unknown): argument is NodeTreeEntry {
  return Boolean(argument && typeof argument === "object" && "kind" in argument &&
    argument.kind === "node" && "workspaceModel" in argument && "treeNode" in argument);
}
