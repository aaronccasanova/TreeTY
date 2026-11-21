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

On versions with saved expansion state, refresh and window reload preserve collapsed groups and roots. New groups start collapsed after expansion state has been saved. If a CLI-created leaf is not visible, expand its ancestors or use node search before treating the configuration reload as failed. Collapse all still closes groups first and roots on the next use.

## Find nodes in large trees

Use the search icon in the TreeTY title bar or `TreeTY: Search nodes` to find groups and terminals across current roots. The native QuickPick supports name abbreviations, small typos, ancestor/workspace names, directories, and descriptive metadata. Terms can match separate fields, such as a group name and leaf name. Results include ancestry to distinguish duplicate names.

Accepting a group reveals and expands it. Accepting a terminal opens or reveals its native session through the usual controller behavior, including clearing attention. Cancelling does not launch a terminal. Search updates with tree changes and resolves the current node identity before accepting a selection.

Only strings or string arrays in the metadata fields `title`, `description`, `summary`, `tags`, `labels`, `owner`, `project`, `service`, `category`, and `aliases` are searchable. Group metadata provides context for descendants. Environment, commands, nested metadata objects, and integration data are excluded.

## Distinguish definitions from sessions

The CLI creates and changes persistent tree definitions. The VS Code adapter owns live sessions.

- `manual` is the default restart policy. TreeTY recovers an identifiable persisted native session, or waits until the terminal leaf is opened or restarted.
- `onOpen` recovers an identifiable session or launches the terminal when the extension loads the tree, unless a saved session remains unresolved.
- Selecting a terminal leaf creates or reveals its native terminal.
- Stop closes the native terminal but keeps its tree entry.
- Delete removes the entry after confirmation and closes a running session in the removed subtree.
- A valid watched configuration update that removes a leaf also closes its matching live terminal.

Use `--restart-policy onOpen` in a scripted CLI command only when an automatic process launch is intended. Remember that a startup command stored in configuration executes when the host launches the terminal, not when the CLI writes it.

## Open a leaf in the intended window

