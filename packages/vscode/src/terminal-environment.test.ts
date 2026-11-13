import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as nodeTest from "node:test";

import type * as vscode from "vscode";

import { configureTerminalEnvironment } from "./terminal-environment";

nodeTest.test("new terminals use the active extension's CLI and disposal clears it", () => {
  const environmentMutations = new Map([
    ["PATH", "stale-extension/bin:"],
    ["TREETY_OLD_VALUE", "stale-value"],
  ]);
  const subscriptions: vscode.Disposable[] = [];
  const environmentVariableCollection = {
    persistent: true,
    description: undefined as string | undefined,
    clear: () => environmentMutations.clear(),
    prepend: (variable: string, value: string) => {
      environmentMutations.set(variable, value);
    },
  };
  const extensionDirPath = path.resolve("extension with spaces");
  const extensionContext = {
    environmentVariableCollection,
    extensionPath: extensionDirPath,
    subscriptions,
  } as unknown as vscode.ExtensionContext;

  configureTerminalEnvironment(extensionContext);

  assert.equal(environmentVariableCollection.persistent, false);
  assert.deepEqual([...environmentMutations], [
    ["PATH", `${path.join(extensionDirPath, "bin")}${path.delimiter}`],
  ]);
  assert.match(
    environmentVariableCollection.description ?? "",
    /Recreate terminals/,
  );
  assert.equal(subscriptions.length, 1);

  subscriptions[0]?.dispose();

  assert.equal(environmentMutations.size, 0);
});
