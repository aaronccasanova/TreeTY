# TreeTY core

`@treety/core` is the host-neutral model and engine behind TreeTY. It provides configuration parsing, inherited working and project directories, opaque stable node IDs, freeform JSON metadata, immutable tree management, terminal lifecycle state, and host interfaces without depending on VS Code or a specific terminal emulator.

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
