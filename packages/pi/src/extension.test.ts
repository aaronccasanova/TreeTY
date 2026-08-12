import * as assert from "node:assert/strict";
import * as test from "node:test";

import registerTreeTYExtension, { assertTreeTYEnvironment } from "./extension";

type PiEventName =
  | "agent_settled"
  | "agent_start"
  | "session_compact"
  | "session_start";

interface PiExtensionContext {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
  };
}

type PiEventHandler = (
  event: unknown,
  extensionContext: PiExtensionContext,
) => Promise<void>;

interface RegisteredCommand {
  handler(
    commandArguments: string,
    commandContext: PiExtensionContext & {
      ui: {
        notify(message: string, level: "info"): void;
      };
    },
  ): Promise<void>;
}

test.test("sets up session resume without PI_SESSION_ID", async () => {
  const previousEnvironment = { ...process.env };
  const registeredEventHandlers = new Map<PiEventName, PiEventHandler>();
  const treeTYCommands: string[][] = [];
  let registeredCommand: RegisteredCommand | undefined;

  delete process.env.PI_SESSION_ID;
  process.env.TREETY_CONFIG_FILE = "/workspace/.treety/tree.json";
  process.env.TREETY_NODE_ID = "shell";
  delete process.env.TREETY_NODE_METADATA;

  try {
    registerTreeTYExtension({
      exec: async (command, commandArguments) => {
        treeTYCommands.push([command, ...commandArguments]);

        return { code: 0, stderr: "", stdout: "" };
      },
      on: (eventName, eventHandler) => {
        registeredEventHandlers.set(eventName, eventHandler);
      },
      registerCommand: (_commandName, command) => {
        registeredCommand = command;
      },
    });

    const notifications: string[] = [];
    const extensionContext = {
      cwd: "/workspace/packages/cli",
      sessionManager: {
        getSessionId: () => "pi-session-123",
      },
    };

    await registeredEventHandlers.get("session_start")?.(
      { reason: "startup", type: "session_start" },
      extensionContext,
    );

    assert.ok(registeredCommand);

    await registeredCommand.handler("", {
      ...extensionContext,
      ui: {
        notify: (message) => notifications.push(message),
      },
    });
    await registeredEventHandlers.get("agent_start")?.({}, extensionContext);
    await registeredEventHandlers.get("agent_settled")?.({}, extensionContext);

    assert.deepEqual(treeTYCommands, [
      [
        "treety",
        "configure",
        "--cwd",
        "/workspace/packages/cli",
        "--",
        "pi",
        "--session",
        "pi-session-123",
      ],
      [
        "treety",
        "metadata",
        "set-path",
        "/integrations/pi/sessionId",
        '"pi-session-123"',
      ],
      ["treety", "attention", "clear"],
      ["treety", "attention", "set"],
    ]);
    assert.equal(notifications.length, 1);
  } finally {
    process.env = previousEnvironment;
  }
});

test.test("enables lifecycle signaling for an already linked session", async () => {
  const previousEnvironment = { ...process.env };
  const registeredEventHandlers = new Map<PiEventName, PiEventHandler>();
  const treeTYCommands: string[][] = [];

  delete process.env.PI_SESSION_ID;
  process.env.TREETY_CONFIG_FILE = "/workspace/.treety/tree.json";
  process.env.TREETY_NODE_ID = "shell";
  process.env.TREETY_NODE_METADATA = JSON.stringify({
    integrations: {
      pi: {
        sessionId: "pi-session-456",
      },
    },
  });

  try {
    registerTreeTYExtension({
      exec: async (command, commandArguments) => {
        treeTYCommands.push([command, ...commandArguments]);

        return { code: 0, stderr: "", stdout: "" };
      },
      on: (eventName, eventHandler) => {
        registeredEventHandlers.set(eventName, eventHandler);
      },
      registerCommand: () => undefined,
    });

    const extensionContext = {
      cwd: "/workspace",
      sessionManager: {
        getSessionId: () => "pi-session-456",
      },
    };

    await registeredEventHandlers.get("session_start")?.(
      { reason: "startup", type: "session_start" },
      extensionContext,
    );
    await registeredEventHandlers.get("agent_start")?.({}, extensionContext);
    await registeredEventHandlers.get("agent_settled")?.({}, extensionContext);

    assert.deepEqual(treeTYCommands, [
      ["treety", "attention", "clear"],
      ["treety", "attention", "set"],
    ]);
  } finally {
    process.env = previousEnvironment;
  }
});

test.test("sets attention after compaction for a linked session", async () => {
  const previousEnvironment = { ...process.env };
  const registeredEventHandlers = new Map<PiEventName, PiEventHandler>();
  const treeTYCommands: string[][] = [];

  process.env.TREETY_CONFIG_FILE = "/workspace/.treety/tree.json";
  process.env.TREETY_NODE_ID = "shell";
  process.env.TREETY_NODE_METADATA = JSON.stringify({
    integrations: {
      pi: {
        sessionId: "pi-session-compact",
      },
    },
  });

  try {
    registerTreeTYExtension({
      exec: async (command, commandArguments) => {
        treeTYCommands.push([command, ...commandArguments]);

        return { code: 0, stderr: "", stdout: "" };
      },
      on: (eventName, eventHandler) => {
        registeredEventHandlers.set(eventName, eventHandler);
      },
      registerCommand: () => undefined,
    });

    const extensionContext = {
      cwd: "/workspace",
      sessionManager: {
        getSessionId: () => "pi-session-compact",
      },
    };

    await registeredEventHandlers.get("session_start")?.(
      { reason: "startup", type: "session_start" },
      extensionContext,
    );
    await registeredEventHandlers.get("session_compact")?.(
      { type: "session_compact" },
      extensionContext,
    );

    assert.deepEqual(treeTYCommands, [["treety", "attention", "set"]]);
  } finally {
    process.env = previousEnvironment;
  }
});

