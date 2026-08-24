# TreeTY Codex plugin

This private workspace package links a Codex session to the TreeTY terminal that launched it. It is distributed as a Codex plugin from this repository, not as an npm package.

After installing and trusting the plugin hooks, invoke `$treety-setup` from Codex inside a TreeTY terminal. The setup hook records the current Codex session ID, captures Codex's working directory, and configures the terminal to resume with `codex resume <session-id>`.

The plugin clears attention when a linked session receives a prompt. It sets attention when Codex stops or finishes compaction. Every event reads current TreeTY metadata before signaling, so replacing the session in a terminal disables signaling from the old session.

Codex discovers `hooks/hooks.json` and the `treety-setup` skill from the plugin root. The hook implementation has no runtime dependencies beyond Node.js and the `treety` executable.
