# TreeTY for VS Code

TreeTY organizes native VS Code terminals into a nested, persistent tree.

Create `.treety/tree.json` manually or run `TreeTY: Initialize Workspace`. You can also run `TreeTY: Initialize Global Tree` to use TreeTY in an empty VS Code window. Workspace trees fall back to the global configuration at `$XDG_CONFIG_HOME/treety/tree.json` or `~/.config/treety/tree.json`.

Use the view title and context-menu controls to create groups and terminals, rename or move nodes, and delete them with confirmation. Select a terminal leaf to create or reveal its native terminal. Groups provide inherited directories, environment variables, shell settings, and restart policies.

`TreeTY: Explorer Directory Sync` controls whether opening a terminal adds its working directory to the VS Code workspace. This exposes the directory to Explorer and VS Code's native Source Control integration. The setting supports `never`, `prompt`, and `always`, and the terminal context menu also provides an explicit add-directory command.

`TreeTY: Global Tree Visibility` can keep the global tree as a fallback, always show it alongside local trees, or hide it while folders are open. Empty windows always load the global tree.

The extension includes JSON validation and completion for the configuration file. The source workspace's root README contains the full configuration reference and architecture.

For local feedback loops, run `pnpm install:snapshot` from the repository root. It builds a uniquely timestamped VSIX under `artifacts/` and force-installs it with the VS Code CLI. Run `pnpm package:snapshot` when you want the artifact without installing it.
