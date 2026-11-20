import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as test from "node:test";

import {
  getTreeNode,
  getTreeStateFilePath,
  loadTreeConfigFile,
  loadTreeStateFile,
  registerTreeNodeSession,
  treeTYNodeIdEnvironmentName,
  treeTYSessionIdEnvironmentName,
} from "@treety/core";

import { runCli } from "./cli";
import { parseCommandArguments } from "./command-options";

test.test("command help is scoped, supports aliases, and needs no configuration", async (testContext) => {
  const cliFixture = await createCliFixture(testContext);

  for (const commandName of [
    "init", "list", "add", "rename", "show", "configure", "metadata", "activity",
    "attention", "uri", "current", "move", "remove", "config", "version", "ls", "rm",
  ]) {
    assert.equal(await runCli([commandName, "--help"], cliFixture.runCliOptions), 0);

    const commandHelp = cliFixture.messages.at(-1) ?? "";

    assert.match(commandHelp, /^Usage:/);
    assert.equal(await runCli(["help", commandName], cliFixture.runCliOptions), 0);
    assert.equal(cliFixture.messages.at(-1), commandHelp);
  }

  assert.equal(await runCli(["move", "-h"], cliFixture.runCliOptions), 0);
  assert.match(cliFixture.messages.at(-1) ?? "", /--node <node-id>/);
  assert.match(cliFixture.messages.at(-1) ?? "", /--before <sibling-id>/);
  assert.doesNotMatch(cliFixture.messages.at(-1) ?? "", /--shell|--env|treety add/);
  assert.equal(await runCli(["uri", "--help"], cliFixture.runCliOptions), 0);
  assert.doesNotMatch(cliFixture.messages.at(-1) ?? "", /--config|--global|--node/);
  assert.equal(await runCli(["help", "missing"], cliFixture.runCliOptions), 1);
  assert.match(cliFixture.errors.at(-1) ?? "", /Unknown command/);
  assert.equal(await runCli(["--help"], cliFixture.runCliOptions), 0);
  assert.match(cliFixture.messages.at(-1) ?? "", /treety add/);
  assert.match(cliFixture.messages.at(-1) ?? "", /treety remove/);
  await assert.rejects(fs.access(cliFixture.treeConfigFilePath), { code: "ENOENT" });
});

test.test("explicit empty IDs never fall back to terminal context", async (testContext) => {
  const cliFixture = await createCliFixture(testContext);

  assert.equal(await runCli(["init"], cliFixture.runCliOptions), 0);
  assert.equal(await runCli(["add", "terminal", "Shell", "--id", "shell"], cliFixture.runCliOptions), 0);
  assert.equal(await runCli(["attention", "set"], cliFixture.runCliOptions), 0);

  const treeConfigFileContent = await fs.readFile(cliFixture.treeConfigFilePath, "utf8");
  const treeStateFilePath = getTreeStateFilePath(cliFixture.treeConfigFilePath);
  const treeStateFileContent = await fs.readFile(treeStateFilePath, "utf8");

  for (const commandArguments of [
    ["show", ""],
    ["remove", "", "--yes"],
    ["rm", "", "-y"],
    ["rename", "", "Changed"],
    ["move", "", "--root"],
    ["configure", "", "--cwd", "/other"],
    ["metadata", "get", ""],
    ["metadata", "set", "", "{}"],
    ["metadata", "clear", ""],
    ["metadata", "set-path", "", "/owner", '"other"'],
    ["metadata", "clear-path", "", "/owner"],
    ["attention", "clear", ""],
    ["show", "--node", ""],
    ["remove", "--node=", "--yes"],
    ["remove", "shell", "--node=", "--yes"],
    ["show", "shell", "--config="],
    ["add", "terminal", "Empty ID", "--id="],
  ]) {
    const previousMessageCount = cliFixture.messages.length;

    assert.equal(await runCli(commandArguments, cliFixture.runCliOptions), 1, commandArguments.join(" "));
    assert.match(cliFixture.errors.at(-1) ?? "", /empty/);
    assert.equal(cliFixture.messages.length, previousMessageCount);
    assert.equal(await fs.readFile(cliFixture.treeConfigFilePath, "utf8"), treeConfigFileContent);
    assert.equal(await fs.readFile(treeStateFilePath, "utf8"), treeStateFileContent);
  }

  assert.equal(await runCli(["show"], cliFixture.runCliOptions), 0);
  assert.equal(JSON.parse(cliFixture.messages.at(-1) ?? "").id, "shell");
  assert.equal(await runCli(["rename", "Current shell"], cliFixture.runCliOptions), 0);
});

