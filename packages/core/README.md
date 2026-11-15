# TreeTY core

`@treety/core` is the host-neutral model and engine behind TreeTY. It provides configuration and local-state parsing, inherited working and project directories, opaque stable node IDs, freeform JSON metadata, immutable tree management, transactional file storage, terminal lifecycle state, and host interfaces without depending on VS Code or a specific terminal emulator.

Tree editing includes before/after ordering, startup-command updates, and targeted JSON Pointer metadata updates. `state.json` stores durable boolean attention separately from `tree.json`. Shared storage helpers use cooperative locks and atomic replacement, while `TreeTYEngine.reconcile()` updates a running tree without replacing matching live sessions.

Host adapters can use `buildTreeTYTerminalEnvironment` to inject TreeTY's standard config, node, metadata, and runtime session context into every terminal they create. Optional `TreeTYTerminalContext.sessionUri` supplies `TREETY_SESSION_URI`, an opaque URI that returns to that exact live session. Omit it when unsupported. Core copies the value unchanged and does not assume an application scheme. `treeTYSessionUriEnvironmentName` exports its environment name. These replace the former `terminalLink` field and `treeTYTerminalLinkEnvironmentName` export.

```ts
import {
  addTreeTerminal,
  createEmptyTreeConfig,
  formatTreeConfigContent,
} from "@treety/core";

const treeConfig = addTreeTerminal(createEmptyTreeConfig(), {
  name: "Workspace shell",
});

console.log(formatTreeConfigContent(treeConfig));
```

## Runtime activity

Each local node state can hold `needsAttention: true` and a `sessions` registry keyed by host session ID. Each registered session can hold an `activity` record with `sessionId`, `reporterId`, `processId`, `state: "busy" | "idle"`, and an optional `metadataPath` JSON Pointer. The pointer's value must equal `reporterId`. Activity belongs to one runtime session. Attention belongs to the persistent node and survives close, restart, and activity cleanup.

Host adapters register live sessions with `registerTreeNodeSession(configFilePath, nodeId, sessionId)` and remove closed sessions with `clearTreeNodeSession(...)`. Registering the same session preserves activity after recovery. Different windows can register independent sessions for the same node. Hosts must unregister each retired session, including the previous session on restart. No host may clear another window's registry entries merely because it cannot see those terminals.

Reporters use `setTreeNodeActivity(configFilePath, nodeId, options)` with an `action` of `register`, `busy`, `idle`, or `unregister`. Register installs an idle reporter, replacing any previous reporter for that runtime session. Busy and idle require the currently registered reporter ID and PID. Busy clears attention. Register and idle preserve attention unless `needsAttention` explicitly changes it. Unregister removes only the matching reporter and preserves attention, including after its metadata guard has been removed. All reporter writes require a registered host session.

`register` and `unregister` are operations, not activity states. `busy` and `idle` describe reported work under TreeTY's convention, not operating-system scheduling states. `reporterId` is an opaque identifier for the reporting integration instance, not an operating-system user or process owner. `sessionId` identifies the terminal runtime created by a TreeTY host. It is distinct from a [POSIX session ID](https://pubs.opengroup.org/onlinepubs/9799919799/functions/getsid.html). `processId` is the reporting process's [PID](https://pubs.opengroup.org/onlinepubs/9799919799/functions/getpid.html).

Activity writes acquire the config lock before the state lock so metadata guards and attention updates are ordered with config mutations. `getTreeNodeActivity(node, nodeState, sessionId)` validates the guard again when reading. Omitting `sessionId` only selects activity when exactly one session is registered. Hosts use native lifecycle evidence and may check the recorded reporter PID when needed. A PID is supplemental evidence, not a durable session identity.

`setTreeNodeAttention(configFilePath, nodeId, needsAttention, expectedSessionId?)` can guard native shell completion against a retired session. Explicit user attention changes can omit the guard. Terminal configuration also accepts `activityAnimation?: boolean` as a per-terminal visual preference.

Upgrade the core, CLI, host adapter, and any activity-reporting integrations together when adopting runtime activity. Older state readers only understand attention and can discard runtime fields during a write. The bundled VS Code CLI stays aligned with its extension.
