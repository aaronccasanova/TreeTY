---
"treety": patch
"@treety/cli": patch
---

Bundle the CLI from the same source revision as the VS Code extension and add it to new integrated terminals automatically. Make local snapshot installation the primary iteration workflow, with dependency installation, build, packaging, and installation in one command. Keep Changesets and publishing available for deliberate releases.

Activate TreeTY at VS Code startup so ordinary integrated terminals receive its CLI without first opening the TreeTY view. Configured `onOpen` terminals can also start at startup.

Read the CLI version from its package metadata so bundled and standalone builds report the version scheduled by Changesets.
