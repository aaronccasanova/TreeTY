# TreeTY CLI

The `@treety/cli` package exposes the `treety` command. It manages the same tree configuration consumed by TreeTY's host adapters.

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

Run `treety help` for the complete command reference.

New nodes receive opaque UUIDs unless `--id` supplies an explicit stable ID. Names remain freely renameable display values. IDs are unique within one config, so the complete persistent identity is the config file path plus node ID.

Inside a terminal created by a TreeTY host adapter, `treety current`, `treety configure`, `treety rename`, and `treety metadata` can infer the current configuration and node from the standard injected environment. `TREETY_SESSION_ID` identifies the runtime terminal instance, while `TREETY_NODE_ID` identifies its persistent leaf.

Tree and attention mutations use bounded cooperative locks and atomic replacement, so concurrent TreeTY commands preserve one another. Local attention lives in `.treety/state.json`; a custom config such as `review.json` uses `review.state.json`.

Use `move --before <sibling-id>` or `move --after <sibling-id>` for explicit ordering. Use a command after `configure ... --` to set a terminal startup command, or `--clear-command` to remove it. `metadata set-path` and `metadata clear-path` apply targeted JSON Pointer changes. `attention set` and `attention clear` default to the current `TREETY_NODE_ID` inside a TreeTY terminal.
