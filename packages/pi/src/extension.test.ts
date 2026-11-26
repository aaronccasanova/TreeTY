import * as assert from "node:assert/strict";
import * as test from "node:test";

import registerTreeTYExtension, { assertTreeTYEnvironment } from "./extension";

type PiExtensionAPI = Parameters<typeof registerTreeTYExtension>[0];
type PiCommand = Parameters<PiExtensionAPI["registerCommand"]>[1];
type PiTool = Parameters<PiExtensionAPI["registerTool"]>[0];
type PiToolResult = Awaited<ReturnType<PiTool["execute"]>>;
type PiEventName = Parameters<PiExtensionAPI["on"]>[0];
type PiEventHandler = Parameters<PiExtensionAPI["on"]>[1];
type PiCommandResult = Awaited<ReturnType<PiExtensionAPI["exec"]>>;

interface TreeTYNode {
  kind: string;
  id: string;
  name: string;
  command?: { executable: string; args: string[] };
  metadata?: unknown;
  [propertyName: string]: unknown;
}

interface ExtensionHarnessOptions {
  node?: TreeTYNode;
  executeCommand?: (
    commandArguments: string[],
  ) => Promise<PiCommandResult | undefined>;
}

const piSessionId = "pi-session-123";
const metadataReadCommand = ["treety", "metadata", "get"];

for (const commandName of ["treety-link", "treety-setup", "treety_link"]) {
  test.test(`${commandName} links session resume without PI_SESSION_ID and signals activity and attention`, async () => {
    await withTreeTYExtension({}, async (extensionHarness) => {
      await extensionHarness.emitEvent("session_start", "startup");
      if (commandName === "treety_link") {
        const toolResult = await extensionHarness.invokeTool(commandName);

        assert.deepEqual(toolResult, {
          content: [{
            type: "text",
            text: "TreeTY will resume this Pi session and show its activity and attention state.",
          }],
          details: undefined,
        });
      } else {
        await extensionHarness.invokeCommand(commandName);
      }
      await extensionHarness.emitEvent("agent_start");
      await extensionHarness.emitEvent("agent_settled");
      await extensionHarness.emitEvent("session_compact");

      assert.deepEqual(extensionHarness.treeTYCommands, [
        metadataReadCommand,
        [
          "treety", "configure", "--cwd", "/workspace/packages/pi",
          "--", "pi", "--session", piSessionId,
        ],
        [
          "treety", "metadata", "set-path", "/integrations/pi/sessionId",
          JSON.stringify(piSessionId),
        ],
        getActivityCommand("register"),
        getActivityCommand("busy"),
        getActivityCommand("idle", "set"),
        getActivityCommand("idle", "set"),
      ]);
      assert.equal(extensionHarness.notifications.length, commandName === "treety_link" ? 0 : 1);
    });
  });
}

test.test("reads current metadata for startup, reload, and resume", async () => {
  await withTreeTYExtension({ node: createLinkedNode() }, async (extensionHarness) => {
    delete process.env.TREETY_NODE_METADATA;

    for (const reason of ["startup", "reload", "resume"]) {
      await extensionHarness.emitEvent("session_start", reason);
      await extensionHarness.emitEvent("agent_start");
      await extensionHarness.emitEvent("agent_settled");
    }

    assert.deepEqual(
      extensionHarness.treeTYCommands,
      Array.from({ length: 3 }, () => [
        metadataReadCommand,
        getActivityCommand("register"),
        getActivityCommand("busy"),
        getActivityCommand("idle", "set"),
      ]).flat(),
    );

    extensionHarness.setSessionId("pi-session-replacement");
    await extensionHarness.emitEvent("session_start", "resume");
    await extensionHarness.emitEvent("agent_settled");

    assert.deepEqual(extensionHarness.treeTYCommands.at(-1), metadataReadCommand);
  });
});

test.test("does not write link metadata when command setup fails", async () => {
  await withTreeTYExtension({
    executeCommand: async () => ({ code: 1, stderr: "configuration failed", stdout: "" }),
  }, async (extensionHarness) => {
    await assert.rejects(extensionHarness.invokeCommand("treety-link"), /configuration failed/);

    assert.deepEqual(extensionHarness.treeTYCommands, [
      [
        "treety", "configure", "--cwd", "/workspace/packages/pi",
        "--", "pi", "--session", piSessionId,
      ],
    ]);
    assert.deepEqual(extensionHarness.notifications, []);
  });
});

