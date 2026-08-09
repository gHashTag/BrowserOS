---
name: agent-safe-build
description: Build TriOS without breaking the app the user is running. Use for any build, rebuild, verification or release of trios - especially when several agents share the repository. Covers the make interface, the dev/release split, and the verification traps that made earlier reports wrong.
---

# Agent-safe build

## The rule

**`make` builds DEV. Release is a deliberate act.**

```bash
make            # dev app; never touches trios.app
make check      # dev build + every logic suite
make run        # build dev and launch it
make release    # replaces trios.app - only when asked
make promote    # gates, then release
make doctor     # state of both variants
```

Never call `./build.sh` directly and never pass `TRIOS_VARIANT=prod` unless the
user asked to ship. The script still exists as an implementation detail; the
Makefile is the interface.

## Why this exists

The dev variant existed for a while and was correct, but `build.sh` defaulted to
`prod`. Every skill, cron job and habit runs the bare command, so routine work
kept overwriting the bundle the user was actively using - the UI would break as a
side effect of an unrelated task. The safe option has to be the default, not the
documented one.

## What is isolated

Both variants coexist because they share nothing:

| Axis | dev | release |
|------|-----|---------|
| Bundle | `trios-dev.app` | `trios.app` |
| Bundle id | `com.browseros.trios.dev` | `com.browseros.trios` |
| Binary | `trios_dev_app` | `trios_app` |
| Frameworks | `Frameworks-dev` | `Frameworks` |
| Data root | `.trinity-dev` | `.trinity` |
| MCP port | 9205 | 9105 |
| Secrets | `DevSecretStore` (files) | Keychain |

The data root matters most: while it was shared, a dev schema change could
corrupt the running app's encrypted database.

`BuildVariantPolicy` encodes all of this and `tests/swift/build_variant_test.swift`
asserts the default is dev, so flipping it back fails loudly.

## Verification traps

These produced confidently wrong reports. Check for them.

1. **Do not grep for failure text.** A crash traps before printing anything, so
   "zero FAIL lines" reads as success. Assert on the positive signal
   (`All ... tests passed`) and check the exit code.
2. **A passing standalone binary is not a passing suite.** The chat e2e passed
   4/4 standalone while failing under `build.sh`. Run it the way CI does.
3. **When a test is flaky, find the third actor.** The chat e2e flake was a
   preflight banner - "Model X is unavailable; switching" - appended as a third
   message whenever the machine's Ollama inventory differed. It is now suppressed
   by `TRIOS_E2E_DISABLE_WARMUP=1`. An e2e test of chat plumbing must not depend
   on which models happen to be installed.
4. **Replacing a fixed structure invalidates every test that indexed it.** After
   plans became dynamic, `items[1]` crashed with Index out of range. Grep the
   suite for literal indices into anything you just made variable-length.

## Proving agent behaviour without a human

UI-only features cannot be verified by building. Two probes exist so a claim can
be evidence rather than inference:

```bash
make chat-probe                       # does the agent answer at all
make delegate-probe REVIEW=accept PATHS=docs TASK="..."
```

`delegate-probe` relaunches dev with `TRIOS_E2E_DELEGATE`, drives the same
`/delegate` the chat window calls, waits for the worker, and prints the verdict
from `.trinity-dev/logs/trios-app.jsonl`.

Traps this cost real time to find:

5. **A new BR-OUTPUT file is not compiled.** `build.sh` uses an explicit
   `LEAN_BR_OUTPUT` allow-list, so a new view fails with "cannot find X in
   scope" until it is added there.
6. **`#` in a Makefile variable starts a comment.** `ISSUE ?= owner/repo#1086`
   silently became `owner/repo`. Escape it: `owner/repo\#1086`.
7. **`open` does not inherit the shell environment.** LaunchServices starts the
   app clean; pass flags with `open --env KEY=value`.
8. **A wait loop that greps the whole log matches the previous run.** Record
   `wc -l` before launching and read only from there.
9. **Tool counts are not success.** A worker reported 18 tool calls and had
   written its file into an unrelated checkout under `~/gitbutler`. Log a
   preview of the agent's own answer, not just counters.
