---
"@treety/core": minor
"@treety/cli": minor
"treety": patch
---

Rename `treety link` to `treety uri` and `TREETY_TERMINAL_LINK` to `TREETY_SESSION_URI`. In the core API, rename `TreeTYTerminalContext.terminalLink` to `sessionUri` and `treeTYTerminalLinkEnvironmentName` to `treeTYSessionUriEnvironmentName`. These are breaking API renames without legacy aliases. Recreate hosted terminals after updating so they receive the new environment variable, and update integrations to use the new command or variable.

Preserve the opaque host-provided URI for the current live session. Keep VS Code's Copy terminal link action and URI handling unchanged, and use sentence case consistently for extension command labels. The skill routes terminal-link work to the VS Code reference for migration and session lifetime details.