test.test("unlink removes only the session link and exact resume command once", async () => {
  const node = createLinkedNode();
  const originalNodeContent = JSON.stringify(node);
  const expectedNode = structuredClone(node);

  delete expectedNode.command;
  expectedNode.metadata = {
    owner: "platform",
    integrations: { pi: { label: "keep this" }, codex: { sessionId: "unrelated-session" } },
  };

  await withTreeTYExtension({ node }, async (extensionHarness) => {
    await extensionHarness.invokeCommand("treety-unlink");

    assert.deepEqual(node, expectedNode);
    assert.equal(extensionHarness.treeTYCommands.length, 3);
    assert.deepEqual(extensionHarness.treeTYCommands[0], ["treety", "show"]);

    const configureCommand = extensionHarness.treeTYCommands[1]!;

    assert.deepEqual(configureCommand.slice(0, 2), ["treety", "configure"]);
    assert.equal(
      configureCommand[configureCommand.indexOf("--if-node") + 1],
      originalNodeContent,
    );
    assert.ok(configureCommand.includes("--clear-command"));
    assert.deepEqual(
      JSON.parse(configureCommand[configureCommand.indexOf("--metadata") + 1]!),
      expectedNode.metadata,
    );

    await extensionHarness.invokeCommand("treety-unlink");

    assert.deepEqual(node, expectedNode);
    assert.equal(
      extensionHarness.treeTYCommands.filter((command) => command[1] === "configure").length,
      1,
    );
    assert.equal(extensionHarness.notifications.length, 2);
  });
});

for (const command of [
  { executable: "custom-pi", args: ["--session", piSessionId] },
  { executable: "pi", args: ["--session", piSessionId, "--model", "custom"] },
  { executable: "pi", args: ["--session", "another-session"] },
]) {
  test.test(`unlink preserves a replacement command: ${JSON.stringify(command)}`, async () => {
    const node = createLinkedNode();
    node.command = command;

    await withTreeTYExtension({ node }, async (extensionHarness) => {
      await extensionHarness.invokeCommand("treety-unlink");

      assert.deepEqual(node.command, command);
      assert.ok(!extensionHarness.treeTYCommands[1]!.includes("--clear-command"));
      assert.deepEqual(node.metadata, {
        owner: "platform",
        integrations: { pi: { label: "keep this" }, codex: { sessionId: "unrelated-session" } },
      });
    });
  });
}

test.test("unlink repairs a resume command left by partial setup", async () => {
  const node = createLinkedNode();
  node.metadata = { owner: "platform" };

  await withTreeTYExtension({ node }, async (extensionHarness) => {
    await extensionHarness.invokeCommand("treety-unlink");

    assert.equal(node.command, undefined);
    assert.deepEqual(node.metadata, { owner: "platform" });
    assert.ok(extensionHarness.treeTYCommands[1]!.includes("--clear-command"));
    assert.ok(!extensionHarness.treeTYCommands[1]!.includes("--metadata"));
  });
});

test.test("unlink clears metadata without removing empty parent containers", async () => {
  const node = createLinkedNode();
  delete node.command;
  node.metadata = { integrations: { pi: { sessionId: piSessionId } } };

  await withTreeTYExtension({ node }, async (extensionHarness) => {
    await extensionHarness.invokeCommand("treety-unlink");

    assert.deepEqual(node.metadata, { integrations: { pi: {} } });
    assert.ok(!extensionHarness.treeTYCommands[1]!.includes("--clear-command"));
  });
});

test.test("unlink is harmless when neither session field belongs to this session", async () => {
  const node: TreeTYNode = {
    kind: "terminal", id: "shell", name: "Shell", metadata: ["unrelated"],
  };
  const originalNode = structuredClone(node);

  await withTreeTYExtension({ node }, async (extensionHarness) => {
    await extensionHarness.invokeCommand("treety-unlink");

    assert.deepEqual(node, originalNode);
    assert.deepEqual(extensionHarness.treeTYCommands, [["treety", "show"], getActivityCommand("unregister")]);
    assert.equal(extensionHarness.notifications.length, 1);
  });
});

