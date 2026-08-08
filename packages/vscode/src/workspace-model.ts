import { TreeTYEngine } from "@treety/core";
import type {
  ResolvedTreeConfig,
  TerminalSessionState,
  TreeConfig,
  TreeState,
} from "@treety/core";
import * as vscode from "vscode";

import type { VscodeTerminalHost } from "./vscode-terminal-host";

export type TreeConfigSource = "global" | "workspace";

interface WorkspaceModelBase {
  id: string;
  name: string;
  workspaceDirUri: vscode.Uri;
  workspaceFolder?: vscode.WorkspaceFolder;
  configFileUri: vscode.Uri;
  stateFileUri: vscode.Uri;
  configSource: TreeConfigSource;
}

export interface ConfiguredWorkspaceModel extends WorkspaceModelBase {
  kind: "configured";
  treeConfig: TreeConfig;
  treeState: TreeState;
  resolvedTreeConfig: ResolvedTreeConfig;
  treeTYEngine: TreeTYEngine;
  vscodeTerminalHost: VscodeTerminalHost;
}

export interface UnconfiguredWorkspaceModel extends WorkspaceModelBase {
  kind: "unconfigured";
}

export interface InvalidWorkspaceModel extends WorkspaceModelBase {
  kind: "invalid";
  errorMessage: string;
}

export type WorkspaceModel =
  | ConfiguredWorkspaceModel
  | UnconfiguredWorkspaceModel
  | InvalidWorkspaceModel;

export type WorkspaceModelChange =
  | { kind: "attention"; workspaceId: string; nodeIds: readonly string[] }
  | { kind: "terminal"; workspaceId: string; nodeIds: readonly string[] }
  | { kind: "tree" }
  | { kind: "workspace" };

export interface WorkspaceModelSource {
  readonly onDidChangeWorkspaceModels: vscode.Event<WorkspaceModelChange>;
  getWorkspaceModels(): readonly WorkspaceModel[];
  getTerminalSessionState(
    workspaceModel: ConfiguredWorkspaceModel,
    nodeId: string,
  ): TerminalSessionState;
}
