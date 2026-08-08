# Changelog

## Unreleased

- Reconcile changed trees in place while preserving matching live terminal sessions.
- Add a searchable tree editor with inline placement controls, expanded-by-default navigation, and expand-all or collapse-all actions for moving terminals and groups.
- Remove redundant Open Terminal and Refresh buttons from the tree view.
- Add an actions gear to group and terminal rows, simplify terminal hover controls, and remove redundant TreeTY prefixes from context-menu labels.
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
