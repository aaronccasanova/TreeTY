---
"@treety/pi": patch
"@treety/cli": patch
"treety": patch
---

Make `/treety-link` the canonical Pi linking command, keeping `/treety-setup` as a compatibility alias. Add `/treety-unlink` to remove the current Pi session association and its matching resume command without removing the terminal or saved session. Recover lifecycle signaling from current configuration, and add guarded CLI configuration updates so unlinking cannot overwrite a concurrent edit.
