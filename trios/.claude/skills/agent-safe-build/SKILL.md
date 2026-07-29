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
