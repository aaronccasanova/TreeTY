# TreeTY for VS Code reference

The `TreeTY.treety` extension renders global and workspace configurations in a dedicated Activity Bar tree and uses native VS Code integrated terminals as its process host.

## Install a local build and use its CLI

On macOS or Linux, run `pnpm install:snapshot` from the TreeTY checkout for the local development workflow. It installs dependencies with the frozen lockfile, builds the required core package and extension, packages a timestamped VSIX, and installs it using the VS Code `code` launcher. Node.js 22 or newer, the repository's pinned pnpm version, and `code` must be available on `PATH`. Use `pnpm package:snapshot` after dependency installation to build the artifact without changing the installed extension. The Node packaging helper does not support Windows command launchers. Follow the manual Windows build commands in the repository README instead.

Reload the VS Code window after installing, then create new terminals. The extension prepends its bundled CLI directory to new integrated terminals' `PATH`, including ordinary VS Code terminals. Prefer that `treety` executable over an independently installed version. Existing terminals keep their previous environment. The CLI still needs Node.js on `PATH`, and the standalone npm package remains available outside VS Code.

Local builds do not require publishing or merging the generated release PR. Continue including Changesets with shipped changes for occasional releases.

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

## Find nodes in large trees

Use the search icon in the TreeTY title bar or `TreeTY: Search nodes` to find groups and terminals across current roots. The native QuickPick supports name abbreviations, small typos, ancestor/workspace names, directories, and descriptive metadata. Terms can match separate fields, such as a group name and leaf name. Results include ancestry to distinguish duplicate names.

Accepting a group reveals and expands it. Accepting a terminal opens or reveals its native session through the usual controller behavior, including clearing attention. Cancelling does not launch a terminal. Search updates with tree changes and resolves the current node identity before accepting a selection.

Only strings or string arrays in the metadata fields `title`, `description`, `summary`, `tags`, `labels`, `owner`, `project`, `service`, `category`, and `aliases` are searchable. Group metadata provides context for descendants. Environment, commands, nested metadata objects, and integration data are excluded.

## Distinguish definitions from sessions

The CLI creates and changes persistent tree definitions. The VS Code adapter owns live sessions.

- `manual` is the default restart policy. VS Code recovers a persisted native session when one exists; otherwise it waits until the terminal leaf is opened or restarted.
- `onOpen` recovers an existing session or launches the terminal as soon as the extension loads the tree.
- Selecting a terminal leaf creates or reveals its native terminal.
- Stop closes the native terminal but keeps its tree entry.
- Delete removes the entry after confirmation and closes a running session in the removed subtree.
- A valid watched configuration update that removes a leaf also closes its matching live terminal.

Use `--restart-policy onOpen` in a scripted CLI command only when an automatic process launch is intended. Remember that a startup command stored in configuration executes when the host launches the terminal, not when the CLI writes it.

## Use native VS Code behavior

An interactive leaf without `shell` uses the user's default VS Code terminal profile. A leaf with `shell` uses that executable and its arguments. A leaf with `command` launches the configured executable directly.

TreeTY marks sessions as stopped, starting, idle, running, or failed. VS Code terminal persistence allows the adapter to reattach matching TreeTY sessions after an extension-host restart rather than creating duplicates.

Attention is a separate durable boolean. A terminal that needs attention receives a small `!` decoration with the tooltip `Needs attention`; ancestor groups receive the same decoration while descendants need attention. Opening or revealing the terminal clears it without changing the lifecycle icon or status description.

## Use terminal links

**Copy terminal link** is available on running terminals through their actions and context menus. `treety uri` prints the host-provided `TREETY_SESSION_URI` unchanged without opening it and accepts no target selectors. Programs inside a TreeTY terminal can also read the variable directly. This is an optional host-neutral context value. VS Code is its current producer. Pi's `/treety-link` and `/treety-unlink` associate a Pi session with a terminal definition and are unrelated to these URIs.

Migrate `treety link` to `treety uri` and `TREETY_TERMINAL_LINK` to `TREETY_SESSION_URI`. The old names are not aliases. Recreate hosted terminals after updating so their environment contains the new name. A shell integration can use `session_uri="$(treety uri)"` and handle command failure, or read the optional value directly:

```sh
session_uri="${TREETY_SESSION_URI:-}"
if [ -n "$session_uri" ]; then
  printf '%s\n' "$session_uri"
fi
```

Pass the nonempty value as the notification or application's URL field. If it is absent, omit the terminal destination or use **Copy terminal link** in the intended terminal's menu. Ordinary VS Code terminals have the bundled CLI but no TreeTY link. Do not infer a destination from another terminal or a stale process environment.

