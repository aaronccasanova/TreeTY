# TreeTY Pi extension

This package links a Pi session to the TreeTY terminal that launched it. It does not add Pi as a local dependency.

Install it from npm:

```sh
pi install npm:@treety/pi
```

You can also install the complete TreeTY repository Pi package:

```sh
pi install git:github.com/aaronccasanova/TreeTY
```

Run `/treety-link` from Pi inside a TreeTY terminal. `/treety-setup` remains a compatibility alias for the same command. The command records the current session ID from Pi's session manager, captures Pi's current working directory, configures the terminal to resume it with `pi --session <session-id>` from that directory, and enables lifecycle activity signaling.

A linked Pi session is idle while waiting for input and busy throughout an agent run, including tools, automatic retries, queued follow-ups, and automatic compaction. Final `agent_settled` marks it idle and needing attention. `agent_end` does not mark it idle as Pi may continue automatically. Manual `/compact` is busy until it succeeds, fails, or is cancelled. Successful manual compaction also marks attention. Pi versions with `ui_prompt_start` and `ui_prompt_end` show idle during a blocking extension dialog and resume busy if work remains. Opening a dialog does not create a completion attention marker.

Run `/treety-unlink` when you're finished with the linked conversation but want to keep the terminal. It removes this session's `/integrations/pi/sessionId` and the exact `pi --session <session-id>` startup command written by `/treety-link`. The terminal stays open, its node and working directory remain, and your saved Pi conversation is untouched. Later restarts use the terminal's shell unless you've set a custom startup command. You can keep chatting or exit Pi normally, and run `/treety-link` again whenever you want to relink.

Unlink preserves unrelated metadata, shell/environment settings, and `restartPolicy`. If you've replaced the startup command, it keeps that custom command and tells you. It refuses to unlink a different session's association. Repeated use is harmless, and a configuration changed concurrently is left untouched so you can retry. Lifecycle hooks reread current metadata on startup and session changes, so stale terminal environment values don't reenable the unlinked session. Unlink, exit, reload, and session changes release this process's activity ownership. Existing attention markers are left alone. Starting work clears attention atomically with its busy signal.

Update the TreeTY CLI with this Pi extension, for example by rebuilding the VS Code extension with `pnpm install:snapshot`. The integration requires the CLI's `activity` commands and guarded `configure --if-node` support, plus the `TREETY_SESSION_ID` supplied by a managed terminal. Each activity signal carries the Pi session ID, process ID, and `/integrations/pi/sessionId` metadata guard. TreeTY checks these against the current terminal session and link, so an old process cannot change a replacement session's activity or attention. Ownership cleanup can only remove that process's own record.

The extension uses small local interfaces for the Pi APIs it calls. Pi executes `src/extension.ts` directly, while the package's build and test scripts compile it only for static validation and isolated tests.

The lifecycle handling follows [Pi's extension events](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#extension-events) and was checked against installed Pi 0.85.1 and current upstream source. Older Pi releases without UI prompt events retain turn and compaction signaling. Forced process termination cannot run shutdown hooks, so TreeTY also validates the owning process and terminal session before using an activity record.
