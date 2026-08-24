import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as test from "node:test";
import * as url from "node:url";

import { runCodexHook } from "./hook.js";

const treeTYEnvironment = {
  TREETY_CONFIG_FILE: "/workspace/.treety/tree.json",
  TREETY_NODE_ID: "shell",
};

test.test("sets up session resume without a Codex session environment variable", () => {
  /** @type {string[][]} */
  const treeTYCommands = [];

  const hookOutput = runCodexHook(
    {
      cwd: "/workspace/packages/cli",
      hook_event_name: "UserPromptSubmit",
      prompt: "$treety-setup",
      session_id: "codex-session-123",
    },
    {
      environment: treeTYEnvironment,
      runCommand: (commandName, commandArguments) => {
        treeTYCommands.push([commandName, ...commandArguments]);

        return { code: 0, stderr: "", stdout: "" };
      },
    },
  );

  assert.deepEqual(treeTYCommands, [
    [
      "treety",
      "configure",
      "--cwd",
      "/workspace/packages/cli",
      "--",
      "codex",
      "resume",
      "codex-session-123",
    ],
    [
      "treety",
      "metadata",
      "set-path",
      "/integrations/codex/sessionId",
      '"codex-session-123"',
    ],
    ["treety", "attention", "clear"],
  ]);
  assert.deepEqual(hookOutput, {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        "TreeTY setup completed. Tell the user that TreeTY will resume this Codex session and signal when it needs attention.",
    },
  });
});

test.test("clears and sets attention for a linked session", () => {
  /** @type {string[][]} */
  const treeTYCommands = [];

  /**
   * @param {string} commandName
   * @param {string[]} commandArguments
   */
  const runCommand = (commandName, commandArguments) => {
    treeTYCommands.push([commandName, ...commandArguments]);

    if (commandArguments[0] === "metadata") {
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          integrations: {
            codex: {
              sessionId: "codex-session-456",
            },
          },
        }),
      };
    }

    return { code: 0, stderr: "", stdout: "" };
  };
  const hookInput = {
    cwd: "/workspace",
    hook_event_name: "UserPromptSubmit",
    prompt: "Continue working",
    session_id: "codex-session-456",
  };

  const promptHookOutput = runCodexHook(hookInput, {
    environment: treeTYEnvironment,
    runCommand,
  });
  const stopHookOutput = runCodexHook(
    { ...hookInput, hook_event_name: "Stop" },
    { environment: treeTYEnvironment, runCommand },
  );

  assert.equal(promptHookOutput, undefined);
  assert.deepEqual(stopHookOutput, {});
  assert.deepEqual(treeTYCommands, [
    ["treety", "metadata", "get"],
    ["treety", "attention", "clear"],
    ["treety", "metadata", "get"],
    ["treety", "attention", "set"],
  ]);
});

test.test("sets attention after compaction for a linked session", () => {
  /** @type {string[][]} */
  const treeTYCommands = [];

  const hookOutput = runCodexHook(
    {
      cwd: "/workspace",
      hook_event_name: "PostCompact",
      session_id: "codex-session-compact",
    },
    {
      environment: treeTYEnvironment,
      runCommand: (commandName, commandArguments) => {
        treeTYCommands.push([commandName, ...commandArguments]);

        if (commandArguments[0] === "metadata") {
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              integrations: {
                codex: {
                  sessionId: "codex-session-compact",
                },
              },
            }),
          };
        }

        return { code: 0, stderr: "", stdout: "" };
      },
    },
  );

  assert.equal(hookOutput, undefined);
  assert.deepEqual(treeTYCommands, [
    ["treety", "metadata", "get"],
    ["treety", "attention", "set"],
  ]);
});

test.test("does not signal attention after session replacement", () => {
  /** @type {string[][]} */
  const treeTYCommands = [];

  const hookOutput = runCodexHook(
    {
      cwd: "/workspace",
      hook_event_name: "Stop",
      session_id: "codex-session-replacement",
    },
    {
      environment: treeTYEnvironment,
      runCommand: (commandName, commandArguments) => {
        treeTYCommands.push([commandName, ...commandArguments]);

        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            integrations: {
              codex: {
                sessionId: "codex-session-original",
              },
            },
          }),
        };
      },
    },
  );

  assert.deepEqual(hookOutput, {});
  assert.deepEqual(treeTYCommands, [["treety", "metadata", "get"]]);
});

test.test("does not write link metadata when setup fails", () => {
  /** @type {string[][]} */
  const treeTYCommands = [];

  const hookOutput = runCodexHook(
    {
      cwd: "/workspace/packages/codex",
      hook_event_name: "UserPromptSubmit",
      prompt: "/treety-setup",
      session_id: "codex-session-failed",
    },
    {
      environment: treeTYEnvironment,
      runCommand: (commandName, commandArguments) => {
        treeTYCommands.push([commandName, ...commandArguments]);

        return { code: 1, stderr: "configuration failed", stdout: "" };
      },
    },
  );

  assert.deepEqual(hookOutput, {
    decision: "block",
    reason: "configuration failed",
  });
  assert.deepEqual(treeTYCommands, [
    [
      "treety",
      "configure",
      "--cwd",
      "/workspace/packages/codex",
      "--",
      "codex",
      "resume",
      "codex-session-failed",
    ],
  ]);
});

test.test("rejects setup outside a TreeTY terminal", () => {
  const hookOutput = runCodexHook(
    {
      cwd: "/workspace",
      hook_event_name: "UserPromptSubmit",
      prompt: "treety-setup",
      session_id: "codex-session-outside",
    },
    { environment: {}, runCommand: () => assert.fail("unexpected command") },
  );

  assert.deepEqual(hookOutput, {
    decision: "block",
    reason: "$treety-setup must run inside a TreeTY terminal.",
  });
});

test.test("writes the required JSON response for a stop hook", () => {
  const hookFilePath = url.fileURLToPath(new URL("./hook.js", import.meta.url));
  const hookProcessResult = childProcess.spawnSync(
    process.execPath,
    [hookFilePath],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
      },
      input: JSON.stringify({
        cwd: "/workspace",
        hook_event_name: "Stop",
        session_id: "codex-session-process",
      }),
    },
  );

  assert.equal(hookProcessResult.status, 0);
  assert.equal(hookProcessResult.stderr, "");
  assert.equal(hookProcessResult.stdout, "{}\n");
});