test.test("unlink refuses another session's metadata even when the command matches", async () => {
  const node = createLinkedNode();
  node.metadata = { integrations: { pi: { sessionId: "another-session" } } };
  const originalNode = structuredClone(node);

  await withTreeTYExtension({ node }, async (extensionHarness) => {
    await assert.rejects(extensionHarness.invokeCommand("treety-unlink"));

    assert.deepEqual(node, originalNode);
    assert.deepEqual(extensionHarness.treeTYCommands, [["treety", "show"]]);
    assert.deepEqual(extensionHarness.notifications, []);
  });
});

for (const failedCommand of ["show", "configure"]) {
  test.test(`unlink reports a ${failedCommand} failure without disabling the existing link`, async () => {
    const node = createLinkedNode();
    const originalNode = structuredClone(node);

    await withTreeTYExtension({
      node,
      executeCommand: async (commandArguments) => commandArguments[0] === failedCommand
        ? { code: 1, stderr: "configuration changed", stdout: "" }
        : undefined,
    }, async (extensionHarness) => {
      await extensionHarness.emitEvent("session_start", "startup");
      await assert.rejects(extensionHarness.invokeCommand("treety-unlink"), /configuration changed/);
      await extensionHarness.emitEvent("agent_settled");

      assert.deepEqual(node, originalNode);
      assert.deepEqual(extensionHarness.notifications, []);
      assert.deepEqual(extensionHarness.treeTYCommands.at(-1), getActivityCommand("idle", "set"));
    });
  });
}

for (const nodeContent of [
  "not json",
  "null",
  "[]",
  '{"kind":"group","id":"shell","children":[]}',
]) {
  test.test(`unlink refuses an invalid terminal snapshot: ${nodeContent}`, async () => {
    await withTreeTYExtension({
      executeCommand: async () => ({ code: 0, stderr: "", stdout: nodeContent }),
    }, async (extensionHarness) => {
      await assert.rejects(extensionHarness.invokeCommand("treety-unlink"));

      assert.deepEqual(extensionHarness.treeTYCommands, [["treety", "show"]]);
      assert.deepEqual(extensionHarness.notifications, []);
    });
  });
}

test.test("lifecycle events cannot relink an unlinked session through stale launch metadata", async () => {
  const node = createLinkedNode();

  await withTreeTYExtension({ node }, async (extensionHarness) => {
    process.env.TREETY_NODE_METADATA = JSON.stringify(node.metadata);
    await extensionHarness.emitEvent("session_start", "startup");
    await extensionHarness.invokeCommand("treety-unlink");

    const unlinkCommandCount = extensionHarness.treeTYCommands.length;

    for (const reason of ["startup", "reload", "resume", "fork", "new"]) {
      await extensionHarness.emitEvent("session_start", reason);
      await extensionHarness.emitEvent("agent_start");
      await extensionHarness.emitEvent("agent_settled");
      await extensionHarness.emitEvent("session_compact");
    }

    assert.deepEqual(
      extensionHarness.treeTYCommands.slice(unlinkCommandCount),
      Array.from({ length: 5 }, () => metadataReadCommand),
    );

    await extensionHarness.invokeCommand("treety-link");
    await extensionHarness.emitEvent("agent_settled");

    assert.deepEqual(extensionHarness.treeTYCommands.at(-1), getActivityCommand("idle", "set"));
  });
});

test.test("unlink waits for a pending lifecycle read and prevents later attention writes", async () => {
  const node = createLinkedNode();
  const metadataReadStarted = createDeferred();
  const metadataReadReleased = createDeferred();
  let metadataReadCount = 0;

  await withTreeTYExtension({
    node,
    executeCommand: async (commandArguments) => {
      if (commandArguments[0] !== "metadata") return undefined;
      metadataReadCount += 1;
      if (metadataReadCount !== 1) return undefined;

      const metadataContent = JSON.stringify(node.metadata);
      metadataReadStarted.resolve();
      await metadataReadReleased.promise;

      return { code: 0, stderr: "", stdout: metadataContent };
    },
  }, async (extensionHarness) => {
    const sessionStart = extensionHarness.emitEvent("session_start", "reload");
    await metadataReadStarted.promise;

    const unlink = extensionHarness.invokeCommand("treety-unlink");
    const laterSessionStart = extensionHarness.emitEvent("session_start", "reload");
    await Promise.resolve();

    assert.deepEqual(extensionHarness.treeTYCommands, [metadataReadCommand]);
    metadataReadReleased.resolve();
    await Promise.all([sessionStart, unlink, laterSessionStart]);
    await extensionHarness.emitEvent("agent_settled");

    assert.deepEqual(
      extensionHarness.treeTYCommands.map((command) => command[1]),
      ["metadata", "activity", "show", "configure", "activity", "metadata"],
    );
  });
});

