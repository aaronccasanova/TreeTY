# TreeTY Codex plugin

This plugin links a Codex session to the TreeTY terminal that launched it. Install the TreeTY marketplace and plugin globally with:

```sh
codex plugin marketplace add aaronccasanova/TreeTY --ref main
codex plugin add treety-codex@treety
```

After trusting the plugin hooks, invoke `/treety-setup` from Codex inside a TreeTY terminal. The `UserPromptSubmit` hook handles that exact prompt without sending it to the model. It records the current Codex session ID, captures Codex's working directory, and configures the terminal to resume with `codex resume <session-id>`.

The plugin clears attention when a linked session receives a prompt. It sets attention when Codex stops or finishes compaction. Every event reads current TreeTY metadata before signaling, so replacing the session in a terminal disables signaling from the old session.

Codex discovers `hooks/hooks.json` from the plugin root. The hook implementation has no runtime dependencies beyond Node.js and the `treety` executable.
