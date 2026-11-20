# TreeTY CLI

The `@treety/cli` package exposes the `treety` command. It manages the same tree configuration consumed by TreeTY's host adapters.

## Use the bundled CLI in VS Code

The TreeTY VS Code extension includes this CLI from the same source revision and adds it to new integrated terminals' `PATH`. Run `treety help` directly there. No global or project CLI installation is needed, and updating the extension updates its bundled CLI. Package release versions remain independent.

After installing or rebuilding the extension, run "Developer: Reload Window" and create new terminals. Existing terminals retain their old environment. The CLI requires Node.js 22 or newer on `PATH`.

You can remove a previous global installation with the package manager that installed it (`pnpm remove --global @treety/cli` or `npm uninstall --global @treety/cli`) after checking `treety help` in a new VS Code terminal.

## Use the standalone CLI outside VS Code

Run it without a global installation:

```sh
pnpm dlx @treety/cli init
```

For a version pinned to your project:

```sh
pnpm add --save-dev @treety/cli
pnpm exec treety init
```

Global installation remains available, but is not required:

```sh
pnpm add --global @treety/cli
treety init
```

The package name is scoped, while the executable remains `treety`.

## Link to the current terminal

Run `treety uri` inside a TreeTY terminal to print its host-provided `TREETY_SESSION_URI` unchanged. The command does not open the URI and accepts no target selectors. This optional value identifies the current live session, not the persistent terminal definition. The VS Code adapter currently supplies it for local desktop windows. See the [VS Code terminal-link guide](../vscode/README.md#link-to-a-live-terminal) for availability and session lifetime.

Migrate `treety link` to `treety uri` and `TREETY_TERMINAL_LINK` to `TREETY_SESSION_URI`. The old command and variable are no longer supplied. Recreate hosted terminals after updating the extension so their environment uses the new name.

Remote windows are not supported. Ordinary VS Code terminals do not receive a TreeTY session link. For an older TreeTY terminal in a local window, recreate it once to receive the environment value or use **Copy terminal link** in the UI. See the [VS Code link guide](../vscode/README.md#link-to-a-live-terminal) for notification integration and lifecycle limits.

## Commands

```sh
treety init
treety add group "Services" --id services --cwd services --project-dir ..
treety add terminal "API server" --id api-server --parent services --cwd api -- pnpm dev
treety list
treety configure <node-id> --project-dir ../.. --env PORT=3000
treety metadata set <node-id> '{"owner":"platform","tags":["api"]}'
treety metadata set-path <node-id> /integrations/example/id '"example-123"'
treety configure <node-id> -- pnpm dev
treety move <node-id> --before <sibling-id>
treety attention set <node-id>
```

TreeTY uses `.treety/tree.json` in the current workspace. If that file does not exist, commands fall back to the global tree at `$XDG_CONFIG_HOME/treety/tree.json` or `~/.config/treety/tree.json`.

Use `--global` to select the global tree explicitly, or `--config <path>` to select any other config. These selectors override terminal-injected config context:

```sh
treety metadata set <node-id> '{"owner":"platform"}' --global
treety metadata set <node-id> '{"owner":"platform"}' --config ../shared/tree.json
```

Run `treety help` for the command list, or `treety <command> --help` for its accepted options.

New nodes receive opaque UUIDs unless `--id` supplies an explicit stable ID. Names remain freely renameable display values. IDs are unique within one config, so the complete persistent identity is the config file path plus node ID.

Inside a terminal created by a TreeTY host adapter, `treety current`, `treety configure`, `treety rename`, and `treety metadata` can infer the current configuration and node from the standard injected environment. `TREETY_SESSION_ID` identifies the runtime terminal instance, while `TREETY_NODE_ID` identifies its persistent leaf.

Tree and attention mutations use bounded cooperative locks and atomic replacement, so concurrent TreeTY commands preserve one another. Local attention lives in `.treety/state.json`; a custom config such as `review.json` uses `review.state.json`.

Use `move --before <sibling-id>` or `move --after <sibling-id>` for explicit ordering. Use a command after `configure ... --` to set a terminal startup command, or `--clear-command` to remove it. `metadata set-path` and `metadata clear-path` apply targeted JSON Pointer changes. `attention set` and `attention clear` default to the current `TREETY_NODE_ID` inside a TreeTY terminal.

When a script reads a node before deciding which settings to change, pass that complete node JSON from `treety show` as `configure --if-node <json>`. TreeTY compares the snapshot with the latest node while holding the configuration lock. If any node field changed, the entire configure operation fails without writing. Read the node again and reconsider the intended update before retrying. JSON property order does not matter, and changes to other nodes do not prevent the update.

## Use the CLI from scripts

Run `treety <command> --help` or `treety help <command>` for that command's usage and accepted options. `treety help` lists all commands.

Quote node IDs supplied by shell variables. An explicitly empty ID fails instead of targeting the current terminal. Omitting the ID still selects `TREETY_NODE_ID` where the command supports terminal context. The shell removes an unquoted empty variable before TreeTY receives it, so quoting remains necessary.

A value beginning with a dash requires the `=` form, for example `--shell-arg=-l` or `--node=-example`. Repeated `--env`, `--unset-env`, `--delete-env`, and `--shell-arg` options retain all values. Arguments after `--` belong to the terminal startup command and aren't interpreted as CLI options. Existing tree configuration validation still applies to the command.

Every mutation command accepts `--json`. Without it, the existing human-readable messages remain unchanged. JSON receipts have these shapes:

| Commands | Receipt |
| --- | --- |
| `init` | `{ "configFilePath": "...", "config": { ... } }` |
| `add`, `rename`, `configure`, `move`, and `metadata` mutations | `{ "configFilePath": "...", "node": { ... } }` |
| `remove` | `{ "configFilePath": "...", "removedNodeIds": ["..."] }` |
| `attention` and `activity` | `{ "configFilePath": "...", "nodeId": "...", "state": { ... } }` |

`node` is the stored node from that mutation, including a generated ID for `add`. `removedNodeIds` includes descendants. `state` is the node's returned local state, including any runtime sessions and activity. An empty state is `{}`. Receipts use the mutation's result rather than a second read, so a later writer cannot change the reported snapshot. They do not combine configuration and runtime state into a single transaction.

```sh
treety add terminal "Build" --json -- pnpm build
treety configure --node "$NODE_ID" --json --cwd build
treety remove --node "$NODE_ID" --yes --json
```

A successful mutation prints one JSON object to stdout. Errors still print `TreeTY: <message>` to stderr and exit with status 1. `--json` does not bypass `remove --yes` or `init --force` confirmation requirements.

## Report terminal activity

Inside a terminal whose host registers runtime sessions, an integration can report work with its own reporter ID and process ID:

```sh
treety activity register --reporter example-run-123 --pid 12345
treety activity busy --reporter example-run-123 --pid 12345
treety activity idle --reporter example-run-123 --pid 12345 --attention set
treety activity unregister --reporter example-run-123 --pid 12345
```

The node and config default to the terminal environment. The host session defaults to `TREETY_SESSION_ID`, or you can pass `--session <host-session-id>`. This is a TreeTY terminal runtime identifier, not a POSIX session ID. Missing or retired host sessions are rejected. `--reporter` identifies this reporting integration instance. `--pid` is the PID of the process reporting work, not the short-lived CLI invocation. The example values above are placeholders.

`register` installs an idle reporter, replacing any previous reporter for that runtime session. `unregister` removes only the matching reporter and preserves attention. These are registration operations. `busy` and `idle` are TreeTY work states, not operating-system scheduling states. `busy` clears attention atomically. `idle` and `register` preserve attention by default and accept `--attention set|clear`.

Pass `--metadata-path <json-pointer>` when registering an integration that stores its reporter ID in node metadata, for example `/integrations/example/sessionId`. TreeTY requires that value to equal `--reporter`, preserves the guard on later busy and idle updates, and validates it again when the host reads activity. Unregister can remove its matching activity after the metadata is removed. An older reporter cannot unregister a replacement reporter or process.

Multiple host sessions can report independent activity for the same node, including terminals in different VS Code windows. Attention remains attached to the node. Keep standalone CLI versions aligned with the host adapter and integration, as older attention-only state readers can discard runtime activity fields.

To override activity animation for one terminal:

```sh
treety configure <node-id> --activity-animation off
treety configure <node-id> --activity-animation on
treety configure <node-id> --clear-activity-animation
```
