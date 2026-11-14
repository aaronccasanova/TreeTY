import * as assert from "node:assert/strict";
import * as performanceHooks from "node:perf_hooks";
import * as nodeTest from "node:test";

import { resolveTreeConfig } from "@treety/core";
import type { TreeNodeConfig } from "@treety/core";

import { buildNodeSearchEntries, resolveNodeSearchEntry, searchNodeEntries } from "./node-search";
import type { WorkspaceModel } from "./workspace-model";

nodeTest.test("matches names, acronyms, compact subsequences, accents, and small typos", () => {
  const entries = buildNodeSearchEntries([createWorkspace("personal", [
    { kind: "terminal", id: "payments", name: "Payments service tests" },
    { kind: "terminal", id: "api", name: "Another project API Server" },
    { kind: "terminal", id: "cafe", name: "Café café" },
  ])]);

  for (const query of ["payments", "PAYMENTS", "pst", "paymnets", "paymets", "pymnts", "servce", "paymentz"]) {
    assert.equal(searchNodeEntries(entries, query)[0]?.nodeId, "payments", query);
  }

  for (const query of ["aps", "ps", "as", "apisrv"]) {
    assert.ok(searchNodeEntries(entries, query).some((entry) => entry.nodeId === "api"), query);
  }

  assert.equal(searchNodeEntries(entries, "CAFE")[0]?.nodeId, "cafe");
  assert.equal(searchNodeEntries(entries, "café")[0]?.nodeId, "cafe");
  assert.deepEqual(searchNodeEntries(entries, "xyzzy"), []);
});

nodeTest.test("ANDs terms across hierarchy, directories, and descriptive metadata", () => {
  const entries = buildNodeSearchEntries([createWorkspace("work", [{
    kind: "group", id: "payments", name: "Payments", metadata: { tags: ["finance"] }, children: [
      { kind: "terminal", id: "tests", name: "Service tests", cwd: "services/ledger", metadata: { owner: "Platform", tags: ["integration", "nightly"] } },
      { kind: "terminal", id: "shell", name: "Shell" },
    ],
  }])]);

  for (const query of ["payments test", "work ledger", "platform nightly", "finance tests", "paymnets tsts"]) {
    assert.equal(searchNodeEntries(entries, query)[0]?.nodeId, "tests", query);
  }

  assert.equal(searchNodeEntries(entries, "Payments")[0]?.nodeId, "payments");
  assert.equal(entries.find((entry) => entry.nodeId === "tests")?.description, "work > Payments");
  assert.match(entries.find((entry) => entry.nodeId === "tests")?.detail ?? "", /owner: Platform/);
  assert.deepEqual(searchNodeEntries(entries, "platform nonexistent"), []);
});

nodeTest.test("ranks names before context and preserves tree order for ties or empty queries", () => {
  const entries = buildNodeSearchEntries([createWorkspace("local", [{
    kind: "group", id: "services", name: "Services", children: [
      { kind: "terminal", id: "metadata", name: "Shell", metadata: { tags: ["payments"] } },
      { kind: "terminal", id: "long", name: "Payments server" },
      { kind: "terminal", id: "exact", name: "Payments" },
      { kind: "terminal", id: "second", name: "Payments server" },
    ],
  }])]);

  assert.deepEqual(searchNodeEntries(entries, "payments").map((entry) => entry.nodeId), ["exact", "long", "second", "metadata"]);
  assert.deepEqual(searchNodeEntries(entries, " "), entries);
});

nodeTest.test("does not index environment, commands, integration data, or arbitrary metadata", () => {
  const entries = buildNodeSearchEntries([createWorkspace("local", [{
    kind: "terminal", id: "shell", name: "Shell",
    env: { API_TOKEN: "environmentsecret" },
    command: { executable: "hiddencommand", args: ["commandsecret"] },
    metadata: {
      token: "metadatasecret",
      integrations: { codex: { sessionId: "sessionsecret" } },
      unknown: "arbitrarysecret",
      labels: { token: "nestedsecret" },
      tags: ["safe-tag", { secret: "arraysecret" }],
      owner: "platform",
    },
  }])]);

  for (const query of ["environmentsecret", "hiddencommand", "commandsecret", "metadatasecret", "sessionsecret", "arbitrarysecret", "nestedsecret", "arraysecret"]) {
    assert.deepEqual(searchNodeEntries(entries, query), [], query);
  }

  assert.equal(searchNodeEntries(entries, "safe-tag").length, 1);
  assert.equal(searchNodeEntries(entries, "platform").length, 1);
  assert.doesNotMatch(entries[0]?.detail ?? "", /secret/);
});

