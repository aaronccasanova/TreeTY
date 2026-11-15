import * as assert from "node:assert/strict";
import * as test from "node:test";

import registerTreeTYExtension, { assertTreeTYEnvironment } from "./extension";

type PiExtensionAPI = Parameters<typeof registerTreeTYExtension>[0];
type PiCommand = Parameters<PiExtensionAPI["registerCommand"]>[1];
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

for (const commandName of ["treety-link", "treety-setup"]) {
  test.test(`${commandName} links session resume without PI_SESSION_ID and signals attention`, async () => {
    await withTreeTYExtension({}, async (extensionHarness) => {
      await extensionHarness.emitEvent("session_start", "startup");
      await extensionHarness.invokeCommand(commandName);
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
        ["treety", "attention", "clear"],
        ["treety", "attention", "set"],
        ["treety", "attention", "set"],
      ]);
      assert.equal(extensionHarness.notifications.length, 1);
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
        ["treety", "attention", "clear"],
        ["treety", "attention", "set"],
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
    assert.equal(extensionHarness.treeTYCommands.length, 2);
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
    assert.deepEqual(extensionHarness.treeTYCommands, [["treety", "show"]]);
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
      assert.deepEqual(extensionHarness.treeTYCommands.at(-1), ["treety", "attention", "set"]);
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

    assert.deepEqual(extensionHarness.treeTYCommands.at(-1), ["treety", "attention", "set"]);
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
      ["metadata", "show", "configure", "metadata"],
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

async function withTreeTYExtension(
  options: ExtensionHarnessOptions,
  runTest: (extensionHarness: ReturnType<typeof createExtensionHarness>) => Promise<void>,
): Promise<void> {
  const previousEnvironment = { ...process.env };

  delete process.env.PI_SESSION_ID;
  process.env.TREETY_CONFIG_FILE = "/workspace/.treety/tree.json";
  process.env.TREETY_NODE_ID = "shell";
  delete process.env.TREETY_NODE_METADATA;

  try {
    await runTest(createExtensionHarness(options));
  } finally {
    process.env = previousEnvironment;
  }
}

function createExtensionHarness(options: ExtensionHarnessOptions) {
  const registeredCommands = new Map<string, PiCommand>();
  const registeredEventHandlers = new Map<PiEventName, PiEventHandler>();
  const treeTYCommands: string[][] = [];
  const notifications: string[] = [];
  const node = options.node ?? { kind: "terminal", id: "shell", name: "Shell" };
  let currentSessionId = piSessionId;

  const extensionContext = {
    cwd: "/workspace/packages/pi",
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
  });

  return {
    treeTYCommands,
    notifications,
    setSessionId: (sessionId: string) => {
      currentSessionId = sessionId;
    },
    invokeCommand: async (commandName: string) => {
      const command = registeredCommands.get(commandName);
      assert.ok(command, `${commandName} must be registered`);
      await command.handler("", extensionContext);
    },
    emitEvent: async (eventName: PiEventName, reason = "startup") => {
      const eventHandler = registeredEventHandlers.get(eventName);
      assert.ok(eventHandler, `${eventName} must be registered`);
      await eventHandler({ type: eventName, reason }, extensionContext);
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
