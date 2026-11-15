import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as test from "node:test";

import {
  parseTreeConfigContent,
  registerTreeNodeSession,
  loadTreeStateFile,
  getTreeStateFilePath,
  parseTreeStateContent,
  treeTYConfigFileEnvironmentName,
  treeTYConfigSourceEnvironmentName,
  treeTYNodeIdEnvironmentName,
  treeTYSessionIdEnvironmentName,
  treeTYSessionUriEnvironmentName,
} from "@treety/core";

import { runCli } from "./cli";

interface CapturedOutput {
  errors: string[];
  messages: string[];
  output: {
    writeError(message: string): void;
    writeOutput(message: string): void;
  };
}

test.test("reports the CLI package version", async () => {
  const cliPackageConfig = require("../package.json") as { version: string };

  for (const versionArgument of ["version", "--version", "-v"]) {
    const capturedOutput = createCapturedOutput();

    assert.equal(
      await runCli([versionArgument], { output: capturedOutput.output }),
      0,
    );
    assert.deepEqual(capturedOutput.messages, [cliPackageConfig.version]);
    assert.deepEqual(capturedOutput.errors, []);
  }
});

test.test("prints the current terminal's opaque session URI without interpreting its query", async () => {
  const sessionUri = "example-host://session/live?target%3Da%2526b%26route%3D4";
  const capturedOutput = createCapturedOutput();

  assert.equal(await runCli(["uri"], {
    environment: { [treeTYSessionUriEnvironmentName]: sessionUri },
    output: capturedOutput.output,
  }), 0);
  assert.deepEqual(capturedOutput.messages, [sessionUri]);
  assert.deepEqual(capturedOutput.errors, []);
});

test.test("uri fails without host context and refuses selectors or extra arguments", async () => {
  const capturedOutput = createCapturedOutput();

  assert.equal(await runCli(["uri"], {
    environment: {},
    output: capturedOutput.output,
  }), 1);
  assert.match(capturedOutput.errors[0] ?? "", /no session URI/);

  for (const cliArguments of [
    ["uri", "other-node"],
    ["uri", "--", "other-command"],
    ["uri", "--node", "other-node"],
    ["uri", "--global"],
    ["uri", "--config", "/other/tree.json"],
  ]) {
    const rejectedOutput = createCapturedOutput();

    assert.equal(await runCli(cliArguments, {
      environment: { [treeTYSessionUriEnvironmentName]: "example-host://session/live" },
      output: rejectedOutput.output,
    }), 1);
    assert.deepEqual(rejectedOutput.messages, []);
  }
});

test.test("manages a complete local tree lifecycle", async () => {
  const temporaryDirPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "treety-cli-"),
  );
  const capturedOutput = createCapturedOutput();
  const runCliOptions = {
    currentDirPath: temporaryDirPath,
    environment: {},
    homeDirPath: temporaryDirPath,
    output: capturedOutput.output,
  };

  try {
    assert.equal(await runCli(["init"], runCliOptions), 0);
    assert.equal(
      await runCli(
        [
          "add",
          "group",
          "Services",
          "--id",
          "services",
          "--cwd",
          "services",
        ],
        runCliOptions,
      ),
      0,
    );
    assert.equal(
      await runCli(
        [
          "add",
          "terminal",
          "API server",
          "--id",
          "api-server",
          "--parent",
          "services",
          "--cwd",
          "api",
          "--env",
          "PORT=3000",
          "--",
          "pnpm",
          "dev",
        ],
        runCliOptions,
      ),
      0,
    );
    assert.equal(
      await runCli(
        ["rename", "api-server", "Development API"],
        runCliOptions,
      ),
      0,
    );
    assert.equal(
      await runCli(["move", "api-server", "--root"], runCliOptions),
      0,
    );
    assert.equal(
      await runCli(
        ["add", "terminal", "Root shell", "--id", "root-shell"],
        runCliOptions,
      ),
      0,
    );
    assert.equal(
      await runCli(
        ["move", "api-server", "--before", "root-shell"],
        runCliOptions,
      ),
      0,
    );
    assert.equal(await runCli(["list"], runCliOptions), 0);

    const treeConfigFilePath = path.join(
      temporaryDirPath,
      ".treety",
      "tree.json",
    );
    const treeConfigFileContent = await fs.readFile(treeConfigFilePath, "utf8");
    const treeConfig = parseTreeConfigContent(treeConfigFileContent);

    assert.equal(treeConfig.tree[0]?.id, "services");
    assert.equal(treeConfig.tree[1]?.name, "Development API");
    assert.deepEqual(
      treeConfig.tree[1]?.kind === "terminal"
        ? treeConfig.tree[1].command
        : undefined,
      {
        executable: "pnpm",
        args: ["dev"],
      },
    );
    assert.match(capturedOutput.messages.at(-1) ?? "", /Development API/);

    assert.equal(
      await runCli(["remove", "services"], runCliOptions),
      1,
    );
    assert.match(capturedOutput.errors.at(-1) ?? "", /--yes/);
    assert.equal(
      await runCli(["remove", "services", "--yes"], runCliOptions),
      0,
    );
  } finally {
    await fs.rm(temporaryDirPath, { recursive: true, force: true });
  }
});

