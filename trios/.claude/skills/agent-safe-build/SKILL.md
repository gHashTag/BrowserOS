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

## Do not delegate a second task on a file whose first task is still uncommitted

Two workers were sent at the same `Makefile`, one after the other. The first
added nine mutation records; I was still verifying them, so they sat in the
working tree uncommitted. The second worker read the file from its own baseline
— which predated those nine records — did its work, and wrote the whole file
back. The nine records vanished without a conflict, a warning, or a diff line
saying so.

Nothing here was a race in the usual sense. Each worker was correct in
isolation. The destruction came from *my* sequencing: I handed out the second
task before the first one's output was in git.

**Commit (or stash) a worker's output before delegating anything that touches
the same path.** The file boundary system stops two *concurrent* bees from
colliding; it says nothing about a bee colliding with the uncommitted remains
of its predecessor.

Recovery, when it happens anyway: the Queen commits each task to its own branch,
so the work is in git even when it is gone from the tree. Find it with
`git log --all --oneline --grep=<issue>`, then lift only the hunk you need out
of that commit — do not merge the branch, which would drag the rest of that
worker's baseline back with it.

## A mutation harness can leave its mutations behind

`make mutants` edits real source files, runs the suite, and restores from a
backup. Two runs overlapped — mine and a worker's — and each had its own
`mktemp` backup directory. The second run snapshotted a file the first had
already mutated, so its "pristine" copy was already broken, and its restore
wrote the mutation back permanently.

Three deliberate defects were left in the tree. One of them was the exact bug
fixed hours earlier: the pull-request lookup adopting `list.first` without
verifying the branch ref. All three compiled, and all three passed every gate —
mutations are chosen precisely to be plausible.

They were noticed only indirectly: the harness reported STALE for three needles,
and the needles were missing because the replacement text was already sitting in
the file.

Two guards, both cheap:

- **A lock.** `mkdir` is atomic; a second run must refuse to start rather than
  interleave. Release on `EXIT INT TERM`.
- **A checksum on restore.** Record each file's hash before mutating and compare
  after restoring. A mismatch is a named, loud failure — `[FAIL] restore
  checksum mismatch for <path>` — not silence.

Prove both from the failing side: hold the lock and watch the run refuse; corrupt
the recorded hash and watch the mismatch fire. A harness that guards everything
else is the last place to accept an unproven guard.

## Never wrap the mutation harness in `timeout`

Two `timeout`-killed runs of `make mutants-changed` left **six** mutations in
the tree across three files, and a stale `/tmp/trios_harness.lock` that would
have blocked the next honest run. Among the six: `isConflict` returning only
`mergeState == "dirty"`, the pull-request lookup back to bare `list.first`, an
empty merge `commit_title`, `409` rewritten to `499`, and a skill guard reduced
to `true`. All of them compile. All of them pass every gate. That is the point
of a mutation — it is chosen to look like ordinary code.

`trap ... EXIT INT TERM` does not save you: `timeout` signals `make`, `make`
dies, and the recipe's shell goes with it before the trap runs.

So:

- Run the harness in the background and **wait for it**, never under `timeout`.
- After any interrupted run, check three things before doing anything else:
  `git status --short rings/ BR-OUTPUT/`, `ls -d /tmp/trios_harness.lock`, and
  the diff of every file the harness touches.
- Restore by reversing the known replacement, not by `git checkout --` — the
  same file may hold real work you have not committed.

The deeper lesson is about the report, not the tool: when the harness said
`STALE - its needle is no longer in <file>`, the true cause was "our own
mutation is sitting there", not "the list is out of date". A message that names
only one of two possible causes sends you looking in the wrong place — twice, in
one night. See gHashTag/trios#1258.

## Ask a filter to say how much it selected

`make mutants-changed` was meant to run only the mutations whose source the
working tree touched. It ran all sixteen, and looked entirely healthy doing it:
every mutation was caught, the tree came back clean, the target exited zero.

The one line that exposed it was the count I had asked for:

    [OK] every changed-file mutation was caught (2173 files considered, 16 selected)

2173 is the whole repository. The selection came from `git diff HEAD~1 HEAD`,
and `HEAD` on this branch is almost always a merge commit, whose diff against
its first parent is the entire other side.

**Any filter, narrowing step, or subset selection must report its own numbers.**
"Selected N of M, from K considered" costs one line and turns a silent no-op —
or a silent everything — into an obvious one. Add a valve too: if a "targeted"
run selects more than half the population, that is not targeting, and it should
fail rather than quietly do the full job under a narrower name.

## The `$` → `$$` transformation defeats workers; put the literal text in the spec

Three separate delegations produced a `Makefile` recipe of correct *shape* and
broken *substance*: every shell variable written with a single `$`, which make
eats before bash ever sees it. `$issue` arrived as `ssue`, `$((before + 1))` as
`)`. The recipes were never run before being handed back.

This is now the most repeated defect in this repository's history — twice in one
night, in two different targets, plus an older instance in `backlog-audit`.
Stating the rule in prose ("every dollar meant for the shell is doubled") has
failed every time.

What to do instead:

- Put the **literal target text** in the specification, doubled dollars and all,
  rather than describing the transformation.
- Make "run the target once and paste the output" an explicit acceptance
  criterion. Every one of these arrived unrun; a single execution would have
  shown `ssue` immediately.
- After any Makefile edit, grep the changed region for `$$` before believing it:
  `sed -n '<range>p' Makefile | grep -c '\$\$'` returning 0 on a recipe with
  shell variables means it cannot work.

And when a mechanical fix fails three times, stop re-delegating it: say it is
undone, restore the last working version so the tool is not left broken, and
keep the attempt somewhere retrievable. The half that works — here the app-side
inbox and concurrent dispatch — should be committed and reported separately from
the half that does not.
