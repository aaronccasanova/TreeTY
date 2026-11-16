---
"@treety/core": patch
"treety": patch
---

Recover new VS Code terminal sessions through random native-title tokens and scoped files in extension global storage while keeping TreeTY labels plain. Coordinate launches for each leaf across windows and retry discovery on terminal events, opening a leaf, or Refresh. Active window owners and matching local terminals block replacement. Treat saved PIDs as advisory and allow explicit forgetting of unresolved sessions without an active owner. Retired identities keep their tokens while clearing owner and PID fields.

Verify new window owners through a local socket handshake so reused extension-host PIDs don't block replacement. If endpoint startup fails, keep launches and recovery available through conservative PID checks and retry startup on later ownership writes. Bound concurrent recovery-file reads and reuse unchanged record contents. Honor an exit status already exposed during disposal when its close event hasn't arrived, while preserving live handles without inferring shutdown.

Preserve identity after native User closes, which can also mean transfer, until explicit forgetting or recovery. TreeTY Stop and confirmed process exits clear it. Use the originating window's recorded shutdown settings to retire unowned sessions automatically when persistence was disabled, or when revival was set to never and the recorded process has exited. Await outstanding session operations and cleanup during extension deactivation. Retired tokens have no time-based expiry and remain recognizable if a native tab returns late. Use the shared filesystem storage path supplied by the Node extension host for both `file` and `vscode-userdata` URIs. Keep the tree available if that path is unavailable, while disabling new launches. Adopt sessions discovered after engine startup without replacing an existing session or a pending launch. Historical unmarked terminals with missing creation identity remain untouched.