test.test("targets the current terminal through its injected environment", async () => {
  const temporaryDirPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "treety-cli-current-"),
  );
  const treeConfigFilePath = path.join(
    temporaryDirPath,
    ".treety",
    "tree.json",
  );
  const capturedOutput = createCapturedOutput();
  const runCliOptions = {
    currentDirPath: temporaryDirPath,
    environment: {
      [treeTYConfigFileEnvironmentName]: treeConfigFilePath,
      [treeTYConfigSourceEnvironmentName]: "workspace",
      [treeTYNodeIdEnvironmentName]: "shell",
      [treeTYSessionIdEnvironmentName]: "terminal-session-123",
    },
    homeDirPath: temporaryDirPath,
    output: capturedOutput.output,
  };

  try {
    assert.equal(await runCli(["init"], runCliOptions), 0);
    assert.equal(
      await runCli(
        ["add", "terminal", "Shell", "--id", "shell"],
        runCliOptions,
      ),
      0,
    );
    assert.equal(
      await runCli(["rename", "Focused shell"], runCliOptions),
      0,
    );
    assert.equal(
      await runCli(
        [
          "configure",
          "--cwd",
          "packages/cli",
          "--project-dir",
          "../..",
          "--env",
          "MODE=test",
        ],
        runCliOptions,
      ),
      0,
    );
    assert.equal(
      await runCli(
        [
          "metadata",
          "set",
          '{"owner":"platform","tags":["cli"]}',
        ],
        runCliOptions,
      ),
      0,
    );
    assert.equal(
      await runCli(
        [
          "metadata",
          "set-path",
          "/integrations/example/sessionId",
          '"example-session-123"',
        ],
        runCliOptions,
      ),
      0,
    );
    assert.equal(
      await runCli(
        ["configure", "--", "example-tool", "--session", "example-session-123"],
        runCliOptions,
      ),
      0,
    );
    assert.equal(await runCli(["attention", "set"], runCliOptions), 0);
    assert.equal(await runCli(["current"], runCliOptions), 0);

    const treeConfigFileContent = await fs.readFile(treeConfigFilePath, "utf8");
    const treeConfig = parseTreeConfigContent(treeConfigFileContent);
    const shellNode = treeConfig.tree[0];

    assert.equal(shellNode?.id, "shell");
    assert.equal(shellNode?.name, "Focused shell");
    assert.equal(shellNode?.cwd, "packages/cli");
    assert.equal(shellNode?.projectDir, "../..");
    assert.deepEqual(shellNode?.env, {
      MODE: "test",
    });
    assert.deepEqual(shellNode?.metadata, {
      owner: "platform",
      tags: ["cli"],
      integrations: {
        example: {
          sessionId: "example-session-123",
        },
      },
    });
    assert.deepEqual(
      shellNode?.kind === "terminal" ? shellNode.command : undefined,
      {
        executable: "example-tool",
        args: ["--session", "example-session-123"],
      },
    );
    assert.deepEqual(
      parseTreeStateContent(
        await fs.readFile(getTreeStateFilePath(treeConfigFilePath), "utf8"),
      ),
      {
        version: 1,
        nodes: {
          shell: { needsAttention: true },
        },
      },
    );
    assert.match(capturedOutput.messages.at(-1) ?? "", /Focused shell/);
    assert.match(
      capturedOutput.messages.at(-1) ?? "",
      /terminal-session-123/,
    );
    assert.equal(
      await runCli(["configure", "--clear-command"], runCliOptions),
      0,
    );
    assert.equal(
      await runCli(
        ["metadata", "clear-path", "/integrations/example/sessionId"],
        runCliOptions,
      ),
      0,
    );
    assert.equal(await runCli(["attention", "clear"], runCliOptions), 0);
  } finally {
    await fs.rm(temporaryDirPath, { recursive: true, force: true });
  }
});

