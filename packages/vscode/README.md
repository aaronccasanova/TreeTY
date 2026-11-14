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

## Find a group or terminal

Click the search icon in the TreeTY title bar or run **TreeTY: Search Nodes**. Search names, ancestor groups, workspace names, directories, and descriptive metadata across current trees, including collapsed groups. Results show their hierarchy and location. Press Enter to reveal and expand a group or open and focus a terminal. Escape cancels.

Abbreviations such as `pst` for "Payments service tests" and small typos such as `paymnets` work. Words can match different fields, so `payments tests` can find "Service tests" under "Payments". Matching ignores case and accents. Search updates immediately as you type and stays current as nodes are added, renamed, moved, or removed.

Descriptive metadata supports strings and arrays of strings in `title`, `description`, `summary`, `tags`, `labels`, `owner`, `project`, `service`, `category`, and `aliases`. Parent group metadata also helps find children. Search does not index environment values, commands, nested metadata objects, or integration session data.

## Use the terminal tree

TreeTY shows the global root first as a stable anchor, followed by an explicit root for every open workspace. Initialize a local root to create `.treety/tree.json`, or initialize the global root to create `$XDG_CONFIG_HOME/treety/tree.json` or `~/.config/treety/tree.json`.

Select a local root, global root, or group before using the title-bar controls. `+` creates a terminal, and `new folder` creates a group at the selected location. Each create prompt confirms its destination. Group hover controls expose create terminal, create group, delete, and actions. The group actions menu and right-click menu can restart every terminal in that group and its nested groups. Terminal hover controls expose delete and actions; selecting the row creates or reveals its native terminal. The actions gear stays at the far right and opens a complete menu for the node, including delete, group creation shortcuts, and applicable terminal session actions. Right-click remains available with the same concise action names. The Command Palette groups the same commands under TreeTY. Stopping closes the native terminal but preserves the tree entry, while deleting removes the entry after confirmation.

Move opens a searchable representation of the tree with every group expanded and the moving node in view. Select individual groups to collapse or expand them, or use the editor's top-right controls to expand or collapse the entire tree. Each destination row exposes inline controls ordered as insert above, insert below, and move inside when applicable. The inside control stays at the far right, and terminal leaves receive an extra indentation step to preserve the tree hierarchy. This keeps the editor to one row per node while supporting cross-group moves for terminals and whole groups. Configuration watchers reconcile only the changed tree and preserve matching live sessions. Changes to launch settings apply to the next terminal launch.

Durable attention from `.treety/state.json` appears as a small `!` file decoration without replacing the lifecycle icon or description. The decoration propagates to ancestor groups. Use **Mark needs attention** from the terminal's actions gear or right-click menu before working elsewhere. Both menus offer **Clear attention** for an existing mark. Opening or revealing the terminal also clears attention.

`TreeTY: Explorer Directory Sync` controls whether opening a terminal adds its configured project directory to the VS Code workspace. It defaults to `never` and also supports `prompt` and `always`. Every group and terminal exposes an explicit add-directory action. A terminal prefers its resolved project directory, then its live current working directory, then an explicitly configured or inherited working directory. A group with no configured directory opens a filterable picker containing the best available directory for every descendant terminal. The picker also accepts another relative or absolute path. The confirmation shows the exact path. TreeTY reports when none of those sources is available instead of treating the global tree's implicit home-directory base as the terminal's current directory.

Configure uses a filterable path field that accepts relative or absolute directories. A terminal offers its current directory when VS Code shell integration reports it. A group recursively offers the live current directories of all descendant terminals, so its behavior does not depend on which terminal is active. Duplicate paths are combined and labeled with their terminal locations. When live directory information isn't available, the field suggests an explicitly configured inherited directory or remains empty.

`TreeTY: Global Tree Visibility` shows local and global roots together by default. It can instead keep the global tree as a fallback or hide it while folders are open. Empty windows always load the global root.

The extension includes JSON validation and completion for the configuration file. The source workspace's root README contains the full configuration reference and architecture.

Source code, issue tracking, and CLI documentation are available in the [TreeTY repository](https://github.com/aaronccasanova/TreeTY).

## Link to a live terminal

Choose **Copy terminal link** from a running terminal's actions or context menu. Inside a terminal created by TreeTY, print the same kind of link with:

```sh
treety link
```

The extension resolves the complete link through VS Code's `asExternalUri` API so it returns to the originating window. The link includes the configuration URI, node ID, and live terminal session ID. Clicking it reveals and focuses that exact native terminal and clears its attention marker. It does not start a stopped terminal, run a supplied command, load an arbitrary configuration, or change the workspace.

Use the returned string unchanged as a notification's URL or Markdown target. For example, a shell integration can prepare a message after a task finishes:

```sh
treety attention set
terminal_link="$(treety link)"
printf '[Return to terminal](%s)\n' "$terminal_link"
```

`TREETY_TERMINAL_LINK` contains the same opaque URL for tools that read environment variables directly. `treety link` only targets its own hosted terminal and rejects node/configuration selectors. To link to another terminal, use its **Copy terminal link** action. Ordinary VS Code terminals have the bundled CLI but do not have a TreeTY session link. Terminals created before this feature need to be recreated once.

Links currently support local desktop VS Code, including Insiders. A recovered native session keeps its link across extension-host reloads. Closing or restarting the terminal ends that session, so open it and copy a new link. If the original window has closed, VS Code may deliver an old link to another window. TreeTY rejects it unless that window has the exact loaded configuration, node, and live session. Missing, deleted, and invalid targets produce an error without launching anything.

Some notification clients restrict custom URL schemes. They must allow the VS Code application URL for this integration to open. Link generation is optional: if VS Code cannot resolve a URL, the terminal still opens and `treety link` explains that no link is available.
