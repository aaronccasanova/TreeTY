# TreeTY for VS Code

TreeTY organizes native VS Code terminals into a nested, persistent tree.

TreeTY is under active development. Local builds are the primary iteration workflow, with occasional npm and Marketplace releases. The configuration format and commands may evolve before the first stable release.

## Install from source

On macOS or Linux, with Node.js 22 or newer, the pnpm version declared in the repository's `package.json`, and VS Code's `code` launcher on `PATH`, run:

```sh
git clone https://github.com/aaronccasanova/TreeTY.git
cd TreeTY
pnpm install:snapshot
```

Windows users can follow the [manual build steps in the repository README](https://github.com/aaronccasanova/TreeTY#windows-local-builds).

The command installs locked dependencies, builds the core and extension, creates a timestamped VSIX, and force-installs it locally. Rerun it after pulling changes or editing the checkout. For an artifact without installation, run `pnpm install --frozen-lockfile` once, then `pnpm package:snapshot`.

Run "Developer: Reload Window" after installation, then create new terminals. The extension provides the matching `treety` CLI in new integrated terminals, including terminals created outside TreeTY. Its CLI is bundled from the same checkout, so you don't need a global `@treety/cli` installation. Node.js 22 or newer must remain available on `PATH`. Existing terminals keep their old environment and need to be recreated to use the new build.

You can disable auto-update for TreeTY in VS Code's Extensions view to keep Marketplace updates from replacing a local snapshot. Snapshot filenames include a timestamp, while the embedded extension version stays unchanged.

## Recover terminals after reload

New native terminals use the title `TreeTY: <name> [treety:<token>]`. The token contains 128 random bits encoded as 22 base64url characters, generated with Node.js's built-in cryptography and no added dependency. TreeTY rows keep the plain configured name. Renaming an entry in TreeTY changes its tree label, while its existing native terminal keeps the original title and token. The next launch uses the new name.

TreeTY saves a separate file for each token in the extension's shared global storage directory, scoped to the configuration path, workspace, host, node, and session. Exclusive files and a lock for each leaf coordinate launches across windows sharing that storage and scope. A known active window owner prevents another launch. Multiple matching local terminals also block creation. Recovery requires a matching token or creation metadata without conflicting identity. Names, the `TreeTY:` prefix, and process IDs alone do not establish ownership. A saved PID is advisory and may have been reused by another process.

New owner records identify a running extension activation through a local socket handshake. A reused PID cannot impersonate that owner. Missing or refused endpoints release the owner veto, while timeouts and permission errors keep it. If the endpoint can't start, launches and recovery remain available using conservative PID checks. Later ownership writes retry startup and use the handshake when it succeeds. Older records, records written during endpoint failure, and abandoned transaction locks retain PID checks that can block after PID reuse. The owner endpoint closes only after pending session operations finish during deactivation.

The endpoint uses Unix sockets on macOS and Linux, and a named pipe on Windows. Windows recovery has not been validated on a Windows desktop.

VS Code can restore a terminal's title after publishing its handle. TreeTY checks when loading the tree, when a native terminal opens, and when you open a leaf or run **TreeTY: Refresh**. If the title arrives later, open the leaf or refresh again. A timeout, an exited PID, or a terminal's absence from this window doesn't establish that its saved session is stale. VS Code can revive the same saved terminal with a new process.

An unresolved saved record prevents automatic replacement, including `onOpen` launches. Without an active window owner, opening the leaf offers **Forget previous session and start**, even if its saved PID is still alive. Use it only after closing that session's terminal, including in other windows. This retires the saved identity, clears its owner and PID, and starts a new session. The token remains available to recognize a late restored tab and has no time-based expiry, but the retired record alone doesn't block later launches. Forgetting never closes existing terminals, and VS Code may still restore an old native tab later. A known active window owner or matching local terminals cannot be bypassed. Cancel and refresh to retry recovery.

Keep the native title suffix intact. If it was removed or changed, restore the original suffix and refresh. Older unmarked terminals can still be identified while their creation metadata is available. Historical terminals with an empty creation environment and no token cannot be recovered automatically. Missing or corrupt recovery records also limit identification and duplicate prevention. Coordination applies to readable records in the same shared storage scope, and cannot prevent VS Code itself from reviving an old tab after its identity was explicitly forgotten.

TreeTY uses the absolute filesystem storage path supplied by the Node extension host. This supports storage whose URI uses either `file` or `vscode-userdata`. If the filesystem path is unavailable, TreeTY displays a warning and keeps the tree available. Existing terminals can still be recovered from their creation metadata, but new launches are disabled because shared session reservations aren't available.

VS Code reports its native trash action and terminal transfers with the same `User` close reason. TreeTY retains that identity, so reopening may need **Forget previous session and start** even after the old PID exits. Confirmed process exits and TreeTY's **Stop** action clear the corresponding records.

A transferred terminal can later revive in another window with a new PID before TreeTY claims it there. This sequence was verified on VS Code 1.146.0: the saved record still contained `closeReason: "user"` and the dead original PID while the same native token had revived with a new PID. The original dead PID therefore doesn't prove that creating a replacement is safe. Recognizing the old token afterward wouldn't undo a duplicate process already launched.

For `Shutdown`, TreeTY records the originating window's terminal persistence settings. When reopening an unowned session, it retires the saved record automatically if `terminal.integrated.enablePersistentSessions` was disabled. It also retires the record if `terminal.integrated.persistentSessionReviveProcess` was `never` and the recorded PID has exited. These cases allow a new launch without confirmation while retaining the token for late recovery. Otherwise, the record continues to guard reconnection or revival. Changing those settings in another window doesn't change the saved decision.

Disposal also uses an exit status already exposed by VS Code when its close event hasn't arrived. Disposal of a live handle, including Refresh, doesn't imply shutdown. Retired tokens remain on disk to recognize handles arriving during cleanup or later restoration. Their count isn't capped. Registry scans limit concurrent file reads and reuse unchanged contents, but still enumerate retained files.

Recovery preserves the existing status dots, native spinner, and selected-row styling. Environment-relaunch warnings remain separate from terminal ownership and process liveness.

## Status, activity, and attention

Terminal status uses theme-aware circles: hollow when stopped, amber while starting, neutral when idle, green when running, and red after failure. Status and activity appear in tooltips and screen-reader labels. Terminal rows keep only their names beside the status icons, without redundant inline status text. The former `treety.showStatusDescriptions` setting has been removed.

Activity describes current work separately from the terminal process. Known work displays a native spinner after one second. Short commands keep their status dot. Explicit reporters can describe work within a long-lived command and become idle while waiting. Their reports take precedence over the enclosing shell command. Ordinary commands use VS Code shell integration. Without those events, activity stays unknown rather than guessing from a live process.

Set `treety.activityAnimation` to `off` for static dots. Use **Configure > Activity animation** on a terminal to override the global preference, for example for a long-lived server. The corresponding terminal property is `activityAnimation: false`. Activity information, execution, and completion attention are preserved. TreeTY also disables its spinner when `terminal.integrated.tabs.enableAnimation` is false or `workbench.reduceMotion` is `on`. With reduced motion set to `auto`, rendering follows VS Code's native behavior. The public extension API does not expose the resolved operating-system preference.

A shell command lasting at least five seconds marks the terminal for attention on completion, including failure. Explicit reporters supply their own completion attention, so the outer command is not counted again. There is no sound or operating-system notification. Completion attention is conservative: VS Code's last active terminal does not prove keyboard focus, so it does not suppress attention. Opening or revealing a terminal acknowledges the existing mark.

Activity is fenced by the terminal runtime session, reporter identity, and current link metadata. Unlinking, stopping, and restarting invalidate the relevant signal without clearing attention. A liveness check runs every five seconds only for registered reporters to recover when a reporting process exits without unregistering. There is no frame-by-frame animation timer.

Use matching versions of the VS Code extension, bundled CLI, and any activity-reporting integrations. Older CLI versions can discard the new runtime fields when rewriting `state.json`. Recreate existing terminals after updating so they use the matching bundled CLI. Attention remains local shared state, while activity is scoped separately to each live terminal instance, including multiple VS Code windows.

## Find a group or terminal

Click the search icon in the TreeTY title bar or run **TreeTY: Search nodes**. Search names, ancestor groups, workspace names, directories, and descriptive metadata across current trees, including collapsed groups. Results show their hierarchy and location. Press Enter to reveal and expand a group or open and focus a terminal. Escape cancels.

Abbreviations such as `pst` for "Payments service tests" and small typos such as `paymnets` work. Words can match different fields, so `payments tests` can find "Service tests" under "Payments". Matching ignores case and accents. Search updates immediately as you type and stays current as nodes are added, renamed, moved, or removed.

Descriptive metadata supports strings and arrays of strings in `title`, `description`, `summary`, `tags`, `labels`, `owner`, `project`, `service`, `category`, and `aliases`. Parent group metadata also helps find children. Search does not index environment values, commands, nested metadata objects, or integration session data.

## Use the terminal tree

TreeTY shows the global root first as a stable anchor, followed by an explicit root for every open workspace. Initialize a local root to create `.treety/tree.json`, or initialize the global root to create `$XDG_CONFIG_HOME/treety/tree.json` or `~/.config/treety/tree.json`.

Select a local root, global root, or group before using the title-bar controls. `+` creates a terminal, and `new folder` creates a group at the selected location. Each create prompt confirms its destination. Group hover controls expose create terminal, create group, delete, and actions. The group actions menu and right-click menu can restart every terminal in that group and its nested groups. Terminal hover controls expose delete and actions; selecting the row creates or reveals its native terminal. The actions gear stays at the far right and opens a complete menu for the node, including delete, group creation shortcuts, and applicable terminal session actions. Right-click remains available with the same concise action names. The Command Palette groups the same commands under TreeTY. Stopping closes the native terminal but preserves the tree entry, while deleting removes the entry after confirmation.

**Collapse all** first collapses groups beneath the open Global and workspace roots, leaving their top-level entries visible. Use it again to collapse the roots too. Roots you've already closed stay closed. If no top-level groups are expanded, it collapses the roots immediately. Expanding a group, including through search or a terminal link, makes the next collapse return to the top-level overview.

Move opens a searchable representation of the tree with every group expanded and the moving node in view. Select individual groups to collapse or expand them. The top-right collapse control follows the same two-stage behavior as the sidebar: groups first, then the root. The collapse and expand controls clear any active search. The expand control opens the entire tree. Each destination row exposes inline controls ordered as insert above, insert below, and move inside when applicable. The inside control stays at the far right, and terminal leaves receive an extra indentation step to preserve the tree hierarchy. This keeps the editor to one row per node while supporting cross-group moves for terminals and whole groups. Configuration watchers reconcile only the changed tree and preserve matching live sessions. Changes to launch settings apply to the next terminal launch.

Durable attention from `.treety/state.json` appears as a small `!` file decoration without replacing the status icon. The decoration propagates to ancestor groups. Use **Mark needs attention** from the terminal's actions gear or right-click menu before working elsewhere. Both menus offer **Clear attention** for an existing mark. Opening or revealing the terminal also clears attention.

`TreeTY: Explorer Directory Sync` controls whether opening a terminal adds its configured project directory to the VS Code workspace. It defaults to `never` and also supports `prompt` and `always`. Every group and terminal exposes an explicit add-directory action. A terminal prefers its resolved project directory, then its live current working directory, then an explicitly configured or inherited working directory. A group with no configured directory opens a filterable picker containing the best available directory for every descendant terminal. The picker also accepts another relative or absolute path. The confirmation shows the exact path. TreeTY reports when none of those sources is available instead of treating the global tree's implicit home-directory base as the terminal's current directory.

Configure uses a filterable path field that accepts relative or absolute directories. A terminal offers its current directory when VS Code shell integration reports it. A group recursively offers the live current directories of all descendant terminals, so its behavior does not depend on which terminal is active. Duplicate paths are combined and labeled with their terminal locations. When live directory information isn't available, the field suggests an explicitly configured inherited directory or remains empty.

`TreeTY: Global Tree Visibility` shows local and global roots together by default. It can instead keep the global tree as a fallback or hide it while folders are open. Empty windows always load the global root.

The extension includes JSON validation and completion for the configuration file. The source workspace's root README contains the full configuration reference and architecture.

Source code, issue tracking, and CLI documentation are available in the [TreeTY repository](https://github.com/aaronccasanova/TreeTY).

## Link to a live terminal

Choose **Copy terminal link** from a running terminal's actions or context menu. Inside a terminal created by TreeTY, run `treety uri` or read `TREETY_SESSION_URI` directly.

The extension resolves the complete link through VS Code's `asExternalUri` API so it returns to the originating window. The link includes the configuration URI, node ID, and live terminal session ID. Clicking it reveals and selects the matching TreeTY leaf, expanding its parent groups as needed, then gives keyboard focus to that exact native terminal and clears its attention marker. It does not start a stopped terminal, run a supplied command, load an arbitrary configuration, or change the workspace.

Use the returned string unchanged as a notification's URL or Markdown target. For example, a shell integration can prepare a message after a task finishes:

```sh
treety attention set
session_uri="${TREETY_SESSION_URI:-}"
if [ -n "$session_uri" ]; then
  printf '[Return to terminal](%s)\n' "$session_uri"
fi
```

Migrate `treety link` to `treety uri` and `TREETY_TERMINAL_LINK` to `TREETY_SESSION_URI`. The old names are not aliases. Recreate terminals after updating to receive the new environment variable. Preserve the value exactly: VS Code supplies opaque window-routing data that cannot be reconstructed from the configuration path, node ID, and session ID alone. If the variable is absent, omit the terminal destination or use **Copy terminal link** in the intended terminal. Ordinary VS Code terminals have the bundled CLI but do not have a TreeTY session link. Terminals created before link support need to be recreated once.

Links currently support local desktop VS Code, including Insiders. A recovered native session keeps its link across extension-host reloads. Closing or restarting the terminal ends that session, so open it and copy a new link. If the original window has closed, VS Code may deliver an old link to another window. TreeTY rejects it unless that window has the exact loaded configuration, node, and live session. Missing, deleted, and invalid targets produce an error without launching anything.

Some notification clients restrict custom URL schemes. They must allow the VS Code application URL for this integration to open. Link generation is optional: if VS Code cannot resolve a URL, the terminal still opens and `TREETY_SESSION_URI` is absent.