TreeTY constructs the target with `vscode.Uri.file(configFilePath).toString()`, the node ID, and the live runtime session ID. It uses `URLSearchParams` for those query values and `vscode.Uri.from` with `vscode.env.uriScheme`, the extension ID, and `/open`, then resolves the entire URI through `vscode.env.asExternalUri`. Preserve the returned string exactly. The [VS Code API contract](https://code.visualstudio.com/api/references/vscode-api#env.asExternalUri) treats this result as opaque. Do not decode, re-encode, rebuild, or add query fields. `TREETY_CONFIG_FILE`, `TREETY_NODE_ID`, and `TREETY_SESSION_ID` alone do not contain VS Code's originating-window routing, so a shell-only construction recipe is not equivalent.

Links currently support local desktop VS Code, including Insiders. The handler waits for TreeTY startup, validates the loaded configuration and latest terminal definition, and requires the exact live session before focusing it and clearing attention. It never loads a new config or starts a terminal. Closed/restarted sessions, deleted nodes, unrelated windows, and remote windows fail safely. Recovered native sessions retain their links across extension reloads. A terminal created before link support needs to be recreated once, or its current link can be copied from the UI. Consumers must support the returned application URL scheme.

## Connect Explorer and Source Control

`TreeTY: Explorer Directory Sync` controls whether opening a terminal adds its configured project directory to the VS Code workspace:

- `never` leaves workspace folders unchanged.
- `prompt` asks before adding an external directory.
- `always` adds the directory automatically.

The setting defaults to `never`. Adding a folder exposes it to Explorer and lets VS Code's native Source Control integration discover repositories there. Use Add directory to VS Code workspace from any group or terminal's actions or context menu for an explicit one-time action. A terminal prefers the resolved `projectDir`, then a live current working directory reported by VS Code shell integration, then an explicitly configured or inherited `cwd`. A group with no configured directory opens a filterable picker containing the best available directory for each descendant terminal. The picker also accepts another relative or absolute path. TreeTY shows the exact absolute path before changing the workspace. If no directory source is available, TreeTY explains that the live directory could not be determined instead of substituting the global tree's implicit home-directory base.

Group hover controls expose create terminal, create group, delete, and actions. Terminal hover controls expose delete and actions. The actions gear stays at the far right and opens a complete picker for the node, including delete, group creation shortcuts, and applicable terminal session actions. Right-click remains available, and its action labels omit the redundant TreeTY category shown in the global Command Palette.

Use Configure from a group or terminal actions menu to edit `cwd`, `projectDir`, environment overrides, freeform metadata, or restart policy. Directory configuration uses a filterable path field that accepts relative or absolute paths and preserves direct configuration values. A terminal offers its live current directory when VS Code shell integration reports it. A group recursively collects live directories from every descendant terminal, deduplicates them, and labels them with their tree locations. Group suggestions do not depend on the active terminal. When live directory information isn't available, the field suggests an explicitly configured inherited directory or remains empty instead of suggesting the global tree's implicit home directory. Move opens a searchable, collapsible representation of the tree with every group expanded. The top-right expand control opens the entire tree. Like the sidebar's Collapse all, the collapse control first closes groups beneath the open root, then closes the root on a subsequent click. If no top-level groups are expanded, it closes the root immediately. The collapse and expand controls clear any active search. Select an individual group to toggle it. A destination row orders its inline controls as insert above, insert below, and move inside when applicable, which keeps the inside arrow at the far right. Terminal rows receive an extra indentation step so the hierarchy remains clear. The editor supports terminals, whole groups, and cross-group moves without generating every possible insertion point as a separate row. Hover a node to inspect its resolved paths and stable ID.

The adapter uses `@treety/core` to inject `TREETY_CONFIG_FILE`, `TREETY_CONFIG_SOURCE`, `TREETY_NODE_ID`, `TREETY_NODE_METADATA`, and `TREETY_SESSION_ID` into each native terminal. `TREETY_NODE_METADATA` is a launch-time snapshot; use `treety metadata get` for current configuration after metadata changes.

`TreeTY: Global Tree Visibility` controls whether the global root is always shown, used only as a fallback, or hidden when workspace folders are open. Empty VS Code windows always show the global root.

## Respect current adapter limits

Do not use the CLI as if it were a live VS Code remote-control protocol. It cannot reveal, restart, or stop an existing native terminal. Those operations currently belong to extension commands and tree controls. Configuration file watching provides CLI-to-view synchronization, while `onOpen` provides configuration-driven launch behavior.

## Read status and activity

Terminal status uses theme-aware circles with text and tooltips. A native spinner appears after one second of known work. Activity is separate from process status and durable attention. Ordinary shell commands require native shell integration, and commands lasting at least five seconds mark attention on completion. Explicit activity reports override their enclosing command and supply their own completion attention.

Use `treety.activityAnimation` (`auto` or `off`) globally, or **Configure > Activity animation** / terminal `activityAnimation` locally. Disabling animation preserves activity text and attention. Respect disabled native terminal-tab animation and explicit `workbench.reduceMotion: on`. Do not claim that the public API resolves the system preference for `auto` or exposes exact terminal focus. TreeTY does not suppress completion attention based on `activeTerminal`.

Keep the extension, bundled CLI, and any activity-reporting integrations aligned. Old state writers can discard runtime activity fields. Recreate terminals after upgrades to refresh their bundled CLI environment. Runtime activity is scoped to each session so multiple windows can host the same definition independently. Cleanup preserves attention.
