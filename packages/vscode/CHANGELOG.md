# Changelog

## 0.1.9

### Patch Changes

- ced247d: Add window-routed links for live local VS Code terminal sessions. Copy links from TreeTY or read the current terminal's injected `TREETY_SESSION_URI` environment value. Links focus only the matching loaded configuration, node, and live session, and remain valid when VS Code recovers that session after an extension reload. Stopped or stale targets never launch a replacement process.
  
  Expose optional terminal links in the shared host environment and coalesce concurrent pending terminal launches while VS Code resolves the link. Cancel pending launches on stop, removal, restart, and disposal so a delayed URL cannot create an orphan terminal.
- 3d5dd21: Reveal and select terminals created from the VS Code UI, then open their native terminal with keyboard focus ready for input.
- 01f36bf: Bundle the CLI from the same source revision as the VS Code extension and add it to new integrated terminals automatically. Make local snapshot installation the primary iteration workflow, with dependency installation, build, packaging, and installation in one command. Keep Changesets and publishing available for deliberate releases.
  
  Activate TreeTY at VS Code startup so ordinary integrated terminals receive its CLI without first opening the TreeTY view. Configured `onOpen` terminals can also start at startup.
  
  Read the CLI version from its package metadata so bundled and standalone builds report the version scheduled by Changesets.
- caa73d2: Add Search Nodes to the TreeTY title bar and Command Palette. Find groups and terminals by name, ancestry, directory, and descriptive metadata with abbreviation and typo matching. Selecting a group reveals it in the tree, and selecting a terminal opens or focuses its session. Search stays current as configurations change.
- 2202bf5: Keep the bundled CLI available in terminals restored after a full VS Code restart. Persist its PATH contribution through shutdown and use an atomically refreshed copy in extension storage so later extension updates don't strand restored terminals on a removed version directory. Terminals opened before this persistent CLI was installed need a one-time recreation to receive the stable path.
- 8ae72d6: Make `/treety-link` the canonical Pi linking command, keeping `/treety-setup` as a compatibility alias. Add `/treety-unlink` to remove the current Pi session association and its matching resume command without removing the terminal or saved session. Recover lifecycle signaling from current configuration, and add guarded CLI configuration updates so unlinking cannot overwrite a concurrent edit.
- 4bca4ec: Collapse groups before closing roots in both the TreeTY sidebar and Move picker, so Collapse All provides a top-level overview before a second click collapses the entire tree.
- 778d6d6: Recover new VS Code terminal sessions through random native-title tokens and scoped files in extension global storage while keeping TreeTY labels plain. Coordinate launches for each leaf across windows and retry discovery on terminal events, opening a leaf, or Refresh. Active window owners and matching local terminals block replacement. Treat saved PIDs as advisory and allow explicit forgetting of unresolved sessions without an active owner. Retired identities keep their tokens while clearing owner and PID fields.
  
  Verify new window owners through a local socket handshake so reused extension-host PIDs don't block replacement. If endpoint startup fails, keep launches and recovery available through conservative PID checks and retry startup on later ownership writes. Bound concurrent recovery-file reads and reuse unchanged record contents. Honor an exit status already exposed during disposal when its close event hasn't arrived, while preserving live handles without inferring shutdown.
  
  Preserve identity after native User closes, which can also mean transfer, until explicit forgetting or recovery. TreeTY Stop and confirmed process exits clear it. Use the originating window's recorded shutdown settings to retire unowned sessions automatically when persistence was disabled, or when revival was set to never and the recorded process has exited. Await outstanding session operations and cleanup during extension deactivation. Retired tokens have no time-based expiry and remain recognizable if a native tab returns late. Use the shared filesystem storage path supplied by the Node extension host for both `file` and `vscode-userdata` URIs. Keep the tree available if that path is unavailable, while disabling new launches. Adopt sessions discovered after engine startup without replacing an existing session or a pending launch. Historical unmarked terminals with missing creation identity remain untouched.
