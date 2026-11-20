import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as nodeTest from "node:test";

import { resolveTreeConfig } from "@treety/core";

import { createAsyncCommandHandler } from "./async-command";
import { parseNodeCommandTarget, resolveCommandNodeEntry } from "./node-command-target";
import type { ConfiguredWorkspaceModel } from "./workspace-model";

nodeTest.test("command targets resolve exact IDs and refuse ambiguous or missing identities", () => {
  const firstWorkspaceModel = createWorkspaceModel("first");
  const secondWorkspaceModel = createWorkspaceModel("second");
  const workspaceModels = [firstWorkspaceModel, secondWorkspaceModel];

  assert.throws(() => resolveCommandNodeEntry(workspaceModels, "shell"), /ambiguous/);
  assert.throws(() => resolveCommandNodeEntry(workspaceModels, "missing"), /not found/);
  assert.throws(() => resolveCommandNodeEntry(workspaceModels, undefined), /nonempty/);
  assert.throws(() => resolveCommandNodeEntry(workspaceModels, ""), /nonempty/);
  assert.throws(() => resolveCommandNodeEntry(workspaceModels, { nodeId: " " }), /nonempty/);
  assert.throws(() => resolveCommandNodeEntry(workspaceModels, { nodeId: "shell", configFile: "" }), /absolute/);
  assert.throws(() => resolveCommandNodeEntry(workspaceModels, { nodeId: "shell", configFile: "tree.json" }), /absolute/);
  assert.throws(() => parseNodeCommandTarget({ nodeId: "shell", confirm: "false" }), /boolean/);
  assert.equal(resolveCommandNodeEntry(workspaceModels, {
    nodeId: "shell", configFile: firstWorkspaceModel.configFileUri.fsPath,
  }).workspaceModel, firstWorkspaceModel);
  assert.equal(resolveCommandNodeEntry([firstWorkspaceModel], "shell").treeNode.id, "shell");
  assert.equal(parseNodeCommandTarget({ nodeId: "shell", confirm: false }).confirm, false);
});

nodeTest.test("tree entry targets resolve the current model and reject removed nodes", () => {
  const previousWorkspaceModel = createWorkspaceModel("first");
  const workspaceModel = createWorkspaceModel("first");
  const nodeTreeEntry = resolveCommandNodeEntry([previousWorkspaceModel], "shell");

  assert.equal(resolveCommandNodeEntry([workspaceModel], nodeTreeEntry).workspaceModel, workspaceModel);
  workspaceModel.resolvedTreeConfig.tree = [];
  assert.throws(() => resolveCommandNodeEntry([workspaceModel], nodeTreeEntry), /no longer available/);
});

nodeTest.test("registered async handlers wait, return cancellation, and reject failures after reporting", async () => {
  let finishCommand: ((value: boolean) => void) | undefined;
  let completed = false;
  const errors: unknown[] = [];
  const commandHandler = createAsyncCommandHandler(() => new Promise<boolean>((resolve) => {
    finishCommand = resolve;
  }), (error) => errors.push(error));
  const completion = commandHandler().then((value) => {
    completed = true;

    return value;
  });

  await Promise.resolve();
  assert.equal(completed, false);
  finishCommand!(false);
  assert.equal(await completion, false);

  const failure = new Error("launch failed");
  const failedCommandHandler = createAsyncCommandHandler(async () => { throw failure; }, (error) => errors.push(error));

  await assert.rejects(failedCommandHandler(), (error) => error === failure);
  assert.deepEqual(errors, [failure]);
});

function createWorkspaceModel(id: string): ConfiguredWorkspaceModel {
  const workspaceDirPath = path.resolve("fixtures", id);

  return {
    kind: "configured",
    id,
    configFileUri: { fsPath: path.join(workspaceDirPath, "tree.json") },
    resolvedTreeConfig: resolveTreeConfig({
      version: 1,
      tree: [{ kind: "terminal", id: "shell", name: "Shell" }],
    }, workspaceDirPath),
  } as ConfiguredWorkspaceModel;
}
