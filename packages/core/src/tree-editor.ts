import * as crypto from "node:crypto";

import {
  JsonValue,
  RestartPolicy,
  TerminalCommandConfig,
  TerminalEnvironment,
  TerminalShellConfig,
  TreeConfig,
  TreeGroupConfig,
  TreeNodeConfig,
  TreeNodeDefaults,
  TreeTerminalConfig,
} from "./model";

export interface AddTreeGroupOptions extends TreeNodeDefaults {
  id?: string;
  metadata?: JsonValue;
  name: string;
  parentId?: string;
}

export interface AddTreeTerminalOptions extends TreeNodeDefaults {
  id?: string;
  metadata?: JsonValue;
  name: string;
  parentId?: string;
  command?: TerminalCommandConfig;
}

export interface MoveTreeNodeOptions {
  afterId?: string;
  beforeId?: string;
  nodeId: string;
  parentId?: string;
}

export interface UpdateTreeNodeOptions {
  command?: TerminalCommandConfig | null;
  cwd?: string | null;
  env?: TerminalEnvironmentUpdate;
  metadata?: JsonValue;
  metadataAction?: "replace" | "remove";
  nodeId: string;
  projectDir?: string | null;
  restartPolicy?: RestartPolicy | null;
  shell?: TerminalShellConfig | null;
}

export interface TerminalEnvironmentUpdate {
  delete?: string[];
  set?: TerminalEnvironment;
}

export class TreeNodeOperationError extends Error {
  public constructor(message: string) {
    super(message);

    this.name = "TreeNodeOperationError";
  }
}

export function createEmptyTreeConfig(): TreeConfig {
  return {
    version: 1,
    defaults: {
      restartPolicy: "manual",
    },
    tree: [],
  };
}

export function addTreeGroup(
  treeConfig: TreeConfig,
  options: AddTreeGroupOptions,
): TreeConfig {
  const treeGroupConfig: TreeGroupConfig = {
    kind: "group",
    id: options.id ?? createTreeNodeId(treeConfig, options.name),
    name: options.name,
    ...getTreeNodeDefaults(options),
    children: [],
  };

  if (options.metadata !== undefined) {
    treeGroupConfig.metadata = options.metadata;
  }

  return addTreeNode(treeConfig, treeGroupConfig, options.parentId);
}

export function addTreeTerminal(
  treeConfig: TreeConfig,
  options: AddTreeTerminalOptions,
): TreeConfig {
  const treeTerminalConfig: TreeTerminalConfig = {
    kind: "terminal",
    id: options.id ?? createTreeNodeId(treeConfig, options.name),
    name: options.name,
    ...getTreeNodeDefaults(options),
  };

  if (options.metadata !== undefined) {
    treeTerminalConfig.metadata = options.metadata;
  }

  if (options.command) {
    treeTerminalConfig.command = options.command;
  }

  return addTreeNode(treeConfig, treeTerminalConfig, options.parentId);
}

export function renameTreeNode(
  treeConfig: TreeConfig,
  nodeId: string,
  name: string,
): TreeConfig {
  assertTreeNodeExists(treeConfig, nodeId);

  return {
    ...treeConfig,
    tree: updateTreeNodes(treeConfig.tree, nodeId, (treeNodeConfig) => ({
      ...treeNodeConfig,
      name,
    })),
  };
}

export function updateTreeNode(
  treeConfig: TreeConfig,
  options: UpdateTreeNodeOptions,
): TreeConfig {
  assertTreeNodeExists(treeConfig, options.nodeId);

  return {
    ...treeConfig,
    tree: updateTreeNodes(
      treeConfig.tree,
      options.nodeId,
      (treeNodeConfig) => getUpdatedTreeNode(treeNodeConfig, options),
    ),
  };
}

