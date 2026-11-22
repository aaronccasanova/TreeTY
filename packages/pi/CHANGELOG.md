# @treety/pi

## 0.1.1

### Patch Changes

- 8ae72d6: Make `/treety-link` the canonical Pi linking command, keeping `/treety-setup` as a compatibility alias. Add `/treety-unlink` to remove the current Pi session association and its matching resume command without removing the terminal or saved session. Recover lifecycle signaling from current configuration, and add guarded CLI configuration updates so unlinking cannot overwrite a concurrent edit.
- 6f9a484: Use consistent theme-aware status dots and a delayed native activity spinner. Track shell commands and linked Pi turns separately from terminal lifetime, preserve session-scoped activity across reloads, and mark long-command completion for attention. Add global and per-terminal animation preferences without changing execution or attention. Provide generic reporter registration and busy/idle work reports, guarded by terminal runtime, reporter identity, process ID, and optional metadata.

## 0.1.0

### Minor Changes

- 5a196a9: Publish the Pi extension to npm so it can be installed with `pi install npm:@treety/pi`.