After [creating a manual leaf](cli.md#create-a-leaf-for-an-explicit-window), run the following through an extension or an available VS Code automation bridge in the intended window. Select that window through the bridge first. This is extension-host TypeScript using the VS Code API, not a shell or `code` CLI command. The config path selects a loaded tree inside that window, not the window itself.

Check the activated API version before using the new command target contract. The command name existed before explicit targets, so command availability alone is insufficient. Replace the target values with the CLI receipt's `configFilePath` and `node.id`:

```ts
const treeTYExtension = vscode.extensions.getExtension("TreeTY.treety");

const treeTYApi = await treeTYExtension?.activate();

if (treeTYApi?.apiVersion !== 1) throw new Error("TreeTY API version 1 is required.");

const target = {
  configFile: "/absolute/path/to/tree.json",
  nodeId: "<node-id-from-receipt>",
};

const opened = await vscode.commands.executeCommand<boolean>("treety.openTerminal", target);

if (opened !== true) throw new Error("TreeTY did not complete the open operation.");
```

Use an absolute config path already loaded in this window. A bare ID is supported only when unique across its loaded trees. Empty, unknown, or ambiguous targets reject. If a just-created leaf is not yet visible to the command, await `treety.refresh` in the same window, then retry the same explicit target. Do not substitute a different node or change its restart policy.

Open reveals an existing session or starts a terminal session for a stopped leaf and clears attention. Await its boolean result: `false` means cancellation, and errors reject. Restart and stop follow the same completion contract. Stop retains the configured confirmation unless the caller deliberately supplies `confirm: false`. Disposal does not prove all descendant processes exited. Recovery conflicts retain their separate **Forget previous session and start** decision.

If API v1 is unavailable, use the UI or an authorized extension update. Retain `onOpen` for automatic startup. Its global-tree window ownership policy is unchanged.

## Look up an exact live session

Activate and check API v1 as above. After opening a leaf, use its explicit `target` to find the current native handle and capture its verified identity:

```ts
const terminalCurrent = await treeTYApi.getTerminal(target);

if (!terminalCurrent) throw new Error("The leaf has no live session in this window.");

const terminalIdentity = await treeTYApi.getTerminalIdentity(terminalCurrent);

if (!terminalIdentity) throw new Error("The terminal has no verified TreeTY identity.");
```

`getTerminalIdentity` returns `{ configFile, nodeId, sessionId }` or `undefined`, including for verified restored terminals with empty creation environments. If you already have the intended native handle, pass it directly. Do not infer identity from a title, PID, or whichever terminal happens to be active. The captured identity describes the session live at lookup time. Opening returns only a boolean, so a concurrent restart between open and capture can change which session you capture.

Store all three identity fields. Later, in the intended window with API v1 checked, look up that exact session:

```ts
const terminal = await treeTYApi.getTerminal(terminalIdentity);

if (!terminal) throw new Error("That exact TreeTY session is not live in this window.");
```

Including `sessionId` rejects a replacement after restart. Omitting it asks for the current session of the leaf instead. Both lookup methods are asynchronous and use verified live bindings in the current window. Closed, closing, removed, unbound, or ambiguous sessions do not resolve. Invalid targets reject.

The lookup methods do not launch, reveal, or clear attention. Extension activation itself still applies configured `onOpen` policies. If an exact lookup is absent, do not drop `sessionId` or call `openTerminal` as a fallback. Revalidate after unrelated asynchronous work before acting on a saved identity. See the [public TypeScript contract](https://github.com/aaronccasanova/TreeTY/blob/main/packages/vscode/src/public-api.ts) for the complete types.

## Recover native sessions

New native titles end with `[treety:<token>]`, where the token is 128 random bits encoded as 22 base64url characters using Node.js's built-in cryptography. No new dependency is needed. TreeTY labels use the plain configured name. A TreeTY rename updates configuration without changing the existing native title or token. The next launch uses the new name.

Each token has its own exclusively created file in the extension's shared global storage directory, binding the configuration path, workspace, host, node, and session. A lock for each leaf coordinates launches across windows sharing that storage and scope. A known active window owner blocks another launch, as do multiple matching local terminals. Recovery requires a token or creation metadata without conflicting identity. A saved PID is advisory and may have been reused. Do not treat a display name, `TreeTY:` prefix, or PID as ownership proof.

New owner records use a local socket handshake to distinguish an extension activation from a reused PID. A missing or refused endpoint clears that owner's veto. An uncertain probe retains it. If endpoint startup fails, creation and recovery use conservative PID checks and retry startup on later ownership writes. Legacy records, fallback records, and abandoned transaction locks retain PID checks that can block after PID reuse. Deactivation closes the endpoint after pending session operations finish. Windows uses a named pipe, but Windows recovery has not been validated on a Windows desktop.

Titles can arrive asynchronously. TreeTY checks on load, native terminal opening, leaf opening, and Refresh. Open the leaf or refresh again if the title appears later. Do not infer that a record is stale because its old PID exited, time elapsed, or its terminal is absent from this window. VS Code can revive a saved terminal with a new process. Its native trash action and terminal transfers share the `User` close reason, so TreeTY preserves that identity and reopening may need confirmation even after the PID exits. Confirmed process exits and TreeTY's **Stop** action clear the corresponding records.

An unresolved record blocks automatic replacement. Without an active window owner, opening the leaf offers **Forget previous session and start**, even if its saved PID is still alive. Use this only after closing the previous terminal, including in other windows. The choice retires the saved identity, clears its owner and PID, and starts a new session without closing any terminal. The token remains available to recognize a late restored tab and has no time-based expiry, but the retired record alone does not block launches. VS Code may still restore the old native tab later. Known active window owners and matching local terminals cannot be bypassed. Cancel and refresh to retry recovery.

On `Shutdown`, TreeTY records the originating window's persistence settings. Reopening automatically retires an unowned saved record when `terminal.integrated.enablePersistentSessions` was disabled, or when `terminal.integrated.persistentSessionReviveProcess` was `never` and its recorded PID has exited. A new launch then needs no confirmation, and the token remains available for late recovery. Other shutdown records continue to guard reconnection or revival. Do not use another window's current settings to decide whether the saved session can be retired.

Disposal honors an already-exposed exit status even before its close event arrives. Disposing a live handle doesn't imply shutdown. Do not expire retained tokens by age or count: a late handle would lose its identity, and later recovery cannot undo a replacement already launched. Record scans bound concurrent reads and reuse unchanged contents, though retained files still accumulate.

If a native title loses its token, restore the original suffix and refresh. Historical unmarked terminals with empty creation environments cannot be recovered automatically. Missing or corrupt records also limit identification and duplicate prevention. Coordination applies to readable records in the same shared storage scope. TreeTY uses the absolute `globalStoragePath` supplied by the Node extension host for both `file` and `vscode-userdata` storage URIs. If that filesystem path is unavailable, TreeTY warns and keeps the tree available, recovers terminals from creation metadata where possible, and blocks new launches.

Do not close or relaunch ambiguous terminals as a cleanup step. Environment-relaunch warnings do not establish ownership or liveness. Regression coverage includes modeled API handles, concurrent file access, real owner sockets, and isolated desktop checks on macOS with VS Code 1.146.0. Window reload with persistence enabled and full quit/reopen with persistence enabled or disabled recovered before Refresh with one terminal and one state entry. Earlier reload checks with both settings passed on VS Code 1.109.5.

Desktop checks also covered closing a second window and native detach/attach. After transfer and full quit, reopening the destination revived the same token with a new PID while its saved record still contained `User` and the dead original PID. Do not use that combination to infer that the native tab was trashed.

## Use native VS Code behavior

An interactive leaf without `shell` uses the user's default VS Code terminal profile. A leaf with `shell` uses that executable and its arguments. A leaf with `command` launches the configured executable directly.

TreeTY marks sessions as stopped, starting, idle, running, or failed. After an extension-host restart, the adapter recovers identifiable persisted sessions and pauses automatic replacement when a saved session remains unresolved.

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

Keep the extension, bundled CLI, and any activity-reporting integrations aligned. Old state writers can discard runtime activity fields. Recreate terminals after upgrades to refresh their bundled CLI environment. Runtime activity is scoped to each session, and the state model supports multiple sessions per node. The VS Code adapter still applies its shared-storage ownership guard before launching. Cleanup preserves attention.
