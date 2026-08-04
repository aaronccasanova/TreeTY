export type RestartPolicy = "manual" | "onOpen";

export type TerminalStatus =
  | "stopped"
  | "starting"
  | "idle"
  | "running"
  | "failed";

export type TerminalEnvironment = Record<string, string | null>;

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [propertyName: string]: JsonValue };

export interface TerminalShellConfig {
  path: string;
  args?: string[];
}

export interface TerminalCommandConfig {
  executable: string;
  args?: string[];
}

export interface TreeNodeDefaults {
  cwd?: string;
  env?: TerminalEnvironment;
  projectDir?: string;
  shell?: TerminalShellConfig;
  restartPolicy?: RestartPolicy;
}

export interface TreeGroupConfig extends TreeNodeDefaults {
  kind: "group";
  id: string;
  name: string;
  metadata?: JsonValue;
  children: TreeNodeConfig[];
}

export interface TreeTerminalConfig extends TreeNodeDefaults {
  kind: "terminal";
  id: string;
  name: string;
  metadata?: JsonValue;
  command?: TerminalCommandConfig;
}

export type TreeNodeConfig = TreeGroupConfig | TreeTerminalConfig;

export interface TreeConfig {
  version: 1;
  defaults?: TreeNodeDefaults;
  tree: TreeNodeConfig[];
}

export interface ResolvedTreeNodeBase {
  id: string;
  name: string;
  cwd: string;
  env: TerminalEnvironment;
  projectDir?: string;
  shell?: TerminalShellConfig;
  restartPolicy: RestartPolicy;
  metadata?: JsonValue;
  parentId?: string;
}

export interface ResolvedTreeGroup extends ResolvedTreeNodeBase {
  kind: "group";
  children: ResolvedTreeNode[];
}

export interface ResolvedTreeTerminal extends ResolvedTreeNodeBase {
  kind: "terminal";
  command?: TerminalCommandConfig;
}

export type ResolvedTreeNode = ResolvedTreeGroup | ResolvedTreeTerminal;

export interface ResolvedTreeConfig {
  version: 1;
  workspaceDirPath: string;
  tree: ResolvedTreeNode[];
}

export interface TerminalSessionState {
  nodeId: string;
  status: TerminalStatus;
  hostSessionId?: string;
  exitCode?: number;
}

export interface Disposable {
  dispose(): void;
}
