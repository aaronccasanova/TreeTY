import * as assert from "node:assert/strict";
import * as test from "node:test";

import {
  buildTreeTYTerminalEnvironment,
  treeTYConfigFileEnvironmentName,
  treeTYConfigSourceEnvironmentName,
  treeTYNodeIdEnvironmentName,
  treeTYNodeMetadataEnvironmentName,
  treeTYSessionIdEnvironmentName,
} from "./environment";

test.test("builds the standard terminal context environment", () => {
  const terminalEnvironment = buildTreeTYTerminalEnvironment({
    configFilePath: "/workspace/.treety/tree.json",
    configSource: "workspace",
    nodeId: "shell",
    metadata: {
      owner: "platform",
    },
    sessionId: "session-123",
  });

  assert.deepEqual(terminalEnvironment, {
    [treeTYConfigFileEnvironmentName]: "/workspace/.treety/tree.json",
    [treeTYConfigSourceEnvironmentName]: "workspace",
    [treeTYNodeIdEnvironmentName]: "shell",
    [treeTYNodeMetadataEnvironmentName]: '{"owner":"platform"}',
    [treeTYSessionIdEnvironmentName]: "session-123",
  });
});

test.test("removes absent metadata from the hosted environment", () => {
  const terminalEnvironment = buildTreeTYTerminalEnvironment({
    configFilePath: "/workspace/.treety/tree.json",
    configSource: "workspace",
    nodeId: "shell",
    sessionId: "session-123",
  });

  assert.equal(terminalEnvironment[treeTYNodeMetadataEnvironmentName], null);
});
