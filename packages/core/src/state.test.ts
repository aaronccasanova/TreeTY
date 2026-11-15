import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as test from "node:test";

import { resolveTreeConfig } from "./config";
import type { TreeState } from "./model";
import {
  clearTreeNodeSession,
  formatTreeStateContent,
  getTreeNodeActivity,
  registerTreeNodeSession,
  setTreeNodeActivity,
  getAffectedTreeNodeAttentionIds,
  getTreeNodeNeedsAttention,
  getTreeStateFilePath,
  loadTreeStateFile,
  parseTreeStateContent,
  setTreeNodeAttention,
} from "./state";
import {
  addTreeGroup,
  addTreeTerminal,
  createEmptyTreeConfig,
  updateTreeNode,
} from "./tree-editor";
import { mutateTreeConfigFile, writeTreeConfigFile } from "./tree-storage";

test.test("parses and formats only non-default attention state", () => {
  const treeState = parseTreeStateContent(`{
    "version": 1,
    "nodes": {
      "ready": { "needsAttention": true },
      "idle": { "needsAttention": false }
    }
  }`);

  assert.deepEqual(treeState, {
    version: 1,
    nodes: {
      ready: { needsAttention: true },
    },
  });
  assert.equal(
    formatTreeStateContent(treeState),
    '{\n  "version": 1,\n  "nodes": {\n    "ready": {\n      "needsAttention": true\n    }\n  }\n}\n',
  );
});

test.test("derives collision-free default and custom state paths", () => {
  assert.equal(
    getTreeStateFilePath("/workspace/.treety/tree.json"),
    "/workspace/.treety/state.json",
  );
  assert.equal(
    getTreeStateFilePath("/workspace/config/review.json"),
    "/workspace/config/review.state.json",
  );
});

test.test("propagates terminal attention through ancestor groups", () => {
  assert.equal(
    getTreeNodeNeedsAttention({
      kind: "group",
      id: "group",
      name: "Group",
      cwd: "/workspace",
      env: {},
      restartPolicy: "manual",
      children: [
        {
          kind: "terminal",
          id: "shell",
          name: "Shell",
          cwd: "/workspace",
          env: {},
          needsAttention: true,
          restartPolicy: "manual",
          parentId: "group",
        },
      ],
    }),
    true,
  );
});

test.test("targets attention changes at terminals and ancestor groups", () => {
  const treeConfigWithOuterGroup = addTreeGroup(createEmptyTreeConfig(), {
    id: "outer",
    name: "Outer",
  });
  const treeConfigWithInnerGroup = addTreeGroup(treeConfigWithOuterGroup, {
    id: "inner",
    name: "Inner",
    parentId: "outer",
  });
  const treeConfig = addTreeTerminal(treeConfigWithInnerGroup, {
    id: "shell",
    name: "Shell",
    parentId: "inner",
  });
  const previousTreeState: TreeState = { version: 1, nodes: {} };
  const treeState: TreeState = {
    version: 1,
    nodes: {
      shell: { needsAttention: true },
      missing: { needsAttention: true },
    },
  };
  const resolvedTreeConfig = resolveTreeConfig(
    treeConfig,
    "/workspace",
    treeState,
  );

  assert.deepEqual(
    getAffectedTreeNodeAttentionIds(
      resolvedTreeConfig.tree,
      previousTreeState,
      treeState,
    ),
    ["shell", "inner", "outer"],
  );
  assert.deepEqual(
    getAffectedTreeNodeAttentionIds(
      resolvedTreeConfig.tree,
      treeState,
      treeState,
    ),
    [],
  );
});

