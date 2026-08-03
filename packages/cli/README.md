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
treety add group "Services" --cwd services
treety add terminal "API server" --parent services --cwd api -- pnpm dev
treety list
```

TreeTY uses `.treety/tree.json` in the current workspace. If that file does not exist, commands fall back to the global tree at `$XDG_CONFIG_HOME/treety/tree.json` or `~/.config/treety/tree.json`.

Run `treety help` for the complete command reference.