export function moveTreeNode(
  treeConfig: TreeConfig,
  options: MoveTreeNodeOptions,
): TreeConfig {
  const treeNodeConfig = getTreeNode(treeConfig, options.nodeId);

  if (!treeNodeConfig) {
    throw new TreeNodeOperationError(
      `Tree node "${options.nodeId}" does not exist.`,
    );
  }

  const placementIds = [options.parentId, options.beforeId, options.afterId].filter(
    (placementId) => placementId !== undefined,
  );

  if (placementIds.length > 1) {
    throw new TreeNodeOperationError(
      "Use one tree node placement option at a time.",
    );
  }

  const siblingId = options.beforeId ?? options.afterId;

  if (options.parentId === options.nodeId || siblingId === options.nodeId) {
    throw new TreeNodeOperationError("A tree node cannot contain itself.");
  }

  const siblingLocation = siblingId
    ? getTreeNodeLocation(treeConfig.tree, siblingId)
    : undefined;

  if (siblingId && !siblingLocation) {
    throw new TreeNodeOperationError(
      `Sibling tree node "${siblingId}" does not exist.`,
    );
  }

  const destinationParentId = siblingLocation?.parentId ?? options.parentId;

  if (destinationParentId) {
    const parentTreeNodeConfig = getTreeNode(treeConfig, destinationParentId);

    if (!parentTreeNodeConfig) {
      throw new TreeNodeOperationError(
        `Parent tree node "${destinationParentId}" does not exist.`,
      );
    }

    if (parentTreeNodeConfig.kind !== "group") {
      throw new TreeNodeOperationError(
        `Parent tree node "${destinationParentId}" is not a group.`,
      );
    }

    if (containsTreeNode(treeNodeConfig, destinationParentId)) {
      throw new TreeNodeOperationError(
        `Tree node "${options.nodeId}" cannot move inside its own descendant.`,
      );
    }
  }

  const treeConfigWithoutNode = removeTreeNode(treeConfig, options.nodeId);

  if (!siblingId) {
    return addTreeNode(treeConfigWithoutNode, treeNodeConfig, options.parentId);
  }

  return insertTreeNodeBesideSibling(
    treeConfigWithoutNode,
    treeNodeConfig,
    siblingId,
    options.afterId !== undefined,
  );
}

export function setTreeNodeMetadataPath(
  treeConfig: TreeConfig,
  nodeId: string,
  metadataPath: string,
  metadataValue: JsonValue,
): TreeConfig {
  const metadataPathSegments = parseJsonPointer(metadataPath);

  if (metadataPathSegments.length === 0) {
    return updateTreeNode(treeConfig, {
      nodeId,
      metadata: metadataValue,
      metadataAction: "replace",
    });
  }

  const treeNodeConfig = getTreeNode(treeConfig, nodeId);

  if (!treeNodeConfig) {
    throw new TreeNodeOperationError(`Tree node "${nodeId}" does not exist.`);
  }

  const metadata = getMetadataObject(treeNodeConfig.metadata, metadataPath);
  let metadataParent = metadata;

  for (const metadataPathSegment of metadataPathSegments.slice(0, -1)) {
    const metadataChild = metadataParent[metadataPathSegment];

    if (metadataChild === undefined) {
      const metadataChildObject: { [propertyName: string]: JsonValue } = {};

      metadataParent[metadataPathSegment] = metadataChildObject;
      metadataParent = metadataChildObject;

      continue;
    }

    if (!isJsonObject(metadataChild)) {
      throw new TreeNodeOperationError(
        `Metadata path "${metadataPath}" traverses incompatible value at "${metadataPathSegment}".`,
      );
    }

    metadataParent = metadataChild;
  }

  const metadataPropertyName = metadataPathSegments.at(-1);

  if (metadataPropertyName === undefined) {
    throw new TreeNodeOperationError(`Metadata path "${metadataPath}" is invalid.`);
  }

  metadataParent[metadataPropertyName] = metadataValue;

  return updateTreeNode(treeConfig, {
    nodeId,
    metadata,
    metadataAction: "replace",
  });
}

