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

## Where the loop's time actually goes, measured

One night of continuous work on this repo, timed rather than guessed:

| step | cost | note |
|---|---|---|
| e2e suite, full | 103–115 s | run alone is 35 s, so ~70 s is compilation |
| `make mutants`, 16 mutations | ~20 min | 14 of those minutes recompile unchanged code |
| one delegation turn | 8–15 min | model time dominates; build is a small part |
| `make dev` | 60–90 s | |
| `make release` | 90–120 s | |

Four conclusions, in order of how much they returned:

**1. Run workers concurrently.** Three bees dispatched in the same second
finished, committed, opened and merged three pull requests within seven seconds
of each other. Before that the dispatch was serialised and cost 57 s between the
first and second; before *that* the second worker killed the first. This was the
single largest win of the night and it changed nothing about how fast any one
step runs.

**2. Attack compilation, not test count.** Two thirds of every verification is
`swiftc` rebuilding 152 unchanged files. Adding tests is nearly free; adding a
*run* is not. Prefer a narrow target (`make mutants-changed`, `make
finish-mark-order`, `make parse-tests` — all seconds) over the full suite when
the narrow one can answer the question.

**3. Scope a task to one turn or the worker dies.** Two workers tonight ended
with `queen.worker.died.clean` — stream over, no text, no files — and both had
broad specs touching four or five files. The same work split into single-file
tasks succeeded. A dead worker costs the full 15 minutes and returns nothing, so
scope is a speed decision, not a tidiness one.

**4. Hand over literal text for mechanical transforms.** `$` → `$$` in a
Makefile recipe failed three delegations in a row, ~30 minutes, before the
corrected recipe was written to a file and the task became "apply this
verbatim, then run it". Some transformations are cheap to state and expensive to
generate; recognise them and stop paying the generation cost.

Two habits that cost hours when skipped: commit a worker's output before
delegating anything else that touches the same path, and never wrap a
source-mutating harness in `timeout`.

## Incremental compilation quietly rewrites what your gates measure

Making the build incremental was the biggest speedup of the effort — the e2e
harness went 82 s to 35 s, the app build got the same treatment. It also broke a
gate, silently, and the break looked like good news.

`make dev` counts compiler warnings out of the build log. Once the build became
incremental, the log stopped describing the tree and started describing the
delta. Same revision, two builds in a row:

    make dev with nothing touched                     -> 0 warnings
    touch BR-OUTPUT/RichTextRenderer.swift; make dev  -> 4 warnings

Worse than the wrong number: on the false zero the recipe printed *"Lower
WARNING_CEILING so the gain cannot be given back"* — advice that would have made
the next cold build fail. A gate that congratulates you is the one to check.

The general rule, because this will recur with every cache you add:

**When you make a step incremental, list everything downstream that reads its
output, and ask of each whether it needed the whole thing.** Warning counts,
timing measurements, "files compiled" tallies, log-derived metrics — all of them
were implicitly full-build measurements. Incrementality does not just make them
faster; it changes their meaning from *tree* to *delta*, and nothing warns you.

Two related traps met the same night:

- **A stale object cache across build variants.** dev and prod now keep separate
  object directories. The comment claimed mixing them "fails to link with
  undefined symbols" — that was invented. Driven: planting all 185 dev objects
  into a prod directory builds fine, exit 0, zero dev symbols, because swiftc
  takes the module name from the output basename and mixing changes the compiler
  arguments, which makes the driver print *"Incremental compilation has been
  disabled, because different arguments were passed"* and recompile everything.
  The real risk was never a mixed binary; it was silently losing incrementality
  — a full 52 s recompile on every alternating build, under an `[OK]`. Guard the
  silent case, and put the stamp *inside* the object directory so it travels
  with what it describes.
- **A git snapshot that hashes build output.** `.gitignore` covered the release
  binaries but not the dev variant's 178 MB, so every Queen snapshot re-hashed
  and zlib-compressed them: 4.91 s against 1.73 s once ignored, measured. First
  attempt at that measurement showed no difference at all, because the blobs were
  already in `.git/objects` from earlier runs — the cost only exists for content
  git has never seen. Measure the state the defect lives in, not the one that is
  convenient to reproduce.

