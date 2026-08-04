import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as test from "node:test";

import {
  parseTreeConfigContent,
  treeTYConfigFileEnvironmentName,
  treeTYConfigSourceEnvironmentName,
  treeTYNodeIdEnvironmentName,
  treeTYSessionIdEnvironmentName,
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

test.test("manages a complete local tree lifecycle", async () => {
  const temporaryDirPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "treety-cli-"),
  );
  const capturedOutput = createCapturedOutput();
  const runCliOptions = {
    currentDirPath: temporaryDirPath,
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
    });
    assert.match(capturedOutput.messages.at(-1) ?? "", /Focused shell/);
    assert.match(
      capturedOutput.messages.at(-1) ?? "",
      /terminal-session-123/,
    );
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

test.test("prints help and version without a configuration", async () => {
  const capturedOutput = createCapturedOutput();

  assert.equal(await runCli([], { output: capturedOutput.output }), 0);
  assert.match(capturedOutput.messages.at(-1) ?? "", /treety init/);

  assert.equal(
    await runCli(["--version"], { output: capturedOutput.output }),
    0,
  );
  assert.equal(capturedOutput.messages.at(-1), "0.0.2");
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