test.test("missing option values fail without consuming flags or changing either config", async (testContext) => {
  const cliFixture = await createCliFixture(testContext);
  const globalConfigFilePath = path.join(cliFixture.temporaryDirPath, ".config", "treety", "tree.json");

  assert.equal(await runCli(["init"], cliFixture.runCliOptions), 0);
  assert.equal(await runCli(["init", "-g"], cliFixture.runCliOptions), 0);
  assert.equal(await runCli(["add", "terminal", "Shell", "--id", "shell"], cliFixture.runCliOptions), 0);

  const treeConfigFileContent = await fs.readFile(cliFixture.treeConfigFilePath, "utf8");
  const globalConfigFileContent = await fs.readFile(globalConfigFilePath, "utf8");

  for (const commandArguments of [
    ["show", "shell", "--config", "--global"],
    ["add", "terminal", "Other", "--id", "--global"],
    ["move", "shell", "--parent", "-g"],
    ["configure", "shell", "--cwd", "-g"],
    ["configure", "shell", "--env", "--json"],
    ["remove", "--node", "--global", "--yes"],
    ["configure", "shell", "--cwd"],
    ["remove", "shell", "--yes=false"],
    ["remove", "shell", "--json"],
  ]) {
    const previousMessageCount = cliFixture.messages.length;

    assert.equal(await runCli(commandArguments, cliFixture.runCliOptions), 1, commandArguments.join(" "));
    assert.equal(cliFixture.messages.length, previousMessageCount);
    assert.equal(await fs.readFile(cliFixture.treeConfigFilePath, "utf8"), treeConfigFileContent);
    assert.equal(await fs.readFile(globalConfigFilePath, "utf8"), globalConfigFileContent);
  }
});

test.test("explicit dash values, repeated options, and startup arguments retain their identity", async (testContext) => {
  const cliFixture = await createCliFixture(testContext);
  const startupArguments = ["--help", "--global", "--", "$literal"];
  const parsedCommandArguments = parseCommandArguments([
    "add", "terminal", "Shell", "--", "example-tool", "", ...startupArguments,
  ]);

  assert.deepEqual(parsedCommandArguments.terminalCommandArguments, ["example-tool", "", ...startupArguments]);

  assert.equal(await runCli(["init"], cliFixture.runCliOptions), 0);
  assert.equal(await runCli([
    "add", "terminal", "Shell", "--id=-shell", "--shell", "/bin/sh",
    "--shell-arg=-l", "--shell-arg=--login", "--env", "FIRST=one", "--env=SECOND=-g",
    "--unset-env", "THIRD", "--unset-env", "FOURTH", "--", "example-tool", ...startupArguments,
  ], cliFixture.runCliOptions), 0);

  const treeConfig = await loadTreeConfigFile(cliFixture.treeConfigFilePath);

  assert.deepEqual(treeConfig.tree[0], {
    kind: "terminal",
    id: "-shell",
    name: "Shell",
    metadata: undefined,
    env: { FIRST: "one", SECOND: "-g", THIRD: null, FOURTH: null },
    shell: { path: "/bin/sh", args: ["-l", "--login"] },
    command: { executable: "example-tool", args: startupArguments },
  });
  assert.equal(await runCli([
    "configure", "--node=-shell", "--shell", "/bin/sh", "--shell-arg=-i",
    "--", "example-tool", "--version", "--unknown=value",
  ], cliFixture.runCliOptions), 0);

  const updatedTreeConfig = await loadTreeConfigFile(cliFixture.treeConfigFilePath);
  const treeNode = updatedTreeConfig.tree[0];

  assert.equal(treeNode?.kind, "terminal");
  assert.deepEqual(treeNode?.shell, { path: "/bin/sh", args: ["-i"] });
  assert.deepEqual(treeNode?.kind === "terminal" && treeNode.command, {
    executable: "example-tool", args: ["--version", "--unknown=value"],
  });
});

