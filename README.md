# TreeTY

TreeTY turns terminal sessions into a persistent, hierarchical workspace. Its first adapters are a VS Code extension and the `@treety/cli` package, while its core engine has no host dependencies.

## MVP behavior

- Render nested groups and terminal leaves in a dedicated Activity Bar view.
- Inherit directories, environment variables, shell settings, and restart policies through the tree.
- Create native VS Code terminals lazily and reveal an existing terminal when its leaf is selected.
- Reattach terminals revived by VS Code instead of launching duplicates.
- Track stopped, starting, idle, running, and failed states.
- Support interactive shells and direct startup commands.
- Load workspace trees from `.treety/tree.json` alongside a separately manageable global tree.
- Manage tree structure from either the VS Code tree or the `treety` command.
- Optionally add terminal working directories to VS Code Explorer and Source Control.

## Architecture

```text
packages/core
  configuration parser and validation
  immutable tree creation, mutation, and validation
  inheritance and path resolution
  session lifecycle state machine
  host-neutral TerminalHost interface

packages/cli
  local and global configuration discovery
  group and terminal creation
  list, rename, move, and remove commands

packages/vscode
  TreeDataProvider adapter
  vscode.Terminal host implementation
  local and global configuration discovery
  tree management commands and native workspace integration
```

The core package controls behavior. A host adapter controls rendering, process creation, persistence discovery, and user interaction. This boundary leaves room for another IDE, an external-terminal bridge, or a standalone application without changing the tree model.

## Agent skill

TreeTY includes an agent skill for managing terminal trees through the CLI, understanding how CLI changes synchronize with VS Code, and building integrations with the core package.

Install it from this repository with the open `skills` CLI:

```sh
npx skills add aaronccasanova/TreeTY --skill treety
```

Add `--global` to make the skill available across projects. The installer can target Codex, Claude Code, Cursor, and other compatible agents.

## CLI

The publishable `@treety/cli` package wraps the core management API and exposes the `treety` executable.

Run a command without installing it globally:

```sh
pnpm dlx @treety/cli init
```

For a pinned project version, install it as a development dependency:

```sh
pnpm add --save-dev @treety/cli
pnpm exec treety init
```

Once the executable is available, the management workflow is:

```sh
treety init
treety add group "Services" --cwd services
treety add terminal "API server" --parent services --cwd api -- pnpm dev
treety list
treety rename api-server "Development API"
treety move api-server --root
treety remove api-server --yes
```

Commands use `.treety/tree.json` in the current workspace. If there is no local tree, TreeTY falls back to `$XDG_CONFIG_HOME/treety/tree.json` or `~/.config/treety/tree.json`. Pass `--global` to target the global tree explicitly, or `--config <path>` to target any configuration file.

## Configuration

TreeTY reads `.treety/tree.json` from the workspace root. The CLI falls back to `$XDG_CONFIG_HOME/treety/tree.json` or `~/.config/treety/tree.json` when a workspace does not have a local tree. The VS Code extension shows explicit local and global roots together by default, so either scope can be managed without changing windows. A VS Code window with no open folder loads the global tree directly, with relative directories resolved from the user's home directory.

You can create the global file with `TreeTY: Initialize Global Tree` or `treety init --global`.

Example configuration:

```json
{
  "version": 1,
  "defaults": {
    "restartPolicy": "manual"
  },
  "tree": [
    {
      "kind": "group",
      "id": "services",
      "name": "Services",
      "cwd": "services",
      "children": [
        {
          "kind": "terminal",
          "id": "api",
          "name": "API server",
          "cwd": "api",
          "command": {
            "executable": "pnpm",
            "args": ["dev"]
          }
        },
        {
          "kind": "terminal",
          "id": "api-shell",
          "name": "API shell",
          "cwd": "api"
        }
      ]
    }
  ]
}
```

Relative `cwd` values resolve from the nearest ancestor. Terminal leaves without `command` use the user's default VS Code terminal profile. Command leaves launch the configured executable directly with its argument array.

`restartPolicy` supports:

- `manual` (default): Recover a native persisted session when available. Otherwise, wait for the user to select the leaf.
- `onOpen`: Recover the session or launch it when the workspace opens.

Environment values inherit and merge. A `null` value removes the variable from the launched terminal environment.

## VS Code workflow

Select a local root, global root, or group, then use the view title controls to create a terminal or group at that location. `+` always means terminal, and `new folder` always means group. The selected destination is repeated in the create prompt. The same create actions are available inline and from root and group context menus.

Terminal rows expose open, restart, stop, and delete controls. Stop closes the native terminal while preserving its entry for a later restart. Delete removes the entry after confirmation. Groups and terminals also provide rename, move, and delete actions from their context menus. Deleting a group confirms the descendant count and closes running terminals in that subtree.

Opening a terminal can also add its resolved working directory to the VS Code workspace. This makes the directory visible in Explorer and lets VS Code's native Source Control integration discover its repository. Configure `TreeTY: Explorer Directory Sync` as `never`, `prompt`, or `always`. You can also use `TreeTY: Add Directory to VS Code Workspace` from any terminal's context menu.

`TreeTY: Global Tree Visibility` shows the global root first, followed by local roots, by default. It can instead use the global tree only as a fallback or hide it when folders are open. Empty VS Code windows always show the global root.

Adding the first folder to an empty VS Code window can restart the extension host. Native terminal persistence lets TreeTY reattach the session afterward.

## Development

Requirements: Node.js 22 or newer and pnpm 10 or newer.

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

Open the repository in VS Code, select "Run Extension" from the Run and Debug view, then open the TreeTY Activity Bar container in the Extension Development Host.

Unpublished npm packages stay at version `0.0.0`. The VS Code extension follows its independent Marketplace version. Create the stable local VSIX path with:

```sh
pnpm package
```

This writes `artifacts/treety-0.1.0.vsix`. Development snapshots use a sortable UTC timestamp with millisecond precision so repeated builds never overwrite each other:

```sh
pnpm package:snapshot
```

For example, this can create `artifacts/treety-0.1.0-snapshot.20260803T221530123Z.vsix`. The command prints the exact `code --install-extension ... --force` command for the new artifact.

Build and force-install a fresh snapshot in one step with:

```sh
pnpm install:snapshot
```

Snapshot timestamps identify local artifacts only. Build a Marketplace pre-release with:

```sh
pnpm package:pre-release
```

VS Code pre-releases use odd minor versions (`0.1.x`, `0.3.x`, etc). Stable releases use even minor versions (`0.2.x`, `0.4.x`, etc). Pre-release status is stored in the VSIX manifest rather than a SemVer suffix.