test.test("falls back to the global tree when no local tree exists", async () => {
  const temporaryDirPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "treety-cli-global-"),
  );
  const workspaceDirPath = path.join(temporaryDirPath, "workspace");
  const capturedOutput = createCapturedOutput();
  const runCliOptions = {
    currentDirPath: workspaceDirPath,
    environment: {},
    homeDirPath: temporaryDirPath,
    output: capturedOutput.output,
  };

  await fs.mkdir(workspaceDirPath);

  try {
    assert.equal(await runCli(["init", "--global"], runCliOptions), 0);
    assert.equal(
      await runCli(
        ["add", "terminal", "Global shell", "--global"],
        runCliOptions,
      ),
      0,
    );
    assert.equal(await runCli(["list"], runCliOptions), 0);
    assert.match(
      capturedOutput.messages.at(-1) ?? "",
      /\.config\/treety\/tree\.json/,
    );
    assert.match(capturedOutput.messages.at(-1) ?? "", /Global shell/);
  } finally {
    await fs.rm(temporaryDirPath, { recursive: true, force: true });
  }
});

test.test("targets an explicit global config ahead of hosted terminal context", async () => {
  const temporaryDirPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "treety-cli-scope-"),
  );
  const workspaceDirPath = path.join(temporaryDirPath, "workspace");
  const localConfigFilePath = path.join(
    workspaceDirPath,
    ".treety",
    "tree.json",
  );
  const globalConfigFilePath = path.join(
    temporaryDirPath,
    ".config",
    "treety",
    "tree.json",
  );
  const capturedOutput = createCapturedOutput();
  const baseRunCliOptions = {
    currentDirPath: workspaceDirPath,
    environment: {},
    homeDirPath: temporaryDirPath,
    output: capturedOutput.output,
  };

  await fs.mkdir(workspaceDirPath);

  try {
    assert.equal(await runCli(["init"], baseRunCliOptions), 0);
    assert.equal(
      await runCli(
        ["add", "terminal", "Local shell", "--id", "shared"],
        baseRunCliOptions,
      ),
      0,
    );
    assert.equal(await runCli(["init", "--global"], baseRunCliOptions), 0);
    assert.equal(
      await runCli(
        [
          "add",
          "terminal",
          "Global shell",
          "--id",
          "shared",
          "--global",
        ],
        baseRunCliOptions,
      ),
      0,
    );

    const hostedRunCliOptions = {
      ...baseRunCliOptions,
      environment: {
        [treeTYConfigFileEnvironmentName]: localConfigFilePath,
        [treeTYConfigSourceEnvironmentName]: "workspace",
        [treeTYNodeIdEnvironmentName]: "shared",
      },
    };

    assert.equal(
      await runCli(
        [
          "metadata",
          "set",
          "shared",
          '{"owner":"global"}',
          "--global",
        ],
        hostedRunCliOptions,
      ),
      0,
    );
    assert.equal(
      await runCli(["current", "--global"], hostedRunCliOptions),
      0,
    );

    const localTreeConfig = parseTreeConfigContent(
      await fs.readFile(localConfigFilePath, "utf8"),
    );
    const globalTreeConfig = parseTreeConfigContent(
      await fs.readFile(globalConfigFilePath, "utf8"),
    );

    assert.equal(localTreeConfig.tree[0]?.metadata, undefined);
    assert.deepEqual(globalTreeConfig.tree[0]?.metadata, {
      owner: "global",
    });
    assert.match(
      capturedOutput.messages.at(-1) ?? "",
      /"configSource": "global"/,
    );
    assert.match(capturedOutput.messages.at(-1) ?? "", /Global shell/);
  } finally {
    await fs.rm(temporaryDirPath, { recursive: true, force: true });
  }
});