test.test("commands reject outside TreeTY and lifecycle events leave it alone", async () => {
  assert.throws(() => assertTreeTYEnvironment({}), /inside a TreeTY terminal/);

  await withTreeTYExtension({}, async (extensionHarness) => {
    delete process.env.TREETY_CONFIG_FILE;
    delete process.env.TREETY_NODE_ID;

    await assert.rejects(extensionHarness.invokeCommand("treety-link"), /\/treety-link must run inside a TreeTY terminal/);
    await assert.rejects(extensionHarness.invokeCommand("treety-setup"), /inside a TreeTY terminal/);
    await assert.rejects(extensionHarness.invokeCommand("treety-unlink"), /inside a TreeTY terminal/);
    await extensionHarness.emitEvent("session_start", "startup");
    await extensionHarness.emitEvent("agent_settled");

    assert.deepEqual(extensionHarness.treeTYCommands, []);
    assert.deepEqual(extensionHarness.notifications, []);
  });
});

test.test("keeps retries, tools, and automatic compaction busy until the full run settles", async () => {
  await withTreeTYExtension({ node: createLinkedNode() }, async (extensionHarness) => {
    await extensionHarness.emitEvent("session_start");
    await extensionHarness.emitEvent("before_agent_start");
    await extensionHarness.emitEvent("agent_start");
    await extensionHarness.emitEvent("agent_end");
    await extensionHarness.emitEvent("session_before_compact", "overflow");
    await extensionHarness.emitEvent("session_compact", "overflow");
    await extensionHarness.emitEvent("agent_start");
    await extensionHarness.emitEvent("agent_end");

    assert.deepEqual(extensionHarness.treeTYCommands.slice(1), [
      getActivityCommand("register"),
      getActivityCommand("busy"),
      getActivityCommand("busy"),
      getActivityCommand("busy"),
      getActivityCommand("busy"),
    ]);

    await extensionHarness.emitEvent("agent_settled");

    assert.deepEqual(extensionHarness.treeTYCommands.at(-1), getActivityCommand("idle", "set"));
  });
});

for (const eventName of ["session_compact", "session_compact_failed"] as const) {
  test.test(`manual ${eventName} returns idle at its documented lifecycle boundary`, async () => {
    await withTreeTYExtension({ node: createLinkedNode() }, async (extensionHarness) => {
      await extensionHarness.emitEvent("session_start");
      await extensionHarness.emitEvent("session_before_compact", "manual");
      await extensionHarness.emitEvent(eventName, {
        reason: "manual", aborted: true, isIdle: eventName === "session_compact_failed",
      });

      assert.deepEqual(extensionHarness.treeTYCommands.slice(1), [
        getActivityCommand("register"),
        getActivityCommand("busy"),
        getActivityCommand("idle", eventName === "session_compact" ? "set" : undefined),
      ]);
    });
  });
}

test.test("manual compaction failure cannot idle a new run started by an earlier handler", async () => {
  await withTreeTYExtension({ node: createLinkedNode() }, async (extensionHarness) => {
    await extensionHarness.emitEvent("session_start");
    await extensionHarness.emitEvent("session_before_compact", "manual");
    await extensionHarness.emitEvent("agent_start");
    await extensionHarness.emitEvent("session_compact_failed", { reason: "manual", isIdle: false });

    assert.deepEqual(extensionHarness.treeTYCommands.at(-1), getActivityCommand("busy"));
  });
});

test.test("an interrupted run settles idle, while an earlier handler's continuation stays busy", async () => {
  await withTreeTYExtension({ node: createLinkedNode() }, async (extensionHarness) => {
    await extensionHarness.emitEvent("session_start");
    await extensionHarness.emitEvent("agent_start");
    await extensionHarness.emitEvent("agent_settled", { isIdle: false });

    assert.deepEqual(extensionHarness.treeTYCommands.at(-1), getActivityCommand("busy"));

    await extensionHarness.emitEvent("agent_settled", { aborted: true });

    assert.deepEqual(extensionHarness.treeTYCommands.at(-1), getActivityCommand("idle", "set"));
  });
});

