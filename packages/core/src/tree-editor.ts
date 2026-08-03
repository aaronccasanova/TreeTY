import {
  TerminalCommandConfig,
  TreeConfig,
  TreeGroupConfig,
  TreeNodeConfig,
  TreeNodeDefaults,
  TreeTerminalConfig,
} from "./model";

export interface AddTreeGroupOptions extends TreeNodeDefaults {
  id?: string;
  name: string;
  parentId?: string;
}

export interface AddTreeTerminalOptions extends TreeNodeDefaults {
  id?: string;
  name: string;
  parentId?: string;
  command?: TerminalCommandConfig;
}

export interface MoveTreeNodeOptions {
  nodeId: string;
  parentId?: string;
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

  if (options.parentId === options.nodeId) {
    throw new TreeNodeOperationError("A tree node cannot contain itself.");
  }

  if (options.parentId) {
    const parentTreeNodeConfig = getTreeNode(treeConfig, options.parentId);

    if (!parentTreeNodeConfig) {
      throw new TreeNodeOperationError(
        `Parent tree node "${options.parentId}" does not exist.`,
      );
    }

    if (parentTreeNodeConfig.kind !== "group") {
      throw new TreeNodeOperationError(
        `Parent tree node "${options.parentId}" is not a group.`,
      );
    }

    if (containsTreeNode(treeNodeConfig, options.parentId)) {
      throw new TreeNodeOperationError(
        `Tree node "${options.nodeId}" cannot move inside its own descendant.`,
      );
    }
  }

  const treeConfigWithoutNode = removeTreeNode(treeConfig, options.nodeId);

  return addTreeNode(treeConfigWithoutNode, treeNodeConfig, options.parentId);
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
  name: string,
): string {
  const nodeIdBase =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "node";
  let nodeId = nodeIdBase;
  let nodeIdSuffix = 2;

  while (getTreeNode(treeConfig, nodeId)) {
    nodeId = `${nodeIdBase}-${nodeIdSuffix}`;
    nodeIdSuffix += 1;
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
  if (options.shell !== undefined) treeNodeDefaults.shell = options.shell;
  if (options.restartPolicy !== undefined) {
    treeNodeDefaults.restartPolicy = options.restartPolicy;
  }

  return treeNodeDefaults;
}
