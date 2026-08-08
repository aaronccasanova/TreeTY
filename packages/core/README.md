# TreeTY core

`@treety/core` is the host-neutral model and engine behind TreeTY. It provides configuration and local-state parsing, inherited working and project directories, opaque stable node IDs, freeform JSON metadata, immutable tree management, transactional file storage, terminal lifecycle state, and host interfaces without depending on VS Code or a specific terminal emulator.

Tree editing includes before/after ordering, startup-command updates, and targeted JSON Pointer metadata updates. `state.json` stores durable boolean attention separately from `tree.json`. Shared storage helpers use cooperative locks and atomic replacement, while `TreeTYEngine.reconcile()` updates a running tree without replacing matching live sessions.

Host adapters can use `buildTreeTYTerminalEnvironment` to inject TreeTY's standard config, node, metadata, and runtime session context into every terminal they create.

```ts
import {
  addTreeTerminal,
  createEmptyTreeConfig,
  formatTreeConfigContent,
} from "@treety/core";

const treeConfig = addTreeTerminal(createEmptyTreeConfig(), {
  name: "Workspace shell",
});

console.log(formatTreeConfigContent(treeConfig));
```