test.test("a blocking UI prompt waits idle and resumes busy without inventing completion attention", async () => {
  await withTreeTYExtension({ node: createLinkedNode() }, async (extensionHarness) => {
    await extensionHarness.emitEvent("session_start");
    await extensionHarness.emitEvent("agent_start");
    await extensionHarness.emitEvent("ui_prompt_start");
    await extensionHarness.emitEvent("agent_start");
    await extensionHarness.emitEvent("ui_prompt_end");
    await extensionHarness.emitEvent("agent_settled");
    await extensionHarness.emitEvent("ui_prompt_start");
    await extensionHarness.emitEvent("ui_prompt_end");

    assert.deepEqual(extensionHarness.treeTYCommands.slice(1), [
      getActivityCommand("register"),
      getActivityCommand("busy"),
      getActivityCommand("idle"),
      getActivityCommand("busy"),
      getActivityCommand("idle", "set"),
      getActivityCommand("idle"),
    ]);
  });
});

for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
  test.test(`shutdown for ${reason} releases only its owned activity and disables later callbacks`, async () => {
    await withTreeTYExtension({ node: createLinkedNode() }, async (extensionHarness) => {
      await extensionHarness.emitEvent("session_start");
      await extensionHarness.emitEvent("agent_start");
      await extensionHarness.emitEvent("session_shutdown", reason);
      await extensionHarness.emitEvent("agent_settled");
      await extensionHarness.emitEvent("session_compact");
      await extensionHarness.emitEvent("session_shutdown", reason);

      assert.deepEqual(extensionHarness.treeTYCommands.slice(1), [
        getActivityCommand("register"),
        getActivityCommand("busy"),
        getActivityCommand("unregister"),
      ]);
    });
  });
}

test.test("relinking during an active turn immediately publishes busy", async () => {
  await withTreeTYExtension({}, async (extensionHarness) => {
    extensionHarness.setIsIdle(false);
    await extensionHarness.invokeCommand("treety-link");

    assert.deepEqual(extensionHarness.treeTYCommands.slice(-2), [
      getActivityCommand("register"),
      getActivityCommand("busy"),
    ]);
  });
});

test.test("events from a different Pi session cannot signal the linked session's activity", async () => {
  await withTreeTYExtension({ node: createLinkedNode() }, async (extensionHarness) => {
    await extensionHarness.emitEvent("session_start");
    extensionHarness.setSessionId("pi-session-replacement");
    await extensionHarness.emitEvent("agent_start");
    await extensionHarness.emitEvent("agent_settled");
    await extensionHarness.emitEvent("session_shutdown");

    assert.deepEqual(extensionHarness.treeTYCommands, [metadataReadCommand, getActivityCommand("register")]);
  });
});

test.test("a missing TreeTY terminal session cannot configure or register activity", async () => {
  await withTreeTYExtension({}, async (extensionHarness) => {
    delete process.env.TREETY_SESSION_ID;

    await assert.rejects(extensionHarness.invokeCommand("treety-link"), /inside a TreeTY terminal/);
    await extensionHarness.emitEvent("session_start");

    assert.deepEqual(extensionHarness.treeTYCommands, []);
  });
});

test.test("registers only the two requested tools with no session arguments", async () => {
  await withTreeTYExtension({}, async (extensionHarness) => {
    assert.deepEqual([...extensionHarness.registeredTools.keys()], ["treety_link", "treety_unlink"]);

    for (const tool of extensionHarness.registeredTools.values()) {
      assert.deepEqual(tool.parameters, { type: "object", properties: {}, additionalProperties: false });
      assert.equal(tool.executionMode, "sequential");
      assert.ok(tool.label);
      assert.ok(tool.description);
    }
  });
});

