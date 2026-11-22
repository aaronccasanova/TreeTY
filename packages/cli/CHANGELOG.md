# @treety/cli

## 0.1.0

### Minor Changes

- b18bf5c: Add scoped CLI help, reject empty or malformed command targets, and provide opt-in JSON mutation receipts. Preserve startup-command passthrough and explicit option values.
  
  Accept explicit node targets in VS Code commands and return their asynchronous results and failures. Return explicit launch completion or cancellation from the core engine. Export a versioned API for verified live terminal identity, including restored sessions. Keep stop confirmation unless a caller explicitly overrides it.
  
  Persist tree expansion state and refresh only affected rows, parents, and attention decorations when configuration changes. Preserve the two-step Collapse All behavior.
- a6db0ac: Rename `treety link` to `treety uri` and `TREETY_TERMINAL_LINK` to `TREETY_SESSION_URI`. In the core API, rename `TreeTYTerminalContext.terminalLink` to `sessionUri` and `treeTYTerminalLinkEnvironmentName` to `treeTYSessionUriEnvironmentName`. These are breaking API renames without legacy aliases. Recreate hosted terminals after updating so they receive the new environment variable, and update integrations to use the new command or variable.
  
  Preserve the opaque host-provided URI for the current live session. Keep VS Code's Copy terminal link action and URI handling unchanged, and use sentence case consistently for extension command labels. The skill routes terminal-link work to the VS Code reference for migration and session lifetime details.

### Patch Changes

- ced247d: Add window-routed links for live local VS Code terminal sessions. Copy links from TreeTY or read the current terminal's injected `TREETY_SESSION_URI` environment value. Links focus only the matching loaded configuration, node, and live session, and remain valid when VS Code recovers that session after an extension reload. Stopped or stale targets never launch a replacement process.
  
  Expose optional terminal links in the shared host environment and coalesce concurrent pending terminal launches while VS Code resolves the link. Cancel pending launches on stop, removal, restart, and disposal so a delayed URL cannot create an orphan terminal.
- 01f36bf: Bundle the CLI from the same source revision as the VS Code extension and add it to new integrated terminals automatically. Make local snapshot installation the primary iteration workflow, with dependency installation, build, packaging, and installation in one command. Keep Changesets and publishing available for deliberate releases.
  
  Activate TreeTY at VS Code startup so ordinary integrated terminals receive its CLI without first opening the TreeTY view. Configured `onOpen` terminals can also start at startup.
  
  Read the CLI version from its package metadata so bundled and standalone builds report the version scheduled by Changesets.
- 8ae72d6: Make `/treety-link` the canonical Pi linking command, keeping `/treety-setup` as a compatibility alias. Add `/treety-unlink` to remove the current Pi session association and its matching resume command without removing the terminal or saved session. Recover lifecycle signaling from current configuration, and add guarded CLI configuration updates so unlinking cannot overwrite a concurrent edit.
- 6f9a484: Use consistent theme-aware status dots and a delayed native activity spinner. Track shell commands and linked Pi turns separately from terminal lifetime, preserve session-scoped activity across reloads, and mark long-command completion for attention. Add global and per-terminal animation preferences without changing execution or attention. Provide generic reporter registration and busy/idle work reports, guarded by terminal runtime, reporter identity, process ID, and optional metadata.
- Updated dependencies [ced247d]
- Updated dependencies [b18bf5c]
- Updated dependencies [778d6d6]
- Updated dependencies [a6db0ac]
- Updated dependencies [6f9a484]
  - @treety/core@0.1.0
