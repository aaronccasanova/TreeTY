# TreeTY

TreeTY turns terminal sessions into a persistent, hierarchical workspace. Its first adapters are a VS Code extension and the `@treety/cli` package, while its core engine has no host dependencies.

## MVP behavior

- Render nested groups and terminal leaves in a dedicated Activity Bar view.
- Inherit working directories, project directories, environment variables, shell settings, and restart policies through the tree.
- Keep opaque stable node IDs independent from human-readable names.
- Store optional freeform JSON metadata on any group or terminal.
- Create native VS Code terminals lazily and reveal an existing terminal when its leaf is selected.
- Reattach terminals revived by VS Code instead of launching duplicates.
- Track stopped, starting, idle, running, and failed states.
- Support interactive shells and direct startup commands.
- Load workspace trees from `.treety/tree.json` alongside a separately manageable global tree.
- Manage tree structure from either the VS Code tree or the `treety` command.
- Serialize tree and local-state mutations with cooperative locks and atomic replacement.
- Persist terminal attention separately from terminal lifecycle status.
- Resume linked Pi sessions through the repository's optional Pi extension.
- Optionally add explicitly configured project directories to VS Code Explorer and Source Control.

## Architecture

```text
packages/core
  configuration parser and validation
  transactional tree and local-state storage
  immutable tree creation, mutation, and validation
  inheritance and path resolution
  session lifecycle state machine
  host-neutral TerminalHost interface

packages/cli
  local and global configuration discovery
  group and terminal creation
  list, inspect, configure, rename, order, metadata, attention, and remove commands

packages/pi
  TypeScript Pi extension loaded by the repository package manifest
  session resume setup and lifecycle attention signaling
  minimal local Pi API types with no Pi runtime dependency

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
treety add group "Services" --id services --cwd services --project-dir ..
treety add terminal "API server" --id api-server --parent services --cwd api -- pnpm dev
treety add terminal "API shell" --id api-shell --parent services --cwd api
treety list
treety rename api-server "Development API"
treety configure api-server --project-dir ../.. --env PORT=3000
treety metadata set api-server '{"owner":"platform","tags":["api"]}'
treety metadata set-path api-server /integrations/example/id '"example-123"'
treety configure api-server -- pnpm dev
treety move api-server --before api-shell
treety attention set api-server
treety remove api-server --yes
```

Commands use `.treety/tree.json` in the current workspace. If there is no local tree, TreeTY falls back to `$XDG_CONFIG_HOME/treety/tree.json` or `~/.config/treety/tree.json`. Pass `--global` to target the global tree explicitly, or `--config <path>` to target any configuration file.

Node IDs are unique within one configuration. A persistent node is identified by its configuration file path and node ID together, so local, global, and custom trees may reuse the same ID without conflict.

## Configuration

TreeTY reads `.treety/tree.json` from the workspace root. The CLI falls back to `$XDG_CONFIG_HOME/treety/tree.json` or `~/.config/treety/tree.json` when a workspace does not have a local tree. The VS Code extension shows explicit local and global roots together by default, so either scope can be managed without changing windows. A VS Code window with no open folder loads the global tree directly, with relative directories resolved from the user's home directory.

You can create the global file with `TreeTY: Initialize Global Tree` or `treety init --global`.

`tree.json` remains the declarative source of truth. TreeTY stores mutable local state beside it:

```text
.treety/
  .gitignore
  tree.json
  state.json
```

`state.json` records boolean `needsAttention` values by terminal node ID. Default values are omitted, deleted node IDs are pruned during later mutations, and the scoped `.treety/.gitignore` excludes state, lock, and temporary files. A custom config such as `review.json` uses `review.state.json` in the same directory.

```json
{
  "version": 1,
  "nodes": {
    "api-server": {
      "needsAttention": true
    }
  }
}
```

TreeTY serializes every owned `tree.json` and `state.json` mutation with a bounded cooperative lock. It rereads the latest document after locking, validates the complete semantic result, and atomically replaces the destination. Concurrent CLI and VS Code mutations therefore preserve one another.

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
      "projectDir": "..",
      "metadata": {
        "owner": "platform"
      },
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

Relative `cwd` values resolve from the nearest ancestor. Terminal leaves without `command` use the host's default interactive shell. Command leaves launch the configured executable directly with its argument array.

`projectDir` is an optional project root that inherits independently from `cwd`. An absolute value remains unchanged. A relative value resolves from the node's resolved working directory. Host adapters can use this value for project-level integrations without assuming that a terminal starts at the project root.

Node IDs are stable machine identities. TreeTY generates opaque UUIDs for new nodes unless `--id` supplies an explicit value. Renaming a node changes only its human-readable name. Existing name-based IDs remain valid.

`metadata` accepts any JSON value and does not inherit. TreeTY treats it as an opaque value and replaces it atomically rather than applying ambiguous deep-merge rules.

Use `metadata set-path` and `metadata clear-path` for targeted JSON Pointer updates. Missing object parents are created, unrelated metadata is preserved, and incompatible traversal fails without changing the file.

