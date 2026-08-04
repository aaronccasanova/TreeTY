import { JsonValue, TerminalEnvironment } from "./model";

export interface TreeTYTerminalContext {
  configFilePath: string;
  configSource: string;
  nodeId: string;
  metadata?: JsonValue;
  sessionId: string;
}

export const treeTYConfigFileEnvironmentName = "TREETY_CONFIG_FILE";
export const treeTYConfigSourceEnvironmentName = "TREETY_CONFIG_SOURCE";
export const treeTYNodeIdEnvironmentName = "TREETY_NODE_ID";
export const treeTYNodeMetadataEnvironmentName = "TREETY_NODE_METADATA";
export const treeTYSessionIdEnvironmentName = "TREETY_SESSION_ID";

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
  };
}
