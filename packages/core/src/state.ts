import * as path from "node:path";

import { parseTreeConfigContent } from "./config";
import {
  getFileErrorCode,
  loadDocumentFile,
  mutateDocumentFile,
} from "./file-storage";
import {
  ResolvedTreeNode,
  TreeConfig,
  TreeNodeConfig,
  TreeState,
} from "./model";
import { getTreeNode } from "./tree-editor";

type UnknownRecord = Record<string, unknown>;

export class TreeStateError extends Error {
  public constructor(message: string) {
    super(message);

    this.name = "TreeStateError";
  }
}

export function createEmptyTreeState(): TreeState {
  return {
    version: 1,
    nodes: {},
  };
}

export function getTreeStateFilePath(treeConfigFilePath: string): string {
  const treeConfigFileBaseName = path.basename(treeConfigFilePath);

  if (treeConfigFileBaseName === "tree.json") {
    return path.join(path.dirname(treeConfigFilePath), "state.json");
  }

  const treeConfigName = treeConfigFileBaseName.endsWith(".json")
    ? treeConfigFileBaseName.slice(0, -".json".length)
    : treeConfigFileBaseName;

  return path.join(
    path.dirname(treeConfigFilePath),
    `${treeConfigName}.state.json`,
  );
}

export function parseTreeStateContent(treeStateFileContent: string): TreeState {
  let treeStateValue: unknown;

  try {
    treeStateValue = JSON.parse(treeStateFileContent);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    throw new TreeStateError(`TreeTY state is not valid JSON: ${errorMessage}`);
  }

  const treeStateRecord = getRecord(treeStateValue, "state");

  if (treeStateRecord.version !== 1) {
    throw new TreeStateError('Property "version" must be 1.');
  }

  const treeStateNodesRecord = getRecord(
    treeStateRecord.nodes,
    'Property "nodes"',
  );
  const nodes: TreeState["nodes"] = {};

  for (const [nodeId, treeNodeStateValue] of Object.entries(
    treeStateNodesRecord,
  )) {
    const treeNodeStateRecord = getRecord(
      treeNodeStateValue,
      `State node "${nodeId}"`,
    );

    if (typeof treeNodeStateRecord.needsAttention !== "boolean") {
      throw new TreeStateError(
        `State node "${nodeId}" property "needsAttention" must be boolean.`,
      );
    }

    if (treeNodeStateRecord.needsAttention) {
      nodes[nodeId] = { needsAttention: true };
    }
  }

  return {
    version: 1,
    nodes,
  };
}

export function formatTreeStateContent(treeState: TreeState): string {
  const validatedTreeState = parseTreeStateContent(JSON.stringify(treeState));

  return `${JSON.stringify(validatedTreeState, null, 2)}\n`;
}

export function getTreeNodeNeedsAttention(
  treeNode: ResolvedTreeNode,
): boolean {
  if (treeNode.kind === "terminal") return treeNode.needsAttention;

  return treeNode.children.some((childTreeNode) =>
    getTreeNodeNeedsAttention(childTreeNode),
  );
}

export async function loadTreeStateFile(
  treeConfigFilePath: string,
): Promise<TreeState> {
  try {
    return await loadDocumentFile(
      getTreeStateFilePath(treeConfigFilePath),
      parseTreeStateContent,
    );
  } catch (error) {
    if (getFileErrorCode(error) === "ENOENT") return createEmptyTreeState();

    throw error;
  }
}

export async function setTreeNodeAttention(
  treeConfigFilePath: string,
  nodeId: string,
  needsAttention: boolean,
): Promise<TreeState> {
  return await mutateTreeStateFile(
    treeConfigFilePath,
    () => loadDocumentFile(treeConfigFilePath, parseTreeConfigContent),
    (treeState, treeConfig) => {
      const treeNodeConfig = getTreeNode(treeConfig, nodeId);

      if (!treeNodeConfig) {
        throw new TreeStateError(`Tree node "${nodeId}" does not exist.`);
      }

      if (treeNodeConfig.kind !== "terminal") {
        throw new TreeStateError("Only terminal nodes can need attention.");
      }

      if (needsAttention) {
        treeState.nodes[nodeId] = { needsAttention: true };
      } else {
        delete treeState.nodes[nodeId];
      }

      return treeState;
    },
  );
}

export async function pruneTreeStateFile(
  treeConfigFilePath: string,
  treeConfig: TreeConfig,
): Promise<TreeState> {
  return await mutateTreeStateFile(
    treeConfigFilePath,
    () => treeConfig,
    (treeState) => treeState,
  );
}

async function mutateTreeStateFile(
  treeConfigFilePath: string,
  getTreeConfig: () => TreeConfig | Promise<TreeConfig>,
  mutateTreeState: (
    treeState: TreeState,
    treeConfig: TreeConfig,
  ) => TreeState,
): Promise<TreeState> {
  return await mutateDocumentFile(
    getTreeStateFilePath(treeConfigFilePath),
    parseTreeStateContent,
    formatTreeStateContent,
    async (treeState) => {
      const treeConfig = await getTreeConfig();
      const updatedTreeState = mutateTreeState(treeState, treeConfig);
      const terminalNodeIds = getTerminalNodeIds(treeConfig.tree);

      for (const stateNodeId of Object.keys(updatedTreeState.nodes)) {
        if (terminalNodeIds.has(stateNodeId)) continue;

        delete updatedTreeState.nodes[stateNodeId];
      }

      return updatedTreeState;
    },
    (treeState) => treeState,
    { createDocument: createEmptyTreeState },
  );
}

function getTerminalNodeIds(treeNodeConfigs: TreeNodeConfig[]): Set<string> {
  const terminalNodeIds = new Set<string>();
  const pendingTreeNodeConfigs = [...treeNodeConfigs];

  while (pendingTreeNodeConfigs.length > 0) {
    const treeNodeConfig = pendingTreeNodeConfigs.shift();

    if (!treeNodeConfig) continue;

    if (treeNodeConfig.kind === "group") {
      pendingTreeNodeConfigs.unshift(...treeNodeConfig.children);

      continue;
    }

    terminalNodeIds.add(treeNodeConfig.id);
  }

  return terminalNodeIds;
}

function getRecord(value: unknown, location: string): UnknownRecord {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as UnknownRecord;
  }

  throw new TreeStateError(`${location} must be an object.`);
}
