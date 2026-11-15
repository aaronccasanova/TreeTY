import * as assert from "node:assert/strict";
import * as nodeTest from "node:test";

import { TerminalActivityTracker } from "./terminal-activity";

nodeTest.test("short commands cancel the delayed spinner without completion attention", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const tracker = new TerminalActivityTracker(() => {});
  const execution = {};

  tracker.startShellExecution(execution, 0);
  context.mock.timers.tick(999);
  assert.deepEqual(tracker.getActivity(), { state: "busy", showSpinner: false });
  assert.equal(tracker.endShellExecution(execution, 999), false);
  tracker.setExplicitActivity(undefined);
  context.mock.timers.tick(1_000);
  assert.deepEqual(tracker.getActivity(), { state: "idle", showSpinner: false });
});

nodeTest.test("native animation starts once after a second and completion attention starts at five seconds", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let changes = 0;
  const tracker = new TerminalActivityTracker(() => { changes += 1; });
  const execution = {};

  tracker.startShellExecution(execution, 0);
  context.mock.timers.tick(1_000);
  assert.deepEqual(tracker.getActivity(), { state: "busy", showSpinner: true });
  context.mock.timers.tick(30_000);
  assert.equal(changes, 2);
  assert.equal(tracker.endShellExecution(execution, 5_000), true);
  assert.deepEqual(tracker.getActivity(), { state: "idle", showSpinner: false });
});

nodeTest.test("linked idle overrides its enclosing shell and never double counts completion", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const tracker = new TerminalActivityTracker(() => {});
  const execution = {};

  tracker.startShellExecution(execution, 0);
  tracker.setExplicitActivity("idle");
  context.mock.timers.tick(2_000);
  assert.deepEqual(tracker.getActivity(), { state: "idle", showSpinner: false });
  tracker.setExplicitActivity("busy");
  context.mock.timers.tick(1_000);
  assert.equal(tracker.getActivity().showSpinner, true);
  tracker.setExplicitActivity("idle");
  tracker.setExplicitActivity(undefined);
  assert.deepEqual(tracker.getActivity(), { state: "unknown", showSpinner: false });
  assert.equal(tracker.endShellExecution(execution, 20_000), false);

  const nextExecution = {};
  tracker.startShellExecution(nextExecution, 30_000);
  assert.equal(tracker.endShellExecution(nextExecution, 35_000), true);
});

nodeTest.test("late completion cannot stop a newer command or create its attention", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const tracker = new TerminalActivityTracker(() => {});
  const previousExecution = {};
  const execution = {};

  tracker.startShellExecution(previousExecution, 0);
  tracker.startShellExecution(execution, 10_000);
  assert.equal(tracker.endShellExecution(previousExecution, 20_000), false);
  assert.equal(tracker.getActivity().state, "busy");
  assert.equal(tracker.endShellExecution(execution, 12_000), false);
});

nodeTest.test("disposal cancels pending refreshes and recovered terminals stay unknown", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let changes = 0;
  const tracker = new TerminalActivityTracker(() => { changes += 1; });

  assert.equal(tracker.getActivity().state, "unknown");
  tracker.startShellExecution({});
  tracker.dispose();
  context.mock.timers.tick(2_000);
  assert.equal(changes, 1);
});