## A restore check that compares the backup to itself

The mutation harness snapshots each source, records its checksum, mutates it,
runs the suite, copies the backup back, and then verifies the restore by
comparing the restored file's checksum against the recorded one. That comparison
can never fail: it checks the copy against the thing it was copied from.

What it does NOT notice is somebody writing to the file while the harness holds
it mutated. The restore then silently reverts that write, and the harness
reports success. This is how one agent's edit came apart: it changed a function
body and its doc comment, a harness run overlapped, and the file ended up with
the new comment describing the old body — a state that never existed as a
coherent edit, and one a human reading the diff would skim straight past,
because the comment says exactly what you expect the code to say.

The fix is one checksum in the other direction. Record the hash of the *mutated*
file right after mutating; before restoring, compare the file on disk to that.
If it differs, someone else wrote to it:

    [FAIL] rings/SR-01/SkillStore.swift changed while the harness held it mutated.
           Restoring the backup would silently revert whoever wrote to it.
           The mutation is left in place; resolve by hand. Backup: <path>

Leaving the mutation in place is deliberate. Reverting either version silently
picks a winner; failing loudly with the backup path lets a person choose.

Driven: start a mutation run, append a line to the file 25 s in, and the guard
fires. Ordinary runs still pass — `ok - caught: probe row (failed twice)`.

**The general rule: a verification that compares an artifact to the source it was
produced from verifies the copy, not the world.** To detect interference you must
compare against what you last observed, not against what you last wrote. The same
shape appeared twice more the same week — a warning cache compared to itself, and
a test that compared the reaper to its own transcription of the reaper.

## Delegate the thinking, run the heavy work yourself

Eleven subagents died in one day to `API Error: Stream idle timeout - no chunks
received`.

**Correction, written an hour after the paragraph below.** This section first
claimed the correlation with heavy commands was "not subtle". Then three
read-only auditors — no builds, no suite runs, no load — died *simultaneously*,
about forty-three minutes in. Three parallel agents failing at the same moment
on a task with no heavy step is not explained by what any one of them was doing.
Whatever this is, it is at least partly global: session-level, rate-related, or
in the API. The heavy-command correlation below is real for the first eight
deaths and is NOT the whole story, and I published it as though it were.

The first eight deaths were all on tasks whose critical step is a single long,
heavy, silent command —

- `make shake` (29 loaded suite runs, ~25 min, load average 190+, 109 GB of I/O)
  killed its agent twice, on two different attempts at the same task;
- the mutation-harness investigation died three times, and only got done when I
  ran it myself;
- a cold `make warnings` and a full `make mutants` account for the rest.

Adding "stay audible — split long work into steps and print between them" to the
agent brief helped and did not cure it: the heaviest task died again afterwards.
The cause is below the repository and cannot be diagnosed from inside it, so do
not theorise about it — route around it.

**The division that works: subagents design, implement and verify; the caller
runs anything that takes tens of minutes or saturates the machine.** A dead
agent costs its whole turn — ten to forty minutes — and returns nothing, so this
is a throughput decision, not a tidiness one.

Two corollaries learned the same day:

- Never let a heavy run overlap with editing agents. `make shake` at load 190
  starves everything else on the machine and is a plausible contributor to the
  timeouts of *other* agents, not just its own.
- If a workflow gates several fixes behind one slow step, one stall freezes all
  of them. An earlier run put three independent fixes behind `await study` and a
  slow researcher idled the whole thing for an hour and a half. Fan out first,
  join only where a result is genuinely needed.

## The mirrored copy had already drifted

The mutant type-gate needed the app module's include set. It resolved the three
`-I` directories the same way `build.sh` does — a second copy of the logic,
knowingly written, with a comment promising it would fail loudly if it diverged.