test.test("configure guards the complete node snapshot and applies all changes together", async () => {
  const temporaryDirPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "treety-cli-configure-guard-"),
  );
  const capturedOutput = createCapturedOutput();
  const runCliOptions = {
    currentDirPath: temporaryDirPath,
    environment: {},
    homeDirPath: temporaryDirPath,
    output: capturedOutput.output,
  };
  const treeConfigFilePath = path.join(temporaryDirPath, ".treety", "tree.json");

  try {
    assert.equal(await runCli(["init"], runCliOptions), 0);
    assert.equal(await runCli([
      "add", "terminal", "Shell", "--id", "shell", "--cwd", "/workspace",
      "--metadata", '{"owner":"platform","sessionId":"session-1"}',
      "--", "example-tool", "--session", "session-1",
    ], runCliOptions), 0);
    assert.equal(await runCli([
      "add", "terminal", "Other", "--id", "other",
    ], runCliOptions), 0);
    assert.equal(await runCli(["show", "shell"], runCliOptions), 0);

    const expectedTreeNode = JSON.parse(
      capturedOutput.messages.at(-1) ?? "",
    ) as Record<string, unknown>;
    const expectedTreeNodeContent = JSON.stringify(
      Object.fromEntries(Object.entries(expectedTreeNode).reverse()),
    );

    assert.equal(await runCli(["rename", "other", "Changed other"], runCliOptions), 0);
    assert.equal(await runCli([
      "configure", "shell", "--if-node", expectedTreeNodeContent,
      "--clear-command", "--metadata", '{"owner":"platform"}',
    ], runCliOptions), 0);

    const configuredTreeConfigFileContent = await fs.readFile(treeConfigFilePath, "utf8");
    const configuredTreeConfig = parseTreeConfigContent(configuredTreeConfigFileContent);

    assert.deepEqual(configuredTreeConfig.tree[0], {
      kind: "terminal",
      id: "shell",
      name: "Shell",
      cwd: "/workspace",
      metadata: { owner: "platform" },
    });
    assert.equal(configuredTreeConfig.tree[1]?.name, "Changed other");

    assert.equal(await runCli([
      "configure", "shell", "--if-node", expectedTreeNodeContent,
      "--clear-cwd", "--clear-metadata",
    ], runCliOptions), 1);
    assert.match(capturedOutput.errors.at(-1) ?? "", /changed since it was read/);
    assert.equal(await fs.readFile(treeConfigFilePath, "utf8"), configuredTreeConfigFileContent);

    assert.equal(await runCli([
      "configure", "shell", "--if-node", "{", "--clear-cwd",
    ], runCliOptions), 1);
    assert.match(capturedOutput.errors.at(-1) ?? "", /--if-node must contain valid JSON/);
    assert.equal(await fs.readFile(treeConfigFilePath, "utf8"), configuredTreeConfigFileContent);
  } finally {
    await fs.rm(temporaryDirPath, { recursive: true, force: true });
  }
});

