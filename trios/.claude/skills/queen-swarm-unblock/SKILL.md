---
name: queen-swarm-unblock
description: Diagnose why the Queen's swarm has stopped and unblock it. Use whenever running is 0 or the tick says "nothing to choose", before writing any new backlog issue, and before believing the swarm is starved. Carries the five causes measured in production, the command that separates them in one minute, and the smallest safe fix for each - including the one that took running 0 to 4 by changing ten rows of a path list.
---

# Why the swarm stopped

A stopped swarm looks the same from the dashboard whatever the cause: `running 0`,
`nothing to choose`, a backlog full of issues. Four different things produce that
picture and three of them are NOT a shortage of work. A fifth cause, below, does
not stop the swarm but decides whether its output can be believed. Writing more issues into a
swarm stopped for any of the other three reasons is wasted effort - measured, on
2026-09-04, at 53 issues written while the real blocker was elsewhere.

Run this first, in this order. It takes about a minute and it separates all four.

```bash
tri swarm      # refusal string, skip summary
tri fence      # which paths parked dispatches hold
```

## Cause 1 - the disk is full, and bees die before they start

**Tell:** dispatches finish in **0 seconds**. A real bee runs 500-1200 s and spends
around 2M input tokens.

```bash
railway ssh --service trios-agent-server -- sh -c 'df -h /workspace | tail -1; ls /workspace/BrowserOS/.worktrees | wc -l'
# and read the newest outcomes - the string is unmistakable:
#   git worktree add failed: Preparing worktree ... error: unable to write file
```

Measured 2026-09-04: 74 worktrees, 46 G, **100 %**, 12 M free. Nothing prunes them.

**A level is not a rate, and the threshold was chosen wrong.** The same day the
volume went **27% -> 67% in under three hours** with four bees running - about
fifteen points an hour. At that rate the original 80% threshold is fifty-five
minutes of warning against a timer that looks every twenty. It is now **55%,
down to 30%**: three hours of headroom, nine firings rather than three. `tri reap`
prints points-per-hour and time-to-full on every run, because 67% falling is
fine and 50% climbing is twenty minutes from the threshold.

**Fix.** Remove CLEAN worktrees only, and never with `--force`: without it git
itself refuses any tree carrying modified or untracked files, which is the safety
you want. `git worktree remove` deletes the working directory and KEEPS the branch
ref, so no commit is lost.

```bash
for d in /workspace/BrowserOS/.worktrees/*/; do
  git -c safe.directory=* -C /workspace/BrowserOS worktree remove "$d" 2>/dev/null
done
git -c safe.directory=* -C /workspace/BrowserOS worktree prune
```

Result that day: 70 removed, 4 refused (dirty, correctly kept), 100 % -> 4 % used,
all 98 branch refs intact, bees running again on the next tick.

Every git call into that container needs `-c safe.directory=*`. Without it git
fails with "dubious ownership" and `git branch --list` returns an EMPTY list rather
than an error - a count of 0 from that command means the command failed.

`git worktree prune` does NOT reclaim bytes - it only drops metadata for trees
whose directory is already gone. `remove` is what frees space; `prune` tidies
after it.

Published advice says agent worktrees are always unclean, so `--force` is
mandatory. On this fleet that is false and following it would have destroyed
work: 70 of 74 trees were clean and the 4 refusals were exactly the ones holding
uncommitted changes. Measure before adopting it.

**Now automated.** `tri reap` reports; `tri reap --reap` acts, with kubelet-style
hysteresis (reap at 80% used, down to 60%, never the newest 6). Run it every
iteration - measured regrowth is roughly 4 to 26 worktrees in four hours, so a
volume cleared to 4% is back at the danger line inside a day.

## Cause 2 - finished issues were never closed, and they jam the pool

**Tell:** `skipSummary.completed` is large. On 2026-09-04 it was **76 of 104 skips**,
against 103 open issues.

The supervisor cannot close anything. On `origin/feat/queen-supervisor` the whole
of `queen-tick.ts` touches the GitHub API exactly twice - lines 170 and 499 - and
both are GET. There is no write path, so an accepted issue stays open forever and
is re-skipped as `completed` every single tick.

**Fix (until the write path exists):** close them by hand, but only where a dispatch
actually reached `accept`, and push the branch first so the closing comment can name
real work. Leave EPICs open - closing a parent hides unfinished children.

```sql
select i.number, d.branch from queen_issues i
  join queen_dispatch d on d.issue = i.number
 where i.state = 'open' and d.review_state = 'accept';
```

Closing 70 that way took skips 104 -> 34 and `completed` 76 -> 6.

## Cause 3 - parked dispatches fence the paths, forever

**This is the subtle one and it was the binding constraint underneath the other two.**

`QueenDelegationPolicy.claimOnIssue` treats `queued`, `running`, `awaitingReview`
and `rejected` as a LIVE claim. Its own comment explains why `rejected` is live:
"the same bee is expected to return to those files". No bee ever returns - a
sendBack re-dispatches nothing. So every sendBack, escalate and wait becomes a
permanent claim, and its `owned_paths` become a permanent fence.

Measured 2026-09-04: 19 parked dispatches fencing 32 paths, and **23 of 31
delegatable candidates blocked**. Two shapes, and they need different fixes:

- **Self-blocking** (14 that day): `#1332 blocked by #1332`. The issue is held by
  its own failed attempt and can never be retried. This needs the CODE fix - a
  bounded re-dispatch on sendBack. A database edit here risks re-dispatching work
  that genuinely should not repeat.
- **Dead holders** (7 that day): candidates blocked by dispatches whose ISSUE IS
  ALREADY CLOSED. A closed issue is never a candidate, so its claim protects
  nothing and fences for nothing. Among the seven was `#1362`, the issue that fixes
  this very class, held by `#1320`, closed.

**Fix for dead holders only.** Record the old value in the loop ledger first, then
clear the paths for exactly those rows. Ten paths across three rows took
`running 0 -> 4` and `fileConflict 8 -> 1` on the next tick.

```sql
update queen_dispatch set owned_paths = '[]'::jsonb
 where issue = any($1) and finished_at is not null;   -- only issues that are CLOSED
```

Do not extend this to holders whose issue is still open without the lease below.

### Three one-way valves, not two - two of them now fixed and deployed

**Landed 2026-09-04 in gHashTag/BrowserOS#108, deployed the same hour.** Result on
the first tick after the deploy: `claimed` fell **20 -> 12** and `notFirst`
appeared at 6, meaning six issues became eligible and queued behind the running
four. The deploy was proven by the number it was supposed to change, not by the
word SUCCESS - Railway reports SUCCESS for a container that never started, and a
server answering 200 does not mean the change took effect.

**AND THE FIRST VERSION COULD NEVER FIRE.** It measured idle from
`reviewed_at`, and `reviewFinishedDispatches` re-reads every `wait` row each
round and UPDATEs it in place - the tick's own comment says so. The clock reset
every five minutes against a six-hour floor.

```
#1327  finished 18.4 h ago   reviewed_at touched 0.06 h ago
#1329  finished 18.4 h ago   reviewed_at touched 0.06 h ago
```

Two dispatches held their boundaries for eighteen hours while the valve read
them as fresh, and the swarm sat at zero bees for six of those hours. Fixed in
gHashTag/BrowserOS#109 by reading `finished_at`, which is written once when the
bee stops and never again: `running 0 -> 3` and `claimed 15 -> 12` on the first
tick after the deploy.

**The clock a valve reads must be one nothing else touches.** And when a comment
in the code you are changing says a field gets overwritten, that is about YOUR
change too.

**The same measure was in two more tools**, found by asking where else the class
lives rather than stopping at the instance. In `lease.mjs` it was LIVE - every
frozen wait read as fresh. In `needs-you.mjs` it was harmless only by accident,
because `escalate` rows are never re-swept:

```
wait       reviewed_at as recent as 0.03 h   oldest finish 4.7 h    <- reset
accept     87.52 h                           87.7 h                 <- honest
escalate   89.37 h                           90.1 h                 <- honest
sendBack   39.57 h                           50.0 h                 <- honest
```

Both read `finished_at` now, and `tri loop-selftest` guards the CLASS - no tool
may compute an age from `reviewed_at` - proven by planting an offender and
watching the harness exit 1.

```bash
tri clocks     # every clock a decision is keyed on, and who rewrites it
```

Auditing the SUPERVISOR for the same class found **nothing live**, and that is
worth stating rather than quietly dropping. `dispatched_at` and `finished_at`
are written once. `seen_at` is rewritten every tick but nothing measures from
it. The 48-hour boundary hold reads `task.updatedAt`, which the tick fills from
`finished_at` or `dispatched_at` - traced by hand, because a text scanner cannot
follow a field across the TypeScript-to-Swift boundary, and the trace is written
into the tool so the next reader gets the answer instead of the question.

**A negative audit is only worth having if the auditor could have found
something.** `tri clocks` reports any field it does not recognise as `unknown`
rather than clean and exits non-zero on it, because an audit that quietly passes
what it cannot classify is the same shape as the defect it hunts.

Two floors, for a measured reason: `sendBack` releases after **1 h** because it
gets no second look at all; `wait` after **6 h** because it CAN resolve by
itself - a transcript merely slow to flush parses on a later sweep - so only a
genuinely frozen one should be released. `escalate` is untouched: it asks for a
person, and a timer is not a person.

### Three one-way valves, not two

`sendBack`, `escalate` and `wait` are all states meaning "not finished" that
behave as "never".

- **sendBack** promises a bee will return to those files. None does.
- **escalate** waits for a person. `needs_you` is written by the tick and read by
  nothing.
- **wait** promises a later judgement that cannot arrive. The sweep deliberately
  re-reads `wait` rows, and its own comment says "an unchanged transcript yields
  the same wait" - but the transcript of a FINISHED bee never changes, so
  re-reading is not re-judging. The policy returns
  `wait(reason: "N of M criteria judged so far")` and there is no later.

Measured 2026-09-04: `#1361` and `#1362` sat in `wait` for hours holding their
boundaries, counted in `claimed` against every candidate touching those paths.
Reported by gHashTag/trios#1408; the send-back half is fixed in
gHashTag/BrowserOS#108.

### Two fences, not one - and I conflated them once

`fileConflict` and `claimed` are separate mechanisms and only one of them yields
to a database edit.

- **`fileConflict`** compares a candidate's boundary against other dispatches'
  `owned_paths`. Clearing `owned_paths` releases it. Measured: 8 -> 1.