It had already diverged. The Makefile pointed at `Frameworks-dev/Modules`, the
*vendored* copy of the QueenUILib interface; a dev build compiles against
SwiftPM's own output under `trinity/apps/queen/.build/.../Modules`. Both were
byte-identical that day — 6125716 bytes each — so nothing was visibly wrong and
nothing would have said so. The gate had been typechecking mutants against an
interface that only happened to match.

The fix is the shape worth keeping: **one definition, consumed twice.**
`build.sh` grew `TRIOS_PRINT_FLAGS=1`, which resolves everything, prints the
flag set one argument per line, and builds nothing; the same
`SWIFTC_MODULE_FLAGS` array feeds both the real compile and the print. A fourth
include directory added to the build reaches the gate on its own, because there
is no second list to update.

Details that made it safe rather than merely shorter:

- **stdout is reserved for the payload.** `exec 3>&1 1>&2` at the top, so none of
  the script's own `[VENDORED]`/`[FAIL]` chatter can be read as a flag.
- **Printing must not build, and must not wait.** The print skips the SwiftPM
  compile step and returns before the build lock, so it cannot block or be
  blocked by a running build. Measured: 0.37-0.46 s. It does still make one
  `swift build --show-bin-path` call, which compiles nothing — stated rather
  than hidden.
- **Refuse a malformed set instead of mis-splitting it.** A `-I` with no
  directory after it, or a directory that does not exist, fails the reader by
  name with zero rows scored. All three arms driven.

The general rule: a comment promising that a copy will fail loudly is not a
mechanism. If two places must agree, make one of them read the other — and if
they cannot, expect the drift to be there already rather than to arrive later.

## A harness and a live agent must not share a data root

`make cassettes` — reached through `make check` — began with `pkill trios-dev`
and ran `rm -f .trinity-dev/state/queen_delegation.json` before each of four
replays. Towards a scratch app that is correct and was written deliberately,
with a comment explaining why. Towards a working one it is data loss, and on
2026-08-17 it destroyed a live registry of four delegated tasks in the middle
of a cycle. Nothing reported it. There is no backup and the file is not under
version control.

The line had been correct for months. It stopped being correct the day the
Queen started keeping real work in `.trinity-dev`, and nothing in the tree
noticed the day that changed — because nothing was watching the *assumption*,
only the behaviour.

`ProjectPaths.trinity` states the principle in its own doc comment: if the dev
build wrote to the release root, an agent iterating could corrupt the state of
the app the user is actually using. The split stopped one level short. Dev was
two roles wearing one directory: scratch space an agent wipes at will, and the
workspace where the supervisor keeps live tasks.

**Rule.** Before a target kills a process or deletes state, ask what else lives
there *today*, not what lived there when the line was written. If a harness
needs to wipe, give it a root nothing else uses. TriOS now builds a third
variant for exactly this: `com.browseros.trios.test`, root `.trinity-test`,
port 9305, driven by `make test-app`.

**Prove it by planting a sentinel.** Write a recognisable file into the state
you claim is protected, run the target, compare the hash. Do it with the other
app *running* and compare its PID too — killing the process and deleting its
state are two separate harms and a fix can address one and miss the other.
Driven here: PID 84479 before and after, sentinel byte-identical.

**Then gate it**, because the isolation is one `sed` from being undone and the
failure is silent — the suite still passes. `make cassette-isolation` fails if
the recipe names `trios-dev`, `.trinity-dev`, `DEV_APP`, `DEV_PROC` or the dev
log, AND fails if it stops naming the test variant at all, so a rename cannot
satisfy it by accident. Both arms driven.

## A boolean that answers two questions is right only until it isn't

`ProjectPaths.isDevVariant` was read at thirteen sites answering three different
questions: *is this the dev supervisor build*, *may this reach the real
Keychain*, *is there a supervisor inbox*. With two variants all three answers
coincided, so the conflation was invisible and every comment at every site
described the requirement correctly while the code asked something else.

Adding a third variant separated them at once. The harness was refused its own
delegation with the message "No inbox in a release build" while running as
`test`; and ten secret-store sites would have sent it at the real Keychain,
which does not fail — it **blocks on a dialog nobody is there to answer**, so
the suite hangs rather than going red.

