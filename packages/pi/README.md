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

Run `/treety-setup` from Pi inside a TreeTY terminal. The command records the current session ID from Pi's session manager, captures Pi's current working directory, configures the terminal to resume it with `pi --session <session-id>` from that directory, and enables lifecycle attention signaling. TreeTY marks the terminal as needing attention when an agent settles or session compaction completes, including after `/compact`.

The extension uses small local interfaces for the Pi APIs it calls. Pi executes `src/extension.ts` directly, while the package's build and test scripts compile it only for static validation and isolated tests.