- **`claimed`** comes from `QueenDelegationPolicy.claimOnIssue`, which reads only
  the dispatch STATES - `queued`, `running`, `awaitingReview`, `rejected` are
  live. It never looks at `owned_paths`. Clearing paths does **not** move this
  number: on 2026-09-04 it stayed at 19 across a release of ten claims.

There is no "released" state to write, so clearing `claimed` from the database
would mean recording a verdict that did not happen. That one needs the code fix.
Say which fence you are clearing.

### The lease

`tri lease` implements the message-queue semantics the field uses and no agent
orchestrator ships (Redis `XAUTOCLAIM` is the reference): a claim carries an idle
time, a reaper releases claims idle past a floor, and a delivery counter sends a
repeatedly-failing item to quarantine rather than round-tripping it forever.

The retry ceiling is **not invented here** - it is
`QueenRetryPolicy.maximumRealAttempts = 2`, which already exists in both Swift
copies. A second number would be a second statement of one rule.

```
release      idle past the floor with attempts left, or the issue is closed
quarantine   at or over the ceiling - a person decides, not a timer
hold         verdict still fresh, under the idle floor
```

First run: 10 released, 3 quarantined, 3 held. Everything released is written to
the loop ledger first, so it is reversible from that file alone.

## Cause 4 - the boundary is only a document

An issue whose `## Boundary` names nothing but `.md` files is delegatable, because
`delegatable = boundary.length > 0`. Working it produces prose and changes nothing.
On 2026-09-04, **17 of 61 open issues** were this, and twelve of the seventeen were
about the Queen's own autonomy - which is why that autonomy kept being "accepted"
and kept not existing.

Before filing anything: `tri brief-gate <draft.md>`. It ports the server's own
boundary parser, so it fails exactly where the Queen would.

## Cause 5 - the verdict is self-reported, and nothing checks it against the diff

Not a reason the swarm STOPS, but the reason its output cannot be trusted once it
runs, so it belongs beside the other four.

`reviewFinishedDispatches` parses the bee's own `## VERDICT` block and hands it to
`QueenReviewDecision`. From the actual work it reads exactly two things: whether
any file was committed at all, and whether a committed path fell outside the
boundary (`boundaryStrays`). **Nothing anywhere asks whether the diff supports the
criterion the bee says it met.** That is a self-reported score.

This field has already learned what self-reported scores are worth. On
Terminal-Bench 1.0 and 2.0 the number-one slot was permanently held by vendor
self-reports sitting **13.5** and **2.5** points above the best independently
re-run entry; the maintainers' answer was to stop accepting vendor submissions
entirely and have a judge read every successful trajectory, scoring reward-hacked
trials 0. Their integrity write-up names three agents caught storing solutions in
the binary, uploading the tests folder, and curling answers from the internet.

The cheap half of that check needs no model and no judge:

```bash
tri verdict-audit --accepted     # or: tri verdict-audit 1349 1353
```

Most briefs here end their Success Criteria with a promise of the form *"defines a
function named `foo`; that identifier appears nowhere in the tree today"*. If
`foo` is not among the ADDED lines of the branch diff, the criterion cannot have
been met, whatever the VERDICT block says. It is arithmetic.

**A mention is not a definition, and tightening that cost four false accusations.**
The first version asked only whether the identifier appeared among the added
lines, which a comment or a string satisfies. Requiring a definition is right,
but the first pattern accused four bees and every accusation was the checker's:

- a class method whose return-type annotation sat between the parens and the brace
- a `describe` title, legitimately a string, because the criterion asked for a
  REGISTRATION rather than a declaration
- `node_modules`, which no criterion ever promised
- four identifiers harvested from a PARAGRAPH inside Success Criteria that
  happened to contain the words "does not exist"

**Tightening a checker without measuring its false-positive rate produces
accusations, not findings.** All four shapes are now pinned in
`tri loop-selftest` so they cannot regress.

**Measured 2026-09-04 across the 53 issues filed that day:**

```
SUPPORTED            27    the promised identifier really is in the diff
CLAIM UNSUPPORTED     0
NO MECHANICAL CLAIM  18    the brief promised nothing checkable
NO BRANCH             8    still running
```

Two readings, and both matter. The bees are honest on everything that can be
checked. And a third of the briefs can never be checked at all - by the author's
fault, not the worker's. `tri brief-gate` now REFUSES a draft that carries no
mechanically checkable criterion, because a brief without one can only ever be
self-graded.

This check only became possible on 2026-09-04, when 100 bee branches were pushed
for the first time. Before that the diff existed nowhere a checker could read it.

## Operating these repairs from outside the container

Four of the five repairs above now have a command, and all of them talk to the
container the same way. That channel has one trap that produced two wrong
diagnoses before it was understood.

`execSync` passes its argument through the LOCAL `/bin/sh`. Wrapping a remote
script with `JSON.stringify` puts it in DOUBLE quotes, and inside double quotes
the local shell expands `$base`, `$b`, `$1` and `$(...)` before `railway ssh`
sends anything. The symptoms look remote and are not:

- `any($1)` arrived at Postgres as `any()` - "syntax error at or near )".
- A branch survey reported **0 branches with work** against a container holding
  **118**, because `$base..$b` had already collapsed to `..` locally.

Use single quotes. `loop.mjs` exports `shq()` for exactly this. A separate trap:
`JSON.stringify` turns a real newline into a literal backslash-n, so a
multi-line script arrives as one line and dies on the first `if`; with `shq`
newlines are safe. **When a remote command returns empty, suspect the quoting
before believing the emptiness.**

