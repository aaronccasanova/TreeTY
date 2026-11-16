---
"treety": patch
---

Keep the bundled CLI available in terminals restored after a full VS Code restart. Persist its PATH contribution through shutdown and use an atomically refreshed copy in extension storage so later extension updates don't strand restored terminals on a removed version directory. Terminals opened before this persistent CLI was installed need a one-time recreation to receive the stable path.