- 586c6a2: Reveal and select a linked terminal's leaf in the TreeTY tree while keeping keyboard focus in the terminal.
- a6db0ac: Rename `treety link` to `treety uri` and `TREETY_TERMINAL_LINK` to `TREETY_SESSION_URI`. In the core API, rename `TreeTYTerminalContext.terminalLink` to `sessionUri` and `treeTYTerminalLinkEnvironmentName` to `treeTYSessionUriEnvironmentName`. These are breaking API renames without legacy aliases. Recreate hosted terminals after updating so they receive the new environment variable, and update integrations to use the new command or variable.
  
  Preserve the opaque host-provided URI for the current live session. Keep VS Code's Copy terminal link action and URI handling unchanged, and use sentence case consistently for extension command labels. The skill routes terminal-link work to the VS Code reference for migration and session lifetime details.
- 8b33d37: Remove redundant inline status and activity descriptions from terminal rows and the `treety.showStatusDescriptions` setting. Preserve status circles, the activity spinner, tooltips, and explicit screen-reader labels with the terminal name, status, and activity.
- 6f9a484: Use consistent theme-aware status dots and a delayed native activity spinner. Track shell commands and linked Pi turns separately from terminal lifetime, preserve session-scoped activity across reloads, and mark long-command completion for attention. Add global and per-terminal animation preferences without changing execution or attention. Provide generic reporter registration and busy/idle work reports, guarded by terminal runtime, reporter identity, process ID, and optional metadata.
- Updated dependencies [ced247d]
- Updated dependencies [01f36bf]
- Updated dependencies [8ae72d6]
- Updated dependencies [778d6d6]
- Updated dependencies [a6db0ac]
- Updated dependencies [6f9a484]
  - @treety/core@0.1.0
  - @treety/cli@0.1.0

## 0.1.8

### Patch Changes

- 407035e: Restart every terminal in a group from its actions or context menu.

## 0.1.7

### Patch Changes

- 1217f6e: Publish the VS Code extension through the Changesets release flow.

## 0.1.6 - 2026-08-23

- Focus the moving terminal or group when opening the Move editor so it is immediately in view.

## 0.1.5 - 2026-08-08

- Capture Pi's current working directory during `/treety-setup` so resumed sessions restart from the same directory.
- Add a **Collapse All** action to the terminal tree toolbar and Command Palette.

## 0.1.4 - 2026-08-08

- Add concise **Mark needs attention** and **Clear attention** actions to both the terminal actions gear and right-click menu.
- Prevent attention decorations from flickering when opening other terminals by skipping unchanged state writes and invalidating only affected terminal and ancestor decorations.

## 0.1.3 - 2026-08-07

- Add any group or terminal's project directory, live current working directory, or configured working directory to the VS Code workspace on demand. Groups without a configured directory offer a filterable list of resolved descendant directories.
- Configure directories through a filterable path field. Terminals offer their live current directory, while groups recursively offer every live descendant directory without depending on the active terminal.

## 0.1.2 - 2026-08-07

- Reconcile changed trees in place while preserving matching live terminal sessions.
- Add a searchable tree editor with inline placement controls, expanded-by-default navigation, and expand-all or collapse-all actions for moving terminals and groups.
- Remove redundant Open Terminal and Refresh buttons from the tree view.
- Add a complete actions gear to group and terminal rows, keep it at the far right after delete, simplify action labels, and remove redundant TreeTY prefixes from context-menu labels.
- Stabilize move-editor controls as insert above, insert below, and move inside, with clearer indentation for terminal leaves.
- Render durable attention independently from lifecycle status and propagate it to ancestor groups.
- Route configuration and state mutations through shared cooperative locks and atomic replacement.

## 0.1.1 - 2026-08-04

- Generate opaque UUIDs for new groups and terminals while preserving existing IDs.
- Add inherited project directories, freeform node metadata, and in-terminal CLI targeting.
- Add node configuration controls for directories, environment, metadata, and restart policy.
- Make Explorer sync opt-in by default and show the exact configured project path before adding it.
- Close live terminals when a valid external configuration update removes their leaves.
- Inject the host-neutral TreeTY terminal context defined by `@treety/core`.

## 0.1.0 - 2026-08-03

Initial TreeTY pre-release.

- Organize native VS Code terminals into persistent nested groups.
- Manage global and workspace-local trees from one Activity Bar view.
- Create, rename, move, stop, restart, and delete terminal entries.
- Add terminal directories to VS Code Explorer and Source Control.
- Resolve inherited directories, environments, commands, and restart policies through the shared TreeTY core.
