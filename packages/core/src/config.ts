import * as path from "node:path";

import {
  JsonValue,
  ResolvedTreeConfig,
  ResolvedTreeNode,
  RestartPolicy,
  TerminalCommandConfig,
  TerminalEnvironment,
  TerminalShellConfig,
  TreeConfig,
  TreeNodeConfig,
  TreeNodeDefaults,
  TreeState,
} from "./model";

type UnknownRecord = Record<string, unknown>;

interface ResolvedNodeDefaults {
  cwd: string;
  env: TerminalEnvironment;
  projectDir?: string;
  shell?: TerminalShellConfig;
  restartPolicy: RestartPolicy;
}

export class TreeConfigError extends Error {
  public constructor(message: string) {
    super(message);

    this.name = "TreeConfigError";
  }
}

export function parseTreeConfigContent(treeConfigFileContent: string): TreeConfig {
  let treeConfigValue: unknown;

  try {
    treeConfigValue = JSON.parse(treeConfigFileContent);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    throw new TreeConfigError(`TreeTY configuration is not valid JSON: ${errorMessage}`);
  }

  return parseTreeConfigValue(treeConfigValue);
}

export function formatTreeConfigContent(treeConfig: TreeConfig): string {
  const validatedTreeConfig = parseTreeConfigContent(JSON.stringify(treeConfig));

  return `${JSON.stringify(validatedTreeConfig, null, 2)}\n`;
}

export function resolveTreeConfig(
  treeConfig: TreeConfig,
  workspaceDirPath: string,
  treeState?: TreeState,
): ResolvedTreeConfig {
  const rootDefaults = resolveNodeDefaults(
    {
      cwd: path.resolve(workspaceDirPath),
      env: {},
      restartPolicy: "manual",
    },
    treeConfig.defaults,
  );

  const tree = treeConfig.tree.map((treeNodeConfig) =>
    resolveTreeNode(treeNodeConfig, rootDefaults, treeState),
  );

  return {
    version: 1,
    workspaceDirPath: path.resolve(workspaceDirPath),
    tree,
  };
}

function parseTreeConfigValue(treeConfigValue: unknown): TreeConfig {
  const treeConfigRecord = getRecord(treeConfigValue, "configuration");

  if (treeConfigRecord.version !== 1) {
    throw new TreeConfigError('Property "version" must be 1.');
  }

  const treeConfigNodes = getArray(treeConfigRecord.tree, 'Property "tree"');
  const nodeIds = new Set<string>();
  const tree = treeConfigNodes.map((treeNodeValue, treeNodeIndex) =>
    parseTreeNodeConfig(treeNodeValue, `tree[${treeNodeIndex}]`, nodeIds),
  );

  if (treeConfigRecord.defaults !== undefined) {
    const treeNodeDefaults = parseTreeNodeDefaults(
      treeConfigRecord.defaults,
      "defaults",
    );

    return {
      version: 1,
      defaults: treeNodeDefaults,
      tree,
    };
  }

  return {
    version: 1,
    tree,
  };
}

function parseTreeNodeConfig(
  treeNodeValue: unknown,
  treeNodeLocation: string,
  nodeIds: Set<string>,
): TreeNodeConfig {
  const treeNodeRecord = getRecord(treeNodeValue, treeNodeLocation);
  const treeNodeId = getRequiredString(treeNodeRecord.id, `${treeNodeLocation}.id`);
  const treeNodeName = getRequiredString(
    treeNodeRecord.name,
    `${treeNodeLocation}.name`,
  );

  if (nodeIds.has(treeNodeId)) {
    throw new TreeConfigError(
      `Node ID "${treeNodeId}" is duplicated at ${treeNodeLocation}.`,
    );
  }

  nodeIds.add(treeNodeId);

  const treeNodeDefaults = parseTreeNodeDefaults(treeNodeRecord, treeNodeLocation);
  const treeNodeMetadata =
    treeNodeRecord.metadata === undefined
      ? undefined
      : parseJsonValue(
          treeNodeRecord.metadata,
          `${treeNodeLocation}.metadata`,
        );

  if (treeNodeRecord.kind === "group") {
    const childNodeValues = getArray(
      treeNodeRecord.children,
      `${treeNodeLocation}.children`,
    );
    const children = childNodeValues.map((childNodeValue, childNodeIndex) =>
      parseTreeNodeConfig(
        childNodeValue,
        `${treeNodeLocation}.children[${childNodeIndex}]`,
        nodeIds,
      ),
    );

    return {
      ...treeNodeDefaults,
      kind: "group",
      id: treeNodeId,
      name: treeNodeName,
      metadata: treeNodeMetadata,
      children,
    };
  }

  if (treeNodeRecord.kind !== "terminal") {
    throw new TreeConfigError(
      `${treeNodeLocation}.kind must be "group" or "terminal".`,
    );
  }

  const treeTerminalConfig: TreeNodeConfig = {
    ...treeNodeDefaults,
    kind: "terminal",
    id: treeNodeId,
    name: treeNodeName,
    metadata: treeNodeMetadata,
  };

  if (treeNodeRecord.command !== undefined) {
    treeTerminalConfig.command = parseTerminalCommandConfig(
      treeNodeRecord.command,
      `${treeNodeLocation}.command`,
    );
  }

  return treeTerminalConfig;
}

