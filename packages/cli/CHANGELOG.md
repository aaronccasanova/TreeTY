# @treety/cli

## 0.0.4

### Patch Changes

- ced247d: Add window-routed links for live local VS Code terminal sessions. Copy links from TreeTY or print the current terminal's injected link with `treety link`. Links focus only the matching loaded configuration, node, and live session, and remain valid when VS Code recovers that session after an extension reload. Stopped or stale targets never launch a replacement process.
  
  Expose optional terminal links in the shared host environment and coalesce concurrent pending terminal launches while VS Code resolves the link. Cancel pending launches on stop, removal, restart, and disposal so a delayed URL cannot create an orphan terminal.
- 01f36bf: Bundle the CLI from the same source revision as the VS Code extension and add it to new integrated terminals automatically. Make local snapshot installation the primary iteration workflow, with dependency installation, build, packaging, and installation in one command. Keep Changesets and publishing available for deliberate releases.
  
  Activate TreeTY at VS Code startup so ordinary integrated terminals receive its CLI without first opening the TreeTY view. Configured `onOpen` terminals can also start at startup.
  
  Read the CLI version from its package metadata so bundled and standalone builds report the version scheduled by Changesets.
- Updated dependencies [ced247d]
  - @treety/core@0.0.4
