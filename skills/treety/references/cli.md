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

The default scope behaves as follows:

1. Use `<current-directory>/.treety/tree.json` when it exists.
2. Otherwise use `$XDG_CONFIG_HOME/treety/tree.json` when it exists.
3. Otherwise use `~/.config/treety/tree.json` when it exists.
4. If neither exists, resolve the local path and require `treety init` before other operations.

Override discovery with exactly one of:

```sh
treety config path --global
treety config path --config /absolute/path/to/tree.json
```

Use `--global` on every command intended for the global tree. Use `--config <path>` on every command intended for a custom file. Do not combine the two flags.

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

## Add groups and terminals

Add a root group:

```sh
treety add group "Services" --id services --cwd services
```

Add a nested group:

```sh
treety add group "Experiments" --parent services --cwd experiments
```

Add an interactive terminal leaf:

```sh
treety add terminal "API shell" --parent services --cwd api
```

Add a terminal leaf with a startup command. Everything after `--` becomes the executable and its argument array; it does not run during the CLI mutation:

```sh
treety add terminal "API server" --parent services --cwd api -- pnpm dev
```

Add a terminal that VS Code should launch when it reloads the changed tree:

```sh
treety add terminal "Research agent" \
  --parent agents \
  --cwd research \
  --restart-policy onOpen \
  -- codex
```

Without `--id`, TreeTY derives a unique lowercase hyphenated ID from the name. Prefer explicit IDs in automation when later commands need a predictable handle.

Node options inherit through the tree:

- `--cwd <path>` sets a working directory relative to the nearest inherited directory unless absolute.
- `--env <NAME=value>` adds or overrides an environment value and can repeat.
- `--unset-env <NAME>` removes an inherited value and can repeat.
- `--shell <path>` selects a shell executable for interactive terminals.
- `--shell-arg <value>` adds a shell argument, can repeat, and requires `--shell`.
- `--restart-policy <manual|onOpen>` controls lazy or automatic launch behavior.

Group nodes accept the same options and pass their resolved defaults to descendants. A terminal startup command takes precedence over its inherited shell configuration.

## Rename, move, and remove nodes

```sh
treety rename api-server "Development API"
treety move api-server --parent experiments
treety move api-server --root
```

Removing a group also removes all descendants:

```sh
treety remove api-server --yes
```

Before removal, resolve the scope, inspect the tree, verify the exact ID, and obtain any required authorization. List the tree again after every mutation.

## Understand current limits

The CLI writes configuration atomically. It does not host terminal processes or control existing sessions. In VS Code, the extension watches local and global configuration files and normally reloads the tree automatically. Read `vscode.md` for session behavior and refresh fallbacks.
