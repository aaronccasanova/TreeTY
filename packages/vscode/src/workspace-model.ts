import {
  ResolvedTreeConfig,
  TerminalSessionState,
  TreeTYEngine,
} from "@treety/core";
import * as vscode from "vscode";

export interface ConfiguredWorkspaceModel {
  kind: "configured";
  workspaceFolder: vscode.WorkspaceFolder;
  configFileUri: vscode.Uri;
  resolvedTreeConfig: ResolvedTreeConfig;
  treeTYEngine: TreeTYEngine;
}

export interface UnconfiguredWorkspaceModel {
  kind: "unconfigured";
  workspaceFolder: vscode.WorkspaceFolder;
  configFileUri: vscode.Uri;
}

export interface InvalidWorkspaceModel {
  kind: "invalid";
  workspaceFolder: vscode.WorkspaceFolder;
  configFileUri: vscode.Uri;
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
