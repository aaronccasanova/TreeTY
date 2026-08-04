# TreeTY for VS Code

TreeTY organizes native VS Code terminals into a nested, persistent tree.

TreeTY shows the global root first as a stable anchor, followed by an explicit root for every open workspace. Initialize a local root to create `.treety/tree.json`, or initialize the global root to create `$XDG_CONFIG_HOME/treety/tree.json` or `~/.config/treety/tree.json`.

Select a local root, global root, or group before using the title-bar controls. `+` creates a terminal, and `new folder` creates a group at the selected location. The same actions are available inline and from each root or group's context menu. Each create prompt confirms its destination. Select a terminal leaf to create or reveal its native terminal. Use its inline controls to open, restart, stop, or delete it. Stopping closes the native terminal but preserves the tree entry; deleting removes the entry after confirmation.

`TreeTY: Explorer Directory Sync` controls whether opening a terminal adds its working directory to the VS Code workspace. This exposes the directory to Explorer and VS Code's native Source Control integration. The setting supports `never`, `prompt`, and `always`, and the terminal context menu also provides an explicit add-directory command.

`TreeTY: Global Tree Visibility` shows local and global roots together by default. It can instead keep the global tree as a fallback or hide it while folders are open. Empty windows always load the global root.

The extension includes JSON validation and completion for the configuration file. The source workspace's root README contains the full configuration reference and architecture.

For local feedback loops, run `pnpm install:snapshot` from the repository root. It builds a uniquely timestamped VSIX under `artifacts/` and force-installs it with the VS Code CLI. Run `pnpm package:snapshot` when you want the artifact without installing it.