test.test("JSON receipts return generated IDs and each committed config mutation", async (testContext) => {
  const cliFixture = await createCliFixture(testContext);

  assert.equal(await runCli(["init", "--json"], cliFixture.runCliOptions), 0);
  assert.deepEqual(JSON.parse(cliFixture.messages.at(-1) ?? ""), {
    configFilePath: cliFixture.treeConfigFilePath,
    config: { version: 1, defaults: { restartPolicy: "manual" }, tree: [] },
  });
  assert.equal(await runCli(["add", "group", "Group", "--id", "group", "--json"], cliFixture.runCliOptions), 0);
  assert.equal(await runCli(["add", "terminal", "Generated", "--parent", "group", "--json"], cliFixture.runCliOptions), 0);

  const addReceipt = JSON.parse(cliFixture.messages.at(-1) ?? "");

  assert.match(addReceipt.node.id, /^[0-9a-f-]{36}$/);
  assert.equal(addReceipt.configFilePath, cliFixture.treeConfigFilePath);

  for (const commandArguments of [
    ["rename", addReceipt.node.id, "Renamed"],
    ["configure", addReceipt.node.id, "--cwd", "/workspace"],
    ["move", addReceipt.node.id, "--root"],
    ["metadata", "set", addReceipt.node.id, '{"owner":"example"}'],
    ["metadata", "set-path", addReceipt.node.id, "/count", "2"],
    ["metadata", "clear-path", addReceipt.node.id, "/owner"],
    ["metadata", "set-path", addReceipt.node.id, "", '{"replaced":true}'],
    ["metadata", "clear-path", addReceipt.node.id, ""],
    ["metadata", "clear", addReceipt.node.id],
    ["move", addReceipt.node.id, "--parent", "group"],
  ]) {
    const previousMessageCount = cliFixture.messages.length;

    assert.equal(await runCli([...commandArguments, "--json"], cliFixture.runCliOptions), 0);
    assert.equal(cliFixture.messages.length, previousMessageCount + 1);

    const treeConfig = await loadTreeConfigFile(cliFixture.treeConfigFilePath);
    const receipt = JSON.parse(cliFixture.messages.at(-1) ?? "");

    assert.deepEqual(receipt, {
      configFilePath: cliFixture.treeConfigFilePath,
      node: JSON.parse(JSON.stringify(getTreeNode(treeConfig, addReceipt.node.id))),
    });
  }

  assert.equal(await runCli(["remove", "group", "--yes", "--json"], cliFixture.runCliOptions), 0);
  assert.deepEqual(JSON.parse(cliFixture.messages.at(-1) ?? ""), {
    configFilePath: cliFixture.treeConfigFilePath,
    removedNodeIds: ["group", addReceipt.node.id],
  });
  assert.deepEqual((await loadTreeConfigFile(cliFixture.treeConfigFilePath)).tree, []);
  assert.deepEqual(cliFixture.errors, []);
});

test.test("attention and activity JSON receipts contain the returned node state", async (testContext) => {
  const cliFixture = await createCliFixture(testContext);

  assert.equal(await runCli(["init"], cliFixture.runCliOptions), 0);
  assert.equal(await runCli(["add", "terminal", "Shell", "--id", "shell"], cliFixture.runCliOptions), 0);

  for (const action of ["set", "clear"]) {
    assert.equal(await runCli(["attention", action, "--json"], cliFixture.runCliOptions), 0);
    assert.deepEqual(JSON.parse(cliFixture.messages.at(-1) ?? ""), {
      configFilePath: cliFixture.treeConfigFilePath,
      nodeId: "shell",
      state: action === "set" ? { needsAttention: true } : {},
    });
  }

  await registerTreeNodeSession(cliFixture.treeConfigFilePath, "shell", "host-session");

  for (const action of ["register", "busy", "idle", "unregister"]) {
    assert.equal(await runCli([
      "activity", action, "--reporter", "reporter", "--pid", "123", "--json",
    ], cliFixture.runCliOptions), 0);

    const treeState = await loadTreeStateFile(cliFixture.treeConfigFilePath);

    assert.deepEqual(JSON.parse(cliFixture.messages.at(-1) ?? ""), {
      configFilePath: cliFixture.treeConfigFilePath,
      nodeId: "shell",
      state: treeState.nodes.shell,
    });
  }

  assert.deepEqual(cliFixture.errors, []);
});