nodeTest.test("keeps duplicate node IDs scoped and resolves the latest model", () => {
  const firstWorkspace = createWorkspace("first", [{ kind: "terminal", id: "shell", name: "Shell" }]);
  const secondWorkspace = createWorkspace("second", [{ kind: "terminal", id: "shell", name: "Shell" }]);
  const entries = buildNodeSearchEntries([firstWorkspace, secondWorkspace]);

  assert.notEqual(entries[0]?.key, entries[1]?.key);
  assert.equal(searchNodeEntries(entries, "second shell")[0]?.workspaceId, "second");

  const updatedWorkspace = createWorkspace("second", [{ kind: "terminal", id: "shell", name: "Renamed" }]);
  const identity = { workspaceId: "second", nodeId: "shell" };

  assert.equal(resolveNodeSearchEntry([firstWorkspace, updatedWorkspace], identity)?.treeNode.name, "Renamed");
  assert.equal(resolveNodeSearchEntry([firstWorkspace, updatedWorkspace], identity)?.workspaceModel, updatedWorkspace);
  assert.equal(resolveNodeSearchEntry([firstWorkspace], identity), undefined);
  assert.equal(resolveNodeSearchEntry([createWorkspace("second", [])], identity), undefined);
});

nodeTest.test("ignores invalid workspaces and bounds query and metadata work", () => {
  const workspaceModel = createWorkspace("local", [{
    kind: "terminal", id: "shell", name: "Shell",
    metadata: { description: "x".repeat(100_000), tags: Array.from({ length: 10_000 }, () => "tag") },
  }]);
  const entries = buildNodeSearchEntries([
    { ...workspaceModel, kind: "invalid", errorMessage: "invalid" } as WorkspaceModel,
    { ...workspaceModel, id: "empty", kind: "unconfigured" } as WorkspaceModel,
    workspaceModel,
  ]);

  assert.equal(entries.length, 1);
  assert.ok((entries[0]?.detail.length ?? Infinity) < 1200);
  assert.deepEqual(searchNodeEntries(entries, "x".repeat(257)), []);
  assert.deepEqual(searchNodeEntries(entries, Array.from({ length: 13 }, () => "shell").join(" ")), []);
});

nodeTest.test("benchmarks responsive searches across 192 realistic groups and terminals", (testContext) => {
  const groupNames = ["Payments", "Accounts", "Dashboard", "Identity", "Catalog", "Notifications", "Analytics", "Infrastructure", "Mobile", "Documentation", "Delivery", "Research"];
  const terminalNames = ["Development server", "Service tests", "Integration tests", "Database shell", "Migration runner", "Log viewer", "Production review", "Release checks", "Background worker", "API explorer", "Agent session", "Repository shell", "Type checker", "Build watcher", "Performance profile"];
  const tree: TreeNodeConfig[] = groupNames.map((groupName, groupIndex) => ({
    kind: "group", id: `group-${groupIndex}`, name: groupName,
    children: terminalNames.map((terminalName, terminalIndex) => ({
      kind: "terminal", id: `terminal-${groupIndex}-${terminalIndex}`, name: terminalName,
      cwd: `/workspace/services/${groupName.toLowerCase()}`,
      metadata: { owner: "Platform", tags: [groupIndex % 2 === 0 ? "backend" : "frontend", "development"] },
    })),
  }));
  const entries = buildNodeSearchEntries([createWorkspace("work", tree)]);
  const queries = ["p", "pay", "payments tests", "paymnets tsts", "pst", "platform backend", "analyitcs", "development", "xyzzy"];
  const durations: number[] = [];

  assert.equal(entries.length, 192);

  for (let iteration = 0; iteration < 12; iteration += 1) {
    for (const query of queries) {
      const startTime = performanceHooks.performance.now();

      searchNodeEntries(entries, query);

      if (iteration > 1) durations.push(performanceHooks.performance.now() - startTime);
    }
  }

  durations.sort((leftDuration, rightDuration) => leftDuration - rightDuration);

  const medianDuration = durations[Math.floor(durations.length * 0.5)] ?? Infinity;
  const percentile95Duration = durations[Math.floor(durations.length * 0.95)] ?? Infinity;

  testContext.diagnostic(`192 nodes, ${durations.length} warmed searches: median ${medianDuration.toFixed(2)} ms, p95 ${percentile95Duration.toFixed(2)} ms`);
  assert.ok(percentile95Duration < 100, `Search p95 exceeded 100 ms: ${percentile95Duration}`);
});

function createWorkspace(id: string, tree: TreeNodeConfig[]): WorkspaceModel {
  return {
    kind: "configured", id, name: id,
    resolvedTreeConfig: resolveTreeConfig({ version: 1, tree }, "/workspace"),
  } as WorkspaceModel;
}