test.test("concurrent guarded configure calls cannot both consume the same snapshot", async () => {
  const temporaryDirPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "treety-cli-concurrent-guard-"),
  );
  const capturedOutput = createCapturedOutput();
  const runCliOptions = {
    currentDirPath: temporaryDirPath,
    environment: {},
    homeDirPath: temporaryDirPath,
    output: capturedOutput.output,
  };

  try {
    assert.equal(await runCli(["init"], runCliOptions), 0);
    assert.equal(await runCli([
      "add", "terminal", "Shell", "--id", "shell", "--cwd", "/workspace",
    ], runCliOptions), 0);
    assert.equal(await runCli(["show", "shell"], runCliOptions), 0);

    const expectedTreeNodeContent = capturedOutput.messages.at(-1) ?? "";
    const configureExitCodes = await Promise.all([
      runCli([
        "configure", "shell", "--if-node", expectedTreeNodeContent,
        "--metadata", '{"owner":"first"}',
      ], runCliOptions),
      runCli([
        "configure", "shell", "--if-node", expectedTreeNodeContent,
        "--metadata", '{"owner":"second"}',
      ], runCliOptions),
    ]);
    const treeConfig = parseTreeConfigContent(await fs.readFile(
      path.join(temporaryDirPath, ".treety", "tree.json"),
      "utf8",
    ));

    assert.deepEqual([...configureExitCodes].sort(), [0, 1]);
    assert.deepEqual(treeConfig.tree[0], {
      kind: "terminal",
      id: "shell",
      name: "Shell",
      cwd: "/workspace",
      metadata: { owner: configureExitCodes[0] === 0 ? "first" : "second" },
    });
    assert.equal(capturedOutput.errors.length, 1);
    assert.match(capturedOutput.errors[0] ?? "", /changed since it was read/);
  } finally {
    await fs.rm(temporaryDirPath, { recursive: true, force: true });
  }
});

test.test("prints help and version without a configuration", async () => {
  const capturedOutput = createCapturedOutput();

  assert.equal(await runCli([], { output: capturedOutput.output }), 0);
  assert.match(capturedOutput.messages.at(-1) ?? "", /treety init/);

  assert.equal(
    await runCli(["--version"], { output: capturedOutput.output }),
    0,
  );
  assert.equal(capturedOutput.messages.at(-1), "0.0.3");
});

test.test("rejects unknown options before changing configuration", async () => {
  const capturedOutput = createCapturedOutput();

  assert.equal(
    await runCli(["init", "--froce"], { output: capturedOutput.output }),
    1,
  );
  assert.match(capturedOutput.errors.at(-1) ?? "", /Unknown option --froce/);
});

function createCapturedOutput(): CapturedOutput {
  const errors: string[] = [];
  const messages: string[] = [];

  return {
    errors,
    messages,
    output: {
      writeError: (message) => errors.push(message),
      writeOutput: (message) => messages.push(message),
    },
  };
}

