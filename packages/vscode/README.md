# TreeTY for VS Code

TreeTY organizes native VS Code terminals into a nested, persistent tree.

TreeTY is currently available as an early pre-release. The configuration format and commands may evolve before the first stable release.

TreeTY shows the global root first as a stable anchor, followed by an explicit root for every open workspace. Initialize a local root to create `.treety/tree.json`, or initialize the global root to create `$XDG_CONFIG_HOME/treety/tree.json` or `~/.config/treety/tree.json`.

Select a local root, global root, or group before using the title-bar controls. `+` creates a terminal, and `new folder` creates a group at the selected location. Each create prompt confirms its destination. Group hover controls expose create terminal, create group, delete, and actions. Terminal hover controls expose delete and actions; selecting the row creates or reveals its native terminal. The actions gear stays at the far right and opens a complete menu for the node, including delete, group creation shortcuts, and applicable terminal session actions. Right-click remains available with the same concise action names. The Command Palette groups the same commands under TreeTY. Stopping closes the native terminal but preserves the tree entry, while deleting removes the entry after confirmation.

Move opens a searchable representation of the tree with every group expanded and the moving node in view. Select individual groups to collapse or expand them, or use the editor's top-right controls to expand or collapse the entire tree. Each destination row exposes inline controls ordered as insert above, insert below, and move inside when applicable. The inside control stays at the far right, and terminal leaves receive an extra indentation step to preserve the tree hierarchy. This keeps the editor to one row per node while supporting cross-group moves for terminals and whole groups. Configuration watchers reconcile only the changed tree and preserve matching live sessions. Changes to launch settings apply to the next terminal launch.

Durable attention from `.treety/state.json` appears as a small `!` file decoration without replacing the lifecycle icon or description. The decoration propagates to ancestor groups. Use **Mark needs attention** from the terminal's actions gear or right-click menu before working elsewhere. Both menus offer **Clear attention** for an existing mark. Opening or revealing the terminal also clears attention.

`TreeTY: Explorer Directory Sync` controls whether opening a terminal adds its configured project directory to the VS Code workspace. It defaults to `never` and also supports `prompt` and `always`. Every group and terminal exposes an explicit add-directory action. A terminal prefers its resolved project directory, then its live current working directory, then an explicitly configured or inherited working directory. A group with no configured directory opens a filterable picker containing the best available directory for every descendant terminal. The picker also accepts another relative or absolute path. The confirmation shows the exact path. TreeTY reports when none of those sources is available instead of treating the global tree's implicit home-directory base as the terminal's current directory.

Configure uses a filterable path field that accepts relative or absolute directories. A terminal offers its current directory when VS Code shell integration reports it. A group recursively offers the live current directories of all descendant terminals, so its behavior does not depend on which terminal is active. Duplicate paths are combined and labeled with their terminal locations. When live directory information isn't available, the field suggests an explicitly configured inherited directory or remains empty.

`TreeTY: Global Tree Visibility` shows local and global roots together by default. It can instead keep the global tree as a fallback or hide it while folders are open. Empty windows always load the global root.

The extension includes JSON validation and completion for the configuration file. The source workspace's root README contains the full configuration reference and architecture.

For local feedback loops, run `pnpm install:snapshot` from the repository root. It builds a uniquely timestamped VSIX under `artifacts/` and force-installs it with the VS Code CLI. Run `pnpm package:snapshot` when you want the artifact without installing it.

Source code, issue tracking, and CLI documentation are available in the [TreeTY repository](https://github.com/aaronccasanova/TreeTY).