test.test("link tool captures the invoking session before waiting for lifecycle work", async () => {
  const metadataReadStarted = createDeferred();
  const metadataReadReleased = createDeferred();

  await withTreeTYExtension({
    executeCommand: async (commandArguments) => {
      if (commandArguments[0] !== "metadata" || commandArguments[1] !== "get") return undefined;

      metadataReadStarted.resolve();
      await metadataReadReleased.promise;

      return { code: 0, stderr: "", stdout: "null" };
    },
  }, async (extensionHarness) => {
    const sessionStart = extensionHarness.emitEvent("session_start");
    await metadataReadStarted.promise;

    extensionHarness.setIsIdle(false);
    const link = extensionHarness.invokeTool("treety_link");
    extensionHarness.setSessionId("pi-session-replacement");
    metadataReadReleased.resolve();

    await Promise.all([sessionStart, link]);
    await extensionHarness.emitEvent("agent_settled");

    assert.deepEqual(extensionHarness.treeTYCommands, [
      metadataReadCommand,
      ["treety", "configure", "--cwd", "/workspace/packages/pi", "--", "pi", "--session", piSessionId],
      ["treety", "metadata", "set-path", "/integrations/pi/sessionId", JSON.stringify(piSessionId)],
      getActivityCommand("register"),
      getActivityCommand("busy"),
    ]);
    assert.deepEqual(extensionHarness.notifications, []);
  });
});

test.test("unlink tool removes resume and stops later signals while preserving terminal settings", async () => {
  const node = createLinkedNode();
  const expectedNode = structuredClone(node);
  delete expectedNode.command;
  expectedNode.metadata = {
    owner: "platform",
    integrations: { pi: { label: "keep this" }, codex: { sessionId: "unrelated-session" } },
  };

  await withTreeTYExtension({ node }, async (extensionHarness) => {
    await extensionHarness.emitEvent("session_start");
    await extensionHarness.emitEvent("agent_start");

    const toolResult = await extensionHarness.invokeTool("treety_unlink");
    const unlinkCommandCount = extensionHarness.treeTYCommands.length;

    await extensionHarness.emitEvent("agent_settled");
    await extensionHarness.emitEvent("session_compact");
    await extensionHarness.emitEvent("ui_prompt_start");
    await extensionHarness.emitEvent("ui_prompt_end");
    await extensionHarness.emitEvent("session_shutdown");

    assert.deepEqual(node, expectedNode);
    assert.equal(extensionHarness.treeTYCommands.length, unlinkCommandCount);
    assert.deepEqual(extensionHarness.treeTYCommands.at(-1), getActivityCommand("unregister"));
    assert.deepEqual(toolResult, {
      content: [{ type: "text", text: "Unlinked this Pi session. The terminal and saved conversation are preserved." }],
      details: undefined,
    });
    assert.deepEqual(extensionHarness.notifications, []);

    const repeatResult = await extensionHarness.invokeTool("treety_unlink");

    assert.deepEqual(repeatResult.content, [{ type: "text", text: "This Pi session is already unlinked from this TreeTY terminal." }]);
    assert.deepEqual(node, expectedNode);
    assert.equal(extensionHarness.treeTYCommands.filter((command) => command[1] === "configure").length, 1);

    await extensionHarness.invokeTool("treety_link");
    await extensionHarness.emitEvent("agent_settled");

    assert.deepEqual(extensionHarness.treeTYCommands.at(-1), getActivityCommand("idle", "set"));
  });
});

test.test("unlink tool preserves a custom command and reports it", async () => {
  const node = createLinkedNode();
  node.command = { executable: "pi", args: ["--session", piSessionId, "--model", "custom"] };
  const command = structuredClone(node.command);

  await withTreeTYExtension({ node }, async (extensionHarness) => {
    const toolResult = await extensionHarness.invokeTool("treety_unlink");

    assert.deepEqual(node.command, command);
    assert.deepEqual(toolResult.content, [{
      type: "text",
      text: "Unlinked this Pi session. The terminal and saved conversation are preserved. The custom startup command was left unchanged.",
    }]);
  });
});

test.test("unlink tool refuses a foreign session and leaves the queue usable", async () => {
  const node = createLinkedNode();
  node.metadata = { integrations: { pi: { sessionId: "another-session" } } };
  const originalNode = structuredClone(node);

  await withTreeTYExtension({ node }, async (extensionHarness) => {
    await assert.rejects(extensionHarness.invokeTool("treety_unlink"), /different Pi session/);

    assert.deepEqual(node, originalNode);
    assert.deepEqual(extensionHarness.treeTYCommands, [["treety", "show"]]);
    assert.deepEqual(extensionHarness.notifications, []);

    extensionHarness.setSessionId("another-session");
    const toolResult = await extensionHarness.invokeTool("treety_unlink");

    assert.match(toolResult.content[0]!.text, /Unlinked this Pi session/);
    assert.deepEqual(node.command, originalNode.command);
  });
});

