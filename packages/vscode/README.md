# TreeTY for VS Code

TreeTY organizes native VS Code terminals into a nested, persistent tree.

TreeTY is currently available as an early pre-release. The configuration format and commands may evolve before the first stable release.

TreeTY shows the global root first as a stable anchor, followed by an explicit root for every open workspace. Initialize a local root to create `.treety/tree.json`, or initialize the global root to create `$XDG_CONFIG_HOME/treety/tree.json` or `~/.config/treety/tree.json`.

Select a local root, global root, or group before using the title-bar controls. `+` creates a terminal, and `new folder` creates a group at the selected location. The same actions are available inline and from each root or group's context menu. Each create prompt confirms its destination. Select a terminal leaf to create or reveal its native terminal. Use its inline controls to restart, stop, or delete it. Stopping closes the native terminal but preserves the tree entry; deleting removes the entry after confirmation. Use Configure Node from a group or terminal context menu to edit its working directory, project directory, environment, metadata, or restart policy.

Move opens a searchable representation of the tree with every group expanded. Select individual groups to collapse or expand them, or use the editor's top-right controls to expand or collapse the entire tree. Each destination row exposes inline controls to insert above, inside a group, or below. This keeps the editor to one row per node while supporting cross-group moves for terminals and whole groups. Configuration watchers reconcile only the changed tree and preserve matching live sessions. Changes to launch settings apply to the next terminal launch.

Durable attention from `.treety/state.json` appears as a small `!` file decoration without replacing the lifecycle icon or description. The decoration propagates to ancestor groups and clears when the terminal is opened or revealed.

`TreeTY: Explorer Directory Sync` controls whether opening a terminal adds its configured project directory to the VS Code workspace. It defaults to `never` and also supports `prompt` and `always`. The terminal context menu exposes an explicit add-project-directory command only when the leaf has an inherited or direct `projectDir`; its confirmation shows the exact path.

`TreeTY: Global Tree Visibility` shows local and global roots together by default. It can instead keep the global tree as a fallback or hide it while folders are open. Empty windows always load the global root.

The extension includes JSON validation and completion for the configuration file. The source workspace's root README contains the full configuration reference and architecture.

For local feedback loops, run `pnpm install:snapshot` from the repository root. It builds a uniquely timestamped VSIX under `artifacts/` and force-installs it with the VS Code CLI. Run `pnpm package:snapshot` when you want the artifact without installing it.

Source code, issue tracking, and CLI documentation are available in the [TreeTY repository](https://github.com/aaronccasanova/TreeTY).
