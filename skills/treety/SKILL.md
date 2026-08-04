---
name: treety
description: Manage and extend TreeTY hierarchical terminal workspaces. Use when an agent needs to inspect, create, rename, move, or remove TreeTY groups and terminal leaves; coordinate independent terminal or agent sessions through @treety/cli; work with local .treety/tree.json or global TreeTY configuration; operate the TreeTY VS Code integration; or build a custom host adapter with @treety/core.
---

# TreeTY

Use TreeTY as a persistent control plane for terminal definitions. Keep the tree model independent from its host: the CLI mutates configuration, the VS Code adapter turns terminal leaves into native terminal sessions, and the core package supports new adapters.

## Route the task

- Read [references/cli.md](references/cli.md) before inspecting or changing a tree from the command line. Prefer this surface for agent-driven management.
- Read [references/vscode.md](references/vscode.md) when the result must appear or run in VS Code, or when diagnosing configuration refresh, terminal persistence, Explorer sync, or session state.
- Read [references/core.md](references/core.md) before importing `@treety/core`, changing the shared model, or implementing another host adapter.

Read only the references needed for the current task.

## Follow the management workflow

1. Select a stable CLI runner using the guidance in `references/cli.md`.
2. Resolve the exact configuration path before making changes.
3. Inspect the current tree and use node IDs for parent, move, rename, and remove operations.
4. Apply the smallest requested mutation through the CLI. Do not edit JSON manually when the CLI supports the operation.
5. List the resulting tree and confirm the intended scope, hierarchy, working directories, and restart policies.
6. Explain whether the result creates only a persistent terminal definition or also starts a VS Code terminal.

Treat `remove --yes` and `init --force` as destructive. Confirm the resolved configuration path and exact target before running either command. Obtain user authorization when the requested work does not already clearly include removal or replacement.

## Preserve host boundaries

- Use the CLI to manage local, global, or explicitly selected configuration files.
- Use VS Code to create, reveal, restart, stop, and track native terminal sessions.
- Use the core package for parsing, inheritance, immutable tree operations, lifecycle orchestration, and host contracts.
- Do not claim that the current CLI can attach to, reveal, stop, or restart a live terminal. It manages terminal definitions only.
- Do not invent an external terminal emulator integration. The current adapter launches native VS Code integrated terminals.

When an agent should add a leaf and have VS Code launch it after the configuration reloads, use `--restart-policy onOpen`. With the default `manual` policy, the new leaf persists but waits for a user to open or restart it in VS Code.
