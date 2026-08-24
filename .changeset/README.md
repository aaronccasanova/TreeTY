# Changesets

Add a changeset to every pull request that changes a shipped package or the VS Code extension:

```sh
pnpm changeset
```

Select every affected package, choose the appropriate SemVer bump, and write a user-facing summary. Select `treety` for the VS Code extension. It is private to npm, but Changesets versions it and updates its changelog before the release workflow publishes its VSIX to the Marketplace.

Changes that do not affect a shipped deliverable do not need a changeset.
