---
"@treety/core": patch
"treety": patch
---

Recover new VS Code terminal sessions through random native-title tokens and scoped files in extension global storage while keeping TreeTY labels plain. Coordinate launches for each leaf across windows, retain unresolved identity through shutdown, and retry discovery on terminal events, opening a leaf, or Refresh. Known live sessions block replacement. Unknown sessions require an explicit forget action before a new launch. Keep the tree available when shared filesystem storage is unavailable, while disabling new launches. Adopt sessions discovered after engine startup without replacing an existing session or a pending launch. Historical unmarked terminals with missing creation identity remain untouched.