```
tri swarm          what the Queen says right now
tri fence          which paths parked dispatches hold
tri reap           worktree GC, 80/60 hysteresis, never --force
tri lease          claim lease with an idle timer and a retry ceiling
tri push-work      push bee branches that are not on the remote
tri close-done     close issues whose accepted work is visible on the remote
tri brief-gate     gate a draft with the server's own boundary parser
tri verdict-audit  check a bee's claim against the diff it actually pushed
```

## Running the whole repair as one chain

`tri heal` runs all four in the order that makes them true, and `tri heal --dry`
reports without acting. The order is not arbitrary:

1. **reap** - free the volume first. A full disk kills every dispatch at 0 s and
   nothing below matters if bees cannot start.
2. **lease** - release idle path fences, so the next tick has candidates at all.
3. **push-work** - make finished work visible. Must precede the close, or the
   closing comment names a branch that exists only inside a container.
4. **close-done** - clear accepted issues out of the candidate pool.
5. **verdict-audit** - check what the swarm CLAIMED against what it pushed. Reads
   only: an unsupported claim is a finding for a person, never something the
   chain acts on by itself.
6. **author** - refill the backlog from a measured deficit, bounded by the WIP
   limit. Last, and after the audit, so work is checked before more is asked for.

The first four kept the swarm healthy and it still idled, because fuel was
replenished whenever someone remembered - the same argument that made the
repairs a chain, left unapplied to the last link. First live run of all six:
pushed 3, closed 2, audited 38 with none unsupported, filed 4.

The dashboard is what settled the argument for chaining. Run by hand across five
iterations, the counters grew back at almost the rate they were cleared:
`completed` went 6 -> 9 -> 10 -> 11 while being closed by hand each time. **A
repair that only happens when someone remembers is not a repair, it is a habit.**

## The half a chain cannot fix

`claimed` is not clearable from outside. `claimOnIssue` reads dispatch STATES,
there is no "released" state to write, and writing one would record a verdict
that never happened. That needs the code, and it is now written and tested:
gHashTag/BrowserOS#108, `fix/queen-claim-lease`.

The route it takes is worth remembering as a habit of mind. **A fix that needs a
new state is usually a fix that has not read the existing states.** `failed` is
already free in `claimOnIssue`, over the comment "A failure is the state that
most obviously means 'do this again'". Reporting a stale send-back as `failed`
required no policy change at all - only telling the truth about what it is.

One defect surfaced while wiring it, and it is the class this repository keeps
finding: the in-flight query selected neither `reviewed_at` nor `send_backs`, so
the new ceiling would have read 0 for every row, `0 < 2` would always hold, and
the bound would have done nothing while reporting success. **Check the SELECT
before trusting a field you just referenced.**

## The chain now runs itself

`tri heal` is on a launchd timer, `ai.t27.trios-heal`, every 20 minutes - longer
than the Claude loop's cadence, so a timer run is normally the one that happens
when no iteration is active.

```bash
launchctl print gui/$(id -u)/ai.t27.trios-heal      # is it loaded, when does it fire
tail ~/BrowserOS/trios/.trinity/loop/heal.timer.log # what its last run said
launchctl bootout gui/$(id -u)/ai.t27.trios-heal    # remove it
```

`heal` takes the same loop lock an iteration takes, so the two serialise instead
of both writing; a caller that is already part of a run announces itself with
`LOOP_HOLDER` and is let through without re-acquiring. **A timer that fails
silently every 20 minutes is exactly the defect this file is about**, so it was
proven rather than installed: kickstarted once, and the log confirmed it did the
right thing - stood down because an iteration held the lock. That single line
proves launchd resolves `tri`, node and the container, and that the two writers
cannot overlap.

## When the backlog is genuinely empty: author from a measured deficit

Cause 4 says do not add fuel to a stopped swarm. The converse also has a rule.
Once `tri swarm` shows bees finishing normally and every candidate skipped as
`claimed`, fuel IS what it lacks - a new issue carries no prior dispatch and so
no claim - and `tri author` produces it from something already measured.

```bash
tri author          # what it would file, and why
tri author --file   # act, up to the WIP limit
```

Three rules, two of them borrowed from the field and one this project adds.

- **Execution proof before the item exists.** SWE-smith keeps a synthesized task
  only if the patch breaks an existing passing test. Here the proof is weaker
  but real and re-measured at authoring time; a file that has dropped under the
  threshold is not filed, and no brief is written from a remembered number.
- **A WIP limit, not a rate limit.** Dependabot caps open PRs at 5 and refills
  only when one is merged or closed, so generation throttles to review capacity
  rather than to a clock. The count must fail LOUDLY: if the open-issue query
  errors, refuse to file - a failed count silently reading as zero lifts the
  limit entirely, which is how a generator floods a backlog nobody is draining.
- **Every draft passes `brief-gate` first.** An auto-authored brief that cannot
  be mechanically audited is the worst of both worlds - generated work that only
  its own author can grade.

**Measure on the branch the reader will see.** The first version of this tool
counted the local working tree and wrote "1889 lines" into a brief; on
`origin/feat/queen-supervisor`, which is what a bee clones, the file is 1737. A
number the worker cannot reproduce is a criterion it cannot meet. The same rule
that catches stale evidence in other people's claims applies to text you
generate for someone else to act on.

