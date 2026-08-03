import {
  ResolvedTreeConfig,
  TerminalSessionState,
  TreeConfig,
  TreeTYEngine,
} from "@treety/core";
import * as vscode from "vscode";

export type TreeConfigSource = "global" | "workspace";

interface WorkspaceModelBase {
  id: string;
  name: string;
  workspaceDirUri: vscode.Uri;
  workspaceFolder?: vscode.WorkspaceFolder;
  configFileUri: vscode.Uri;
  configSource: TreeConfigSource;
}

export interface ConfiguredWorkspaceModel extends WorkspaceModelBase {
  kind: "configured";
  treeConfig: TreeConfig;
  resolvedTreeConfig: ResolvedTreeConfig;
  treeTYEngine: TreeTYEngine;
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

export interface WorkspaceModelSource {
  readonly onDidChangeWorkspaceModels: vscode.Event<void>;
  getWorkspaceModels(): readonly WorkspaceModel[];
  getTerminalSessionState(
    workspaceModel: ConfiguredWorkspaceModel,
    nodeId: string,
  ): TerminalSessionState;
}