test.test("mutates attention idempotently and prunes stale nodes", async () => {
  const temporaryDirPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "treety-state-"),
  );
  const treeConfigFilePath = path.join(
    temporaryDirPath,
    ".treety",
    "tree.json",
  );
  const treeConfig = addTreeTerminal(createEmptyTreeConfig(), {
    id: "shell",
    name: "Shell",
  });

  try {
    await writeTreeConfigFile(treeConfigFilePath, treeConfig);
    await fs.writeFile(
      getTreeStateFilePath(treeConfigFilePath),
      '{"version":1,"nodes":{"stale":{"needsAttention":true}}}\n',
      "utf8",
    );

    await setTreeNodeAttention(
      treeConfigFilePath,
      "shell",
      true,
    );
    const stateFileStat = await fs.stat(
      getTreeStateFilePath(treeConfigFilePath),
    );

    await setTreeNodeAttention(
      treeConfigFilePath,
      "shell",
      true,
    );

    const unchangedStateFileStat = await fs.stat(
      getTreeStateFilePath(treeConfigFilePath),
    );

    assert.deepEqual(await loadTreeStateFile(treeConfigFilePath), {
      version: 1,
      nodes: {
        shell: { needsAttention: true },
      },
    });
    assert.equal(unchangedStateFileStat.ino, stateFileStat.ino);

    await setTreeNodeAttention(
      treeConfigFilePath,
      "shell",
      false,
    );

    assert.deepEqual(await loadTreeStateFile(treeConfigFilePath), {
      version: 1,
      nodes: {},
    });
    assert.match(
      await fs.readFile(
        path.join(temporaryDirPath, ".treety", ".gitignore"),
        "utf8",
      ),
      /state\.json/,
    );
  } finally {
    await fs.rm(temporaryDirPath, { recursive: true, force: true });
  }
});

test.test("preserves attention through activity registration and host session changes", async () => {
  const temporaryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-activity-"));
  const treeConfigFilePath = path.join(temporaryDirPath, "tree.json");
  const treeConfig = addTreeTerminal(createEmptyTreeConfig(), {
    id: "shell",
    name: "Shell",
    metadata: { integrations: { example: { sessionId: "reporter" } } },
  });
  const reporter = {
    sessionId: "host-session",
    reporterId: "reporter",
    processId: 123,
    metadataPath: "/integrations/example/sessionId",
  };

  try {
    await writeTreeConfigFile(treeConfigFilePath, treeConfig);
    await setTreeNodeAttention(treeConfigFilePath, "shell", true);
    await registerTreeNodeSession(treeConfigFilePath, "shell", reporter.sessionId);
    await setTreeNodeActivity(treeConfigFilePath, "shell", { ...reporter, action: "register" });

    const registeredTreeState = await loadTreeStateFile(treeConfigFilePath);

    assert.equal(registeredTreeState.nodes.shell?.needsAttention, true);
    assert.equal(registeredTreeState.nodes.shell?.sessions?.[reporter.sessionId]?.activity?.state, "idle");
    assert.deepEqual(
      await registerTreeNodeSession(treeConfigFilePath, "shell", reporter.sessionId),
      registeredTreeState,
    );
    assert.deepEqual(
      getAffectedTreeNodeAttentionIds(
        resolveTreeConfig(treeConfig, temporaryDirPath).tree,
        { version: 1, nodes: { shell: { needsAttention: true } } },
        registeredTreeState,
      ),
      [],
    );

    await setTreeNodeActivity(treeConfigFilePath, "shell", { ...reporter, action: "busy" });

    const busyTreeState = await loadTreeStateFile(treeConfigFilePath);

    assert.equal(busyTreeState.nodes.shell?.needsAttention, undefined);
    assert.equal(busyTreeState.nodes.shell?.sessions?.[reporter.sessionId]?.activity?.state, "busy");

    await setTreeNodeActivity(treeConfigFilePath, "shell", {
      ...reporter,
      action: "idle",
      needsAttention: true,
    });
    await setTreeNodeAttention(treeConfigFilePath, "shell", false, "stale-session");
    await setTreeNodeActivity(treeConfigFilePath, "shell", {
      ...reporter,
      reporterId: "old-reporter",
      action: "unregister",
    });

    const completedTreeState = await loadTreeStateFile(treeConfigFilePath);

    assert.equal(completedTreeState.nodes.shell?.needsAttention, true);
    assert.equal(completedTreeState.nodes.shell?.sessions?.[reporter.sessionId]?.activity?.state, "idle");
    assert.equal(
      getTreeNodeActivity(treeConfig.tree[0]!, completedTreeState.nodes.shell, "stale-session"),
      undefined,
    );

    await registerTreeNodeSession(treeConfigFilePath, "shell", "replacement-session");

    const concurrentTreeState = await loadTreeStateFile(treeConfigFilePath);

    assert.equal(concurrentTreeState.nodes.shell?.sessions?.[reporter.sessionId]?.activity?.state, "idle");
    assert.deepEqual(concurrentTreeState.nodes.shell?.sessions?.["replacement-session"], {});
    assert.equal(getTreeNodeActivity(treeConfig.tree[0]!, concurrentTreeState.nodes.shell), undefined);

    await clearTreeNodeSession(treeConfigFilePath, "shell", reporter.sessionId);
    await assert.rejects(
      setTreeNodeActivity(treeConfigFilePath, "shell", { ...reporter, action: "busy" }),
      /no longer current/,
    );

    assert.deepEqual((await loadTreeStateFile(treeConfigFilePath)).nodes.shell, {
      needsAttention: true,
      sessions: { "replacement-session": {} },
    });

    await clearTreeNodeSession(treeConfigFilePath, "shell", "replacement-session");

    assert.deepEqual((await loadTreeStateFile(treeConfigFilePath)).nodes.shell, {
      needsAttention: true,
    });
  } finally {
    await fs.rm(temporaryDirPath, { recursive: true, force: true });
  }
});

