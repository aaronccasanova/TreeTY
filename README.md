# TreeTY

TreeTY turns terminal sessions into a persistent, hierarchical workspace. Its first adapter is a VS Code extension, while its core engine has no VS Code dependencies.

## MVP behavior

- Render nested groups and terminal leaves in a dedicated Activity Bar view.
- Inherit directories, environment variables, shell settings, and restart policies through the tree.
- Create native VS Code terminals lazily and reveal an existing terminal when its leaf is selected.
- Reattach terminals revived by VS Code instead of launching duplicates.
- Track stopped, starting, idle, running, and failed states.
- Support interactive shells and direct startup commands.
- Load one `.treety/tree.json` configuration from every VS Code workspace folder.

## Architecture

```text
packages/core
  configuration parser and validation
  inheritance and path resolution
  session lifecycle state machine
  host-neutral TerminalHost interface

packages/vscode
  TreeDataProvider adapter
  vscode.Terminal host implementation
  workspace loading and file watching
  commands, menus, icons, and JSON schema
```

The core package controls behavior. A host adapter controls rendering, process creation, persistence discovery, and user interaction. This boundary leaves room for a CLI, another IDE, an external-terminal bridge, or a standalone application without changing the tree model.

## Configuration

TreeTY reads `.treety/tree.json` from the workspace root:

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

## Development

Requirements: Node.js 22 or newer and pnpm 10 or newer.

```sh
pnpm install
pnpm check
pnpm test
pnpm build
pnpm package
```

Open the repository in VS Code, select "Run Extension" from the Run and Debug view, then open the TreeTY Activity Bar container in the Extension Development Host.