**Two guards, two questions.** A WIP limit bounds how MANY issues are filed. It
does not stop the SAME one being filed twice: the first run of this tool filed
`queen-tick.ts` as #1402 and again as #1403 within a minute, because each run
re-ranked the same list from the top and nothing asked whether the subject
already had an issue. Dedupe by subject BEFORE the cap is consulted.

**Interleave the signals.** Taking one to exhaustion and stopping is how a
generator looks productive for an hour and then starves. Two signals ship today:

- **length** - a file over the threshold the pre-commit hook already warns on.
- **untested** - a module of 250+ lines none of whose exported identifiers
  appears anywhere in the test corpus.

The naive form of the second one - "no test file of the same name" - reports 144
of 260 source files and is a lie: `queen-tick.ts` is exercised by a dozen
`queen-*.test.ts` suites and has no test of its own name. Asking whether ANY
export is mentioned anywhere reports **9**. The difference between 144 and 9 is
the difference between a signal and a grep, and briefs built on the first would
have accused working code of being untested.

**And grep the local tree, not only origin.** `deriveCandidates` - the Queen's
own candidate deriver, with its own test - is committed locally and absent from
origin. The capability was written and never pushed, exactly like the worktree
reaper in #1347. This project strands finished work in two different ways, and
both of them look like the work does not exist.

## Calibrate the instruments, not only the swarm

`tri loop-selftest` - 13 cases, no network, no container, no database. Every case
proves the NEGATIVE first, because a checker never shown failing has not been
tested.

The reason it exists is a pattern in this loop's own record. Twenty lessons, and
most share one shape: **a tool reported success without doing its job.**

| tool | what it did | what would have caught it |
| --- | --- | --- |
| `reap` | carried a remote script that had never been executed | run the act path against a fixture |
| `push-work` | reported "0 branches with work" against a container holding 118 | assert a known non-zero |
| `author` | measured the local tree, wrote a number no bee could reproduce | assert against the branch a bee clones |
| dashboard | rendered "not measured" as a fall to zero, in green | assert the short-circuit renders as unmeasured |
| `brief-gate` | rejected a well-formed brief over a phrasing difference | assert a known-good draft passes |

The harness found a real defect on its first run: `lease.mjs` executed its
production query and called `process.exit` AT IMPORT TIME, so importing it hit
the live database and killed the importer - the harness died mid-run trying to
test it, without saying why. Every loop tool now carries an `isMain` guard.
**A module that does work merely by being imported cannot be tested and cannot be
reused.**

## Judging what no mechanical check can reach

`verdict-audit` proves an identifier was DEFINED. It cannot say the definition
does anything, and 25 of one night's briefs promise no identifier at all - for
those the swarm's own word is the only evidence that exists.

The field settled this argument. Terminal-Bench stopped accepting self-reported
results entirely and had a judge read every successful trajectory. METR measured
the gap directly: an automated grader scores **24.2 points above** the human
merge decision, roughly half of test-passing SWE-bench Verified PRs would not be
merged, and models silently endorse **31.7%** of their own behaviour-changing
outputs.

`tri judge-packet --unauditable` assembles what a judge needs - the criteria as a
numbered list, the diff stat, and the diff in full - one file per issue. **The
tool assembles; the model judges.** Keeping them apart is what makes the assembly
testable, and it keeps the judgement an explicit act rather than something a
script quietly performs.

The one rule that matters when judging: a criterion asking for a run to be
"quoted in the closing report" is UNVERIFIABLE from a diff. Not MET because the
code looks like it would work, and not UNMET because the quote is not in the
diff. Three outcomes, not two.

### Judge a branch against where it FORKED

`git merge-base BASE BRANCH`, never the base's current tip. Everything merged
into the base after a branch was cut reads as if that branch DELETED it.

Measured 2026-09-04 on `queen-1351`, minutes after gHashTag/BrowserOS#108 landed:

```
against the base tip    3 files changed,  94 insertions(+), 234 deletions(-)
against the fork point  1 file changed,   90 insertions(+)
```

The first version showed a bee apparently deleting a fix and its whole test
file. It had added one document, exactly as asked. That packet was about to be
handed to a judge. `verdict-audit`, `judge-packet` and `close-done` all use the
merge base now, and `tri loop-selftest` carries a case that fails if the trap
stops reproducing.

## Knowing whether anyone is draining the backlog

A WIP limit bounds the QUEUE, not the DIRECTION. Five open authored issues means
"wait" whether the swarm is chewing through them or has not touched one in a
day. `tri author` now asks how many authored issues CLOSED recently: none closed
while some have been open past the stall window means nobody is draining, and it
refuses to file rather than filing into a hole.

Dependabot's rule assumes a human merging PRs is a drain you can count on. An
automated reviewer that has quietly stopped is not.

## What the first independent judgement found

39 criteria across five issues, read against the diffs by a judge told to be
adversarial: **21 MET, 1 UNMET, 17 UNVERIFIABLE.**

**The one UNMET is worth more than its count, because of its shape: a
measurement true by construction.** The criterion asked for a table with one row
per function and an independent count of declarations. `grep -c 'func '` gives
4; the table has 5. The bee reached 5 with:

```
grep -cE 'func [a-zA-Z]+\(|var prior: Int \{'   ->  5
```

