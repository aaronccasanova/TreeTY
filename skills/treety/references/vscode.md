# TreeTY for VS Code reference

The `TreeTY.treety` extension renders global and workspace configurations in a dedicated Activity Bar tree and uses native VS Code integrated terminals as its process host.

## Understand configuration and refresh

- Local trees live at `<workspace>/.treety/tree.json`.
- Global trees live at `$XDG_CONFIG_HOME/treety/tree.json` or `~/.config/treety/tree.json`.
- Local relative working directories resolve from the workspace folder.
- Global relative working directories resolve from the user's home directory.
- The extension watches both local and global `tree.json` files for creation, changes, and deletion.

A successful CLI mutation should therefore update the TreeTY view without reloading the VS Code window. No `code` CLI command is required. If the view remains stale, run `TreeTY: Refresh` from the Command Palette. Reload the window only after the targeted refresh fails.

## Distinguish definitions from sessions

The CLI creates and changes persistent tree definitions. The VS Code adapter owns live sessions.

- `manual` is the default restart policy. VS Code recovers a persisted native session when one exists; otherwise it waits until the terminal leaf is opened or restarted.
- `onOpen` recovers an existing session or launches the terminal as soon as the extension loads the tree.
- Selecting a terminal leaf creates or reveals its native terminal.
- Stop closes the native terminal but keeps its tree entry.
- Delete removes the entry after confirmation and closes a running session in the removed subtree.

Use `--restart-policy onOpen` in an agent-driven CLI command only when an automatic process launch is intended. Remember that a startup command stored in configuration executes when the host launches the terminal, not when the CLI writes it.

## Use native VS Code behavior

An interactive leaf without `shell` uses the user's default VS Code terminal profile. A leaf with `shell` uses that executable and its arguments. A leaf with `command` launches the configured executable directly.

TreeTY marks sessions as stopped, starting, idle, running, or failed. VS Code terminal persistence allows the adapter to reattach matching TreeTY sessions after an extension-host restart rather than creating duplicates.

## Connect Explorer and Source Control

`TreeTY: Explorer Directory Sync` controls whether opening a terminal adds its resolved working directory to the VS Code workspace:

- `never` leaves workspace folders unchanged.
- `prompt` asks before adding an external directory.
- `always` adds the directory automatically.

Adding the folder exposes it to Explorer and lets VS Code's native Source Control integration discover repositories there. Use `TreeTY: Add Directory to VS Code Workspace` from a terminal's context menu for an explicit one-time action.

`TreeTY: Global Tree Visibility` controls whether the global root is always shown, used only as a fallback, or hidden when workspace folders are open. Empty VS Code windows always show the global root.

## Respect current adapter limits

Do not use the CLI as if it were a live VS Code remote-control protocol. It cannot reveal, restart, or stop an existing native terminal. Those operations currently belong to extension commands and tree controls. Configuration file watching provides CLI-to-view synchronization, while `onOpen` provides configuration-driven launch behavior.
