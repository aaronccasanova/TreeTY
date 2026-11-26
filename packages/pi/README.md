# TreeTY Pi extension

This package links a Pi session to the TreeTY terminal that launched it. It does not add Pi as a local dependency.

## Install from a local checkout

Local checkout installs are the primary workflow. Use the absolute path to a stable TreeTY checkout or worktree:

```sh
pi install /path/to/TreeTY
```

The repository root and its `packages/pi` directory both expose the same extension. Register only one of them. Pi records the local path without copying the package, so keep that checkout available at the same path.

If switching from the npm package, first run `pi remove npm:@treety/pi`, then install the local path above. Use `pi list` to check for an earlier Git or local entry and remove the old source before switching to avoid loading the extension twice. If the old entry is project-local, use `--local` for both removal and installation.

npm releases (`pi install npm:@treety/pi`) and a Pi-managed Git clone (`pi install git:github.com/aaronccasanova/TreeTY`) remain alternatives. A Git-source install uses Pi's separate clone, not your existing checkout. See [Pi's package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) for source and settings scopes.

### Refresh after changes

Pull updates into the checkout registered with Pi:

```sh
git -C /path/to/TreeTY pull --ff-only
```

Then run `/reload` in each existing Pi session, or start a new session. Pi reloads the TypeScript source and runs the extension's shutdown/startup hooks. Source-only changes need no `pi install`, `pi update`, or Pi package build. Updating another worktree does not update the registered path, and reloading one session does not reload the others.

The Pi extension currently has no runtime package dependencies and does not import built workspace packages. If dependency requirements change, install those dependencies in the checkout before reloading. Pi's local-path installation does not install dependencies for you. The CLI and VS Code extension have a separate build and installation workflow, described below.

## Link and unlink sessions

Ask Pi to link or unlink its current session using the `treety_link` and `treety_unlink` tools. Both take no arguments and use Pi's current session ID. They share the slash commands' behavior, return a confirmation as a tool result, and report failures through Pi's normal tool error handling. They work without an interactive UI.

Run `/treety-link` from Pi inside a TreeTY terminal. `/treety-setup` remains a compatibility alias for the same command. The command records the current session ID from Pi's session manager, captures Pi's current working directory, configures the terminal to resume it with `pi --session <session-id>` from that directory, and enables lifecycle activity signaling.

A linked Pi session is idle while waiting for input and busy throughout an agent run, including tools, automatic retries, queued follow-ups, and automatic compaction. Final `agent_settled` marks it idle and needing attention. `agent_end` does not mark it idle as Pi may continue automatically. Manual `/compact` is busy until it succeeds, fails, or is cancelled. Successful manual compaction also marks attention. Pi versions with `ui_prompt_start` and `ui_prompt_end` show idle during a blocking extension dialog and resume busy if work remains. Opening a dialog does not create a completion attention marker.

Run `/treety-unlink` when you're finished with the linked conversation but want to keep the terminal. It removes this session's `/integrations/pi/sessionId` and the exact `pi --session <session-id>` startup command written by `/treety-link`. The terminal stays open, its node and working directory remain, and your saved Pi conversation is untouched. Later restarts use the terminal's shell unless you've set a custom startup command. You can keep chatting or exit Pi normally, and run `/treety-link` again whenever you want to relink.

Unlink preserves unrelated metadata, shell/environment settings, and `restartPolicy`. If you've replaced the startup command, it keeps that custom command and tells you. It refuses to unlink a different session's association. Repeated use is harmless, and a configuration changed concurrently is left untouched so you can retry. Lifecycle hooks reread current metadata on startup and session changes, so stale terminal environment values don't reenable the unlinked session. Unlink, exit, reload, and session changes unregister this process's activity reporter. Existing attention markers are left alone. Starting work clears attention atomically with its busy signal.

Keep the TreeTY CLI compatible with this Pi extension. For the VS Code host, follow the [local build workflow](../../README.md#install-a-local-build): run `pnpm install:snapshot`, reload the VS Code window, and recreate terminals to pick up the updated bundled CLI and environment. Pi's `/reload` does not rebuild or install the VS Code extension or CLI. The integration requires the CLI's `activity` commands and guarded `configure --if-node` support, plus the `TREETY_SESSION_ID` supplied by a managed terminal. Each activity signal carries the Pi session ID, process ID, and `/integrations/pi/sessionId` metadata guard. TreeTY checks these against the current terminal session and link, so an old process cannot change a replacement session's activity or attention. Unregistering can only remove that process's matching reporter record.

The extension uses small local interfaces for the Pi APIs it calls. Pi executes `src/extension.ts` directly, while the package's build and test scripts compile it only for static validation and isolated tests.

The lifecycle handling follows [Pi's extension events](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#extension-events) and was checked against installed Pi 0.85.1 and current upstream source. Older Pi releases without UI prompt events retain turn and compaction signaling. Forced process termination cannot run shutdown hooks, so TreeTY also validates the reporting process and terminal session before using an activity record.
