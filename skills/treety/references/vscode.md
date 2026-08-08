# TreeTY for VS Code reference

The `TreeTY.treety` extension renders global and workspace configurations in a dedicated Activity Bar tree and uses native VS Code integrated terminals as its process host.

## Understand configuration and refresh

- Local trees live at `<workspace>/.treety/tree.json`.
- Global trees live at `$XDG_CONFIG_HOME/treety/tree.json` or `~/.config/treety/tree.json`.
- Local relative working directories resolve from the workspace folder.
- Global relative working directories resolve from the user's home directory.
- Working directories (`cwd`) inherit through groups and seed native terminal processes.
- Optional project directories (`projectDir`) inherit separately and control VS Code workspace-folder integration.
- The extension watches both local and global `tree.json` files for creation, changes, and deletion.
- The extension also watches sibling `state.json` files for durable attention changes.

A successful CLI mutation should therefore update the TreeTY view without reloading the VS Code window. No `code` CLI command is required. If the view remains stale, run `TreeTY: Refresh` from the Command Palette. Reload the window only after the targeted refresh fails.

Tree changes reconcile only the workspace model identified by the changed URI. Existing terminal sessions and subscriptions survive moves, renames, metadata changes, inherited-setting changes, and launch-setting changes. Added nodes appear in place, removed leaves close their matching sessions, and newly applicable `onOpen` policies retain automatic launch behavior. State-only changes refresh attention without rebuilding the engine.

## Distinguish definitions from sessions

The CLI creates and changes persistent tree definitions. The VS Code adapter owns live sessions.

- `manual` is the default restart policy. VS Code recovers a persisted native session when one exists; otherwise it waits until the terminal leaf is opened or restarted.
- `onOpen` recovers an existing session or launches the terminal as soon as the extension loads the tree.
- Selecting a terminal leaf creates or reveals its native terminal.
- Stop closes the native terminal but keeps its tree entry.
- Delete removes the entry after confirmation and closes a running session in the removed subtree.
- A valid watched configuration update that removes a leaf also closes its matching live terminal.

Use `--restart-policy onOpen` in an agent-driven CLI command only when an automatic process launch is intended. Remember that a startup command stored in configuration executes when the host launches the terminal, not when the CLI writes it.

## Use native VS Code behavior

An interactive leaf without `shell` uses the user's default VS Code terminal profile. A leaf with `shell` uses that executable and its arguments. A leaf with `command` launches the configured executable directly.

TreeTY marks sessions as stopped, starting, idle, running, or failed. VS Code terminal persistence allows the adapter to reattach matching TreeTY sessions after an extension-host restart rather than creating duplicates.

Attention is a separate durable boolean. A terminal that needs attention receives a small `!` decoration with the tooltip `Needs attention`; ancestor groups receive the same decoration while descendants need attention. Opening or revealing the terminal clears it without changing the lifecycle icon or status description.

## Connect Explorer and Source Control

`TreeTY: Explorer Directory Sync` controls whether opening a terminal adds its configured project directory to the VS Code workspace:

- `never` leaves workspace folders unchanged.
- `prompt` asks before adding an external directory.
- `always` adds the directory automatically.

The setting defaults to `never`. No `projectDir` means no add-folder action. Adding the folder exposes it to Explorer and lets VS Code's native Source Control integration discover repositories there. Use `TreeTY: Add Project Directory to VS Code Workspace...` from a terminal's context menu for an explicit one-time action. TreeTY shows the exact absolute path before changing the workspace.

Use Configure Node from a group or terminal context menu to edit `cwd`, `projectDir`, environment overrides, freeform metadata, or restart policy. Move opens a searchable, collapsible representation of the tree. Use a destination row's inline controls to insert above, inside a root or group, or below. The editor supports terminals, whole groups, and cross-group moves without generating every possible insertion point as a separate row. Hover a node to inspect its resolved paths and stable ID.

The adapter uses `@treety/core` to inject `TREETY_CONFIG_FILE`, `TREETY_CONFIG_SOURCE`, `TREETY_NODE_ID`, `TREETY_NODE_METADATA`, and `TREETY_SESSION_ID` into each native terminal. `TREETY_NODE_METADATA` is a launch-time snapshot; use `treety metadata get` for current configuration after metadata changes.

`TreeTY: Global Tree Visibility` controls whether the global root is always shown, used only as a fallback, or hidden when workspace folders are open. Empty VS Code windows always show the global root.

## Respect current adapter limits

Do not use the CLI as if it were a live VS Code remote-control protocol. It cannot reveal, restart, or stop an existing native terminal. Those operations currently belong to extension commands and tree controls. Configuration file watching provides CLI-to-view synchronization, while `onOpen` provides configuration-driven launch behavior.