`restartPolicy` supports:

- `manual` (default): Recover a hosted session when available. Otherwise, wait for an explicit open or restart request.
- `onOpen`: Recover the session or launch it when the host opens the tree.

Environment values inherit and merge. A `null` value removes the variable from the launched terminal environment.

Host adapters inject a standard terminal context built by `@treety/core`: `TREETY_CONFIG_FILE`, `TREETY_CONFIG_SOURCE`, `TREETY_NODE_ID`, `TREETY_NODE_METADATA`, and `TREETY_SESSION_ID`. The CLI uses this context to target the active config and leaf without positional arguments. Explicit `--global`, `--config`, positional IDs, and `--node` selectors take precedence. `TREETY_SESSION_ID` identifies one runtime terminal instance and can change when that terminal is recreated; `TREETY_NODE_ID` remains stable. Metadata in the environment is a launch-time snapshot, while `treety metadata get` reads the current configuration.

## VS Code workflow

Select a local root, global root, or group, then use the view title controls to create a terminal or group at that location. `+` always means terminal, and `new folder` always means group. The selected destination is repeated in the create prompt. The same create actions are available inline and from root and group context menus.

Terminal rows open or reveal their native terminal when selected. Hover controls expose delete followed by an actions gear, which stays at the far right. Group hover controls expose create terminal, create group, delete, and actions. The gear provides every action for the node, including delete, group creation shortcuts, and applicable terminal session actions; the context menu remains available. Context menus use concise action names, while the Command Palette groups the same commands under TreeTY. Configure edits working directory, project directory, environment, metadata, and restart policy without opening JSON. Stop closes the native terminal while preserving its entry for a later restart. Deleting a group confirms the descendant count and closes running terminals in that subtree. A valid CLI or file edit that removes a leaf also closes its matching live terminal.

Move uses a searchable, collapsible representation of the tree with inline controls on each destination. The tree starts fully expanded, and its top-right controls expand or collapse everything. Insert above or below any node, or move inside a root or group. The editor stays to one row per node and supports terminals, whole groups, and cross-group moves. Watched configuration changes reconcile only the affected tree. Existing sessions survive moves, renames, metadata changes, and launch-setting changes; removed leaves close their matching sessions.

Attention is independent from stopped, starting, idle, running, and failed lifecycle states. `treety attention set` or the terminal's VS Code actions gear adds a small `!` decoration to a terminal and its ancestor groups. The gear can also clear attention. Opening or revealing that terminal clears it automatically.

## Pi integration

Install this repository as a Pi package:

```sh
pi install git:github.com/aaronccasanova/TreeTY
```

Run `/treety-setup` inside a TreeTY terminal. The TypeScript extension in `packages/pi` stores the current ID from Pi's session manager at `/integrations/pi/sessionId`, configures the terminal to start with `pi --session <session-id>`, and enables attention signaling without changing `restartPolicy`. Pi reconstructs that link on session startup and reload, clears attention on `agent_start`, and sets it on `agent_settled`. The package defines only the small Pi API boundary it uses and does not install Pi locally. TreeTY core, CLI state, and VS Code rendering remain agent-agnostic. The repository extension composes their generic capabilities.

Opening a terminal can also add its explicitly configured project directory to the VS Code workspace. This makes the directory visible in Explorer and lets VS Code's native Source Control integration discover its repository. `TreeTY: Explorer Directory Sync` defaults to `never` and also supports `prompt` or `always`. Every group and terminal exposes an explicit Add Directory to VS Code Workspace action. Terminal actions prefer a configured project directory, then the live current working directory, then a configured working directory. Groups without their own directory offer a filterable list of resolved descendant directories. Directory configuration uses the same filterable path field and collects every live descendant CWD for groups. The confirmation shows the exact absolute path before changing the workspace.

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

The core library and CLI are versioned independently from the VS Code extension. The current release versions are `@treety/core@0.0.3`, `@treety/cli@0.0.3`, and `TreeTY.treety@0.1.3`. The private Pi integration starts at `0.0.0` and ships from this Git repository rather than a package registry. Create the stable local VSIX path with:

```sh
pnpm package
```

This writes `artifacts/treety-0.1.3.vsix`. Development snapshots use a sortable UTC timestamp with millisecond precision so repeated builds never overwrite each other:

```sh
pnpm package:snapshot
```

For example, this can create `artifacts/treety-0.1.3-snapshot.20260807T221530123Z.vsix`. The command prints the exact `code --install-extension ... --force` command for the new artifact.

Build and force-install a fresh snapshot in one step with:

```sh
pnpm install:snapshot
```

Snapshot timestamps identify local artifacts only. Build a Marketplace pre-release with:

```sh
pnpm package:pre-release
```

VS Code pre-releases use odd minor versions (`0.1.x`, `0.3.x`, etc). Stable releases use even minor versions (`0.2.x`, `0.4.x`, etc). Pre-release status is stored in the VSIX manifest rather than a SemVer suffix.

See [RELEASING.md](RELEASING.md) for the complete npm and VS Code Marketplace release workflow.
