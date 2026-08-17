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
