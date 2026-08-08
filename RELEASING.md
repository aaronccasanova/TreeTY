# Releasing TreeTY

TreeTY currently uses an explicit local release workflow. Keep the package versions and changelogs in source control, then publish each deliverable in dependency order.

## Release order

Publish releases in this order:

1. `@treety/core`
2. `@treety/cli`
3. `TreeTY.treety`

The CLI depends on the exact workspace version of core. pnpm replaces `workspace:*` with that version when it packs or publishes the CLI. The VS Code extension bundles core, so it does not depend on npm availability at runtime.

The private `@treety/pi` package is not published separately. It ships with the repository through the root Pi package manifest. Keep its workspace version synchronized with the root package version so Pi can detect Git package updates.

## Prepare the release

Update these versions before publishing:

- `package.json`
- `packages/core/package.json`
- `packages/cli/package.json`
- `packages/pi/package.json`
- `packages/vscode/package.json`

Only bump deliverables changed by the release. Keep the root Pi package and `packages/pi/package.json` at the same version. Keep `packages/cli/src/cli.ts`, its version test, the root README, and the VS Code changelog synchronized with the relevant package versions.

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

The VS Code Marketplace supports command-line publishing through `vsce`. TreeTY installs `@vscode/vsce` as a local development dependency, so a global `vsce` command is not required.

### Create a Marketplace token

Create the token with the same Microsoft account that owns the `TreeTY` Marketplace publisher:

1. Sign in to the [Azure DevOps portal](https://dev.azure.com/).
2. Open the user settings menu from your avatar, then select **Personal access tokens**.
3. Select **New Token**.
4. Enter a descriptive name such as `TreeTY VS Code publishing`.
5. Set **Organization** to **All accessible organizations**.
6. Choose the shortest practical expiration period.
7. Select **Custom defined** scopes, then select **Show all scopes**.
8. Under **Marketplace**, enable **Manage**.
9. Select **Create**, then copy the token immediately. Azure DevOps displays it only once.

See the [official VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token) for the current token requirements.

Sign in once with the local `vsce` installation and the `TreeTY` publisher ID:

```sh
pnpm --dir packages/vscode exec vsce login TreeTY
```

Paste the token at the `Personal Access Token for publisher 'TreeTY':` prompt, then press Enter. The prompt does not display the pasted value. `vsce login` stores the verified credential for later commands and does not currently use a browser-based developer login. Running the publish command without logging in first produces the same token prompt and can publish immediately.

If `vsce` cannot open the operating system credential store, it warns that it will store the token as clear text in `~/.vsce`. Use a short-lived token in that situation. After publishing, remove the stored publisher credential with:

```sh
pnpm --dir packages/vscode exec vsce logout TreeTY
```

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
