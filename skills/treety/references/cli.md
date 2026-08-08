# TreeTY CLI reference

Use `@treety/cli` to inspect and mutate TreeTY configuration. It exposes the `treety` executable and requires Node.js 22 or newer.

## Choose a runner

Prefer an installed, project-pinned executable when available:

```sh
pnpm exec treety help
```

Otherwise run the published package without installing it globally:

```sh
pnpm dlx @treety/cli@latest help
```

With npm tooling, use:

```sh
npx --yes @treety/cli@latest help
```

Use the same runner consistently for the remaining examples, replacing `treety` when necessary.

## Resolve configuration scope

Run both path and list commands before a mutation:

```sh
treety config path
treety list
```

The scope precedence behaves as follows:

1. Use an explicit `--config <path>`.
2. Otherwise use `--global` when supplied.
3. Otherwise use `TREETY_CONFIG_FILE` when running inside a hosted TreeTY terminal.
4. Otherwise use `<current-directory>/.treety/tree.json` when it exists.
5. Otherwise use `$XDG_CONFIG_HOME/treety/tree.json` or `~/.config/treety/tree.json` when it exists.
6. If neither exists, resolve the local path and require `treety init` before other operations.

Override discovery with exactly one of:

```sh
treety config path --global
treety config path --config /absolute/path/to/tree.json
```

Use `--global` on every command intended for the global tree. Use `--config <path>` on every command intended for a custom file. Do not combine the two flags.

Node IDs are unique within one configuration. Treat the config file path and node ID together as the persistent identity. Different local, global, or custom configs may contain the same node ID.

Initialize a local or global tree:

```sh
treety init
treety init --global
```

Do not use `--force` unless replacing an existing tree is explicitly authorized.

## Inspect the tree

Render names and stable node IDs:

```sh
treety list
```

Read the full configuration as JSON when inherited settings or startup commands matter:

```sh
treety list --json
```

Use IDs shown in square brackets by the text view for later mutations.

Inside a TreeTY terminal, inspect its exact config and node definition:

```sh
treety current
treety show
```

`TREETY_NODE_ID` supplies the default node target. A positional node ID or `--node <node-id>` takes precedence. Outside a TreeTY terminal, pass a node ID explicitly.
`treety current` also reports the config source and `TREETY_SESSION_ID` when the host provides them. The session ID identifies the runtime terminal instance and can change when the terminal is recreated. The node ID remains stable.

## Add groups and terminals

Add a root group:

```sh
treety add group "Services" --cwd services
```

Add a nested group:

```sh
treety add group "Experiments" --parent <services-id> --cwd experiments
```

Add an interactive terminal leaf:

```sh
treety add terminal "API shell" --parent <services-id> --cwd api
```

Add a terminal leaf with a startup command. Everything after `--` becomes the executable and its argument array; it does not run during the CLI mutation:

```sh
treety add terminal "API server" --parent <services-id> --cwd api -- pnpm dev
```

Add a terminal that a host should launch when it opens the changed tree:

```sh
treety add terminal "Background worker" \
  --parent <services-id> \
  --cwd worker \
  --restart-policy onOpen \
  -- pnpm run worker
```

Without `--id`, TreeTY generates an opaque UUID that remains stable across renames and moves. Capture the ID printed by `add` or read it from `list`. Use `--id` only when the workflow genuinely needs an externally chosen identifier.

Node options inherit through the tree:

- `--cwd <path>` sets a working directory relative to the nearest inherited directory unless absolute.
- `--project-dir <path>` sets an optional project root. An absolute value remains unchanged; a relative value resolves from that node's resolved working directory. It inherits independently from `cwd` so project integrations do not need to assume that the terminal starts at the project root.
- `--env <NAME=value>` adds or overrides an environment value and can repeat.
- `--unset-env <NAME>` removes an inherited value and can repeat.
- `--shell <path>` selects a shell executable for interactive terminals.
- `--shell-arg <value>` adds a shell argument, can repeat, and requires `--shell`.
- `--restart-policy <manual|onOpen>` controls lazy or automatic launch behavior.
- `--metadata <json>` stores an optional freeform JSON value on the node without inheritance.

Group nodes accept the same options and pass their resolved defaults to descendants. A terminal startup command takes precedence over its inherited shell configuration.

## Rename, move, and remove nodes

```sh
treety rename <node-id> "Development API"
treety move <node-id> --parent <experiments-id>
treety move <node-id> --root
treety move <node-id> --before <sibling-id>
treety move <node-id> --after <sibling-id>
```

Removing a group also removes all descendants:

```sh
treety remove <node-id> --yes
```

Inside the target leaf, omit the ID or use `--node`:

```sh
treety rename "PR review"
treety move --parent <reviews-id>
treety remove --yes
```

## Configure nodes and metadata

Change node-owned settings without replacing inherited defaults:

```sh
treety configure <node-id> \
  --cwd packages/cli \
  --project-dir ../.. \
  --env MODE=review \
  --unset-env DEBUG \
  --restart-policy manual
```

Use `--clear-cwd`, `--clear-project-dir`, `--clear-shell`, or `--clear-restart-policy` to restore inheritance. Use `--delete-env <NAME>` to remove a node override; `--unset-env <NAME>` stores `null` and removes an inherited or host environment value when the terminal launches.

Set or clear an existing terminal's startup command:

```sh
treety configure <node-id> -- pi --session <session-id>
treety configure <node-id> --clear-command
```

Metadata accepts any JSON value and is replaced atomically:

```sh
treety metadata get <node-id>
treety metadata set <node-id> '{"owner":"platform","tags":["review"]}'
treety metadata clear <node-id>
treety metadata set-path <node-id> /integrations/example/id '"example-123"'
treety metadata clear-path <node-id> /integrations/example/id
```

Target the same operations in another config explicitly:

```sh
treety metadata set <node-id> '{"owner":"platform"}' --global
treety metadata set <node-id> '{"owner":"platform"}' --config /absolute/path/to/tree.json
```

Whole-value `metadata set` still replaces metadata. Use JSON Pointer path operations for targeted object changes. They preserve unrelated properties, create missing object parents, and reject incompatible traversal. Inside the target leaf, omit `<node-id>`.

Set or clear durable local attention:

```sh
treety attention set <node-id>
treety attention clear <node-id>
```

Inside the target terminal, both commands infer the config and node from `TREETY_CONFIG_FILE` and `TREETY_NODE_ID`. Attention is idempotent and stored in local `state.json`, not declarative `tree.json`.

Before removal, resolve the scope, inspect the tree, verify the exact ID, and obtain any required authorization. List the tree again after every mutation.

## Understand current limits

The CLI serializes tree and state changes with shared cooperative locks and atomic replacement. It does not host terminal processes or reveal, stop, or restart existing sessions. Host adapters decide how to watch configuration and reconcile live terminals. Read `vscode.md` for the current VS Code adapter's session behavior and refresh fallbacks.

## Link a Pi session

Install the repository Pi package with `pi install git:github.com/aaronccasanova/TreeTY`, then run `/treety-setup` inside the target TreeTY terminal. The TypeScript extension in `packages/pi` stores the current `PI_SESSION_ID` through `metadata set-path`, sets `pi --session <session-id>` through `configure`, leaves `restartPolicy` unchanged, and maps `agent_start` and `agent_settled` to generic attention commands. It defines a minimal local Pi API boundary and does not install Pi as a package dependency.