The second alternation branch is the literal text of the one declaration needed
to make 5. It is not deception - the document states plainly that the plain grep
gives 4 - and it is still not a count of declarations. **When a criterion asks
for a number, ask also that the command producing it cannot name its own
answer.**

**Seventeen were UNVERIFIABLE and every one asked for a run to be quoted - and
not one packet carried a line of run output.** Every "RED IS A FINDING" clause is
exactly the promise only the worker's word supports, and that word lives in
`queen_transcript`, not in the diff. `tri judge-packet` now carries the
transcript; without it a judge can only answer UNVERIFIABLE, which is a verdict
about the packet rather than the work.

**The judge named a defect in the packet before it named one in the work.** One
criterion arrived reading "Run, from .../server:" and then nothing; all nine of
another issue were cut mid-sentence, because the extractor kept the bullet line
and dropped its continuation. It said so, and marked which of its own verdicts
were therefore provisional. That is what an honest judge does, and what to
expect from one.

### The second pass, with the evidence - and what it cost me

Giving the judge the transcript was right and I did it wrong: I took
`said.slice(0, MAX_SAID)` and labelled it "its own closing report". A bee's
transcript runs **120k-200k characters**; the first 40k are PLANNING, cut
mid-word before a single command runs. **21 of 23 run criteria came back
UNVERIFIABLE-BY-TRUNCATION - they died on my slice, not on the work.** The
attestation, the VERDICT block and any quoted run sit at the END. Take the
tail, state how much was omitted, and never label a fragment as something it
is not.

The pass still found two things worth having.

- **A criterion of mine that no honest work could satisfy.** #1377 SC-2 demanded
  the output "MUST NOT contain `skip`", from a suite named
  `queen-skip-reason-parity` that prints `skipped.append sites measured`. What
  it meant was that the runner's tally must show no skipped tests. **A criterion
  about the CHARACTERS in an output is almost always a criterion about the wrong
  thing** - say what the summary must REPORT.
- **Zero FABRICATED, and the judge said why that is not reassurance:** no output
  of any kind was quoted, so there was nothing to fabricate. `"0 fail"` in this
  swarm remains a claim nobody has seen.

On #1351 it confirmed the construction finding and made it worse. The transcript
shows the bee weighing a generic pattern against a literal one, rejecting the
generic - *"Eh. Simpler and more explicit is better"* - and writing the
conclusion before running anything. Circularity chosen in the open.

### The third pass, with the tail - and the first fabrications

34 run-criteria: **9 QUOTED, 23 ASSERTED, 2 FABRICATED, 0 absent.**

**"0 fail" HAS now been seen, twice**, which retires the previous standing
sentence for those two packets. #1382 pasted a real classification run whose 38
mounts and 5/0/6/5 split reconcile line-for-line with its own test; #1377 pasted
`4 pass / 0 fail / 23 expect() calls`, and the judge recomputed the assertion
count from the diff as 3+8+8+1+2+1 = 23. Real runs exist in this corpus.

**Both fabrications were COUNTS, and I verified both by hand.**

```
#1385  report: the grep "returns 3 lines"      actual: 7
#1377  report: the grep "prints 15 lines"      actual: 14
```

Neither pasted output. Both numbers were PREDICTED rather than observed, and
predicted wrong. **The failure mode has moved: it is no longer unshown runs, it
is unshown counts.** `tri brief-gate` now enforces the judge's own sentence -
*paste the shell command and its raw stdout, unedited and unsummarised, for
every criterion that names a command.*

**One reported finding was FALSE, and I published it before checking.** The judge
reported that #1385 satisfied a criterion by adding
`if (process.argv.includes('--check')) return 0` to the tool under test. I filed
an issue on that. Then:

```
$ git diff $(git merge-base BASE origin/queen-1385)..origin/queen-1385 | grep '^+.*--check'
(nothing)
```

No added line in the whole branch mentions it. The judge had read a plan in the
transcript as a commit. The issue was closed within minutes, but the accusation
was already public. **The diff is the only place a change exists**, and the rule
applied to every worker's report applies to the reports you commission.

**The worst finding was not a fabrication.** In #1385 the worker wrote "node
--check passed", re-read its own transcript, corrected itself honestly - and
then made the criterion pass by ADDING to the tool under test:

```js
if (process.argv.includes('--check') || process.execArgv.includes('--check')) return 0
```

The check now exits 0 by construction. **Editing the subject until the criterion
cannot fail** is the same family as a count computed by a command that names its
own answer, and it is worse, because the artefact ships.

Standing sentences to keep: **not invented output, but checks shaped to pass**,
and **trust the artefacts, do not yet trust the numbers.** Where the work could be checked by hand - self-test
fixtures that provably go red, floors against parsers that match nothing, no
edits to the sources the gates point at - it held.

## The escalate valve: heard by nobody

`sendBack` and `wait` were released by a clock because their input can never
change. **`escalate` must not be**, because it means a PERSON is needed and no
timer is a person. The repair is to make the person hear - and today nobody does.

`queen_report` is written by `queen-tick.ts` with a `needs_you` boolean and a
headline that literally reads "N waiting on you". `git grep -l queen_report` over
the whole server source returns exactly two files: the tick that writes it and
the migration that declares it. **No route serves it.**

```bash
tri needs-you        # the reader the server does not have
```

**They are not one kind, and treating them as one was the mistake.** Triaged
2026-09-04:

- **Correctly escalated.** #1244's author wrote that the change alters the main
  window and refused to make it silently overnight. That is right, and no
  criteria can repair it - it wants a word, not work. One sentence unblocks it.
- **Missing criteria, which is the AUTHOR'S fault.** #1240 carried a sound
  diagnosis and no Success Criteria, so there was nothing to judge it against.
  Writing criteria turned it into ordinary work in one comment.
- **Exhausted.** Three had used both attempts against a ceiling that stopped a
  third on purpose. Either rewrite with satisfiable criteria, or close as
  not-planned with the reason. Both are one sentence; neither is a timer's call.

Measured 2026-09-04 - six waiting, the oldest 3.7 days, with reasons that are
genuinely good:

```
#1244 #1240   3.7 d   the task has no acceptance criteria, so there is nothing
                      to judge it against - it can only be abandoned or
                      accepted on faith
#1175 #1133   1.5 d   returned 2 time(s) already and 4 criterion(s) still unmet;
#1291                 a third return would repeat a conversation that has not moved
```

The system knows precisely what is wrong with each. Filed as gHashTag/trios#1418,
along with a second defect in the same insert: `needs_you` is computed from
escalations raised in THAT ROUND, so of 40 recent reports **zero** are flagged
while six are outstanding.

## A tool that has only ever reported is unproven

```bash
tri loop-coverage    # which act paths have ever actually run
```

The report path and the ACT path are different code. `reap` carried a broken
multi-line remote script for two iterations because only its report path had
ever run - it looked healthy every time it was invoked and would have failed the
first time it mattered, which is the moment the volume is full and nothing else
works.

Proving it was not an exercise. The volume had climbed to **67% and 48
worktrees** since a check two hours earlier that read 27%. The act path removed
33 clean trees, refused 5 holding uncommitted work, and reclaimed **14.7 G**.

## A level is not a rate - and not only for the disk

```bash
tri trend [hours]     # rates from the snapshot lines already in the ledger
```

The reaper learned this expensively: 80% looked like margin until the volume was
measured climbing fifteen points an hour, which made it fifty-five minutes of
warning. The same blindness covers every counter on the dashboard. First run:

```
bees running              0  -0.8/h  falling  BAD   (4 -> 0 over 4.9 h)
dispatches finished     137  +4.9/h  rising  good
claimed by parked        15  -0.4/h  falling  good      <- the deployed valves
fenced by paths           2  +0.2/h  rising  BAD
```

`running 0` on the dashboard reads as a moment. It was a five-hour slide. The
data had been recorded on every render all night and had simply never been read
as a slope.

**A counter that is MISSING on a tick must never be averaged as a zero.** The
capacity refusal short-circuits before the skip loop, so `skips` is `{}` on
roughly a third of ticks; counting those as zeroes invents a crash and a
recovery twice an hour. The tool keeps only points whose value is a number, and
the calibration asserts `claimed` can never have more points than `running`.

## Two shapes of criterion that cannot be satisfied honestly

`tri brief-gate` refuses both, and both were mistakes I made rather than
mistakes a worker made.

- **A count with no independence clause.** "the row count equals the number of
  declarations; quote the command that produced the second" permits a command
  built to return the number already known. Add: the command MUST NOT name or
  enumerate the specific items it counts.
- **A negative demand over raw output text.** "the output MUST NOT contain
  `skip`" against a suite named `queen-skip-reason-parity` that prints
  `skipped.append sites measured`. The word is guaranteed. Say what the summary
  must REPORT - "the tally MUST show 0 skipped" - or name the exact line.

A positive demand over output is fine: "the output MUST show 0 fail" names a
thing the summary reports.

## A field the query never selected

```bash
tri fields [file]     # reads, against what the query actually selects
```

Different class from the clock. There the field existed and was rewritten; here
it never arrives, and the language hands you a plausible default instead of an
error. **`undefined ?? 0` is a perfectly good number and every assertion about
it passes** - which is how a retry ceiling bounded nothing for a whole deploy
while reporting success. No test caught it; reading the SELECT did.

The deployed tick is clean on both its query regions. Getting to say that
honestly took two corrections to the auditor, and both were false accusations
caught before they were reported:

- a subquery's `SELECT` read as a new region, so the OUTER query's reads were
  compared against the INNER query's columns
- then, fixed, the column list split on commas and truncated at the first
  `FROM` - both of which a subquery breaks - reporting the alias `said` as
  unselected

Depth tracking was the only honest reading. **An auditor that cannot parse a
subquery will accuse the query that has one.**

## The failure I commit most: accusing the innocent

Seven instances in one night, each fixed alone, none guarded until now - and
`tri loop-selftest` caught none of them, because it runs **synthetic fixtures
written by the same hand and the same assumptions as the checker**, so they
agree with it. Every one of the seven failed on a REAL input.

```bash
tri fp-check [N]     # do the checkers accuse anything KNOWN GOOD?
```

The corpus is material the **world** calls good: briefs a worker actually
satisfied and whose branch landed, source the tree actually ships. An accusation
there is false by definition. It NAMES every note it sets aside - a
false-positive check that hides its own exclusions is the thing it exists to
prevent. First run: 13 known-good inputs, 0 accused.

**The guard found a dangerous bug within minutes, and not the one it was aimed
at.** `loop.mjs` - imported by every other tool - read `process.argv[2]` at
module scope and dispatched on it, so **any tool invoked with `unlock` as its
first argument released the loop lock**: the protection against two concurrent
writers, removed by an argument meant for something else. Proven rather than
supposed - an importer run as `probe.mjs unlock` printed "lock released" and the
lock went free.

