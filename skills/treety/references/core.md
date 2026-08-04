# TreeTY core reference

Use `@treety/core` to build or extend host adapters. Keep host UI, filesystem discovery, and process implementation outside the package.

## Use the public surfaces

The package exports these main concerns:

- Configuration: `parseTreeConfigContent`, `formatTreeConfigContent`, `resolveTreeConfig`, and `TreeConfigError`
- Immutable tree editing: `createEmptyTreeConfig`, `addTreeGroup`, `addTreeTerminal`, `renameTreeNode`, `moveTreeNode`, `removeTreeNode`, `getTreeNode`, `createTreeNodeId`, and `TreeNodeOperationError`
- Lifecycle orchestration: `TreeTYEngine` and `TerminalSessionStore`
- Host integration: `TerminalHost`, `TerminalLaunchRequest`, `HostedTerminalSession`, and `TerminalHostEvent`
- Models: unresolved and resolved tree nodes, defaults, commands, shells, environment values, restart policies, and terminal session states

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
- Merges inherited environment values, with `null` preserved for host-level removal.
- Inherits shell and restart policy values.
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

The host must provide stable session IDs and associate recovered sessions with TreeTY node IDs. Emit `started`, `idle`, and `closed` events with both identifiers. The engine uses these events to maintain stopped, starting, idle, running, and failed states.

## Keep responsibilities separate

Let the engine decide whether to recover, create, reveal, restart, or stop a session. Let the host translate those decisions into its terminal system. Let the adapter own:

- Configuration file discovery and persistence
- UI rendering and user interaction
- Process or terminal creation
- Host-native session recovery metadata
- File watching and configuration reloads

Do not add VS Code imports, terminal-emulator assumptions, or host-specific paths to `@treety/core`.
