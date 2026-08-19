## E2E Testing Skill for trios

### Enable Accessibility (Required)
1. System Settings > Privacy & Security > Accessibility
2. Add /Users/playra/BrowserOS/trios/trios_app
3. Enable checkbox
4. Restart trios_app

### Test via MCP API (No UI needed)
```
curl -s http://127.0.0.1:9105/health
curl -X POST http://127.0.0.1:9105/mcp -H "Content-Type: application/json" -d JSON_RPC_PAYLOAD
```

### CGEvent Mouse Simulation (Swift)
Use CoreGraphics CGEvent for low-level mouse events

### E2E Test Scenarios
1. Launch trios > verify status bar icon
2. Click status bar > verify panel opens
3. Type message > verify ViewModel receives it
4. Send command > verify MCP health passes
5. Switch to BrowserOS tab > verify view renders
## A break test that does not break is not a passed break test

The rule "when an assertion passes, break what it guards and confirm it fails"
has a failure mode that reads exactly like success: you break the code, re-run,
and everything still passes. That is not the guard proving itself robust. That
is your break missing.

Worked example (#1247, #1248). Two bees running in parallel; a worker that had
finished 0.7 s earlier was being restarted as "silent" — 20 of 37 restarts in
the whole log were this. Two fixes went in: a guard (`completedTurns > 0` is not
an orphan) and an ordering change (record the completed turn synchronously in
the finish callback, not inside the deferred `Task` that queues behind the other
bee's review).

- Breaking the **guard** — deleting one line — reproduced the defect at once:
  3 finishes and 1 restart, against 2 and 0 with the line present. Proven.
- Breaking the **ordering** — putting the mark back inside a `Task` — changed
  nothing: 2 finishes, 0 restarts. The two bees happened to finish six seconds
  apart that run and the window never opened.

The honest conclusion is not "the ordering fix is confirmed". It is: the pair is
proven together, and the ordering half is traced through the code and the
timestamps but has no falsifying run behind it. That sentence went into the
issue verbatim.

**Timing defects need a break that forces the timing, not one that hopes for
it.** If you cannot force it — a fake slow reviewer, a stalled main actor, a
cassette that replays the exact interleaving — then say the fix is unproven
rather than counting the quiet run as evidence. A green run under a break you
could not aim is silence, and silence is what this whole class of bug looks
like from the outside.

Corollary for measuring: define the failure numerically before you fix anything.
Here it was "restarts within ten seconds of a clean finish", counted straight
off the JSONL — 20 of 37. Without that number, "it seems better now" would have
been the whole report, and the second, subtler race would never have surfaced.

## When the forge lies quietly: filters that are ignored, not refused

`GET /repos/{o}/{r}/pulls?head=<branch>` looks like it works. It returns 200 and
a JSON array. It is also *completely unfiltered* unless the value is in
`owner:branch` form — GitHub silently ignores a bare ref rather than rejecting
it. Take `.first` of that array and you have adopted a stranger's pull request
with no error anywhere in the log.

This cost the Queen sixteen merge refusals out of twenty-one attempts before
anyone noticed, because under a single worker the array's first element usually
*is* the right PR. It only became visible with two bees running at once.

Two rules fall out of it, and they generalise past GitHub:

1. **An API filter you cannot see failing is not a filter.** After narrowing a
   query, verify the result actually matches what you asked for — here,
   `pr.head.ref == branch`. If it does not match, that is an error to throw, not
   a result to use. The check costs one comparison and turns a silent
   misattribution into a loud one.
2. **Percent-encode query values whose content you do not control.** Branch
   names contain slashes; an unencoded slash in a query value injects a path
   segment. Remove `:` and `/` from `urlQueryAllowed` before encoding, or the
   colon that makes the filter work gets mangled too.

Diagnostic habit that found it: count the log's own verbs against each other.
`21 pr.attempt, 14 pr.opened, 2 pr.refused` does not add up, and the missing
five are where the truth is. Ratios between event names cost nothing to compute
and point straight at the gap; reading any single line would not have.

## Observability must not queue behind the thing it observes

A stall notice that repeats every ten seconds emitted exactly once during an
86-second push, and the number it carried said 11 s while the line landed on
disk at 68 s. The loop was:

    sleep 10 → compute elapsed → await postQueenNotice(...) → log the event

`postQueenNotice` persists the conversation, and under load that await took
~57 seconds. So the log line was 57 s stale, and every later iteration of the
loop was eaten by the same await. Swapping two lines — log first, then post —
made the repetition work and the timestamps honest.

The general rule: **the cheap, structured record goes first; the expensive,
user-facing one goes second.** Anything else makes your instrument depend on
the health of the thing being instrumented, which is precisely backwards during
an incident. A log line that waits on an encrypted store write is not
telemetry, it is a second victim.

Corollary worth checking whenever a periodic reporter under-reports: count the
events you got against the events the interval implies. Two ticks in 86 seconds
at a 10-second interval is not "roughly working", it is a factor of four, and
the factor is the bug.

## `make dev` passing does not mean the tree is whole

A worker's edit swallowed the `static func` header of the function *next to*
the one it was adding, leaving the test file one brace short so the enclosing
type closed early. The app build stayed green through all of it: the app target
does not compile `tests/swift/`. Only the e2e run surfaced it, as three
"static methods may only be declared on a type" errors far below the real
damage.

So: after any worker touches a test file, the e2e suite is not optional and its
compile step is the check that matters. And when the compiler points at line
3942, the break is usually *above* it — walk the brace depth back from the
first complaint to the last line where it was still correct rather than reading
the reported line.

## Three self-demonstrating checks in one night, none of which demonstrated

A "self-demonstrating" check runs itself against a known-bad input first, so a
check that has quietly stopped working announces itself instead of printing OK
forever. The idea is sound. All three attempts at it tonight were broken, each
in a different way, and each printed a cheerful OK while broken:

1. `check-selftest` exercised a **copy** of the target instead of the target,
   so it praised a recipe that was already broken.
2. `finish-mark-order` ran `awk` on its fixture and treated *any* non-zero exit
   as "the bad fixture was correctly rejected". Delete the fixture and awk
   fails to open it — which read as success. The demonstration switched itself
   off silently.
3. `parse-tests` shipped a fixture that was **valid Swift**, parsed it in the
   same loop as the real sources, and printed `[OK] every test source parses`.
   Its comment described the manual procedure — "remove the func header and
   this would fail" — instead of performing it. Nothing was demonstrated at all.

The shape is always the same: **the negative arm degrades into the positive
arm.** So when writing one, check these three things explicitly:

- The bad input is genuinely bad. Run the check on it by hand once and watch it
  fail before you believe the recipe.
- The bad input's *absence* is a failure, named — not an error code that the
  recipe reinterprets as success.
- The negative arm asserts the opposite outcome from the positive arm. If both
  arms are "this thing succeeded", there is no negative arm.

And the break test for a self-demonstrating check is two-sided: replace the bad
fixture with a good one (the target must fail), and break the real subject (the
target must fail, naming the real location). Only then does a passing run mean
anything. `parse-tests` earned it — it names line 3887, where the damage is,
while the full e2e run pointed at 3942, 3985 and 4267, all of them consequences.

## A check that cannot reach the decision is not guarding it

Two decisions went in behind a network call: whether the merge request carries
the reviewed `sha`, and whether HTTP 409 maps to "the branch moved". The
accompanying checks exercised the registry field and the enum's case matching —
everything *around* the decisions. Both break tests passed with the code
deliberately broken:

    sha removed from the payload   → All tests passed (655 checks)
    the 409 branch deleted         → All tests passed (655 checks)

The fix is the same one this file already used for `isConflict`: pull the
decision out as a pure function the suite can call directly.

    static func mergePayload(title: String, sha: String?) -> [String: Any]
    static func outcome(statusCode: Int, mergeable: Bool?, mergeState: String?) -> MergeOutcome

and let the network method do nothing but call them. After that the same two
breaks fail.

**Rule: if a decision lives behind I/O, the suite cannot see it, and a check
written next to it is decoration.** Extract the decision or admit it is
unguarded — do not let its neighbours' green ticks stand in for it.

Note on break-test quality: deleting the `409` branch made the suite fail
through its coverage guard ("a scenario returned early without asserting"),
not through a named assertion. That is a real signal but a blunt one — it says
*something* went missing, not what. Prefer a check that names the mapping, so
the failure reads as "409 is no longer headMoved" rather than "coverage moved".

Also: make the break faithful. The first attempt at this one replaced the digits
`409` in a *comment* three lines above the branch and, of course, changed
nothing. Verify the edit landed on the executable line before you trust the
result — a break test aimed at a comment is indistinguishable from a passing
guard.

## An offset that outlives its file reads past the end and says nothing

The dev-only Queen inbox remembers a byte offset in `UserDefaults` and seeks to
it before reading. Delete or shorten the file and the offset stays: the seek
lands past EOF, `readToEnd` returns nothing, and the poller is silently dead.
Appending line after line produced not one log entry — no error, no warning,
nothing to grep for.

It cost most of an hour, and the diagnosis only came from looking outside the
program:

    $ defaults read com.browseros.trios.dev | grep inbox
        "queen.inbox.offset.dev" = 339;     # the file was 190 bytes

The same defect was already solved once in this repo for the LOGS live tail,
which detects truncation and restarts from zero. A durable cursor is a cache of
a fact about a file, and like every cache it needs an invalidation rule.

**Any persisted read offset needs two things**: a size check before the seek
(offset > size means the file was replaced — start over) and a log line when
that happens. A reader that has stopped reading must say so; silence is
indistinguishable from an empty inbox.

Note for driving tests: state that outlives the process is invisible in
`git status` and in the log. When a component "does nothing" and its code looks
right, ask what it remembers from last time — `defaults read <bundle-id>` for a
Mac app, and the state files under `.trinity-dev/state/`.

## A quiet component proves nothing: check it was alive during the window

The claim was "the release variant never reads the dev inbox". First proof: put
a line in `.trinity/state/queen_inbox.jsonl`, wait ninety seconds, observe that
no file appeared and no inbox event was logged. Clean-looking, and worthless —
the release app wrote **zero** log lines in that window. A guard that works and
an app that is idle produce identical evidence.

    процесс: 1
    строк добавлено за проверку: 0      # <- the whole proof, undone

The proof that counted: restart the release app with the line *already sitting*
in the inbox, then count.

    строк записано после старта: 38
    из них про ящик: 0

Thirty-eight entries establish liveness inside the window; zero of them about
the inbox establishes the guard. Same conclusion, but now the absence means
something.

**Whenever the expected result is "nothing happened", the observation needs a
second measurement showing the subject was capable of acting.** Otherwise the
test passes when the feature is broken, when the app is dead, when the log path
is wrong, and when the test itself never ran — four failure modes wearing one
face. Pick a moment when the subject is guaranteed to be busy (startup is
usually the cheapest) and count its unrelated activity alongside the silence you
care about.

## Measure the parts before you believe the whole

Asked to speed up the loop, the first thing I did was time an ad-hoc `swiftc`
over the same sources and get **6 seconds** against the harness's 85. A 13×
win, apparently, from two flags — `-j 1 -disable-batch-mode`.

It was nonsense. I had redirected stderr to `/dev/null`, and the compile had
*failed*; the six seconds were the time it took to give up. The binary was never
produced, and I did not check. Removing the two flags for real: **1:54 → 1:43**,
about ten percent.

Two rules from that, both cheap:

- **A timing measurement of a command whose exit status you did not check is not
  a measurement.** Failure is always the fastest path. Time the command, then
  assert its artifact exists — `ls -l` on the output, or the check count in the
  log.
- **Split the total before optimising it.** The useful number was not the 103 s
  total but its parts: run the already-built binary alone (35 s), subtract, and
  compilation is 70 s — two thirds of every iteration, and the only part worth
  attacking. Getting that split cost one extra command and redirected the whole
  investigation.

Concretely for this repo: `tests/swift/run_chat_sse_e2e.sh` is a single `swiftc`
invocation over ~152 files with no `-incremental` and no output file map, so
every run rebuilds everything whether one file changed or none. `make mutants`
pays that cost once per mutation — sixteen mutations, twenty minutes, fourteen
of them recompiling code that did not change. See gHashTag/trios#1261.

## A gate that reads an exit code is scoring the wrong thing

`make mutants` decided whether a mutation was caught like this:

    if bash tests/swift/run_chat_sse_e2e.sh >/dev/null 2>&1; then SURVIVED else caught fi

Any nonzero exit meant "caught". Driven proof: put `exit 1` at the top of the
script so not one test runs, then run one mutation —

      ok   - caught: a switched-off skill reports itself as on
    [OK] every mutation was caught (1)

The gate that guards every other guard scored a corpse as a victory. Missing
SQLCipher, a compile error, a held lock, a full disk, a typo in the script — all
of them read as proof that the suite noticed a defect.

**Score on positive evidence that the work happened, never on an exit code.**
Capture the output and require the marker that only a real run can produce:

    output contains "test(s) failed"                     -> caught
    output contains "All ChatSSEEndToEnd tests passed"   -> survived
    neither                                              -> ERROR, the suite never ran

The general shape: an exit code is a *claim about the process*, not about the
work. Any harness whose verdict is "the thing failed, therefore my check works"
must first establish that the thing ran at all — the same asymmetry as proving
a negative result (see the release-inbox section above, where zero log lines
proved nothing until thirty-eight unrelated ones established liveness).

Corollary discovered immediately after: once `caught` keys on "test(s) failed",
a **flaky** suite is indistinguishable from a caught mutation. Positive-evidence
scoring is necessary but not sufficient; the suite itself has to be stable, or
the score has to require the failure to repeat. See gHashTag/trios#1263.

## A cache entry outlives the truth it recorded

The warning gate was rebuilt around a per-file cache: remember each file's
warnings, refresh only the files this build recompiled, report the union as a
tree total. It reads as obviously correct and it drifts in both directions,
neither of them visible from inside the cache.

**Over-count.** Adversaries planted warnings, drove the gate, and removed the
plants. The plants' files were never recompiled again, so their cache entries
were never refreshed. Three consecutive builds reported `8 compiler warnings in
the tree (185/185 files measured)` on a tree holding 4, enforced the ceiling
against that, and never healed. Only deleting the cache by hand recovered it.

**Under-count.** When a build fails *after* some files have compiled, their
incremental state has already advanced. They are "Skipping input" ever after,
their warnings were never folded in, and because they are still listed as seen,
the gate still claims 185/185 and passes. The trigger is not exotic — the driver
error "input file was modified during the build" is the worktree flicker this
repo already documents, and it fired spontaneously twice during one review.

The general shape, and it is not specific to warnings:

**A cache of derived facts about files needs an invalidation rule that can fire
without recompiling the file — and usually there isn't one.** The entry says
"this file had N warnings when I last compiled it". Nothing about the file's
current bytes tells you whether that is still true; only compiling it does. So
the cache can only be refreshed by the very work it exists to avoid.

What we did instead: `make dev` no longer keeps the cache between builds. It
reports only what this build compiled, labels the count partial, and does not
enforce the ceiling. Enforcement moved to `make warnings`, which compiles
everything — 3 s warm, because it keeps its own build directory rather than its
own *answer* directory. Caching the objects is sound; caching the conclusion is
not.

If you must keep a conclusion cache, give it a expiry it cannot outlive: tie the
entry to the object file's identity, and treat a missing or older object as no
entry at all.

## A test that transcribes the logic tests the transcript

Twenty named checks went in to guard the stall reaper. They drive
`QueenDelegationPolicy.isStreamOpen` and `wasNeverStarted` through a real
registry, they fail by name when either predicate is gutted, and two mutation
rows catch the same thing. All good — and an adversary then deleted
`guard !QueenDelegationPolicy.isStreamOpen(current) else { continue }` from the
*shipped reaper* in ChatViewModel.swift and the suite was byte-identical to the
pristine baseline. Not one of the twenty noticed.

Because the test helper carried its own copy of that line. It reimplemented the
reaper's decision instead of calling it, so the checks proved the predicates
correct and proved nothing about the code that consults them. This is the same
defect as a self-check that exercises a copy of the target — it was
`check-selftest` earlier the same night, praising a recipe that was already
broken.

**Ask, of every test: if I delete the line under test from the shipped code,
does this fail?** If the answer is no because the test has its own copy of that
line, the test is guarding the copy.

When the real call site cannot be invoked from the harness — here
`reapStalledWorkers` is `@MainActor` on a view model with a live runner — the
honest options are two, and both are cheap:

- guard the *shape*: a row in `make guard-shapes` asserting the guard line still
  sits above its anchor in the real file, with a broken fixture proving the
  check can fail (this is what closed the gap; removing the line now produces a
  named FAIL);
- or state plainly in the test's own comment that it covers the predicate and
  not its use, so the next reader does not mistake the twenty green ticks for
  coverage of the decision.

Silently transcribing is the only wrong answer, and it is the one that looks
most like thorough testing.

## A failed check still ran, and the order of the two verdicts matters

`make mutants` scored three real catches as `ERROR - the suite never ran`. They
were not coverage holes: the suite built, ran, detected each mutation and named
it. The harness was told a lie by the suite itself, through a four-link chain
worth knowing because every link looks harmless:

1. `fail()` incremented `failures` but not `checksRun`. A check that ran and
   failed stopped counting as a check that ran.
2. The scenario was written `if case .X = outcome(...) { check(true, name) }
   else { fail(name) }`. So a *caught* mutation lowered `checksRun` by one.
3. `minimumChecks` was set at exactly the green count. Its own comment said "set
   just under the current count so ordinary edits do not trip it" — it was set
   AT it. Zero slack.
4. The coverage floor was tested *before* the failure summary, and exited early.

Result: `FAIL - only 717 checks ran, expected at least 718` instead of
`1 of 718 test(s) failed`, and the mutation gate — which scores on the string
"test(s) failed" — read that as a suite that never ran.

Two one-line rules fix it, and both generalise:

- **A check that ran and failed still ran.** Count execution and outcome
  separately; never let a failure reduce the execution count.
- **When something failed, the failure is the news.** A coverage floor answers
  "did a scenario vanish?", which is only meaningful when nothing failed. Test
  it *after* the failure summary, or guard it with `failures == 0`.

Proof both ways after the fix: reverting the code under test now prints
`5 of 718 test(s) failed` (was: `only 713 checks ran`), and the mutation row for
it is caught, "failed twice".

Corollary about self-describing counters: a floor set exactly at the current
value has no slack in either direction, so it fires on the first honest failure
as well as on real coverage loss. If the comment says "just under", make the
number just under.

## What a mutation table cannot ask, and why

Seven standing Makefile checks were audited for mechanical falsifiability — can
the MUTANTS table ask "what event makes this red?" on their behalf? The answer
for all seven is no, and the reason is structural rather than incidental:

**The table's oracle is the e2e suite. Every one of those checks exists
precisely because the compiler and the suite cannot see the failure it guards.
Read backwards, that is: its failure cannot be scored here.**

Measured, not reasoned:

- `keychain-doors` — a real `SecItemCopyMatching` planted outside the allowlist.
  The check names the file and exits 1; the harness printed **SURVIVED**. The
  suite runs with `TRIOS_E2E_DISABLE_KEYCHAIN=1`; it is keychain-blind by design.
- the warning gate — the mutation put a genuine warning into the suite's own
  build log, and the harness still printed **SURVIVED**. The runner reads
  `PIPESTATUS`, never the warning text.
- `parse-tests` — fails both ways: a syntax break in a compiled source gives
  **ERROR - the suite never ran**; in a source the suite does not compile (the
  exact case the check exists for) it **SURVIVED**.
- `backlog-audit` has no red at all: against its bad fixture it prints
  `verdict=looks-open` and exits 0, by design. It is a report, not a gate.

Two conclusions worth keeping:

1. **A row that passes for the wrong reason is the same lie as scoring a flake.**
   One tempting row would have opened a keychain door *by* deleting an
   identifier the suite counts — "ok - caught" for the deleted call site, not
   for the open door. Rejected on purpose.
2. **The right home for a Makefile check's question is a harness whose oracle is
   the check itself** — `check-selftest`, not the suite. The sketch: a sibling
   table `source@@needle@@replacement@@target@@name`, run `make <target>` before
   the mutation (must be green, or a red machine forges a catch), mutate, run
   again, score only green→red as caught. No repeat run needed: those targets
   are deterministic file readers with no build, network or clock.

And the finding that came out of the audit rather than out of the table: a check
that **hangs** is worse than one that cannot fail. `make drift-guard` never
finishes; it is not in `check`, so nobody had run it. Four undrained `Pipe()`s
turned out to be a real deadlock hazard and were fixed — and the hang survived
them, so that was not the cause. Silence about a check nobody runs is how both
of those lived.

## `try? p.run()` followed by `waitUntilExit()` is a deadlock, not a fallback

`make drift-guard` never finished. Two runs, seven and eleven minutes, killed by
hand; `sample` gave the same stack both times — parked in `waitUntilExit` inside
a local `git` helper — and `ps` showed no live git process.

The cause, once instrumented (print the command before and after each call):

    GITPROBE start: init -q -b main      <- and no matching "done", ever

The scratch repository's directory was never created. `NSTemporaryDirectory() +
"trios-drift-<uuid>"` produces a *path*; the only `createDirectory` in the
scenario lives inside `writeFile`, which runs later. So `git init` got a
`currentDirectoryURL` that did not exist, `Process.run()` threw, `try?` swallowed
the throw — and `waitUntilExit()` then blocked forever on a child that had never
been born.

**Never write `try? p.run()` above `p.waitUntilExit()`.** The `try?` turns a
loud, instant failure into a silent permanent one: no child, no exit, no news.
Either propagate the error or skip the wait. And `ps` showing no child while the
parent waits is the signature of exactly this bug.

Two things this cost, both worth remembering:

- The check had never once run to completion, so nothing it asserts had ever
  been true or false. On its first finishing run it went straight to
  `2 of 722 test(s) failed` — the drift guard does not catch the drift it exists
  for, or its fixture has rotted. Either way that was invisible behind the hang.
- It is not in `make check`, which is why a target that hangs forever survived in
  the repository. **A check nobody runs is indistinguishable from one that does
  not work**, and the way to tell them apart is to run it once on purpose.

Method note: instrumenting was worth more than three theories. Undrained pipes
(a real hazard — four were found and fixed) and gpg signing were both plausible
and both wrong. One `print` before and after each call named the culprit in a
single run.

## One missing flag, and the guard could not see the case it exists for

`make drift-guard` builds a scratch repo where one branch changes a signature
and another adds a caller using the old one, then asserts the combined tree does
not compile. It reported success. The tree, extracted and listed, explained why:

    Sources/App contains: App.swift          <- Caller.swift is missing
    Sources/Lib/Lib.swift: greet(_ name: String, _ greeting: String)

Only the signature branch made it in. The overlay staged each changed path with

    git update-index --cacheinfo <mode>,<sha>,<path>

and **without `--add`, git refuses any path not already in the index**. Files a
branch *modifies* land; files a branch *adds* are silently dropped. The return
value was discarded with `_ =`, so nothing said so.

The consequence is the whole point of the guard: the commonest two-bee conflict
is exactly "one adds a caller, another changes the signature it calls", and that
is precisely the shape it could not see. One word — `--add` — and it catches it:
`All ChatSSEEndToEnd tests passed (722 checks)`, first green run in its life.

Three method notes, each of which cost a wrong turn today:

- **Instrument, don't theorise.** Undrained pipes, gpg signing, and tree size
  were all plausible causes of the earlier hang and all wrong; one `print`
  before and after each git call named it in a single run. The same again here:
  printing the extracted directory listing settled in one run what three
  readings of the code had not.
- **Check the exit status of the thing you are timing or judging**, not of the
  pipeline. `swift build 2>&1 | tail -3; echo $?` reports `tail`'s status — it
  told me the reproduction built when it had failed.
- **Count occurrences before replacing text.** Twice today a replacement took
  the first of several identical helpers and fixed the wrong one, both times
  leaving a green suite and an unfixed bug.

And the standing lesson underneath: `drift-guard` is not in `make check`, so
nobody ran it, so a guard that could not see its own subject survived for
months. A check nobody runs is indistinguishable from one that does not work.

## Give each family of checks an oracle it can actually fail against

The MUTANTS table could not ask "what event makes this red?" of the standing
Makefile checks, and the reason was structural: its oracle is the e2e suite, and
those checks exist precisely because the suite cannot see what they guard. A
real `SecItemCopyMatching` planted outside the allowlist measured **SURVIVED**
there, while `make keychain-doors` named the file and exited 1.

The fix is not a cleverer row. It is a second table with a different oracle:

    MUTANTS_GUARD := source@@needle@@replacement@@target@@name

Per row: run `make <target>` first and require green, mutate, run it again,
score green→red as caught. Both rows the old table could not express are caught
here by their own check. No repeat run is needed — unlike the suite these
targets are deterministic file readers with no build, no network and no clock,
which is exactly why they can be scored on a single observation.

The load-bearing detail is the **pre-check**. Without it a machine that is
already red scores every mutation as caught — the gate would certify itself
loudest exactly when it is most broken. Driven: with `keychain-doors` red before
the mutation, the run refuses and says
`a guard mutation ... ran against a red machine`, instead of printing a catch.

Generalise it: **a verification harness needs a positive control, and the
cheapest one is "prove the detector is currently working before you trust its
verdict".** Same shape as requiring the suite to print its own "N tests failed"
line rather than trusting an exit code, and as requiring 38 unrelated log lines
before believing that zero inbox lines means the guard held.

Corollary about reporting tools: `make doctor` printed the mtime of the bundle
*directory*, which does not move when the binary inside is replaced — it was
nineteen days stale — and `pgrep -x trios-dev` could never match, because both
bundles ship a binary named `trios`. It is in `make help`, in no gate, and exits
0 always, so it had been lying to everyone who looked at it. Match processes by
their bundle path, stat the binary, and remember that a target with no red state
is a report, not a check.

## A rule that lives in the file it searches can never go stale out loud

`make-dollars` was the obvious next row for the guard-oracle table: plant a
single-dollar shell variable in a recipe, the check must go red. Two agents
refused it, and the second one's reason is the interesting one — it replaced the
first's.

The first said: the harness would rewrite the Makefile it is executing. That is
not the objection; the parent `make` has already parsed the file, and a mutation
chosen to keep it parsing is survivable.

The real objection is **self-reference**. A row stores its needle and its
replacement *as text in the same file it searches*. So `needle in file` and
`replacement in file` are permanently true, whatever the recipe below says. The
two branches that depend on those tests stop working:

- STALE can never fire — the needle is always "present", in the table entry.
- The leftover-mutation repair can never fire either, and worse, a mutation
  applied by first-match would hit the *table row* rather than the recipe once
  the recipe line has moved.

So the row would not merely be useless; it would quietly forge verdicts later.
The event it wants to catch already has an honest red-driver in `check-selftest`,
which appends a single-dollar line to a **copy** of the Makefile — the same
event, scored where the table holds no copy of the string.

**Generalise: a checker whose rules are stored in the artifact it inspects has a
blind spot exactly the size of its own rule table.** Keep the rule and the
subject in different files, or accept that the rule is invisible to itself.

Related, from the same round: two rows needed a one-line change to their oracle
before they could be scored at all. `finish-mark-order` and `guard-shapes`
printed human-readable lines but no bracketed `[OK]`/`[FAIL]`, so the harness's
positive-evidence rule could not read them and every row against them would have
scored ERROR. **A target that a machine is meant to score must say so in a form
a machine can read** — the same discipline as the suite printing its own
"N of M test(s) failed".

## Prove the mutant is the code you claim it is

The guard table plants code into shipped Swift sources and then asks a make
target whether it noticed. Two rows were argued to compile "by construction" —
each replacement uses only identifiers already in scope and discards them with
`_ =` — and no compiler had ever checked.

That gap is not cosmetic. If a mutant does not compile, the target may go red
for the wrong reason, and the row prints `caught` while proving nothing. For the
suite-oracle table that case becomes ERROR by the scoring contract; for a table
whose oracles are text readers that never build anything, nothing catches it.

The counterfactual is the whole argument, and it was driven: take a replacement
that cannot parse, declare it as parseable, and the table printed

    ok   - caught by guard-shapes: ...
    [OK] every guard mutation was caught by its own check (4)

which is exactly what it printed before the gate existed. With the gate:

    BROKEN ROW - ...: the mutant does not parse
                 make guard-shapes was NOT consulted: when the mutant is not
                 the code the row claims it is, a red target says nothing

Three design points worth carrying:

- **Declare the expectation per row.** Some rows plant a syntax error on
  purpose; a fifth field (`parses` / `must-not-parse`) turns "it did not parse"
  from an ambiguous outcome into a checkable claim. An unrecognised value is a
  broken row, not a default.
- **Parse the pristine source first.** Otherwise a file somebody else broke gets
  blamed on the row. That arm was driven too, and refuses without writing.
- **Say what the instrument does not catch.** `swiftc -parse` is 0.13-0.21 s and
  catches syntax; it does not catch types, scope or imports — `_ = task.id`
  parses whether or not `task` exists. Named a floor in the Makefile rather than
  implied. Whole-module typecheck was rejected with numbers: pristine sources
  already fail alone (28 and 190 errors), so there is no green baseline to
  compare against, and `make dev` per row costs 80 s.

And the honest corner: for a `must-not-parse` row the gate and the oracle are
the same command, so it asserts the row's premise rather than independently
confirming the catch. Written into the comment where the next reader will meet
it, not left for them to discover.

## Measure the thing at the scale it lives at

A whole-module typecheck was rejected once here with numbers, and the numbers
were real: `swiftc -typecheck` on a single pristine source gives 28 errors, on
another 190. Conclusion recorded at the time: "there is no green baseline, so
this cannot be a pass/fail gate."

Wrong, and the correction is worth more than the gate. Those measurements were
of **one file alone**. A Swift file alone is not a compilable unit — it has no
module around it, so of course it is red. Measured at the scale the thing
actually lives at, all 185 app sources together:

    swiftc -typecheck, whole module        13.3 s, exit 0, 0 errors
    + -incremental, warm, nothing changed   0.48 s
    + -incremental, one file changed        0.83-2.08 s

The green baseline was there the whole time; the earlier measurement had sliced
below the level where the property exists. **Before concluding "X cannot be
measured", check that you measured X at the granularity where X is defined.**

With that, the mutant gate went from syntax to types, and the counterfactual is
the proof: a replacement naming a method that does not exist —
`QueenDelegationPolicy.isStreamOpenNoSuchMember(current)` — *parses* cleanly, so
the old gate passed it and the row printed `ok - caught`. Now:

    BROKEN ROW - ...: the mutant parses but does not typecheck
           | error: type 'QueenDelegationPolicy' has no member 'isStreamOpenNoSuchMember'

Two design points that made it safe rather than merely faster:

- **The row's declared expectation is measured, not trusted.** Whether a row may
  say `typechecks` is decided by reading the dev build's own output-file-map: in
  the module, only `typechecks` is legal; outside it, only `parses`. So the
  vocabulary cannot be used as a shortcut, and the day the test sources join the
  app build, the affected row says so out loud.
- **Read the build's artifacts, do not copy them.** The 185-file list comes from
  `.trinity/build/dev/output-file-map.json`, which `make dev` writes. A copy
  would rot silently; a read cannot. (The three `-I` paths are still mirrored —
  named in the comment as the remaining copy, and it fails loudly rather than
  silently because the pristine typecheck goes red and every row refuses.)

Cost of the whole table: 21 s → 42-51 s warm, for ten rows across three mutation
operations. The incremental state lives in a directory *beside* the app build's
objects, never inside it — mixing a `-typecheck` dependency graph into the
objects' graph would corrupt the build the gate is imitating.

## Ask a green threshold why it is green, not only whether it can go red

`XCTEST_ERROR_CEILING` was 2. I checked it the way this file recommends: plant
an error in a file the build actually reaches, watch the target go red, restore,
watch it go green. Falsifiable, driven, recorded as sound.

It was measuring wreckage. The app's source list was written twice — in
`build.sh` and in `Package.swift` at the git root — and had diverged by 46
paths. SwiftPM stopped at `cannot find type SessionGuard in scope`, produced
exactly 2 errors, and the ceiling had been set to exactly 2. The entire XCTest
suite had never once compiled, so nothing it asserts had ever been true or
false. With the list unified the real number is **23**, in 4 of 42 test files,
none in the library — a suite that drifted behind Swift 6 concurrency and API
changes while silently not building.

Worse, one manifest entry named `BR-OUTPUT/HotkeyAnalytics.swift`, deleted eight
months of commits earlier. SwiftPM does not fail on a missing source: it prints
`Invalid Source ...: File not found.` as a **warning** and builds on. So
`HotkeyAnalyticsEncryptionTests.swift`, which asserts hotkey analytics are
encrypted at rest, had been asserting nothing.

**A threshold equal to the current measurement is a snapshot, not a threshold.**
Falsifiability is necessary and not sufficient. Two questions, always:

1. What event makes this red? (this file has said so for days)
2. **Why is it green at exactly this number?** If the answer is "because that is
   what the tree measures today", the number encodes whatever was broken when it
   was written — and it will be tuned again the next time something breaks.

I had written that warning into the brief for someone else the same day, then
walked past the instance in front of me, because I checked property 1 and never
asked property 2.

The structural fix is the same as everywhere else this week: one list, read not
copied. `build.sh` grew `TRIOS_PRINT_SOURCES=1` beside its existing flag printer,
`Package.swift` matches what it prints, and `make sources-drift` (0.1 s, in
`check`) fails on four conditions — the sets disagree, an entry names a file
that does not exist, a declared exception is stale, or either list comes back
empty. That last one matters: an empty list agrees with everything.

## The suite that had never compiled: 23 to 0, and what it cost to keep honest

With the source manifest unified, `tests/TriOSKitTests` compiled for the first
time and reported 23 errors in 4 of 42 files — pure drift, accumulated while
nothing could build it: MainActor isolation, mocks that no longer conformed to
the protocols they stub, an argument the API had dropped. All 23 are gone.

The rule that made the number mean something was set before the work started:
**do not weaken an assertion to make it compile.** A test that compiles because
its check was deleted is worse than one that does not compile, because it then
reports success. Measured afterwards rather than trusted:

    ChatFailureTests        67 -> 68 assertions
    LocalAuthProviderTests  50 -> 51
    LogsTabViewTests       280 -> 280
    HotkeyAnalytics...       5 ->   5

Nothing was gutted; two files gained an assertion.

The interesting case is the one whose subject no longer exists.
`HotkeyAnalyticsEncryptionTests` asserts that hotkey analytics are encrypted at
rest, and `HotkeyAnalyticsViewModel` was deleted months ago. There were three
options and only one is honest:

- restore the assertion — impossible, the subject is gone;
- rewrite it into something that passes — this is the failure mode, dressed as
  progress;
- **skip loudly.** `throw XCTSkip(Self.subjectDeleted)`, the original assertions
  preserved as comments in place, and a header recording what happened. Two
  skips in the whole suite, both here, both named.

Then the ceiling. It had been 2 (the number a broken build happened to produce),
then 23 (the number the first real compile produced). Both were readings. It is
now **0**, and that number comes from a requirement — a suite that compiles —
so any rise is a regression rather than a new normal. Driven: one planted type
error takes it red.

The same question asked of `WARNING_CEILING` gave a different answer, and the
difference is worth keeping. It is 4, which is exactly the four deprecated
`Text` concatenations in one file — a reading. But the fix is an
`AttributedString` rewrite that changes rendering, and rendering cannot be
verified from a build log. So the number stays and **the comment now says it is
a reading with a named debt**, with the issue linked. Correcting the claim is a
real repair; retuning a number you cannot justify is the same defect facing the
other way.

## Compiling is not passing

`make xctest` counts compile errors. When it reached zero I nearly reported the
suite as healthy. Compiling is a precondition; the question is what the tests
say. Run for the first time:

    121 executed, 2 skipped, 10 failures across 4 suites
    ...and the process still exits with signal 5

The 2 skips are the deliberate ones. The 10 failures are not test drift — they
are assertions about the product that nobody could evaluate for months:

- a `BackgroundHealthPoller` that is not nil after being stopped;
- `/doctor --model` with an empty value parsing as `doctor(model: nil)` instead
  of being rejected — a flag with no value silently accepted;
- a disabled provider catalog reporting `unknown("not configured")` where the
  test expects `unavailable`.

And a trap worth knowing before anyone repeats the run: **without
`TRIOS_E2E_DISABLE_KEYCHAIN=1` the run does not merely fail, it aborts.**
`KeychainSymmetricKeyStoreTests` hits `Fatal error: Unexpectedly found nil` and
everything after it never executes — so the naive run shows a truncated picture,
not ten failures. With the variable those six tests pass. A precondition that
changes the *shape* of the result, not just its value, belongs in the contract
rather than in somebody's memory.

**Three distinct states, and a gate that stops at the first is not measuring the
third:** does it build, does it run, does it pass. This repository had a gate on
the first, believed it was measuring the third, and the gap held for months.

## A failing assertion must not be able to kill the run

The suite reported 121 tests, then 133, and I believed each number in turn. The
real figure was 483. Three quarters of it had never executed — not failed,
never executed — because two patterns turn one bad assertion into a dead
process, and everything scheduled afterwards silently disappears.

    133  before        died in a URLProtocol's fatalError
    187  after fix 1   died on a force-unwrap after a failed XCTAssertNotNil
    483  after fix 2   no crash; 122 failures now visible

**Pattern 1: `fatalError` inside a callback the framework owns.**
`MockURLProtocol` had `fatalError("requestHandler is not set")`. The handler is
a shared static that suites set and clear, so a request still in flight arrives
after somebody's tearDown has nilled it — and takes the whole run with it. Fail
the *request* instead: `client?.urlProtocol(self, didFailWithError:)`. One test
fails, in the suite that leaked the request, and the run continues.

**Pattern 2: `XCTAssertNotNil(x)` followed by `x!`.** Fourteen of these across
four files. The assertion reports the failure and then the next line crashes the
process, so the assertion's own message is the last thing anyone sees. Use
`guard let ... else { XCTFail(...); return }`, or `try XCTUnwrap`.

The rule underneath both: **in a test suite, a failure must be a value, never a
control-flow event that leaves the process.** A crashed run does not report
"n failures" — it reports a prefix, and a prefix is indistinguishable from a
short suite.

Two counting traps met while measuring this:

- Summing `Executed N tests` lines triple-counts, because XCTest prints a total
  per class, per suite and per run. That gave "1449". Count unique
  `Test Case ... started` lines, or read the final `All tests` summary.
- `cmd 2>&1 > file` sends stdout to the file and leaves stderr on the terminal —
  the opposite of what is wanted. It buried the answer under a 13 MB warning
  about 105,032 unhandled files in `node_modules`. Write `cmd > file 2>&1`.

## A recorded test that needs a live credential is not recorded

The cassette suite replays a recorded SSE stream so a swarm run is
deterministic — same bytes, same order, every time. It substituted a
`ReplayTransport` for the **workers**. The chat panel kept a live
`SSETransport`, and `ChatViewModel`'s API-key precondition keys off exactly
that:

```swift
if type(of: transport) is SSETransport.Type {
    let resolvedKey = modelStore.resolvedAPIKey(for: modelStore.selectedProvider)
    guard !resolvedKey.isEmpty else { /* refuse to dispatch */ }
}
```

So every replay was gated on a credential it would never use. The suite passed
on a machine that happened to have a key and failed on one that did not, with
the message *API key is unavailable — the Keychain did not respond*, which
names the wrong layer entirely. This is the resource-affected flake class (Silva
et al.): the result depends on the machine, not the code.

**Rule.** Substituting the transport is not enough. Find every precondition that
*inspects* the transport — its type, its configuration, its credentials — and
check what each one sees under replay. The question is not "did I replace the
thing that fetches bytes" but "does anything still ask whether the real fetcher
could have worked".

Fixed by building both transports from one factory. Note the trap avoided: the
two callers genuinely differ (a worker gets an hour, the chat keeps the
default), so the factory takes the timeout as a parameter. Folding them into one
constant would have changed the chat's patience as a side effect of a transport
fix — a behaviour change smuggled in under a bug fix.

Result: 4 of 4 cassettes, up from 3 of 4. The orphan-tool-call replay had been
red for the API-key reason all along, and was being read as a real regression.

## Harness memory outlives the harness run

After the transport fix the replays still failed, now with
`queen.inbox.skipped — Line already executed`. The cassette feeds the same
delegation line every run, and the inbox idempotency store remembered it.

That store is **not a file**. The offset and the executed-fingerprint set live
in `UserDefaults` under the bundle id, so wiping the state directory does not
touch them. A harness variant's defaults domain is disposable by construction:

```
defaults delete com.browseros.trios.test >/dev/null 2>&1 || true
```

**Rule.** When resetting a harness between runs, enumerate where state can hide:
files under the data root, `UserDefaults` keyed by bundle id, the Keychain,
`/tmp`, and git branches. A reset that clears only the obvious one produces a
second run that behaves differently from the first, and the difference is
reported as a missing marker rather than as leftover memory.

## A run must certify its own completeness

An aborted run does not report "n failures" — it reports a **prefix**, and a
prefix is indistinguishable from a short suite. This repository read 121 tests,
then 133, while the real figure was 483: a `fatalError` in a URLProtocol stub
and fourteen force-unwraps after a failed `XCTAssertNotNil` were each killing
the process mid-run, and everything scheduled after the crash disappeared
silently.

XCTest prints a final `Test Suite 'All tests'` summary if and only if it
reached the end. `make xctest-run` refuses any log without it, whatever count
the log claims.

Two details that cost a round trip each:

- The judgement lives in a separate target, `xctest-log-complete LOG=<path>`,
  so the **red** side can be driven in milliseconds against a synthetic
  truncated log instead of the 5.5 minutes a real abort costs. A gate proven
  only from the green side is not proven.
- Counting `^Test Case '-\[` double-counts: XCTest prints a line at start and
  another at finish. The first run of the new target printed 966 for a 483-test
  suite. Match ` started$`.

## A gate validated against prose cannot tell prose from code

`make keychain-doors` fails a file containing `SecItemCopyMatching` outside an
allowlist. It fired on a test whose **comment** explained why the suite must not
touch the Keychain — the opposite of a violation.

The self-test that was supposed to prove the gate planted this fixture:

```
// check-selftest SecItemAdd
```

A comment. So for its whole life the self-test proved only that the gate greps
for a word. The fixture is now a real call on a code line, and the rule skips
lines whose first non-blank characters are `//` or `*`. That filter cannot hide
a real call: a call on a line beginning `//` is not a call.

**Rule.** A gate's negative fixture must be a real instance of the thing being
forbidden. If the fixture is cheaper to write than the real violation, the gate
is being validated against the cheap thing.

Three arms driven every time: clean tree passes, real violation caught, benign
lookalike passes.

## Timing something whose exit status you did not check

Measured time-to-first-byte five times: 0.31s, 0.07s, 0.07s, 0.07s, 0.12s.
Those were five measurements of a **404** — wrong route. `curl | head -c 1`
happily reports the first byte of an error page.

This is the second time the same mistake produced a publishable-looking number
in this repository. Print the status alongside the timing, always, in the same
line — not as a separate check that can be skipped when the numbers look
plausible.

## Triage by cause, not by file — and let an adversary kill the diagnoses

Sixty-two failing tests across nineteen classes were triaged by nine read-only
agents in parallel, one per related cluster, each asked to classify every cause
as product-defect / test-defect / environment / design-question. Every claimed
*product* defect was then handed to a separate agent told to **refute** it, with
the instruction to default to refuted when unsure.

Nine claims died there. What survived was almost all real, and most of it was
product code rather than tests — the opposite of the assumption that a long-red
suite is mostly stale tests.

Two things made this work, and both are worth copying:

- **Read-only diagnosis, serial repair.** Parallel agents that *build* Swift
  will thrash a machine (load average hit 136 here) and parallel agents that
  *edit* one tree reproduce the exact source-collision the worktree work had
  just fixed. The expensive part is understanding, and understanding
  parallelises safely.
- **The adversary is not optional.** A plausible-but-wrong diagnosis costs more
  than a missed one, because it gets acted on. Nine of twenty-two would have
  been acted on.

## Three numbers that are not the same number

XCTest's summary counts **assertion failures**, not tests. "104 failures" was 74
failing tests. Reports in this project quoted 122, 118, 105, 99 and 62
interchangeably over several days — all assertion counts, none of them the
number of broken tests.

    grep -oE "^Test Case '-\[[^]]+\]' failed" run.log | sort -u | wc -l

And a third, distinct number: how many of those fail **in isolation**. Running
each class alone separates "broken" from "contaminated by a neighbour". Here
every sampled class failed alone too — so there was no cross-test leakage to
chase. Two classes failed *more* alone than together, which is order dependence
in the direction nobody looks for: the full run was masking failures.

## Machine configuration wearing an assertion

`Calendar.current` on a Thai-region machine (`en_TH`) is the **Buddhist era**: a
correctly parsed 2026 reads back as 2569, and the test fails on a value the
parser got right. The same file asserted hour 12 for `...T12:00:00Z` while
reading in local time, which is 19:00 in Bangkok.

The instant under test is absolute. Only the *reading* of it was
locale-dependent, so pin the reading and leave the parser alone. Any assertion
that reads a date through `Calendar.current` is testing the machine.

## Defects that hide in what a test does not compare

Several of the confirmed product defects had the same shape: a value computed
correctly and then dropped, or compared against the wrong companion.

- `ModelHealthService.probe` rebuilt its result and carried three fields of
  five. `quota` survived because it was the one field copied — which is exactly
  why the three quota tests passed and the retry-after and failure-kind ones did
  not. **When a subset of a cluster passes, ask what the passing ones have that
  the failing ones lack; the answer is often the defect.**
- `lsof <path>` exits **1** when nothing holds the file open — the normal case —
  and the rotation policy read that as "somebody is writing" and cancelled
  itself. The retention policy was inert for precisely the files it exists to
  trim. **An exit status you did not read the manual for is a guess.**
- `LogParser.category` looked for `event-log`, `cron-log`, `queen-log`; the
  files this project writes are `event_log.jsonl`, `cron.log`, `queen.log`.
  Nothing matched, ever. **Grep the tree for the names a matcher expects; if
  none exist, the matcher has never matched.**
- `TriOSEncryptionError.openFailure` was declared and unreachable, because
  `decrypt` let CryptoKit's own error out. **An enum case nothing throws is
  either dead or a missing `catch`.**
- A migration ladder re-tested the immutable original version at every rung, so
  it could only ever climb one. **A stepwise migration needs a running value;
  testing the entry condition inside each step is a ladder with one rung.**

## A control nobody can reach is a constant

`queenAutonomyEnabled` was a stored preference with a getter, a setter, and a
default. It had no callers of its setter - not in the UI, not in a command, not
in a test. For as long as it existed it therefore only ever held its default,
and in the dev variant that default is off. The build meant for testing the
Queen was the one build in which she could not be started.

Every test passed. They set the value directly and asserted on the reader,
which is a test of a variable, not of a preference.

**Rule:** for anything described as "the operator's choice", the test must go
through whatever the operator would touch. If nothing in the app can reach it,
that is the finding - write it down before writing a test that hides it.

**Two-sided proof, from one log:**

```
queen.autonomy.skipped  | Not picking up work: autonomy is switched off
queen.autonomy.tick     | Capacity free - choosing and starting the next open sub-issue
queen.autonomy.approved | Approved gHashTag/trios#1129 on her own authority - autonomy is on
```

The first line is what the fix had to change. Keeping both in the same log is
cheaper and more convincing than any assertion about either alone.

## Layout defects need a screenshot, not a reading

"The design jumps" and "the fonts are unreadable" cannot be verified from
source, and both were true here in ways the code did not obviously show:

- A status label written straight from an enum - `queued`, `running`,
  `awaitingReview` - is 6, 7 and 14 characters. Placed after a `Spacer` it
  resizes its neighbours every time the work advances. Nothing in the file
  looks wrong.
- An `HStack` that does not fit does not clip, it *compresses*, and which child
  loses depends on what the others happen to contain. That produced a label
  reading `committ / ed` across two lines - a wrap inside a nine-character
  word.

**Method that worked:** `screencapture -x -o` the whole screen, crop with
`sips`, read the image. Faster than any UI automation and it needs no
permissions. Bring the window forward first with
`osascript -e 'tell application id "<bundle-id>" to activate'` - `System
Events` position/size calls need assistive access and will fail.

**Reserve, do not conditionally insert.** Both fixes are the same shape: render
the widest thing the slot can ever hold, hidden, and put the real content over
it. Derive the widest from the data (`allCases.map(\.rawValue).max(by: count)`),
so a case added later widens the reservation instead of overflowing it.

## A floor belongs in one place or it is not a floor

618 hard-coded font sizes, 317 of them 10pt or smaller. No single one is a
defect and the sum is an unreadable app. The fix that holds is not 317 edits,
it is one function every size passes through, plus a gate that fails on a raw
`.system(size:)` anywhere else. Without the gate the 618th is indistinguishable
from the 617 that came before it.

## One word for two endings makes the record useless

The delegation registry spelled every failure `failed`. A worker killed by a
rebuild and a worker that ran forty-one tool calls and committed nothing were
the same word afterwards, so nothing downstream could treat them differently -
and the thing downstream was the decision to send another bee. #1127 collected
seven attempts that way.

The two are separable from what was already recorded, without adding any new
measurement:

```
streamOutcome == "open" && completedTurns == 0   -> interrupted
committedFiles == 0                              -> produced nothing
otherwise                                        -> worked and still failed
```

A worker that finishes closes its stream. One that was killed never gets to.

**Rule:** when a state is reached from two causes with different consequences,
record the cause at the moment it is known. `reconcileOrphanedWorkers` KNEW it
was reconciling a dead process - it exists for that - and wrote the same word
as a genuine defeat. The knowledge was there and discarded, which is cheaper to
fix than to reconstruct.

**Corollary for the fallback:** records written before the field existed cannot
be classified now. Count them as the *real* kind, not the harmless one - the
alternative lets an issue with a long history of defeats look untouched and
start its budget over.

## Do not let your own restarts read as the system failing

Ten of the fourteen dev failures in this round were tasks I orphaned by killing
the app during rebuilds. Presented as-is they would have been fourteen Queen
defects. Check `streamOutcome` and the measurement fields before attributing a
failure to the thing you are investigating: all-null measurements mean nobody
ran, and if you restarted the app that hour, the likeliest cause is you.

## A retry with an identical brief is the first attempt run twice

Counting attempts is only half. The bee that goes second must be told what the
first hit, or it cannot do anything different - it does not even know it is
second. The briefing carries the kinds, in order, and an explicit instruction
not to repeat the approach, plus: if you reach the same wall, name it rather
than stopping quietly. An empty branch and a named obstacle cost the same and
are worth very different amounts.

## The fourth mechanism built and never called

The list in this project so far: the autonomy preference (a setter with no
caller), the worktree committer (`commitInWorktree`, declared and unused), the
skill match (matched against the wrong shape, so inert), and now the review
send-back. `/review <slug> reject <why>` returns a task to its worker, rebriefs
it and restarts the runner. It worked. Nothing had ever called it but a human
typing the command, so eight fully-judged tasks sat in `awaitingReview` for up
to fifteen hours, each holding its file boundary, and the autonomous tick
reported "all 24 candidates look already done" because every path to real work
was owned by something nobody had finished.

**The tell is a queue that only a person drains.** When a state has an exit
that exists but no rule that takes it, the queue does not look broken - it
looks busy. Ask of every terminal-ish state: what moves a task out of here
without a human, and if the answer is "nothing", that is the bug, not the
backlog.

**Search for it directly.** For each function that changes state, grep for its
callers. One caller that is a command handler and none that are policy means
the mechanism is manual-only, whatever the design says.

## A new automatic action spends whatever the manual one spent

The send-back puts a worker back on the wing, so it costs a slot. The manual
command could ignore the ceiling because a human issues one at a time; the
automatic sweep runs over every judged task at once. Eight would have started
against a ceiling of four.

The guard went in at the last minute and earned itself on the first run:

```
queen.review.send_back_deferred | #1149 is ready to go back but 4 workers are already flying
```

**Rule:** when converting a manual action into an automatic one, re-ask every
resource question the manual version never had to answer. Rate, concurrency,
cost, and idempotence were all implicitly bounded by the human doing it.

**And the notice needs bounding too.** The sweep passes over every waiting task
every tick. An escalation that speaks each time buries the tasks that moved
under the ones that cannot. Once per task per run.

## A refused transition still ran the code after it

`registry.transition(...)` returns whether the move happened, and the line
after it recorded a failure kind unconditionally. A cancelled task refuses the
move to `failed` - correctly - and was then stamped `producedNothing`, feeding
a failure to the policy that counts failures against an issue.

Found by reading the suite's own log rather than its verdict:

```
queen.transition.rejected  Cannot move #4243 from cancelled to failed.
queen.failure.classified   #4243 failed as producedNothing
```

Two consecutive lines that contradict each other, in a run that passed.
**Read the log of a green suite.** The assertions only cover what someone
thought to assert.

## Count the things, not the lines about the things

I reported "410 undecryptable conversations in the release". It was 410 log
lines: sixteen conversations, re-reported once per launch across twenty-six
launches. The number was off by a factor of twenty-five and it was in a report
I wrote to be read while asleep.

**Rule:** before quoting a count from a log, collapse it by identity. One
`grep -c` answers "how often was this said", never "how many things are wrong".

## A filter that silently empties the result must say what it removed

The branch committer diffs the whole tree, then drops every path outside the
task boundary. When nothing survives it reported "The worker changed no files"
- the same sentence as a worker that genuinely did nothing.

So a bee that wrote six files in the wrong place was recorded as idle,
classified `producedNothing`, counted against the issue by the retry policy,
and shown to the operator as lazy. The real fault - a boundary and a task that
describe different work - is fixable in one line of a brief, and nothing in the
system said it out loud.

**Rule:** wherever a filter can reduce a non-empty input to an empty output,
the empty case needs two branches. "There was nothing" and "there was
something and I removed all of it" are different facts about different
problems, and only one of them is the worker's fault.

## Data that cannot be read today is not data that is gone

Sixteen conversations decrypt to nothing because the key was created on 25 July
and overwritten on 27 July. `load` returned `[]` for them - which is exactly
what an empty conversation returns - so the app showed sixteen blank chats and
would have saved a short new history over 23KB-507KB of real ciphertext at the
first message.

The key paths that caused it were already guarded by the time I looked, so the
fix was not there. It was in the read: quarantine the bytes on first failure,
and refuse to write into a conversation whose stored form could not be
decrypted.

**Rule:** when a decode fails, the caller must be able to tell "empty" from
"unreadable". Returning the empty value for both is the step that converts a
recoverable problem into a permanent one, and it always looks like graceful
degradation.

## Not reproducible is a finding, not a gap

One suite run reported a failure that six consecutive runs afterwards could not
reproduce. The likeliest cause was environmental - the same worktree flicker
that, minutes later, handed the compiler an empty source file git considered
unmodified. Say that. A flake reported as fixed because it stopped appearing is
the same sentence as a flake nobody looked at.

## A constant is the wrong shape for the operator's decision

The epic number `1090` was written into eight places, one of them a URL. Six
sub-issues were then opened under a second epic - acceptance criteria, disjoint
boundaries, everything the selection needs - and the Queen could not see one of
them. Not refuse them: **see** them. Her log said "all 24 candidates look
already done" while six untouched tasks sat one epic away.

That log line is the tell, and it is a comfortable one: it describes a board
that has been fully considered. Nothing about it suggests the board is the
wrong board.

**Rule:** ask of every constant whether it encodes a law or a choice. A law
(`MAX_CONCURRENT_WORKERS`) belongs in code. A choice - which repository, which
epic, which branch, which model - belongs in a stored preference with the
constant as its default. The test is whether the operator could reasonably want
a different value tomorrow without a build.

**Two consequences that are easy to miss when fanning one out to many:**

- Deduplicate. A repeated epic reads the same timeline twice and every
  sub-issue in it counts double, which looks like real work.
- Do not let one failure become total failure. One unreachable epic must not
  stop work sitting open in another - and the error must name *which* one,
  because "HTTP 404" is unactionable the moment there is more than one source.

## Rules arrive in pairs, and the second one breaks the first

The operator asked for everything to be written in English. The Queen's
boundary parser recognised `## Границы` and nothing else, so the first English
issue would have been skipped as having no boundary section at all - a true
statement about the parser and a false one about the issue.

**Rule:** when a documentation or naming convention changes, grep for the
places that parse the old convention. A heading, a prefix or a filename that a
machine reads is a token, not prose, and both spellings have to work for as
long as both exist in the corpus.

## `git add -A` in a shared checkout owns whatever the bees left there

Three bees' work ended up inside commits whose messages describe my own
changes: a 209-line ring rewrite, a 363-line parity harness and a 288-line
Verilog harness, all under a commit titled "the bee was handed a copy of its
task". The branch was already pushed, so rewriting that history would cost more
than the wrong attribution does - but it is wrong, and it happened because
`git add -A rings tests` cannot tell my edits from theirs.

The cause and the defect being fixed in that same commit are the same thing:
the bees were writing into the shared checkout because the task struct handed
to the runner was copied before its worktree existed. Fixing dispatch stops it
recurring; it does not undo it.

**Rule:** in a repository where agents write concurrently, stage by path, not
by `-A`. `git add <the files I edited>` is three seconds of typing and the
difference between a commit that says what it does and one that quietly
absorbs someone else's day.

**Tell:** `git show --stat <your commit>` listing files you never opened.

## A count is not evidence unless something can be looked up

`committedFiles: 1` on a task whose branch does not exist. The number was true
when it was measured and unverifiable ever after, because nothing recorded
*which commit* those files landed in.

The same shape appears wherever a measurement is stored without its subject: a
test count with no run id, a coverage percentage with no commit, a "healthy"
with no probe timestamp. Each is a claim that cannot be rechecked, and each
degrades silently rather than failing.

**Rule:** store the identity beside the measurement, and make the gate require
it. `qualifiesForAutoAccept` now refuses a task whose commit cannot be named -
so the Queen may close her own worker's work only when there is something to
look at.

**Corollary for the other side of the branch:** the failure path had computed
the same number all along and dropped it, so a bee that committed 288 lines and
then died was recorded as having produced nothing. If a measurement is worth
taking on success it is worth recording on failure - that is exactly where the
record is most likely to be wrong and least likely to be checked.

## Three targets, one table, or the claim is decoration

Ring 00's whole argument is that a rule generated into Rust, Zig and Verilog is
one rule rather than four. That is only worth saying if the three are run
against the same inputs and compared:

```
ring00_parity.sh    generated Rust vs the Swift table   (rustc --crate-type lib)
ring00_verilog.sh   generated Verilog vs the same table (iverilog + vvp)
```

Both skip rather than fail when the toolchain is missing - the compiler lives
in a sibling repository - because a machine without `iverilog` should not be
told the ring is broken. Proven red by changing one constant in the `.t27`:
two of thirty-five rows disagree and the harness prints both sides.

## The wrong base, three times

Counting "what did the bee actually commit" needs a base to count from, and I
have now chosen the wrong one three separate times:

1. `origin/master..branch` in a repository whose default branch is `main`. The
   ref does not exist, `rev-list` returns nothing, and every branch reads as
   empty. **A base that does not exist looks exactly like a branch with no
   work.**
2. `dev..branch` when the branches were cut from the working branch. Every
   commit of mine counted as the bee's - one bee's single commit reported as
   507.
3. The second one again, in code, *after* writing a warning about it into the
   helper's own doc comment.

**The question is always `HEAD..branch`** - commits on that branch that are not
already here. Not a named branch, which is a guess about where the branch was
cut from; not a two-way `diff`, which reports a stale branch as productive
because it is *behind*.

**Rule:** before quoting a commit or file count, run the same command by hand
on one known case and check the number against what you can see. `#1283` was
two commits; the code said 513; one `git rev-list` settled it in a second.

**And a comment is not a guard.** I wrote the warning and then made the mistake
in the function the warning was attached to. If a rule matters, put it in a
signature or a test, not in prose above the code that breaks it.

## Put the audit outside the branch that skips it

The reconciliation scan went in inside `if no active tasks at launch`, so it
was skipped exactly when the swarm was busy - and a busy swarm is when work
goes missing. The scan reads only git and costs nothing; there was no reason to
gate it at all.

**Rule:** an audit that only runs when the system is idle audits the state you
were least worried about. Ask what condition you have attached it to and
whether that condition correlates with the failure you are looking for.

## Detection before correction

The scan reports and does not fix. Advancing a task's state from a git scan is
a judgement about work nobody reviewed; saying that the record and the tree
disagree is not, and it was the half that did not exist.

Separate the historical from the urgent, or the report becomes noise: eight
rows carrying a count written before commits were recorded are not eight
emergencies, and listing them beside three real disagreements teaches the
reader to skip all eleven.

## An assertion asked at the wrong moment passes for the wrong reason

I checked "a proposal number out of range is refused by name" *after* applying
the only proposal. With the list empty the command correctly answers
"everything agrees" - a different sentence entirely - and the check passed
while testing nothing.

This is the fourth time in this project a check has passed for the wrong
reason, and the shape is always the same: **the precondition the assertion
needs was destroyed by the step before it.** Asked while the list still had
something in it, the same check tests what it claims to.

**Rule:** for any assertion about a refusal, ask what state must exist for the
refusal to be reachable, and put the check where that state is still true. A
refusal that is unreachable is indistinguishable from a refusal that works.

## Proving the offer is not proving the effect

A gate that refuses correctly and an `apply` that does nothing look identical
from outside. The decision layer was tested - correct proposals, correct
"waits for a word" - and the effect was not, so `apply` could have been an
empty branch and every check would still be green.

**Rule:** for a command with a side effect, read the store afterwards, not the
message. `check(registry.task(...)?.committedFiles == 0)` survives an
implementation that only *says* it cleared the count; `check(messages.contains
"cleared"))` does not.

**Break it the same way:** make the command announce the repair without
performing it. If nothing goes red, the test is about the announcement.

## Detection, proposal, application - three separate steps on purpose

- **Detect** and say nothing else. Advancing a state from a scan is a judgement
  about work nobody read.
- **Propose**, numbered, with the reason in terms of the repository rather than
  the record.
- **Apply** only on an explicit word, and let showing and doing be different
  words rather than a flag - a typo in a flag should not be the difference
  between a report and an edit.

The reason for the ceremony is not caution. A registry made to agree with the
repository by construction stops being evidence about anything; the
disagreement IS the finding, and a supervisor that quietly repairs its own past
verdicts is worse than one that leaves a wrong number visible.

## The most reassuring line in the log was the symptom

```
queen.choose | All 26 candidates look already done — nothing to choose
```

That sentence describes a board that has been fully considered and found
finished. It is what a healthy idle supervisor says. Underneath it, four issues
were deadlocked by tasks she had opened herself, and two of them were the start
of a migration I had spent the night setting up.

**A task whose dispatch fails stays `queued`, and nothing ever looked at
`queued`.** The stall reaper handles `running`. A queued task still owns its
file boundary, so the Queen considers its issue, finds a live task holding
exactly those paths, and refuses with "its files are owned by a live task" -
true, and the live task is hers, for that same issue.

**Rule:** for every state in a lifecycle, name what moves a task out of it. If
the answer for any state is "nothing", that state is a leak, and the symptom
will not look like a leak - it will look like the system having nothing to do.

**Corollary about resources held by non-running states.** Anything a task owns -
a path, a lock, a slot - is held for as long as the task is non-terminal, not
for as long as it is *working*. Ask of every held resource: which states hold
it, and is there a state that holds it forever?

## Read "never started" from the runner, not the clock

Age alone cannot distinguish a task that was never dispatched from one that has
been working for hours. The runner already records what it did: a stream that
opened sets `streamOutcome`, a finished turn sets `completedTurns`. Either
means the task was taken, whatever the registry state says and however long ago
it was created.

Grace of two ticks, not one: a single tick's refusal may be a slot that was
full, which is backpressure working correctly rather than a dispatch that
failed.

**And cancel rather than fail.** Nobody failed - the dispatch did not happen.
Recording it as a failure would count against the issue in the retry policy and
tell the next bee that the last one produced nothing.

## A message that names a cause nobody measured

`"API key is unavailable - the Keychain did not respond."` The code observed
one thing: the resolved key was empty. It could have come from three places,
and the message picked one and blamed it. Everyone who read that line - me
included, for a whole night - went looking at the Keychain.

The truth, once the refusal reported every source it consulted:
`~/.trios/config.json` held both provider keys with **zero-length values**. A
file that looks configured to anyone who opens it and supplies nothing to every
consumer. The fallback meant to cover the Keychain's intermittency had never
worked once.

**Rule:** an error message may state what was observed and must not state what
was inferred. If three sources feed a value, the failure names all three and
what each returned. The cost of the shortcut is not the wrong word - it is
every future reader searching the wrong layer.

**Same shape, twice in one night:** the issue fetcher logged "API empty"
whatever had actually failed, because the real error was swallowed by `try?`.

## Present-but-empty is not absent

Both are falsy and they send a reader to opposite places. "Absent" asks whether
the file exists and whether the path is right. "Present but empty" points at
the single line that is wrong.

This is the third form of the same distinction in this project:

- `nil` committed-file count is "not tallied", `0` is "tallied and empty"
- a branch that does not exist is not a branch with no commits
- a config key with `""` is not a missing config key

**Rule:** wherever a value can be missing OR blank, report which. Collapsing
them with `?? default` is how a wrong story survives contact with the evidence.

## Correct the record when you find out you were wrong

I wrote in a commit message that `resolvedAPIKey` reads `~/.trios/config.json`
"and the key is there". It is not there. The dev variant reads
`~/.trios-dev/secrets/`, and I generalised from that to the release without
opening the file.

A wrong sentence in a commit message is durable in a way a wrong sentence in
chat is not: it is what the next person greps. Correct it in the next commit,
by name, rather than quietly writing the truth beside it.
