import * as path from "node:path";

import { formatTreeConfigContent, parseTreeConfigContent } from "./config";
import {
  getFileErrorCode,
  loadDocumentFile,
  mutateDocumentFile,
} from "./file-storage";
import {
  ResolvedTreeNode,
  JsonValue,
  TreeNodeActivity,
  TreeNodeState,
  TreeNodeSessionState,
  TreeConfig,
  TreeNodeConfig,
  TreeState,
} from "./model";
import { getTreeNode } from "./tree-editor";

type UnknownRecord = Record<string, unknown>;

export interface SetTreeNodeActivityOptions {
  action: "register" | "busy" | "idle" | "unregister";
  sessionId: string;
  reporterId: string;
  processId: number;
  metadataPath?: string;
  needsAttention?: boolean;
}

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

    const treeNodeState: TreeNodeState = {};

    if (treeNodeStateRecord.needsAttention !== undefined) {
      if (typeof treeNodeStateRecord.needsAttention !== "boolean") {
        throw new TreeStateError(
          `State node "${nodeId}" property "needsAttention" must be boolean.`,
        );
      }

      if (treeNodeStateRecord.needsAttention) {
        treeNodeState.needsAttention = true;
      }
    }

    if (treeNodeStateRecord.sessions !== undefined) {
      const sessionRecords = getRecord(treeNodeStateRecord.sessions, `State node "${nodeId}" sessions`);
      const sessions: Record<string, TreeNodeSessionState> = {};

      for (const [sessionId, sessionValue] of Object.entries(sessionRecords)) {
        parseActivityIdentifier(sessionId, "Terminal session ID");

        const sessionRecord = getRecord(sessionValue, `Terminal session "${sessionId}"`);
        const session: TreeNodeSessionState = {};

        if (sessionRecord.activity !== undefined) {
          session.activity = parseTreeNodeActivity(sessionRecord.activity);

          if (session.activity.sessionId !== sessionId) {
            throw new TreeStateError(`State node "${nodeId}" activity must match its registered session.`);
          }
        }

        Object.defineProperty(sessions, sessionId, {
          value: session,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }

      if (Object.keys(sessions).length > 0) {
        treeNodeState.sessions = sessions;
      }
    }

    if (Object.keys(treeNodeState).length > 0) {
      Object.defineProperty(nodes, nodeId, {
        value: treeNodeState,
        enumerable: true,
        configurable: true,
        writable: true,
      });
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

export function getAffectedTreeNodeAttentionIds(
  treeNodes: readonly ResolvedTreeNode[],
  previousTreeState: TreeState,
  treeState: TreeState,
): string[] {
  const stateNodeIds = new Set([
    ...Object.keys(previousTreeState.nodes),
    ...Object.keys(treeState.nodes),
  ]);
  const changedAttentionNodeIds = new Set<string>();

  for (const stateNodeId of stateNodeIds) {
    if (
      Boolean(previousTreeState.nodes[stateNodeId]?.needsAttention) ===
      Boolean(treeState.nodes[stateNodeId]?.needsAttention)
    ) {
      continue;
    }

    changedAttentionNodeIds.add(stateNodeId);
  }

  const affectedAttentionNodeIds: string[] = [];

  for (const treeNode of treeNodes) {
    addAffectedTreeNodeAttentionIds(
      treeNode,
      changedAttentionNodeIds,
      affectedAttentionNodeIds,
    );
  }

  return affectedAttentionNodeIds;
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
  expectedSessionId?: string,
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

      const treeNodeState = getTreeNodeState(treeState, nodeId) ?? {};

      if (expectedSessionId !== undefined && !getTreeNodeSessionState(treeNodeState, expectedSessionId)) {
        return treeState;
      }

      if (needsAttention) {
        treeNodeState.needsAttention = true;
      } else {
        delete treeNodeState.needsAttention;
      }

      treeState.nodes = { ...treeState.nodes, [nodeId]: treeNodeState };

      return treeState;
    },
  );
}

export async function registerTreeNodeSession(
  treeConfigFilePath: string,
  nodeId: string,
  sessionId: string,
): Promise<TreeState> {
  parseActivityIdentifier(sessionId, "sessionId");

  return await mutateTreeStateFile(
    treeConfigFilePath,
    () => loadDocumentFile(treeConfigFilePath, parseTreeConfigContent),
    (treeState, treeConfig) => {
      assertTerminalNode(treeConfig, nodeId);

      const treeNodeState = getTreeNodeState(treeState, nodeId) ?? {};

      treeNodeState.sessions = {
        ...treeNodeState.sessions,
        [sessionId]: getTreeNodeSessionState(treeNodeState, sessionId) ?? {},
      };
      treeState.nodes = { ...treeState.nodes, [nodeId]: treeNodeState };

      return treeState;
    },
  );
}

export async function clearTreeNodeSession(
  treeConfigFilePath: string,
  nodeId: string,
  sessionId: string,
): Promise<TreeState> {
  parseActivityIdentifier(sessionId, "sessionId");

  return await mutateTreeStateFile(
    treeConfigFilePath,
    () => loadDocumentFile(treeConfigFilePath, parseTreeConfigContent),
    (treeState) => {
      const treeNodeState = getTreeNodeState(treeState, nodeId);

      if (!treeNodeState?.sessions || !getTreeNodeSessionState(treeNodeState, sessionId)) return treeState;

      delete treeNodeState.sessions[sessionId];

      if (Object.keys(treeNodeState.sessions).length === 0) {
        delete treeNodeState.sessions;
      }

      return treeState;
    },
  );
}

export function getTreeNodeActivity(
  treeNode: TreeNodeConfig | ResolvedTreeNode,
  treeNodeState?: TreeNodeState,
  sessionId?: string,
): TreeNodeActivity | undefined {
  const sessionIds = Object.keys(treeNodeState?.sessions ?? {});
  const selectedSessionId = sessionId ?? (sessionIds.length === 1 ? sessionIds[0] : undefined);

  if (selectedSessionId === undefined) return undefined;

  const treeNodeActivity = getTreeNodeSessionState(treeNodeState, selectedSessionId)?.activity;

  if (treeNode.kind !== "terminal" || !treeNodeActivity) return undefined;
  if (selectedSessionId !== treeNodeActivity.sessionId) return undefined;
  if (!getActivityMetadataMatches(treeNode, treeNodeActivity)) return undefined;

  return treeNodeActivity;
}

export async function setTreeNodeActivity(
  treeConfigFilePath: string,
  nodeId: string,
  options: SetTreeNodeActivityOptions,
): Promise<TreeState> {
  // Keep metadata validation and attention updates ordered with config writes.
  let updatedTreeState: TreeState | undefined;

  await mutateDocumentFile(
    treeConfigFilePath,
    parseTreeConfigContent,
    formatTreeConfigContent,
    async (treeConfig) => {
      updatedTreeState = await mutateTreeStateFile(
        treeConfigFilePath,
        () => treeConfig,
        (treeState) => updateTreeStateActivity(treeState, treeConfig, nodeId, options),
      );

      return treeConfig;
    },
  );

  return updatedTreeState!;
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
        if (
          terminalNodeIds.has(stateNodeId) &&
          Object.keys(updatedTreeState.nodes[stateNodeId]!).length > 0
        ) {
          continue;
        }

        delete updatedTreeState.nodes[stateNodeId];
      }

      return updatedTreeState;
    },
    (treeState) => treeState,
    { createDocument: createEmptyTreeState },
  );
}

