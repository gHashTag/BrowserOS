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