**Tell.** Read the comment above the predicate. If it names a *requirement*
("so a release app never…") while the code names an *instance* ("is this dev"),
they agree only by coincidence of the current case count.

Split into `usesFileSecretStore` and `hasSupervisorInbox`, both defined as
`!isRelease` against one source rather than two copies of the same comparison.

## Both arms of a variant switch must be written out

`build.sh` had two `if [ "$VARIANT" = "dev" ]; then … else …` blocks. The
`else` hands every unrecognised variant the **release** binary path and the
release bundle id — the single outcome the variant split exists to prevent
would have been its default. Now explicit three-way `case` statements with an
unreachable arm that fails loudly. The validation above them makes that arm
dead; it is written anyway, because the two guards drift independently.

## The app must start — and keep — the service it cannot work without

Three times in one day the report was "the Queen is not working". Three times
the cause was the same and it was never the Queen: no agent server.

`ProjectPaths.agentServerEntrypoint` had pointed at the runtime for as long as
the runtime had lived in the tree, and **nothing ever called it**. The app
depended on a server it did not start, so the server was whatever somebody had
left running by hand — and after a reboot, nothing. The supervisor then chooses
an issue, delegates it, and the worker finds no transport. That reads like a
broken supervisor and is not.

Three separate mistakes had to be undone, and the middle one was mine:

1. **The server refused to start without a browser.** The asymmetry was the
   tell: once running it tolerated losing CDP perfectly well — `/health`
   reported `cdpConnected:false` and stayed `ok` — but it would not *start*
   without it. So "it worked yesterday" and "it refuses to start today" were
   both true, which is the signature of a startup precondition that the running
   state does not share.

2. **I then made the HTTP failure non-fatal too, and that was wrong.** A
   browser is optional; HTTP *is* the product. A process that could not bind —
   because an older instance still held the port — logged a warning and kept
   running. The older one died; this one never retried. What was left was live
   processes serving nothing, and every launcher that asked "is a server
   running?" by looking at processes saw one. Six delegated tasks waited six
   hours behind that.

   **Rule:** when deciding whether a startup failure is fatal, ask what the
   process is *for*. Optional capability → degrade and retry. The reason the
   process exists → exit, so the port frees and the next attempt is a real
   attempt.

3. **Starting at launch is not supervising.** The app started a server at
   22:47; it died by 01:00; nothing looked again until a human noticed at 09:00.
   A supervisor that supervises only at boot supervises nothing. Sixty-second
   watch, and because `startIfNeeded` asks the port before spawning, the loop is
   just the same question asked repeatedly.

**Drive it, don't reason about it:** launch the app, confirm the port answers,
`kill -9` the server, confirm the port goes dead, wait, confirm it answers
again. Anything less proves only that it started once.

**And do not throw away the evidence.** The first launcher sent the spawned
server's output to `/dev/null`. It started, died, and there was nothing to
read — the one question a launcher exists to answer had been discarded. The log
is what then said `Port 9105 is already in use`, which is the state a health
check cannot see: something holding the port without serving it. A test now
asserts the output is not discarded.

## A refusal is not the end of a loop

The autonomous tick chose the highest-scored open issue every five minutes, was
correctly refused with "already delegated to queen-swift", and stopped there.
Twenty-three delegations in ten minutes, all the same refusal, one worker slot
of four free the whole time and nothing new ever started.

The refusal was right — one chat per issue. Treating it as "the tick is over"
instead of "try the next candidate" was the defect. A selection loop must
exclude what is already taken *before* choosing, not discover it by being told
no.

**Tell:** a log with the same refusal repeating at the loop interval. That is
never healthy backpressure; it is a loop that cannot advance.

## A comment in the tree already knew

Before overriding a guard, read what it says about itself. `DevSecretStore`
opens with the reason the dev build avoids the Keychain: the dev binary is
ad-hoc signed, so its identity changes on every rebuild and macOS treats each
build as a different application asking for someone else's secret. It does not
prompt once and remember. It demands the **login keychain password**, per
secret, per rebuild.