test.test("rejects stale reporter writes and hides changed metadata guards", async () => {
  const temporaryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-activity-"));
  const treeConfigFilePath = path.join(temporaryDirPath, "tree.json");
  const treeConfig = addTreeTerminal(createEmptyTreeConfig(), {
    id: "shell",
    name: "Shell",
    metadata: { reporter: "first" },
  });
  const reporter = {
    sessionId: "host-session",
    reporterId: "first",
    processId: 123,
    metadataPath: "/reporter",
  };

  try {
    await writeTreeConfigFile(treeConfigFilePath, treeConfig);
    await assert.rejects(
      setTreeNodeActivity(treeConfigFilePath, "shell", { ...reporter, action: "register" }),
      /no longer current/,
    );
    await registerTreeNodeSession(treeConfigFilePath, "shell", reporter.sessionId);
    await setTreeNodeActivity(treeConfigFilePath, "shell", { ...reporter, action: "register" });
    await assert.rejects(
      setTreeNodeActivity(treeConfigFilePath, "shell", { ...reporter, processId: 456, action: "idle" }),
      /no longer registered/,
    );

    const updatedTreeConfig = updateTreeNode(treeConfig, {
      nodeId: "shell",
      metadata: { reporter: "second" },
      metadataAction: "replace",
    });

    await writeTreeConfigFile(treeConfigFilePath, updatedTreeConfig);

    const staleTreeState = await loadTreeStateFile(treeConfigFilePath);

    assert.equal(getTreeNodeActivity(updatedTreeConfig.tree[0]!, staleTreeState.nodes.shell), undefined);
    await assert.rejects(
      setTreeNodeActivity(treeConfigFilePath, "shell", { ...reporter, action: "idle", needsAttention: true }),
      /does not match/,
    );
    await assert.rejects(
      setTreeNodeActivity(treeConfigFilePath, "shell", { ...reporter, action: "register" }),
      /does not match/,
    );

    assert.equal((await loadTreeStateFile(treeConfigFilePath)).nodes.shell?.needsAttention, undefined);

    await setTreeNodeActivity(treeConfigFilePath, "shell", { ...reporter, action: "unregister" });
    await setTreeNodeActivity(treeConfigFilePath, "shell", { ...reporter, action: "unregister" });
    await setTreeNodeActivity(treeConfigFilePath, "shell", {
      ...reporter,
      reporterId: "second",
      processId: 456,
      action: "register",
      needsAttention: true,
    });
    await setTreeNodeActivity(treeConfigFilePath, "shell", { ...reporter, action: "unregister" });

    const replacementTreeState = await loadTreeStateFile(treeConfigFilePath);

    assert.equal(replacementTreeState.nodes.shell?.sessions?.[reporter.sessionId]?.activity?.reporterId, "second");
    assert.equal(replacementTreeState.nodes.shell?.needsAttention, true);
    await setTreeNodeAttention(treeConfigFilePath, "shell", false);
    assert.equal((await loadTreeStateFile(treeConfigFilePath)).nodes.shell?.sessions?.[reporter.sessionId]?.activity?.reporterId, "second");
  } finally {
    await fs.rm(temporaryDirPath, { recursive: true, force: true });
  }
});

