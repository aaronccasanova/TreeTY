---
"@treety/core": patch
"@treety/cli": patch
"treety": patch
---

Add window-routed links for live local VS Code terminal sessions. Copy links from TreeTY or print the current terminal's injected link with `treety link`. Links focus only the matching loaded configuration, node, and live session, and remain valid when VS Code recovers that session after an extension reload. Stopped or stale targets never launch a replacement process.

Expose optional terminal links in the shared host environment and coalesce concurrent pending terminal launches while VS Code resolves the link. Cancel pending launches on stop, removal, restart, and disposal so a delayed URL cannot create an orphan terminal.
