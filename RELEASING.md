# Releasing TreeTY

TreeTY currently uses an explicit local release workflow. Keep the package versions and changelogs in source control, then publish each deliverable in dependency order.

## Release order

Publish releases in this order:

1. `@treety/core`
2. `@treety/cli`
3. `TreeTY.treety`

The CLI depends on the exact workspace version of core. pnpm replaces `workspace:*` with that version when it packs or publishes the CLI. The VS Code extension bundles core, so it does not depend on npm availability at runtime.

## Prepare the release

Update these versions before publishing:

- `packages/core/package.json`
- `packages/cli/package.json`
- `packages/vscode/package.json`

Update the relevant package changelogs and documentation in the same commit. Commit and push the release state to `main`, then confirm the worktree is clean and synchronized with `origin/main`.

Run the full validation and packaging pass from the repository root:

```sh
pnpm release:prepare
```

This command runs type checks, tests, and builds. It also creates the npm tarballs and the Marketplace pre-release VSIX under `artifacts/`. Inspect those artifacts before publishing when a release changes package contents or extension packaging.

## Publish npm packages

Publish core first:

```sh
pnpm release:publish:core
pnpm view @treety/core@latest version
```

Wait until the new core version is visible, then publish the CLI:

```sh
pnpm release:publish:cli
pnpm view @treety/cli@latest version
```

pnpm prompts directly when npm requires a one-time password or web-based authentication. A package version cannot be reused after it has been published, so resume from the failed step instead of rerunning earlier successful steps.

## Publish the VS Code extension

The VS Code Marketplace supports command-line publishing through `vsce`. For the current local authentication flow, sign in once with the `TreeTY` publisher ID:

```sh
pnpm --dir packages/vscode exec vsce login TreeTY
```

`vsce login` prompts for an Azure DevOps Personal Access Token with the Marketplace `Manage` scope. It stores the verified credential for later commands. It does not currently use a browser-based developer login.

Publish the pre-release:

```sh
pnpm release:publish:vscode
```

This command publishes the exact pre-release VSIX created by `pnpm release:prepare`. It stops if the expected versioned artifact is missing. Verify the result on the [TreeTY Marketplace listing](https://marketplace.visualstudio.com/items?itemName=TreeTY.treety).

Microsoft plans to retire global Azure DevOps Personal Access Tokens on December 1, 2026. Before automating Marketplace releases, migrate this step to Microsoft Entra ID authentication with `vsce --azure-credential` instead of adding a long-lived PAT to GitHub secrets.

## When to adopt release automation

Keep this workflow while releases are infrequent and version changes remain easy to review. Adopt Changesets or a comparable release tool when coordinated version bumps, generated changelogs, or release pull requests start consuming meaningful time.

Future automation should preserve the same boundaries:

- Use npm trusted publishing from GitHub Actions for `@treety/core` and `@treety/cli`.
- Publish core before CLI.
- Use Microsoft Entra ID for the VS Code Marketplace.
- Publish only from a clean, reviewed commit on `main`.
