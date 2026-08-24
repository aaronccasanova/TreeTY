# Releasing TreeTY

Releases are automated with Changesets 3 and [the Changesets GitHub Action](https://github.com/changesets/action). A merged delivery change produces or updates a release pull request. Merge that reviewed release PR to publish the npm packages in dependency order and then publish the VS Code Marketplace pre-release.

## Add a changeset

Every pull request that changes a shipped package or the VS Code extension must include a changeset:

```sh
pnpm changeset
```

Select every affected package and write the release-note summary. Select `treety` when the VS Code extension changes. Changesets treats the extension as a private package, which lets it version the extension and write `packages/vscode/CHANGELOG.md` without attempting to publish it to npm.

Changes that affect only tests, tooling, or documentation do not need a changeset.

## Merge the release PR

1. Merge delivery pull requests into `main`.
2. The `Release` workflow creates or updates a `Version Packages` pull request with version, dependency-range, and changelog changes.
3. Review and merge that release pull request.
4. The same workflow validates the release, publishes `@treety/core` and `@treety/cli` through npm trusted publishing in dependency-aware order, then packages and publishes the versioned pre-release VSIX for `TreeTY.treety`.

The workflow is serialized per branch. If npm publishing fails, it never reaches the extension publish step. After resolving the failure, rerun the release workflow from the failed release commit. Do not create a second release PR or manually change the generated versions.

Changesets publishes `@treety/core`, `@treety/cli`, and `@treety/pi` to npm. The private VS Code extension is published only to the Marketplace.

## One-time setup

Before merging the first release PR, configure the following external credentials.

### npm trusted publishers

For `@treety/core`, `@treety/cli`, and `@treety/pi`, open npm package settings, then add a GitHub Actions trusted publisher with:

- Organization or user: `aaronccasanova`
- Repository: `TreeTY`
- Workflow filename: `release.yml`
- Environment name: `release`
- Allowed action: `npm publish`

Trusted publishing requires the GitHub-hosted runner and the workflow's `id-token: write` permission. It removes the need for an npm token and generates npm provenance automatically. After confirming the first automated publish succeeds, npm recommends enabling `Require two-factor authentication and disallow tokens` for each package.

`@treety/pi` needs one bootstrap publish before npm exposes its package settings. After this PR merges, but before merging its generated `Version Packages` PR, publish the current `@treety/pi@0.0.2` from `main` with an interactive npm login, then configure its trusted publisher. The generated release PR will then publish the first managed `0.1.0` release through OIDC.

### VS Code Marketplace

Create a GitHub environment named `release`, add required reviewers if you want a confirmation gate, and add a `VSCE_PAT` environment secret. Create that Personal Access Token under the Microsoft account that owns the `TreeTY` publisher, with the Marketplace `Manage` scope. `vsce` reads `VSCE_PAT` automatically during the final publish step.

The Marketplace currently uses PAT authentication for this workflow. When TreeTY's publisher is migrated to Microsoft Entra ID, replace this secret-backed step with `vsce --azure-credential`.

### GitHub Actions

In repository settings, allow GitHub Actions to create and approve pull requests. The workflow already declares the required `contents`, `pull-requests`, and `id-token` permissions.

## Local checks

Run the complete release validation and artifact build without publishing:

```sh
pnpm release:prepare
```

To inspect the exact pending release plan locally:

```sh
pnpm changeset status
```
