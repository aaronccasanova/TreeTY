import * as assert from "node:assert/strict";
import * as test from "node:test";

import registerTreeTYExtension, {
  getRequiredSetupEnvironment,
} from "./extension";

type PiEventName = "agent_settled" | "agent_start";

interface RegisteredCommand {
  handler(
    commandArguments: string,
    commandContext: {
      ui: {
        notify(message: string, level: "info"): void;
      };
    },
  ): Promise<void>;
}

test.test("sets up session resume and enables lifecycle attention", async () => {
  const previousEnvironment = { ...process.env };
  const registeredEventHandlers = new Map<PiEventName, () => Promise<void>>();
  const treeTYCommands: string[][] = [];
  let registeredCommand: RegisteredCommand | undefined;

  process.env.PI_SESSION_ID = "pi-session-123";
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

    assert.ok(registeredCommand);

    await registeredCommand.handler("", {
      ui: {
        notify: (message) => notifications.push(message),
      },
    });
    await registeredEventHandlers.get("agent_start")?.();
    await registeredEventHandlers.get("agent_settled")?.();

    assert.deepEqual(treeTYCommands, [
      [
        "treety",
        "metadata",
        "set-path",
        "/integrations/pi/sessionId",
        '"pi-session-123"',
      ],
      [
        "treety",
        "configure",
        "--",
        "pi",
        "--session",
        "pi-session-123",
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
  const registeredEventHandlers = new Map<PiEventName, () => Promise<void>>();
  const treeTYCommands: string[][] = [];

  process.env.PI_SESSION_ID = "pi-session-456";
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

    await registeredEventHandlers.get("agent_start")?.();
    await registeredEventHandlers.get("agent_settled")?.();

    assert.deepEqual(treeTYCommands, [
      ["treety", "attention", "clear"],
      ["treety", "attention", "set"],
    ]);
  } finally {
    process.env = previousEnvironment;
  }
});

test.test("rejects setup outside a TreeTY terminal", () => {
  assert.throws(
    () =>
      getRequiredSetupEnvironment({
        PI_SESSION_ID: "pi-session-789",
      }),
    /inside a TreeTY terminal/,
  );
});
