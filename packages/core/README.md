# TreeTY core

`@treety/core` is the host-neutral model and engine behind TreeTY. It provides configuration parsing, inheritance, immutable tree management, terminal lifecycle state, and host interfaces without depending on VS Code or a specific terminal emulator.

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