export function clearTreeNodeMetadataPath(
  treeConfig: TreeConfig,
  nodeId: string,
  metadataPath: string,
): TreeConfig {
  const metadataPathSegments = parseJsonPointer(metadataPath);

  if (metadataPathSegments.length === 0) {
    return updateTreeNode(treeConfig, {
      nodeId,
      metadataAction: "remove",
    });
  }

  const treeNodeConfig = getTreeNode(treeConfig, nodeId);

  if (!treeNodeConfig) {
    throw new TreeNodeOperationError(`Tree node "${nodeId}" does not exist.`);
  }

  if (treeNodeConfig.metadata === undefined) return treeConfig;

  const metadata = getMetadataObject(treeNodeConfig.metadata, metadataPath);
  let metadataParent = metadata;

  for (const metadataPathSegment of metadataPathSegments.slice(0, -1)) {
    const metadataChild = metadataParent[metadataPathSegment];

    if (metadataChild === undefined) return treeConfig;

    if (!isJsonObject(metadataChild)) {
      throw new TreeNodeOperationError(
        `Metadata path "${metadataPath}" traverses incompatible value at "${metadataPathSegment}".`,
      );
    }

    metadataParent = metadataChild;
  }

  const metadataPropertyName = metadataPathSegments.at(-1);

  if (
    metadataPropertyName === undefined ||
    !(metadataPropertyName in metadataParent)
  ) {
    return treeConfig;
  }

  delete metadataParent[metadataPropertyName];

  return updateTreeNode(treeConfig, {
    nodeId,
    metadata,
    metadataAction: "replace",
  });
}

export function removeTreeNode(
  treeConfig: TreeConfig,
  nodeId: string,
): TreeConfig {
  assertTreeNodeExists(treeConfig, nodeId);

  return {
    ...treeConfig,
    tree: removeTreeNodeFromNodes(treeConfig.tree, nodeId),
  };
}

export function getTreeNode(
  treeConfig: TreeConfig,
  nodeId: string,
): TreeNodeConfig | undefined {
  const pendingTreeNodes = [...treeConfig.tree];

  while (pendingTreeNodes.length > 0) {
    const treeNodeConfig = pendingTreeNodes.shift();

    if (!treeNodeConfig) continue;
    if (treeNodeConfig.id === nodeId) return treeNodeConfig;

    if (treeNodeConfig.kind === "group") {
      pendingTreeNodes.unshift(...treeNodeConfig.children);
    }
  }

  return undefined;
}

export function createTreeNodeId(
  treeConfig: TreeConfig,
  _name?: string,
): string {
  let nodeId = crypto.randomUUID();

  while (getTreeNode(treeConfig, nodeId)) {
    nodeId = crypto.randomUUID();
  }

  return nodeId;
}

function addTreeNode(
  treeConfig: TreeConfig,
  treeNodeConfigToAdd: TreeNodeConfig,
  parentId?: string,
): TreeConfig {
  if (getTreeNode(treeConfig, treeNodeConfigToAdd.id)) {
    throw new TreeNodeOperationError(
      `Tree node "${treeNodeConfigToAdd.id}" already exists.`,
    );
  }

  if (!parentId) {
    return {
      ...treeConfig,
      tree: [...treeConfig.tree, treeNodeConfigToAdd],
    };
  }

  const parentTreeNodeConfig = getTreeNode(treeConfig, parentId);

  if (!parentTreeNodeConfig) {
    throw new TreeNodeOperationError(
      `Parent tree node "${parentId}" does not exist.`,
    );
  }

  if (parentTreeNodeConfig.kind !== "group") {
    throw new TreeNodeOperationError(
      `Parent tree node "${parentId}" is not a group.`,
    );
  }

  return {
    ...treeConfig,
    tree: updateTreeNodes(
      treeConfig.tree,
      parentId,
      (treeNodeConfig) => {
        if (treeNodeConfig.kind !== "group") return treeNodeConfig;

        return {
          ...treeNodeConfig,
          children: [...treeNodeConfig.children, treeNodeConfigToAdd],
        };
      },
    ),
  };
}