I read the fence as answering the wrong question - "is this prod?" rather than
"is anyone at the keyboard?" - and moved dev onto the real Keychain. The dev
app then came up as an empty window standing behind a password dialog. The
reasoning was sound in the abstract and wrong about this machine, and the
paragraph that would have stopped me was three files away.

**Tell:** an app that launches, reports healthy in its log, and draws nothing.
Look for a modal owned by the system, not by the app - it will not be in the
app's log, because from the app's side the call has simply not returned yet.

## One flag, two lifetimes

The same change moved dev's *data-at-rest* key along with its *credential*
store, because one property answered both. Every conversation dev had written
under the old key stopped decrypting - 18 `conversation.persist.decrypt_failed`
in a single launch.

The two are different in kind and the difference is durable:

- A **provider API key** belongs to the person. Sharing it across builds is the
  point of having it.
- A **data-at-rest key** belongs to a data root. `.trinity-dev` and `.trinity`
  are separate by construction, so the key must stay where the data was
  written. Moving it does not fail loudly - it makes existing data unreadable
  while everything reports success.

**Rule:** before repointing a secret store, ask what was encrypted with the old
one. If the answer is "the user's history", that is a migration, not a flag.

## Check what a variant already has before adding a way to give it one

Dev's missing API key was the wrong diagnosis twice over. The path I checked,
`~/.trios/secrets/`, is not the dev store - it is `~/.trios-dev/secrets/`, and
it exists. And dev never needed either: `resolvedAPIKey` reads
`~/.trios/config.json` as its second source and the key was already there. The
warm-up succeeds on attempt 1 with the fence fully in place.

**Rule:** read the resolution order end to end before concluding a credential
is absent. A store returning nil is the first source, not the answer.

## The rebuild loop is the swarm's main hazard

Twenty-two of the forty failures in the dev registry after a night's work are
`interrupted` - workers orphaned by my own `pkill && open`. Not by the code
under test, not by the provider, not by the issues. By the person verifying the
fixes.

Every rebuild-and-relaunch during a working swarm costs whatever those bees had
in hand: the stream dies mid-turn, the task is reaped, and the branch keeps a
half-written change nobody asked for. The bookkeeping survives - interruptions
are recorded as such and do not count against the issue - but the work does
not, and the cost was invisible because nothing ever said "you are about to
kill three workers".

**Rule:** `make relaunch` instead of `pkill && open`. It reads the registry,
refuses while any worker is `running`, and names the count. `FORCE=1` overrides,
for when the running app is the thing that is broken.

**And read your own failure statistics before diagnosing anything.** I spent
several rounds looking for why bees fail, with the largest single cause being
my own verification loop, plainly labelled, in a field I had added myself for
exactly this purpose.

## Look at every variant before saying the system is stopped

I reported "the swarm is stopped" eleven times. It was true of the release,
where the Keychain would not answer, and false of dev, which keeps its key in a
file and had been dispatching workers all along - thirteen accepted tasks, one
with a recorded commit.

**Rule:** when a symptom is environmental - credentials, signing, paths - check
whether it is variant-specific before generalising. The variants differ exactly
in the places environmental faults live, which is why they were separated.

## Added 2026-08-21, night cycle

Do not edit a source file while your own `make check` is compiling: the
build fails with "input file ... was modified during the build", the gate
reads red, and the red is yours in the dumbest possible way. Sequence the
cycle as observe -> edit -> gate, never edit-during-gate. If the gate is
already running and an edit cannot wait, kill the gate first and rerun it
clean afterwards - a gate result from a tree that changed mid-run proves
nothing either way.

## Added 2026-08-22, harvest round

`make check` run from the wrong directory (agent-server/, any subdir) fails
instantly with "No rule to make target" - and in a background task that
tail-reads as a completed gate. It happened twice in one night. Anchor
every gate invocation: `make check`,
and treat any gate that finished in under a minute as not having run.