for (const failedCommand of ["show", "configure"]) {
  test.test(`unlink tool reports ${failedCommand} errors and preserves signaling until a successful retry`, async () => {
    const node = createLinkedNode();
    const originalNode = structuredClone(node);
    let commandShouldFail = true;

    await withTreeTYExtension({
      node,
      executeCommand: async (commandArguments) => commandShouldFail && commandArguments[0] === failedCommand
        ? { code: 1, stderr: "configuration changed", stdout: "" }
        : undefined,
    }, async (extensionHarness) => {
      await extensionHarness.emitEvent("session_start");
      await assert.rejects(extensionHarness.invokeTool("treety_unlink"), /configuration changed/);
      await extensionHarness.emitEvent("agent_settled");

      assert.deepEqual(node, originalNode);
      assert.deepEqual(extensionHarness.treeTYCommands.at(-1), getActivityCommand("idle", "set"));
      assert.deepEqual(extensionHarness.notifications, []);

      commandShouldFail = false;
      await extensionHarness.invokeTool("treety_unlink");
      await extensionHarness.emitEvent("agent_settled");

      assert.deepEqual(extensionHarness.treeTYCommands.at(-1), getActivityCommand("unregister"));
    });
  });
}

test.test("link tool reports command failure without enabling signals and can retry", async () => {
  let commandShouldFail = true;

  await withTreeTYExtension({
    executeCommand: async () => commandShouldFail
      ? { code: 1, stderr: "configuration failed", stdout: "" }
      : undefined,
  }, async (extensionHarness) => {
    await assert.rejects(extensionHarness.invokeTool("treety_link"), /configuration failed/);
    await extensionHarness.emitEvent("agent_settled");

    assert.deepEqual(extensionHarness.treeTYCommands, [
      ["treety", "configure", "--cwd", "/workspace/packages/pi", "--", "pi", "--session", piSessionId],
    ]);

    commandShouldFail = false;
    await extensionHarness.invokeTool("treety_link");
    await extensionHarness.emitEvent("agent_settled");

    assert.deepEqual(extensionHarness.treeTYCommands.at(-1), getActivityCommand("idle", "set"));
    assert.deepEqual(extensionHarness.notifications, []);
  });
});

for (const toolName of ["treety_link", "treety_unlink"]) {
  test.test(`${toolName} rejects outside a managed TreeTY terminal`, async () => {
    await withTreeTYExtension({}, async (extensionHarness) => {
      delete process.env.TREETY_SESSION_ID;

      await assert.rejects(extensionHarness.invokeTool(toolName), new RegExp(`${toolName} must run inside a TreeTY terminal`));

      assert.deepEqual(extensionHarness.treeTYCommands, []);
      assert.deepEqual(extensionHarness.notifications, []);
    });
  });
}

function getActivityCommand(activity: "register" | "busy" | "idle" | "unregister", attention?: "set"): string[] {
  const activityCommand = [
    "treety", "activity", activity, "--reporter", piSessionId,
    "--pid", String(process.pid), "--metadata-path", "/integrations/pi/sessionId",
  ];

  if (attention) activityCommand.push("--attention", attention);

  return activityCommand;
}

async function withTreeTYExtension(
  options: ExtensionHarnessOptions,
  runTest: (extensionHarness: ReturnType<typeof createExtensionHarness>) => Promise<void>,
): Promise<void> {
  const previousEnvironment = { ...process.env };

  delete process.env.PI_SESSION_ID;
  process.env.TREETY_CONFIG_FILE = "/workspace/.treety/tree.json";
  process.env.TREETY_NODE_ID = "shell";
  process.env.TREETY_SESSION_ID = "treety-session-123";
  delete process.env.TREETY_NODE_METADATA;

  try {
    await runTest(createExtensionHarness(options));
  } finally {
    process.env = previousEnvironment;
  }
}

