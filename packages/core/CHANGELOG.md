# @treety/core

## 0.1.0

### Minor Changes

- a6db0ac: Rename `treety link` to `treety uri` and `TREETY_TERMINAL_LINK` to `TREETY_SESSION_URI`. In the core API, rename `TreeTYTerminalContext.terminalLink` to `sessionUri` and `treeTYTerminalLinkEnvironmentName` to `treeTYSessionUriEnvironmentName`. These are breaking API renames without legacy aliases. Recreate hosted terminals after updating so they receive the new environment variable, and update integrations to use the new command or variable.
  
  Preserve the opaque host-provided URI for the current live session. Keep VS Code's Copy terminal link action and URI handling unchanged, and use sentence case consistently for extension command labels. The skill routes terminal-link work to the VS Code reference for migration and session lifetime details.

### Patch Changes

- ced247d: Add window-routed links for live local VS Code terminal sessions. Copy links from TreeTY or read the current terminal's injected `TREETY_SESSION_URI` environment value. Links focus only the matching loaded configuration, node, and live session, and remain valid when VS Code recovers that session after an extension reload. Stopped or stale targets never launch a replacement process.
  
  Expose optional terminal links in the shared host environment and coalesce concurrent pending terminal launches while VS Code resolves the link. Cancel pending launches on stop, removal, restart, and disposal so a delayed URL cannot create an orphan terminal.
- 778d6d6: Recover new VS Code terminal sessions through random native-title tokens and scoped files in extension global storage while keeping TreeTY labels plain. Coordinate launches for each leaf across windows and retry discovery on terminal events, opening a leaf, or Refresh. Active window owners and matching local terminals block replacement. Treat saved PIDs as advisory and allow explicit forgetting of unresolved sessions without an active owner. Retired identities keep their tokens while clearing owner and PID fields.
  
  Verify new window owners through a local socket handshake so reused extension-host PIDs don't block replacement. If endpoint startup fails, keep launches and recovery available through conservative PID checks and retry startup on later ownership writes. Bound concurrent recovery-file reads and reuse unchanged record contents. Honor an exit status already exposed during disposal when its close event hasn't arrived, while preserving live handles without inferring shutdown.
  
  Preserve identity after native User closes, which can also mean transfer, until explicit forgetting or recovery. TreeTY Stop and confirmed process exits clear it. Use the originating window's recorded shutdown settings to retire unowned sessions automatically when persistence was disabled, or when revival was set to never and the recorded process has exited. Await outstanding session operations and cleanup during extension deactivation. Retired tokens have no time-based expiry and remain recognizable if a native tab returns late. Use the shared filesystem storage path supplied by the Node extension host for both `file` and `vscode-userdata` URIs. Keep the tree available if that path is unavailable, while disabling new launches. Adopt sessions discovered after engine startup without replacing an existing session or a pending launch. Historical unmarked terminals with missing creation identity remain untouched.
- 6f9a484: Use consistent theme-aware status dots and a delayed native activity spinner. Track shell commands and linked Pi turns separately from terminal lifetime, preserve session-scoped activity across reloads, and mark long-command completion for attention. Add global and per-terminal animation preferences without changing execution or attention. Provide generic reporter registration and busy/idle work reports, guarded by terminal runtime, reporter identity, process ID, and optional metadata.
