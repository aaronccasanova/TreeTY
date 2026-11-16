---
"@treety/core": patch
"treety": patch
---

Recover new VS Code terminal sessions through a random native-title token and scoped record in a separate file under extension global storage while keeping TreeTY labels plain. Retry delayed discovery, preserve recovery records across shutdown, and require an explicit new launch when a saved session remains unresolved. Adopt sessions discovered after engine startup without replacing an existing session or a pending launch. Historical unmarked terminals with missing creation identity remain untouched.
