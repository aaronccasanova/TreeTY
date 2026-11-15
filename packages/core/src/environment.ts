import { JsonValue, TerminalEnvironment } from "./model";

export interface TreeTYTerminalContext {
  configFilePath: string;
  configSource: string;
  nodeId: string;
  metadata?: JsonValue;
  sessionId: string;
  /** Opaque host-provided URI for this live session, absent when unsupported. */
  sessionUri?: string;
}

export const treeTYConfigFileEnvironmentName = "TREETY_CONFIG_FILE";
export const treeTYConfigSourceEnvironmentName = "TREETY_CONFIG_SOURCE";
export const treeTYNodeIdEnvironmentName = "TREETY_NODE_ID";
export const treeTYNodeMetadataEnvironmentName = "TREETY_NODE_METADATA";
export const treeTYSessionIdEnvironmentName = "TREETY_SESSION_ID";
export const treeTYSessionUriEnvironmentName = "TREETY_SESSION_URI";

export function buildTreeTYTerminalEnvironment(
  treeTYTerminalContext: TreeTYTerminalContext,
): TerminalEnvironment {
  return {
    [treeTYConfigFileEnvironmentName]: treeTYTerminalContext.configFilePath,
    [treeTYConfigSourceEnvironmentName]: treeTYTerminalContext.configSource,
    [treeTYNodeIdEnvironmentName]: treeTYTerminalContext.nodeId,
    [treeTYNodeMetadataEnvironmentName]:
      treeTYTerminalContext.metadata === undefined
        ? null
        : JSON.stringify(treeTYTerminalContext.metadata),
    [treeTYSessionIdEnvironmentName]: treeTYTerminalContext.sessionId,
    [treeTYSessionUriEnvironmentName]: treeTYTerminalContext.sessionUri ?? null,
  };
}