test.test("recomputes lifecycle signaling after reload and resume", async () => {
  const previousEnvironment = { ...process.env };
  const registeredEventHandlers = new Map<PiEventName, PiEventHandler>();
  const treeTYCommands: string[][] = [];

  process.env.TREETY_CONFIG_FILE = "/workspace/.treety/tree.json";
  process.env.TREETY_NODE_ID = "shell";
  delete process.env.TREETY_NODE_METADATA;

  try {
    registerTreeTYExtension({
      exec: async (command, commandArguments) => {
        treeTYCommands.push([command, ...commandArguments]);

        if (commandArguments[0] === "metadata") {
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              integrations: {
                pi: {
                  sessionId: "pi-session-789",
                },
              },
            }),
          };
        }

        return { code: 0, stderr: "", stdout: "" };
      },
      on: (eventName, eventHandler) => {
        registeredEventHandlers.set(eventName, eventHandler);
      },
      registerCommand: () => undefined,
    });

    const extensionContext = {
      cwd: "/workspace",
      sessionManager: {
        getSessionId: () => "pi-session-789",
      },
    };

    await registeredEventHandlers.get("session_start")?.(
      { reason: "reload", type: "session_start" },
      extensionContext,
    );
    await registeredEventHandlers.get("agent_start")?.({}, extensionContext);
    await registeredEventHandlers.get("agent_settled")?.({}, extensionContext);
    await registeredEventHandlers.get("session_start")?.(
      { reason: "resume", type: "session_start" },
      extensionContext,
    );
    await registeredEventHandlers.get("agent_start")?.({}, extensionContext);
    await registeredEventHandlers.get("agent_settled")?.({}, extensionContext);

    assert.deepEqual(treeTYCommands, [
      ["treety", "metadata", "get"],
      ["treety", "attention", "clear"],
      ["treety", "attention", "set"],
      ["treety", "metadata", "get"],
      ["treety", "attention", "clear"],
      ["treety", "attention", "set"],
    ]);
  } finally {
    process.env = previousEnvironment;
  }
});

test.test("disables lifecycle signaling after session replacement", async () => {
  const previousEnvironment = { ...process.env };
  const registeredEventHandlers = new Map<PiEventName, PiEventHandler>();
  const treeTYCommands: string[][] = [];

  process.env.TREETY_CONFIG_FILE = "/workspace/.treety/tree.json";
  process.env.TREETY_NODE_ID = "shell";

  try {
    registerTreeTYExtension({
      exec: async (command, commandArguments) => {
        treeTYCommands.push([command, ...commandArguments]);

        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            integrations: {
              pi: {
                sessionId: "pi-session-original",
              },
            },
          }),
        };
      },
      on: (eventName, eventHandler) => {
        registeredEventHandlers.set(eventName, eventHandler);
      },
      registerCommand: () => undefined,
    });

    const extensionContext = {
      cwd: "/workspace",
      sessionManager: {
        getSessionId: () => "pi-session-replacement",
      },
    };

    await registeredEventHandlers.get("session_start")?.(
      { reason: "resume", type: "session_start" },
      extensionContext,
    );
    await registeredEventHandlers.get("agent_start")?.({}, extensionContext);
    await registeredEventHandlers.get("agent_settled")?.({}, extensionContext);

    assert.deepEqual(treeTYCommands, [["treety", "metadata", "get"]]);
  } finally {
    process.env = previousEnvironment;
  }
});

test.test("does not write link metadata when command setup fails", async () => {
  const previousEnvironment = { ...process.env };
  let registeredCommand: RegisteredCommand | undefined;
  const treeTYCommands: string[][] = [];

  process.env.TREETY_CONFIG_FILE = "/workspace/.treety/tree.json";
  process.env.TREETY_NODE_ID = "shell";

  try {
    registerTreeTYExtension({
      exec: async (command, commandArguments) => {
        treeTYCommands.push([command, ...commandArguments]);

        return { code: 1, stderr: "configuration failed", stdout: "" };
      },
      on: () => undefined,
      registerCommand: (_commandName, command) => {
        registeredCommand = command;
      },
    });

    assert.ok(registeredCommand);

    await assert.rejects(
      registeredCommand.handler("", {
        cwd: "/workspace/packages/pi",
        sessionManager: {
          getSessionId: () => "pi-session-failed",
        },
        ui: {
          notify: () => undefined,
        },
      }),
      /configuration failed/,
    );

    assert.deepEqual(treeTYCommands, [
      [
        "treety",
        "configure",
        "--cwd",
        "/workspace/packages/pi",
        "--",
        "pi",
        "--session",
        "pi-session-failed",
      ],
    ]);
  } finally {
    process.env = previousEnvironment;
  }
});

test.test("rejects setup outside a TreeTY terminal", () => {
  assert.throws(() => assertTreeTYEnvironment({}), /inside a TreeTY terminal/);
});