test.test("rejects malformed activity state and runtime identities", () => {
  const activity = { sessionId: "session", reporterId: "reporter", processId: 123, state: "idle" };

  for (const invalidActivity of [
    { ...activity, sessionId: "" },
    { ...activity, sessionId: "other" },
    { ...activity, reporterId: "white space" },
    { ...activity, processId: -1 },
    { ...activity, processId: 1.5 },
    { ...activity, processId: Number.MAX_SAFE_INTEGER + 1 },
    { ...activity, state: "running" },
    { ...activity, metadataPath: "reporter" },
    { ...activity, metadataPath: "/~2" },
  ]) {
    assert.throws(() => parseTreeStateContent(JSON.stringify({
      version: 1,
      nodes: { shell: { sessions: { session: { activity: invalidActivity } } } },
    })));
  }

  assert.deepEqual(parseTreeStateContent(JSON.stringify({
    version: 1,
    nodes: { shell: { sessions: { session: { activity } } } },
  })).nodes.shell, { sessions: { session: { activity } } });
});

test.test("serializes guarded attention with metadata configuration changes", async () => {
  const temporaryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "treety-activity-lock-"));
  const treeConfigFilePath = path.join(temporaryDirPath, "tree.json");
  const treeConfig = addTreeTerminal(createEmptyTreeConfig(), {
    id: "shell",
    name: "Shell",
    metadata: { reporter: "first" },
  });
  const reporter = {
    sessionId: "host-session",
    reporterId: "first",
    processId: 123,
    metadataPath: "/reporter",
  };
  let releaseConfiguration: () => void = () => undefined;
  let markConfigurationStarted: () => void = () => undefined;
  const configurationReleased = new Promise<void>((resolve) => { releaseConfiguration = resolve; });
  const configurationStarted = new Promise<void>((resolve) => { markConfigurationStarted = resolve; });

  try {
    await writeTreeConfigFile(treeConfigFilePath, treeConfig);
    await registerTreeNodeSession(treeConfigFilePath, "shell", reporter.sessionId);
    await setTreeNodeActivity(treeConfigFilePath, "shell", { ...reporter, action: "register" });

    const configurationTransaction = mutateTreeConfigFile(treeConfigFilePath, async (currentTreeConfig) => {
      markConfigurationStarted();
      await configurationReleased;

      return updateTreeNode(currentTreeConfig, {
        nodeId: "shell",
        metadataAction: "replace",
        metadata: { reporter: "second" },
      });
    });

    await configurationStarted;

    const activityTransaction = setTreeNodeActivity(treeConfigFilePath, "shell", {
      ...reporter,
      action: "idle",
      needsAttention: true,
    });
    const rejectedActivityTransaction = assert.rejects(activityTransaction, /does not match/);
    const earlyActivityResult = await Promise.race([
      activityTransaction.then(() => "completed", () => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 40)),
    ]);

    releaseConfiguration();
    await Promise.all([configurationTransaction, rejectedActivityTransaction]);

    assert.equal(earlyActivityResult, "waiting");
    assert.equal((await loadTreeStateFile(treeConfigFilePath)).nodes.shell?.needsAttention, undefined);
  } finally {
    releaseConfiguration();
    await fs.rm(temporaryDirPath, { recursive: true, force: true });
  }
});
