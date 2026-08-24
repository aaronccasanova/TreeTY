---
name: treety-setup
description: Link the current Codex session to the TreeTY terminal that launched it. Use only when the user invokes $treety-setup or asks to connect this Codex session to TreeTY resume and attention signaling.
---

# TreeTY setup

The TreeTY Codex plugin handles setup through its `UserPromptSubmit` hook before this skill runs.

If developer context says TreeTY setup completed, confirm that TreeTY will resume this Codex session and signal when it needs attention.

If that context is absent, do not infer or search for the Codex session ID. Tell the user to open `/hooks`, trust the TreeTY Codex hooks, and invoke `$treety-setup` again.