function createExtensionHarness(options: ExtensionHarnessOptions) {
  const registeredCommands = new Map<string, PiCommand>();
  const registeredTools = new Map<string, PiTool>();
  const registeredEventHandlers = new Map<PiEventName, PiEventHandler>();
  const treeTYCommands: string[][] = [];
  const notifications: string[] = [];
  const node = options.node ?? { kind: "terminal", id: "shell", name: "Shell" };
  let currentSessionId = piSessionId;
  let isIdle = true;

  const extensionContext = {
    cwd: "/workspace/packages/pi",
    isIdle: () => isIdle,
    sessionManager: { getSessionId: () => currentSessionId },
    ui: { notify: (message: string) => notifications.push(message) },
  };

  registerTreeTYExtension({
    exec: async (command, commandArguments) => {
      treeTYCommands.push([command, ...commandArguments]);

      const commandResult = await options.executeCommand?.(commandArguments);
      if (commandResult) return commandResult;

      if (commandArguments[0] === "show") {
        return { code: 0, stderr: "", stdout: JSON.stringify(node) };
      }

      if (commandArguments[0] === "metadata" && commandArguments[1] === "get") {
        return { code: 0, stderr: "", stdout: JSON.stringify(node.metadata ?? null) };
      }

      if (commandArguments[0] === "metadata" && commandArguments[1] === "set-path") {
        node.metadata = {
          integrations: { pi: { sessionId: JSON.parse(commandArguments[3]!) } },
        };
      }

      if (commandArguments[0] === "configure" && commandArguments.includes("--if-node")) {
        assert.deepEqual(
          JSON.parse(commandArguments[commandArguments.indexOf("--if-node") + 1]!),
          node,
        );

        if (commandArguments.includes("--metadata")) {
          node.metadata = JSON.parse(
            commandArguments[commandArguments.indexOf("--metadata") + 1]!,
          );
        }

        if (commandArguments.includes("--clear-command")) delete node.command;
      }

      return { code: 0, stderr: "", stdout: "" };
    },
    on: (eventName, eventHandler) => registeredEventHandlers.set(eventName, eventHandler),
    registerCommand: (commandName, command) => registeredCommands.set(commandName, command),
    registerTool: (tool) => registeredTools.set(tool.name, tool),
  });

  return {
    treeTYCommands,
    notifications,
    registeredTools,
    setSessionId: (sessionId: string) => {
      currentSessionId = sessionId;
    },
    setIsIdle: (nextIsIdle: boolean) => {
      isIdle = nextIsIdle;
    },
    invokeTool: async (toolName: string): Promise<PiToolResult> => {
      const tool = registeredTools.get(toolName);

      assert.ok(tool, `${toolName} must be registered`);

      return tool.execute("tool-call-123", {}, undefined, undefined, {
        cwd: extensionContext.cwd,
        isIdle: extensionContext.isIdle,
        sessionManager: extensionContext.sessionManager,
      });
    },
    invokeCommand: async (commandName: string) => {
      const command = registeredCommands.get(commandName);
      assert.ok(command, `${commandName} must be registered`);
      await command.handler("", extensionContext);
    },
    emitEvent: async (
      eventName: PiEventName | "agent_end",
      eventDetails: string | { reason?: string; aborted?: boolean; isIdle?: boolean } = {},
    ) => {
      if (eventName === "agent_end") {
        assert.ok(!registeredEventHandlers.has(eventName as PiEventName));
        return;
      }

      const eventHandler = registeredEventHandlers.get(eventName);

      assert.ok(eventHandler, `${eventName} must be registered`);

      const event = typeof eventDetails === "string"
        ? { type: eventName, reason: eventDetails }
        : { type: eventName, reason: "manual", ...eventDetails };

      if (["before_agent_start", "agent_start", "session_before_compact"].includes(eventName)) {
        isIdle = false;
      }

      if (eventName === "agent_settled") isIdle = true;
      if ("isIdle" in event && typeof event.isIdle === "boolean") isIdle = event.isIdle;

      await eventHandler(event, extensionContext);

      if (eventName.startsWith("session_compact") && event.reason === "manual") isIdle = true;
    },
  };
}

function createLinkedNode(): TreeTYNode {
  return {
    kind: "terminal",
    id: "shell",
    name: "Persistent shell",
    cwd: "/workspace/main",
    projectDir: "/workspace",
    env: { KEEP: "yes" },
    shell: { path: "/bin/zsh", args: ["-l"] },
    restartPolicy: "onOpen",
    command: { executable: "pi", args: ["--session", piSessionId] },
    metadata: {
      owner: "platform",
      integrations: {
        pi: { sessionId: piSessionId, label: "keep this" },
        codex: { sessionId: "unrelated-session" },
      },
    },
  };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}
