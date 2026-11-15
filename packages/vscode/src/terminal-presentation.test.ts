import * as assert from "node:assert/strict";
import * as nodeTest from "node:test";

import type { TerminalStatus } from "@treety/core";

import { getTerminalPresentation } from "./terminal-presentation";

nodeTest.test("every status uses the circle family with text that does not depend on color", () => {
  for (const status of ["stopped", "starting", "idle", "running", "failed"] as TerminalStatus[]) {
    const presentation = getTerminalPresentation({
      status, activity: { state: "unknown", showSpinner: false },
      animationEnabled: true, terminalAnimationEnabled: true, reduceMotion: false,
    });

    assert.equal(presentation.icon, status === "stopped" ? "circle-outline" : "circle-filled");
    assert.equal(presentation.description, status);
  }
});

nodeTest.test("animation preferences retain busy text with a static status dot", () => {
  const options = {
    status: "running" as const, activity: { state: "busy" as const, showSpinner: true },
    animationEnabled: true, terminalAnimationEnabled: true, reduceMotion: false,
  };

  assert.equal(getTerminalPresentation(options).icon, "loading~spin");

  for (const override of [
    { animationEnabled: false }, { terminalAnimationEnabled: false }, { reduceMotion: true },
  ]) {
    const presentation = getTerminalPresentation({ ...options, ...override });

    assert.equal(presentation.icon, "circle-filled");
    assert.equal(presentation.description, "running, busy");
  }
});
