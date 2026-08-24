# Changesets

Add a changeset to every pull request that changes a shipped package or the VS Code extension:

```sh
pnpm changeset
```

Select every affected package, choose the appropriate SemVer bump, and write a user-facing summary. Select `treety` for the VS Code extension and `@treety/codex` for the Codex plugin. Both are private to npm, but Changesets versions them and updates their changelogs. The release workflow publishes the VSIX to the Marketplace, while the Codex plugin remains a Git artifact.

Changes that do not affect a shipped deliverable do not need a changeset.