test.test("concurrent mutation receipts retain their own node snapshots", async (testContext) => {
  const cliFixture = await createCliFixture(testContext);

  assert.equal(await runCli(["init"], cliFixture.runCliOptions), 0);
  assert.equal(await runCli(["add", "terminal", "Shell", "--id", "shell"], cliFixture.runCliOptions), 0);

  const renameReceipts = await Promise.all(["First", "Second"].map(async (name) => {
    const messages: string[] = [];
    const exitCode = await runCli(["rename", "shell", name, "--json"], {
      ...cliFixture.runCliOptions,
      output: {
        writeError: cliFixture.runCliOptions.output.writeError,
        writeOutput: (message) => messages.push(message),
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(messages.length, 1);

    return JSON.parse(messages[0] ?? "");
  }));

  assert.deepEqual(renameReceipts.map((receipt) => receipt.node.name), ["First", "Second"]);
});

test.test("the executable preserves stdout, stderr, exit codes, and quoted empty arguments", async (testContext) => {
  const cliFixture = await createCliFixture(testContext);
  const cliFilePath = path.join(__dirname, "cli.js");

  for (const commandArguments of [
    ["init", "--json"],
    ["add", "terminal", "Shell", "--id", "shell", "--json"],
  ]) {
    const cliProcessResult = childProcess.spawnSync(process.execPath, [cliFilePath, ...commandArguments], {
      cwd: cliFixture.temporaryDirPath,
      env: { [treeTYNodeIdEnvironmentName]: "shell" },
      encoding: "utf8",
    });

    assert.equal(cliProcessResult.status, 0, cliProcessResult.stderr);
    assert.equal(cliProcessResult.stderr, "");
    assert.equal(JSON.parse(cliProcessResult.stdout).configFilePath, cliFixture.treeConfigFilePath);
  }

  const treeConfigFileContent = await fs.readFile(cliFixture.treeConfigFilePath, "utf8");
  const cliProcessResult = childProcess.spawnSync(process.execPath, [cliFilePath, "remove", "", "--yes", "--json"], {
    cwd: cliFixture.temporaryDirPath,
    env: { [treeTYNodeIdEnvironmentName]: "shell" },
    encoding: "utf8",
  });

  assert.equal(cliProcessResult.status, 1);
  assert.equal(cliProcessResult.stdout, "");
  assert.match(cliProcessResult.stderr, /^TreeTY: A node ID cannot be empty\.\n$/);
  assert.equal(await fs.readFile(cliFixture.treeConfigFilePath, "utf8"), treeConfigFileContent);
});

async function createCliFixture(testContext: test.TestContext) {
  const temporaryDirPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "treety-cli-regression-")));
  const messages: string[] = [];
  const errors: string[] = [];

  testContext.after(() => fs.rm(temporaryDirPath, { recursive: true, force: true }));

  return {
    temporaryDirPath,
    treeConfigFilePath: path.join(temporaryDirPath, ".treety", "tree.json"),
    messages,
    errors,
    runCliOptions: {
      currentDirPath: temporaryDirPath,
      homeDirPath: temporaryDirPath,
      environment: {
        [treeTYNodeIdEnvironmentName]: "shell",
        [treeTYSessionIdEnvironmentName]: "host-session",
      },
      output: {
        writeOutput: (message: string) => messages.push(message),
        writeError: (message: string) => errors.push(message),
      },
    },
  };
}
