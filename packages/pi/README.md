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

Run `/treety-link` from Pi inside a TreeTY terminal. `/treety-setup` remains a compatibility alias for the same command. The command records the current session ID from Pi's session manager, captures Pi's current working directory, configures the terminal to resume it with `pi --session <session-id>` from that directory, and enables lifecycle attention signaling. TreeTY marks the terminal as needing attention when an agent settles or session compaction completes, including after `/compact`.

Run `/treety-unlink` when you're finished with the linked conversation but want to keep the terminal. It removes this session's `/integrations/pi/sessionId` and the exact `pi --session <session-id>` startup command written by `/treety-link`. The terminal stays open, its node and working directory remain, and your saved Pi conversation is untouched. Later restarts use the terminal's shell unless you've set a custom startup command. You can keep chatting or exit Pi normally, and run `/treety-link` again whenever you want to relink.

Unlink preserves unrelated metadata, shell/environment settings, and `restartPolicy`. If you've replaced the startup command, it keeps that custom command and tells you. It refuses to unlink a different session's association. Repeated use is harmless, and a configuration changed concurrently is left untouched so you can retry. Lifecycle hooks reread current metadata on startup and session changes, so stale terminal environment values don't reenable the unlinked session. Existing attention markers are left alone.

Update the TreeTY CLI with this Pi extension, for example by rebuilding the VS Code extension with `pnpm install:snapshot`. Unlink needs the CLI's guarded `configure --if-node` support. An older CLI rejects the command without changing the configuration.

The extension uses small local interfaces for the Pi APIs it calls. Pi executes `src/extension.ts` directly, while the package's build and test scripts compile it only for static validation and isolated tests.