10. **Keychain reads can hang the suite indefinitely.** These are legacy-file
    keychain items, so `kSecUseAuthenticationUISkip` is not honoured and the read
    blocks in `SecKeychainItemCopyContent` waiting for a dialog nobody will
    answer. Every credential read must honour `TRIOS_E2E_DISABLE_KEYCHAIN=1`.

## Several agents in one repository

Check `ps aux | grep claude` before a long editing run. Concurrent agents have
landed commits mid-session, rewritten files under the compiler, and produced
`build.db: database is locked`. Back up new files to `/tmp` before rebuilding,
and treat a build failure in code you did not touch as possible interference
rather than your own bug.

## Known limits

- `swift test` (the XCTest target under `tests/TriOSKitTests/`) has a large
  pre-existing breakage: missing types and Swift 6 actor-isolation errors. It is
  unrelated to the app build, which is why `build.sh` can report `[FAIL]` while
  `trios_app` builds cleanly. Judge the app by the logic suites and the chat e2e.
- The Xcode license can block `swiftc` with no warning. Workaround:
  `DEVELOPER_DIR=/Library/Developer/CommandLineTools`. Everything compiles under
  it except the QueenUILib link, which needs XCTest.

## The build stood on a stale module (2026-08-10)

`make dev` compiles trios against `QueenUILib` from the **trinity** checkout at
`$TRINITY_ROOT/apps/queen` (default `~/trinity`). Two facts about that
dependency cost a night:

**It had not been rebuilt since July.** trios linked the module already sitting
in trinity's `.build`. That module exported `QueenHostedRoute` and the whole
`QueenUI/Integration` surface. Trinity's *present* source has none of it — the
navigation was redesigned to `MainView`, and `Integration/` was deleted. The
build worked only because nothing forced a recompile.

**Forcing a recompile destroys that.** `build.sh` asked for
`swift build --product QueenUILib`; the package declares `products: []`, so the
product error is real. Changing it to `--target` makes the compile happen — and
the fresh module overwrites the stale one, taking the API trios needs with it.
There is no backup. The vendored dylibs in `Frameworks/` and `Frameworks-dev/`
carry the old symbols but no `.swiftmodule`, so `TRIOS_VENDORED=1` cannot save
you either.

**Before "fixing" a build error, ask why it was ever building.** That question,
asked first, would have shown the crutch instead of removing it.

Two genuine faults were found on the way and are worth keeping if trinity is
ever repaired: `onKeyPress(.return, modifiers: .shift)` has no such parameter —
the handler receives a `KeyPress` and reads `press.modifiers`; and
`QueenUI/Cortex/Calibration/cerebellum_tests.swift` sits inside the library
target, so the module demands `XCTest` from everyone who imports it. Add it to
the target's `exclude` list.

Restoring the deleted `Integration/` files from `a8fec1de5` is not enough: they
need `QueenActionFeedback`, `QueenActionPhase` and `TrinityRuntimePaths`, which
the current `Bridge/ActionQueue.swift` also dropped. Unpicking someone else's
redesign one file at a time is the trap — stop and ask.

## Do not call a UI change invisible if you cannot look at it (2026-08-10)

I replaced the container type behind `BR-OUTPUT/QueenTabView.swift`, said the
tabs would come out identical, and shipped it. The canonical 999 menu
disappeared. In the same commit message I had written that I could prove the
claim only by compiling, not by looking — and shipped anyway.

**A build that succeeds says the types line up. It says nothing about what the
window shows.** For anything under `BR-OUTPUT/` that renders, either look at it
or say plainly that you did not.

Recovery, if this happens again: `git revert` the change, then restore whatever
the old code depended on. Here that meant `git checkout <old-commit> -- apps/queen`
in the trinity checkout — the present design stays in that repository's history
and comes back with `git checkout HEAD -- apps/queen`.

The restored older trinity carries thirty deprecation warnings. `WARNING_CEILING`
in the Makefile used to count every `.swift` path, dependency included, so a
dependency's deprecations drowned the gate. It counts only files under this
project root now — proved by planting five unused-value warnings in a ring file
and watching the build fail at nine.