function updateTreeNodes(
  treeNodeConfigs: TreeNodeConfig[],
  nodeId: string,
  updateTreeNodeConfig: (treeNodeConfig: TreeNodeConfig) => TreeNodeConfig,
): TreeNodeConfig[] {
  return treeNodeConfigs.map((treeNodeConfig) => {
    if (treeNodeConfig.id === nodeId) {
      return updateTreeNodeConfig(treeNodeConfig);
    }

    if (treeNodeConfig.kind !== "group") return treeNodeConfig;

    return {
      ...treeNodeConfig,
      children: updateTreeNodes(
        treeNodeConfig.children,
        nodeId,
        updateTreeNodeConfig,
      ),
    };
  });
}

function removeTreeNodeFromNodes(
  treeNodeConfigs: TreeNodeConfig[],
  nodeId: string,
): TreeNodeConfig[] {
  return treeNodeConfigs
    .filter((treeNodeConfig) => treeNodeConfig.id !== nodeId)
    .map((treeNodeConfig) => {
      if (treeNodeConfig.kind !== "group") return treeNodeConfig;

      return {
        ...treeNodeConfig,
        children: removeTreeNodeFromNodes(treeNodeConfig.children, nodeId),
      };
    });
}

function containsTreeNode(
  treeNodeConfig: TreeNodeConfig,
  nodeId: string,
): boolean {
  if (treeNodeConfig.id === nodeId) return true;
  if (treeNodeConfig.kind !== "group") return false;

  return treeNodeConfig.children.some((childTreeNodeConfig) =>
    containsTreeNode(childTreeNodeConfig, nodeId),
  );
}

function assertTreeNodeExists(treeConfig: TreeConfig, nodeId: string): void {
  if (getTreeNode(treeConfig, nodeId)) return;

  throw new TreeNodeOperationError(`Tree node "${nodeId}" does not exist.`);
}

function getTreeNodeDefaults(options: TreeNodeDefaults): TreeNodeDefaults {
  const treeNodeDefaults: TreeNodeDefaults = {};

  if (options.cwd !== undefined) treeNodeDefaults.cwd = options.cwd;
  if (options.env !== undefined) treeNodeDefaults.env = options.env;
  if (options.projectDir !== undefined) {
    treeNodeDefaults.projectDir = options.projectDir;
  }
  if (options.shell !== undefined) treeNodeDefaults.shell = options.shell;
  if (options.restartPolicy !== undefined) {
    treeNodeDefaults.restartPolicy = options.restartPolicy;
  }

  return treeNodeDefaults;
}

function getUpdatedTreeNode(
  treeNodeConfig: TreeNodeConfig,
  options: UpdateTreeNodeOptions,
): TreeNodeConfig {
  const updatedTreeNodeConfig: TreeNodeConfig = {
    ...treeNodeConfig,
  };

  if (options.command !== undefined) {
    if (treeNodeConfig.kind !== "terminal") {
      throw new TreeNodeOperationError(
        "Only terminal nodes can define a startup command.",
      );
    }

    if (updatedTreeNodeConfig.kind === "terminal") {
      if (options.command === null) {
        delete updatedTreeNodeConfig.command;
      } else {
        updatedTreeNodeConfig.command = options.command;
      }
    }
  }

  updateOptionalProperty(updatedTreeNodeConfig, "cwd", options.cwd);
  updateOptionalProperty(
    updatedTreeNodeConfig,
    "projectDir",
    options.projectDir,
  );
  updateOptionalProperty(
    updatedTreeNodeConfig,
    "restartPolicy",
    options.restartPolicy,
  );
  updateOptionalProperty(updatedTreeNodeConfig, "shell", options.shell);

  if (options.env) {
    const terminalEnvironment = { ...treeNodeConfig.env };

    for (const environmentName of options.env.delete ?? []) {
      delete terminalEnvironment[environmentName];
    }

    Object.assign(terminalEnvironment, options.env.set);

    if (Object.keys(terminalEnvironment).length > 0) {
      updatedTreeNodeConfig.env = terminalEnvironment;
    } else {
      delete updatedTreeNodeConfig.env;
    }
  }

  if (options.metadataAction === "replace") {
    updatedTreeNodeConfig.metadata = options.metadata;
  } else if (options.metadataAction === "remove") {
    delete updatedTreeNodeConfig.metadata;
  }

  return updatedTreeNodeConfig;
}