function addAffectedTreeNodeAttentionIds(
  treeNode: ResolvedTreeNode,
  changedAttentionNodeIds: ReadonlySet<string>,
  affectedAttentionNodeIds: string[],
): boolean {
  if (treeNode.kind === "terminal") {
    if (!changedAttentionNodeIds.has(treeNode.id)) return false;

    affectedAttentionNodeIds.push(treeNode.id);

    return true;
  }

  let hasAffectedDescendant = false;

  for (const childTreeNode of treeNode.children) {
    if (
      addAffectedTreeNodeAttentionIds(
        childTreeNode,
        changedAttentionNodeIds,
        affectedAttentionNodeIds,
      )
    ) {
      hasAffectedDescendant = true;
    }
  }

  if (hasAffectedDescendant) {
    affectedAttentionNodeIds.push(treeNode.id);
  }

  return hasAffectedDescendant;
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

function updateTreeStateActivity(
  treeState: TreeState,
  treeConfig: TreeConfig,
  nodeId: string,
  options: SetTreeNodeActivityOptions,
): TreeState {
  const treeNodeActivity = parseTreeNodeActivity({
    sessionId: options.sessionId,
    reporterId: options.reporterId,
    processId: options.processId,
    state: options.action === "busy" ? "busy" : "idle",
    metadataPath: options.metadataPath,
  });

  if (!["register", "busy", "idle", "unregister"].includes(options.action)) {
    throw new TreeStateError("Activity action must be register, busy, idle, or unregister.");
  }

  if (options.needsAttention !== undefined) {
    if (typeof options.needsAttention !== "boolean") {
      throw new TreeStateError("Activity needsAttention must be boolean.");
    }

    if (options.action !== "register" && options.action !== "idle") {
      throw new TreeStateError("Only register and idle accept an attention change.");
    }
  }

  const treeNode = assertTerminalNode(treeConfig, nodeId);
  const treeNodeState = getTreeNodeState(treeState, nodeId);
  const treeNodeSessionState = getTreeNodeSessionState(treeNodeState, options.sessionId);

  if (!treeNodeState || !treeNodeSessionState) {
    throw new TreeStateError(`Terminal session "${options.sessionId}" is no longer current.`);
  }

  const previousTreeNodeActivity = treeNodeSessionState.activity;

  if (options.action !== "register") {
    if (
      previousTreeNodeActivity?.reporterId !== options.reporterId ||
      previousTreeNodeActivity.processId !== options.processId ||
      previousTreeNodeActivity.sessionId !== options.sessionId
    ) {
      if (options.action === "unregister") return treeState;

      throw new TreeStateError("Activity reporter is no longer registered for this terminal.");
    }

    if (options.action === "unregister") {
      delete treeNodeSessionState.activity;

      return treeState;
    }

    if (
      options.metadataPath !== undefined &&
      options.metadataPath !== previousTreeNodeActivity.metadataPath
    ) {
      throw new TreeStateError("Activity metadata guard cannot change after registration.");
    }

    treeNodeActivity.metadataPath = previousTreeNodeActivity.metadataPath;
  }

  if (!getActivityMetadataMatches(treeNode, treeNodeActivity)) {
    throw new TreeStateError("Activity reporter does not match the current node metadata.");
  }

  treeNodeSessionState.activity = treeNodeActivity;

  if (options.action === "busy" || options.needsAttention === false) {
    delete treeNodeState.needsAttention;
  } else if (options.needsAttention === true) {
    treeNodeState.needsAttention = true;
  }

  return treeState;
}

function parseTreeNodeActivity(activityValue: unknown): TreeNodeActivity {
  const activityRecord = getRecord(activityValue, "Activity");
  const sessionId = parseActivityIdentifier(activityRecord.sessionId, "Activity sessionId");
  const reporterId = parseActivityIdentifier(activityRecord.reporterId, "Activity reporterId");

  if (
    typeof activityRecord.processId !== "number" ||
    !Number.isSafeInteger(activityRecord.processId) ||
    activityRecord.processId <= 0
  ) {
    throw new TreeStateError("Activity processId must be a positive integer.");
  }

  if (activityRecord.state !== "busy" && activityRecord.state !== "idle") {
    throw new TreeStateError('Activity state must be "busy" or "idle".');
  }

  const treeNodeActivity: TreeNodeActivity = {
    sessionId,
    reporterId,
    processId: activityRecord.processId,
    state: activityRecord.state,
  };

  if (activityRecord.metadataPath !== undefined) {
    if (typeof activityRecord.metadataPath !== "string") {
      throw new TreeStateError("Activity metadataPath must be a JSON Pointer.");
    }

    parseActivityMetadataPath(activityRecord.metadataPath);
    treeNodeActivity.metadataPath = activityRecord.metadataPath;
  }

  return treeNodeActivity;
}

function parseActivityIdentifier(identifier: unknown, location: string): string {
  if (typeof identifier === "string" && /^[^\s\u0000-\u001f\u007f]+$/.test(identifier)) {
    return identifier;
  }

  throw new TreeStateError(`${location} must be a non-empty identifier without whitespace.`);
}

function parseActivityMetadataPath(metadataPath: string): string[] {
  if (metadataPath === "") return [];

  if (!metadataPath.startsWith("/") || /~(?:[^01]|$)/.test(metadataPath)) {
    throw new TreeStateError("Activity metadataPath must be a valid JSON Pointer.");
  }

  return metadataPath.slice(1).split("/").map((metadataPathSegment) =>
    metadataPathSegment.replace(/~1/g, "/").replace(/~0/g, "~"),
  );
}

function getActivityMetadataMatches(
  treeNode: TreeNodeConfig | ResolvedTreeNode,
  treeNodeActivity: TreeNodeActivity,
): boolean {
  if (treeNodeActivity.metadataPath === undefined) return true;

  let metadataValue = treeNode.metadata;

  for (const metadataPathSegment of parseActivityMetadataPath(treeNodeActivity.metadataPath)) {
    if (
      typeof metadataValue !== "object" ||
      metadataValue === null ||
      !Object.prototype.hasOwnProperty.call(metadataValue, metadataPathSegment)
    ) {
      return false;
    }

    metadataValue = (metadataValue as Record<string, JsonValue>)[metadataPathSegment];
  }

  return metadataValue === treeNodeActivity.reporterId;
}

function assertTerminalNode(treeConfig: TreeConfig, nodeId: string): TreeNodeConfig {
  const treeNode = getTreeNode(treeConfig, nodeId);

  if (!treeNode) {
    throw new TreeStateError(`Tree node "${nodeId}" does not exist.`);
  }

  if (treeNode.kind !== "terminal") {
    throw new TreeStateError("Only terminal nodes can report activity.");
  }

  return treeNode;
}

function getTreeNodeState(treeState: TreeState, nodeId: string): TreeNodeState | undefined {
  return Object.hasOwn(treeState.nodes, nodeId) ? treeState.nodes[nodeId] : undefined;
}

function getTreeNodeSessionState(
  treeNodeState: TreeNodeState | undefined,
  sessionId: string,
): TreeNodeSessionState | undefined {
  if (!treeNodeState?.sessions || !Object.hasOwn(treeNodeState.sessions, sessionId)) {
    return undefined;
  }

  return treeNodeState.sessions[sessionId];
}
