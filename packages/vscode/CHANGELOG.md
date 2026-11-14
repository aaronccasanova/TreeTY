# Changelog

## 0.1.9

### Patch Changes

- ced247d: Add window-routed links for live local VS Code terminal sessions. Copy links from TreeTY or print the current terminal's injected link with `treety link`. Links focus only the matching loaded configuration, node, and live session, and remain valid when VS Code recovers that session after an extension reload. Stopped or stale targets never launch a replacement process.
  
  Expose optional terminal links in the shared host environment and coalesce concurrent pending terminal launches while VS Code resolves the link. Cancel pending launches on stop, removal, restart, and disposal so a delayed URL cannot create an orphan terminal.
- 01f36bf: Bundle the CLI from the same source revision as the VS Code extension and add it to new integrated terminals automatically. Make local snapshot installation the primary iteration workflow, with dependency installation, build, packaging, and installation in one command. Keep Changesets and publishing available for deliberate releases.
  
  Activate TreeTY at VS Code startup so ordinary integrated terminals receive its CLI without first opening the TreeTY view. Configured `onOpen` terminals can also start at startup.
  
  Read the CLI version from its package metadata so bundled and standalone builds report the version scheduled by Changesets.
- caa73d2: Add Search Nodes to the TreeTY title bar and Command Palette. Find groups and terminals by name, ancestry, directory, and descriptive metadata with abbreviation and typo matching. Selecting a group reveals it in the tree, and selecting a terminal opens or focuses its session. Search stays current as configurations change.
- Updated dependencies [ced247d]
- Updated dependencies [01f36bf]
  - @treety/core@0.0.4
  - @treety/cli@0.0.4

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