test.test("reports guarded activity with terminal context and atomic attention", async () => {
  const temporaryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-cli-activity-"));
  const treeConfigFilePath = path.join(temporaryDirPath, ".treety", "tree.json");
  const capturedOutput = createCapturedOutput();
  const runCliOptions = {
    currentDirPath: temporaryDirPath,
    environment: {
      [treeTYNodeIdEnvironmentName]: "shell",
      [treeTYSessionIdEnvironmentName]: "host-session",
    },
    homeDirPath: temporaryDirPath,
    output: capturedOutput.output,
  };
  const reporterArguments = ["--reporter", "reporter", "--pid", "123", "--metadata-path", "/reporter"];

  try {
    assert.equal(await runCli(["init"], runCliOptions), 0);
    assert.equal(await runCli([
      "add", "terminal", "Shell", "--id", "shell", "--metadata", '{"reporter":"reporter"}',
    ], runCliOptions), 0);
    await registerTreeNodeSession(treeConfigFilePath, "shell", "host-session");

    assert.equal(await runCli(["activity", "register", ...reporterArguments], runCliOptions), 0);
    assert.equal(await runCli(["activity", "busy", ...reporterArguments], runCliOptions), 0);
    assert.equal(await runCli(["activity", "idle", ...reporterArguments, "--attention", "set"], runCliOptions), 0);

    const completedTreeState = await loadTreeStateFile(treeConfigFilePath);

    assert.equal(completedTreeState.nodes.shell?.needsAttention, true);
    assert.equal(completedTreeState.nodes.shell?.sessions?.["host-session"]?.activity?.state, "idle");
    assert.equal(await runCli(["activity", "busy", ...reporterArguments], runCliOptions), 0);
    assert.equal((await loadTreeStateFile(treeConfigFilePath)).nodes.shell?.needsAttention, undefined);
    assert.equal(await runCli(["activity", "idle", ...reporterArguments, "--attention", "set"], runCliOptions), 0);
    assert.equal(await runCli(["metadata", "clear"], runCliOptions), 0);
    assert.equal(await runCli(["activity", "busy", ...reporterArguments], runCliOptions), 1);
    assert.equal(await runCli(["activity", "unregister", ...reporterArguments], runCliOptions), 0);

    assert.deepEqual((await loadTreeStateFile(treeConfigFilePath)).nodes.shell, {
      needsAttention: true,
      sessions: { "host-session": {} },
    });

    for (const invalidArguments of [
      ["activity", "register", "--reporter", "reporter", "--pid", "0"],
      ["activity", "register", "--reporter", "reporter", "--pid", "1.5"],
      ["activity", "register", "--reporter", "reporter", "--pid", "1e3"],
      ["activity", "register", "--reporter", "reporter", "--pid", "9007199254740992"],
      ["activity", "register", "--reporter", "bad reporter", "--pid", "123"],
      ["activity", "register", "--reporter", "reporter"],
      ["activity", "running", ...reporterArguments],
      ["activity", "register", ...reporterArguments, "--session", "stale"],
      ["activity", "register", "--reporter", "reporter", "--pid", "123", "--session", "constructor"],
      ["activity", "register", "--reporter", "reporter", "--pid", "123", "--session", "__proto__"],
      ["activity", "busy", ...reporterArguments, "--attention", "set"],
      ["activity", "idle", ...reporterArguments, "--attention", "true"],
    ]) {
      assert.equal(await runCli(invalidArguments, runCliOptions), 1, invalidArguments.join(" "));
    }

    assert.equal(await runCli(["activity", "register", ...reporterArguments], {
      ...runCliOptions,
      environment: { [treeTYNodeIdEnvironmentName]: "shell" },
    }), 1);
    assert.match(capturedOutput.errors.at(-1) ?? "", /TREETY_SESSION_ID/);
  } finally {
    await fs.rm(temporaryDirPath, { recursive: true, force: true });
  }
});

test.test("configures and clears per-terminal activity animation", async () => {
  const temporaryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-cli-animation-"));
  const treeConfigFilePath = path.join(temporaryDirPath, ".treety", "tree.json");
  const capturedOutput = createCapturedOutput();
  const runCliOptions = {
    currentDirPath: temporaryDirPath,
    environment: {},
    homeDirPath: temporaryDirPath,
    output: capturedOutput.output,
  };

  try {
    assert.equal(await runCli(["init"], runCliOptions), 0);
    assert.equal(await runCli(["add", "terminal", "Shell", "--id", "shell"], runCliOptions), 0);
    assert.equal(await runCli(["add", "group", "Group", "--id", "group"], runCliOptions), 0);

    for (const activityAnimation of ["off", "on"]) {
      assert.equal(await runCli(["configure", "shell", "--activity-animation", activityAnimation], runCliOptions), 0);

      const treeConfig = parseTreeConfigContent(await fs.readFile(treeConfigFilePath, "utf8"));
      const terminal = treeConfig.tree[0];

      assert.equal(terminal?.kind === "terminal" && terminal.activityAnimation, activityAnimation === "on");
    }

    assert.equal(await runCli(["configure", "shell", "--clear-activity-animation"], runCliOptions), 0);

    const treeConfig = parseTreeConfigContent(await fs.readFile(treeConfigFilePath, "utf8"));

    assert.equal("activityAnimation" in treeConfig.tree[0]!, false);
    assert.equal(await runCli(["configure", "group", "--activity-animation", "off"], runCliOptions), 1);
    assert.equal(await runCli(["configure", "shell", "--activity-animation", "false"], runCliOptions), 1);
    assert.equal(await runCli(["configure", "shell", "--activity-animation", "off", "--clear-activity-animation"], runCliOptions), 1);
  } finally {
    await fs.rm(temporaryDirPath, { recursive: true, force: true });
  }
});