function parseTreeNodeDefaults(
  treeNodeDefaultsValue: unknown,
  treeNodeDefaultsLocation: string,
): TreeNodeDefaults {
  const treeNodeDefaultsRecord = getRecord(
    treeNodeDefaultsValue,
    treeNodeDefaultsLocation,
  );
  const treeNodeDefaults: TreeNodeDefaults = {};

  if (treeNodeDefaultsRecord.cwd !== undefined) {
    treeNodeDefaults.cwd = getRequiredString(
      treeNodeDefaultsRecord.cwd,
      `${treeNodeDefaultsLocation}.cwd`,
    );
  }

  if (treeNodeDefaultsRecord.env !== undefined) {
    treeNodeDefaults.env = parseTerminalEnvironment(
      treeNodeDefaultsRecord.env,
      `${treeNodeDefaultsLocation}.env`,
    );
  }

  if (treeNodeDefaultsRecord.projectDir !== undefined) {
    treeNodeDefaults.projectDir = getRequiredString(
      treeNodeDefaultsRecord.projectDir,
      `${treeNodeDefaultsLocation}.projectDir`,
    );
  }

  if (treeNodeDefaultsRecord.shell !== undefined) {
    treeNodeDefaults.shell = parseTerminalShellConfig(
      treeNodeDefaultsRecord.shell,
      `${treeNodeDefaultsLocation}.shell`,
    );
  }

  if (treeNodeDefaultsRecord.restartPolicy !== undefined) {
    treeNodeDefaults.restartPolicy = parseRestartPolicy(
      treeNodeDefaultsRecord.restartPolicy,
      `${treeNodeDefaultsLocation}.restartPolicy`,
    );
  }

  return treeNodeDefaults;
}

function parseTerminalEnvironment(
  terminalEnvironmentValue: unknown,
  terminalEnvironmentLocation: string,
): TerminalEnvironment {
  const terminalEnvironmentRecord = getRecord(
    terminalEnvironmentValue,
    terminalEnvironmentLocation,
  );
  const terminalEnvironment: TerminalEnvironment = {};

  for (const [environmentName, environmentValue] of Object.entries(
    terminalEnvironmentRecord,
  )) {
    if (typeof environmentValue === "string" || environmentValue === null) {
      terminalEnvironment[environmentName] = environmentValue;

      continue;
    }

    throw new TreeConfigError(
      `${terminalEnvironmentLocation}.${environmentName} must be a string or null.`,
    );
  }

  return terminalEnvironment;
}

function parseTerminalShellConfig(
  terminalShellValue: unknown,
  terminalShellLocation: string,
): TerminalShellConfig {
  const terminalShellRecord = getRecord(
    terminalShellValue,
    terminalShellLocation,
  );
  const terminalShellConfig: TerminalShellConfig = {
    path: getRequiredString(
      terminalShellRecord.path,
      `${terminalShellLocation}.path`,
    ),
  };

  if (terminalShellRecord.args !== undefined) {
    terminalShellConfig.args = getStringArray(
      terminalShellRecord.args,
      `${terminalShellLocation}.args`,
    );
  }

  return terminalShellConfig;
}

function parseTerminalCommandConfig(
  terminalCommandValue: unknown,
  terminalCommandLocation: string,
): TerminalCommandConfig {
  const terminalCommandRecord = getRecord(
    terminalCommandValue,
    terminalCommandLocation,
  );
  const terminalCommandConfig: TerminalCommandConfig = {
    executable: getRequiredString(
      terminalCommandRecord.executable,
      `${terminalCommandLocation}.executable`,
    ),
  };

  if (terminalCommandRecord.args !== undefined) {
    terminalCommandConfig.args = getStringArray(
      terminalCommandRecord.args,
      `${terminalCommandLocation}.args`,
    );
  }

  return terminalCommandConfig;
}

function parseRestartPolicy(
  restartPolicyValue: unknown,
  restartPolicyLocation: string,
): RestartPolicy {
  if (restartPolicyValue === "manual" || restartPolicyValue === "onOpen") {
    return restartPolicyValue;
  }

  throw new TreeConfigError(
    `${restartPolicyLocation} must be "manual" or "onOpen".`,
  );
}