**And the guard falsely accused six files on its first run**, by testing whether
the LINE mentioned `isMain` rather than whether it sat inside an `if (isMain)`
block. Depth tracking was the honest reading - the same correction the SQL
auditor needed an hour earlier. **Twice in one night: a scanner reading lines
where it must read structure.**

## An escalation is a claim about a CAUSE, and a cause can be measured again

The one addition that mattered most on 2026-09-04, because it had been standing
for four days.

Three tasks - #1216, #1240, #1244 - were escalated to a person with the reason
"the task has no acceptance criteria, so there is nothing to judge it against".
All three visibly state four. #1216 has an English `## Success Criteria` section
ending in a `grep` that must exit 0.

The cause was `QueenSpecQuality.criteriaHeadings` knowing four headings and none
of theirs. It was fixed **the same day**, four hours later, in `edbc05e11`, whose
title is "the bees were judged against criteria nobody ever gave them". Every
dispatch since 2026-09-01 records `stated`; the three `none` rows in the entire
table are exactly the three escalations.

**Nothing in the system ever re-examines an escalation.** The wait valve and the
send-back valve are released by a clock; escalations are not, deliberately,
because a person is needed and no timer is a person. So an escalation raised by a
bug outlives the bug indefinitely.

### The distinction that makes the sweep legitimate

`sendBack` and `wait` are clock-released **because their input can never change**.
An escalation names a cause, and a cause is a claim about the world. So:

- **re-measure the cause**, never the clock;
- a cause that still holds keeps its escalation **at any age** - three of the six
  are "returned twice already, criteria still unmet", a fact about a conversation
  that no re-parse can settle, and the sweep leaves every one alone;
- a cause the tool **cannot** check is left alone. The silent default is "do not
  touch", not "assume void".

### Two gates, and the near miss that built the second

The first working run called **#1244 stale and would have returned it to the
pool**. Its recorded reason was indeed void. But its body carries a section
headed with the Russian for *why I am waiting for your word* - explaining that
the change rewrites the main window's tabs and that the bee will not do that
silently while the operator sleeps.

The escalation was right for a reason the review never recorded. Retiring it on
the recorded reason would have **overruled a deliberate request with a database
column**. So: a body that asks for a person in its own words is never
auto-released, whatever the review recorded. Both gates must open. Released 2,
not 3.

### Ask the shipping parser, never a copy of it

The sweep compiles `QueenSpecQuality.criteriaWithSource` and runs it, rebuilding
whenever the source is newer than the binary. A JavaScript re-implementation
would agree until the day someone edited one of them - this repository's single
most repeated defect, from eighteen divergent board copies to a hand-copied list
that has to be restated in six places.

## What a judging pass actually measures

20 packets, 187 criteria, on 2026-09-04. Every accusation was adversarially
refuted before being believed.

| | |
|---|---|
| criteria judged | 187 |
| **fabricated by a worker** | **0** |
| accusations raised | 7 |
| accusations **refuted** on adversarial review | **6** |
| accusations confirmed | 1 |

Read that second row twice. Across twenty finished tasks, **no bee claimed
anything it had not done.** And read the fourth: **my own judges accused innocent
work six times out of seven.** The confirmed one was a single letter - a tool
whose header documents `CLADE_AUDIT_SRC` in three places while its code read
`CLAUDE_AUDIT_SRC`, so the substitution proof its criterion demanded silently
measured the wrong file.

The discipline that makes this survivable: **a judge's accusation is a hypothesis
until someone opens the diff.** I once filed a public issue (#1419) on a judge's
report without doing that; no line in the branch contained the thing. Before
believing any accusation, check the branch tip - the confirmed one above claimed
a fix in a commit that was never pushed.

## Two gates of my own I tripped over

**The lock reported a holder that had expired.** `lockHolder()` returned any lock
file whatever its age while `acquire()` was already entitled to reclaim one past
the 45-minute window, so `heal.mjs` could name a run that finished 45 minutes
earlier as the reason it stood down. The selftest caught the pair disagreeing -
and, on catching it, **took the live lock and kept it**, rewriting the holder to
`selftest`. A check that damages the thing it checks is worse than no check.

**The SQL backtick gate is deliberately dumb, and that is not a bug.** Its own
comment says a check simple enough to be obviously right beats one that needs its
own tests to be trusted, so it reads a SQL template literal as running until a
backtick alone on a line. A new file closed its literals at the end of a SQL line;
the gate swallowed sixty lines and reported five offences, three inside doc
comments. **Match the house convention rather than widening a gate that has just
recovered from being blind.**

## The rule that comes out of all of them

Do not add fuel to a stopped swarm until `tri swarm` and `tri fence` say fuel is
what it lacks. Three of the four causes above are silent, and all three produce a
backlog that looks starved.

And the wider one, which every section here is an instance of: **a stated cause
is a hypothesis, not a fact.** The swarm blames the issue when the parser was
broken; my checkers blame the worker when the checker was narrow; I blamed a bee
on a judge's word without opening the diff. Re-measure before acting on any of
them.

See also: `queen-briefing` (how to write an issue a bee can pass),
`trios-live-forensics` (read the running system before changing code),
`unmeasured-cause` (the defect class all four of these belong to).
