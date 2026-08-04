# TreeTY core reference

Use `@treety/core` to build or extend host adapters. Keep host UI, filesystem discovery, and process implementation outside the package.

## Use the public surfaces

The package exports these main concerns:

- Configuration: `parseTreeConfigContent`, `formatTreeConfigContent`, `resolveTreeConfig`, and `TreeConfigError`
- Immutable tree editing: `createEmptyTreeConfig`, `addTreeGroup`, `addTreeTerminal`, `updateTreeNode`, `renameTreeNode`, `moveTreeNode`, `removeTreeNode`, `getTreeNode`, `createTreeNodeId`, and `TreeNodeOperationError`
- Lifecycle orchestration: `TreeTYEngine` and `TerminalSessionStore`
- Host integration: `TerminalHost`, `TerminalLaunchRequest`, `HostedTerminalSession`, and `TerminalHostEvent`
- Terminal context: `buildTreeTYTerminalEnvironment`, `TreeTYTerminalContext`, and the exported environment names
- Models: unresolved and resolved tree nodes, opaque IDs, working and project directories, freeform JSON metadata, defaults, commands, shells, environment values, restart policies, and terminal session states

Import from the package root:

```ts
import {
  addTreeTerminal,
  createEmptyTreeConfig,
  formatTreeConfigContent,
} from "@treety/core";

const treeConfig = addTreeTerminal(createEmptyTreeConfig(), {
  id: "workspace-shell",
  name: "Workspace shell",
});

const treeConfigFileContent = formatTreeConfigContent(treeConfig);
```

## Resolve inheritance before hosting

Call `resolveTreeConfig(treeConfig, workspaceDirPath)` before constructing an engine. Resolution:

- Makes every working directory absolute.
- Resolves relative `cwd` values from the nearest ancestor.
- Preserves an absolute `projectDir`, or resolves a relative value from that node's working directory, then inherits the resolved project directory independently.
- Merges inherited environment values, with `null` preserved for host-level removal.
- Inherits shell and restart policy values.
- Preserves node metadata without inheritance or merge semantics.
- Defaults `restartPolicy` to `manual`.

Parse untrusted JSON with `parseTreeConfigContent` rather than casting it. Format writes with `formatTreeConfigContent` to validate the model and include a trailing newline.

## Implement a host adapter

Implement the `TerminalHost` contract:

```ts
interface TerminalHost {
  getSessions(): Promise<HostedTerminalSession[]>;
  createSession(request: TerminalLaunchRequest): Promise<HostedTerminalSession>;
  revealSession(hostSessionId: string): void;
  closeSession(hostSessionId: string): void;
  subscribe(listener: TerminalHostEventListener): Disposable;
  dispose(): void;
}
```

Then resolve configuration, construct `TreeTYEngine`, and call `start()`:

```ts
const resolvedTreeConfig = resolveTreeConfig(treeConfig, workspaceDirPath);
const treeTYEngine = new TreeTYEngine(resolvedTreeConfig, terminalHost);

await treeTYEngine.start();
```

The host must provide session IDs and associate recovered sessions with TreeTY node IDs. A session ID identifies one runtime terminal instance; a node ID identifies the persistent terminal definition. Emit `started`, `idle`, and `closed` events with both identifiers. The engine uses these events to maintain stopped, starting, idle, running, and failed states. `TerminalLaunchRequest` includes the resolved `cwd`, inherited environment, and optional node metadata.

Before creating a terminal process, use `buildTreeTYTerminalEnvironment` with the resolved config file path, config source, node ID, metadata, and host session ID. Merge the result after user-configured environment values so the reserved TreeTY context cannot be overridden. This standardizes `TREETY_CONFIG_FILE`, `TREETY_CONFIG_SOURCE`, `TREETY_NODE_ID`, `TREETY_NODE_METADATA`, and `TREETY_SESSION_ID` across adapters.

## Keep responsibilities separate

Let the engine decide whether to recover, create, reveal, restart, or stop a session. Let the host translate those decisions into its terminal system. Let the adapter own:

- Configuration file discovery and persistence
- UI rendering and user interaction
- Process or terminal creation
- Host-native session recovery metadata
- File watching and configuration reloads

Do not add VS Code imports, terminal-emulator assumptions, or host-specific paths to `@treety/core`.