interface TreeNodeLocation {
  index: number;
  parentId?: string;
}

function getTreeNodeLocation(
  treeNodeConfigs: TreeNodeConfig[],
  nodeId: string,
  parentId?: string,
): TreeNodeLocation | undefined {
  for (const [treeNodeIndex, treeNodeConfig] of treeNodeConfigs.entries()) {
    if (treeNodeConfig.id === nodeId) {
      return {
        index: treeNodeIndex,
        parentId,
      };
    }

    if (treeNodeConfig.kind !== "group") continue;

    const treeNodeLocation = getTreeNodeLocation(
      treeNodeConfig.children,
      nodeId,
      treeNodeConfig.id,
    );

    if (treeNodeLocation) return treeNodeLocation;
  }

  return undefined;
}

function insertTreeNodeBesideSibling(
  treeConfig: TreeConfig,
  treeNodeConfigToAdd: TreeNodeConfig,
  siblingId: string,
  insertAfter: boolean,
): TreeConfig {
  const siblingLocation = getTreeNodeLocation(treeConfig.tree, siblingId);

  if (!siblingLocation) {
    throw new TreeNodeOperationError(
      `Sibling tree node "${siblingId}" does not exist.`,
    );
  }

  const insertionIndex = siblingLocation.index + (insertAfter ? 1 : 0);

  if (!siblingLocation.parentId) {
    const tree = [...treeConfig.tree];

    tree.splice(insertionIndex, 0, treeNodeConfigToAdd);

    return {
      ...treeConfig,
      tree,
    };
  }

  return {
    ...treeConfig,
    tree: updateTreeNodes(
      treeConfig.tree,
      siblingLocation.parentId,
      (treeNodeConfig) => {
        if (treeNodeConfig.kind !== "group") return treeNodeConfig;

        const children = [...treeNodeConfig.children];

        children.splice(insertionIndex, 0, treeNodeConfigToAdd);

        return {
          ...treeNodeConfig,
          children,
        };
      },
    ),
  };
}

function parseJsonPointer(metadataPath: string): string[] {
  if (metadataPath === "") return [];

  if (!metadataPath.startsWith("/")) {
    throw new TreeNodeOperationError(
      `Metadata path "${metadataPath}" must be a JSON Pointer starting with "/".`,
    );
  }

  if (/~(?:[^01]|$)/.test(metadataPath)) {
    throw new TreeNodeOperationError(
      `Metadata path "${metadataPath}" contains an invalid JSON Pointer escape.`,
    );
  }

  return metadataPath
    .slice(1)
    .split("/")
    .map((metadataPathSegment) =>
      metadataPathSegment.replace(/~1/g, "/").replace(/~0/g, "~"),
    );
}

function getMetadataObject(
  metadata: JsonValue | undefined,
  metadataPath: string,
): { [propertyName: string]: JsonValue } {
  if (metadata === undefined) return {};

  if (isJsonObject(metadata)) return structuredClone(metadata);

  throw new TreeNodeOperationError(
    `Metadata path "${metadataPath}" cannot traverse non-object metadata.`,
  );
}

function isJsonObject(
  jsonValue: JsonValue,
): jsonValue is { [propertyName: string]: JsonValue } {
  return typeof jsonValue === "object" && jsonValue !== null && !Array.isArray(jsonValue);
}

function updateOptionalProperty<
  PropertyName extends "cwd" | "projectDir" | "restartPolicy" | "shell",
>(
  treeNodeConfig: TreeNodeConfig,
  propertyName: PropertyName,
  propertyValue: TreeNodeConfig[PropertyName] | null | undefined,
): void {
  if (propertyValue === undefined) return;

  if (propertyValue === null) {
    delete treeNodeConfig[propertyName];

    return;
  }

  treeNodeConfig[propertyName] = propertyValue;
}