function resolveTreeNode(
  treeNodeConfig: TreeNodeConfig,
  parentDefaults: ResolvedNodeDefaults,
  treeState?: TreeState,
  parentId?: string,
): ResolvedTreeNode {
  const treeNodeDefaults = resolveNodeDefaults(parentDefaults, treeNodeConfig);
  const resolvedTreeNodeBase = {
    id: treeNodeConfig.id,
    name: treeNodeConfig.name,
    cwd: treeNodeDefaults.cwd,
    env: treeNodeDefaults.env,
    projectDir: treeNodeDefaults.projectDir,
    shell: treeNodeDefaults.shell,
    restartPolicy: treeNodeDefaults.restartPolicy,
    metadata: treeNodeConfig.metadata,
    parentId,
  };

  if (treeNodeConfig.kind === "terminal") {
    return {
      ...resolvedTreeNodeBase,
      kind: "terminal",
      needsAttention:
        treeState?.nodes[treeNodeConfig.id]?.needsAttention ?? false,
      command: treeNodeConfig.command,
    };
  }

  return {
    ...resolvedTreeNodeBase,
    kind: "group",
    children: treeNodeConfig.children.map((childNodeConfig) =>
      resolveTreeNode(
        childNodeConfig,
        treeNodeDefaults,
        treeState,
        treeNodeConfig.id,
      ),
    ),
  };
}

function resolveNodeDefaults(
  parentDefaults: ResolvedNodeDefaults,
  nodeDefaults?: TreeNodeDefaults,
): ResolvedNodeDefaults {
  if (!nodeDefaults) return parentDefaults;

  const cwd = nodeDefaults.cwd
    ? resolveDirPath(parentDefaults.cwd, nodeDefaults.cwd)
    : parentDefaults.cwd;
  const projectDir = nodeDefaults.projectDir
    ? resolveDirPath(cwd, nodeDefaults.projectDir)
    : parentDefaults.projectDir;

  return {
    cwd,
    env: {
      ...parentDefaults.env,
      ...nodeDefaults.env,
    },
    projectDir,
    shell: nodeDefaults.shell ?? parentDefaults.shell,
    restartPolicy: nodeDefaults.restartPolicy ?? parentDefaults.restartPolicy,
  };
}

function parseJsonValue(jsonValue: unknown, jsonValueLocation: string): JsonValue {
  if (
    jsonValue === null ||
    typeof jsonValue === "boolean" ||
    typeof jsonValue === "string"
  ) {
    return jsonValue;
  }

  if (typeof jsonValue === "number" && Number.isFinite(jsonValue)) {
    return jsonValue;
  }

  if (Array.isArray(jsonValue)) {
    return jsonValue.map((arrayValue, arrayValueIndex) =>
      parseJsonValue(arrayValue, `${jsonValueLocation}[${arrayValueIndex}]`),
    );
  }

  if (
    typeof jsonValue === "object" &&
    jsonValue !== null
  ) {
    const jsonObject: { [propertyName: string]: JsonValue } = {};

    for (const [propertyName, propertyValue] of Object.entries(jsonValue)) {
      jsonObject[propertyName] = parseJsonValue(
        propertyValue,
        `${jsonValueLocation}.${propertyName}`,
      );
    }

    return jsonObject;
  }

  throw new TreeConfigError(`${jsonValueLocation} must be valid JSON data.`);
}

function resolveDirPath(parentDirPath: string, childDirName: string): string {
  if (path.isAbsolute(childDirName)) return path.normalize(childDirName);

  return path.resolve(parentDirPath, childDirName);
}

function getRecord(recordValue: unknown, recordLocation: string): UnknownRecord {
  if (
    typeof recordValue === "object" &&
    recordValue !== null &&
    !Array.isArray(recordValue)
  ) {
    return recordValue as UnknownRecord;
  }

  throw new TreeConfigError(`${recordLocation} must be an object.`);
}

function getArray(arrayValue: unknown, arrayLocation: string): unknown[] {
  if (Array.isArray(arrayValue)) return arrayValue;

  throw new TreeConfigError(`${arrayLocation} must be an array.`);
}

function getRequiredString(stringValue: unknown, stringLocation: string): string {
  if (typeof stringValue === "string" && stringValue.trim().length > 0) {
    return stringValue;
  }

  throw new TreeConfigError(`${stringLocation} must be a non-empty string.`);
}

function getStringArray(arrayValue: unknown, arrayLocation: string): string[] {
  const unknownValues = getArray(arrayValue, arrayLocation);

  return unknownValues.map((unknownValue, unknownValueIndex) =>
    getRequiredString(unknownValue, `${arrayLocation}[${unknownValueIndex}]`),
  );
}
