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

## Filing N tasks does not give you N workers

The measurement that closes the "the backlog is empty" story, and it was my own
mistake that produced it.

Four issues were filed to fill four worker slots. Two of them named
`trios/agent-server/apps/server/src/api/services/queen-tick.ts` in their
Boundary. Two bees may not write one file, so the scheduler refused one with
`fileConflict` - correctly - and the fourth slot stayed empty while the backlog
looked perfectly healthy.

### The conflict belongs where the work is CREATED

| system | what it does |
|---|---|
| Dependabot | **groups** updates that would open conflicting PRs, rather than opening them and letting the merge fail |
| Nx, Turborepo | a task graph keyed on file inputs; two tasks run in parallel only when their input sets are disjoint |
| Kubernetes | pod anti-affinity - the *scheduler* is told what must not land together, at admission |
| Bazel | inputs and outputs are declared; the executor will not run two actions writing one output |

Every one of them settles the conflict at admission, not on collision. The
Queen's scheduler already refuses correctly; nothing upstream was choosing work
that could coexist. `tri holds` shows what is held right now, and it found a
real double claim the first time it ran: `rings/SR-02/ChatViewModel.swift` held
by BOTH #1133 and #1240.

**Paths compare component-wise, never as strings.** `rings/SR-0` is a string
prefix of `rings/SR-00/Queen.swift` and is not a directory containing it. This
project has already shipped that defect once.

### Detector variety is a throughput input

The pool emptied with the swarm at zero bees and it looked like a broken loop.
It was not. `author.mjs` had found fourteen real deficits and could file against
none of them - every one already had an issue, and those issues were the ones
parked at the retry ceiling. Two detectors cannot feed four workers.

The third was L3: repository law, broken in 86 server files by 2690 characters,
almost all box drawing in comment rules. That is the right shape of fuel -
**measurable** by one grep, **disjoint** at one file per task, and
**renewable**. A file whose non-ASCII is in live code is skipped, because
rewriting a user-facing string is a change of behaviour and not a cleanup.

## My gates keep being narrow in the direction that refuses honest work

Three real cleanups were refused because `brief-gate` knew exactly ONE shape of
mechanical proof: an identifier the worker must define. A cleanup defines
nothing new, so no honest draft could ever pass.

A command over a path the Boundary reserves, with an exact expected output, is a
property of the **tree** rather than of the report - and is harder to fake than
an identifier, because the reader runs it against the branch instead of reading
what the worker said. The demand stays strict: exact output, and the path must
be one the Boundary actually holds.

This is the fourth time a gate of mine has refused something good. The pattern
is always the same: the rule encodes the ONE example I had in front of me when I
wrote it.

## Two ways a checker lies about itself

**A fixture that swears an identifier appears nowhere falsifies its own premise
the moment it is committed.** The selftest's fixed name existed five times in
the tree once the file was saved, and `brief-gate` did exactly its job and
refused the draft. It mints the name per run now.

**A checker must not count a TRUE report as a false accusation.** `fp-check`
flagged `NEVER ACTED`, which is the most valuable line `coverage.mjs` prints -
it is how the reaper's untested branch was found. Counting it as a false
positive would have made every newly written tool look guilty until its first
act, and taught me to ignore the checker.

## The WIP limit was on the wrong column, and that is why the swarm idled

The measurement that finally reached four bees of four, and it corrects what I
wrote here one round earlier.

I had concluded that **review latency** bounded throughput. It does not. Measured
over 119 dispatches:

| | |
|---|---|
| review latency, finished -> verdict | **p50 0.8 s** |
| bee runtime, dispatched -> finished | p50 792 s |
| dispatches in two days | 120 |

The review is instant. What bound throughput was the author refusing to file:

```
open queen-authored: 5   -> "at the WIP limit", room 0
  of those dispatched at least once: 4
  UNSTARTED, the actual queue: 1
```

**Kanban limits work IN PROGRESS and never the backlog.** Dependabot's
`open-pull-requests-limit`, which the rule was copied from, exists to protect a
HUMAN reviewer's capacity - and here the reviewer answers in under a second.
There was no human to protect and nothing to throttle. The limit had been placed
on the backlog column, where limits do not belong.

**Little's Law gives the target.** Four workers at a 792 s service time consume
roughly 18 tasks an hour; the author fires about four times an hour. So the
queue must hold enough that a worker always finds something - `workers + 1` -
and that is a DEPTH, not a census of everything open. An issue with a dispatch
row is in progress, not queue.

Room went 0 -> 4, four issues were filed, and the swarm held **4 of 4 across two
consecutive ticks** for the first time.

### The three things that had to stay

- a count that could not be TAKEN still returns null and still refuses, because
  zero LIFTS a limit rather than holding it;
- the stall guard still reads the oldest OPEN issue, not the oldest unstarted
  one: an issue dispatched six hours ago and still not closed is exactly as much
  evidence that the drain has stopped. The guard asks "is anything finishing";
  the queue depth asks "is anything starting";
- its message prints both numbers now. It once printed a count of open issues
  while the variable behind it held the queue depth - a report that disagrees
  with its own measure is how a number gets believed for the wrong reason.

## An advisory warning became a hard blocker in a shell it was not written for

Four bee branches carrying finished work could not reach the remote. The reported
reason was the branch name. The real one was the dialect.

`lefthook.yml`'s branch-name check used `[[ ]]` and `=~`, which are bash. The
worker container runs hooks under `sh`, where dash answers
`Syntax error: "(" unexpected` and the non-zero exit takes the push with it. The
check contains **no `exit 1` anywhere** - it was written to WARN.

So a piece of advice became the thing that stopped finished work from being seen,
which is this project's oldest recorded defect wearing a new face: 63 branches,
1321 files, 2 pushed.

Two repairs, and both were needed. The rule is now POSIX `case`, ends in an
explicit `exit 0` so no future edit can make advice fatal by accident, and knows
`queen-<issue>` - a warning that fires on every branch the swarm creates is
noise, and noise teaches people to ignore the warning that matters. And the tool
pushes with `--no-verify`, because the branches it publishes were written days
ago and carry their own copy of the rule, and because a pre-push hook is the
AUTHOR's check run on the author's machine - a third machine making finished
work visible proves nothing by running it.

## When the bees sleep, look at the machinery around the Queen, not at her

Asked twice in one night why only one bee was running. Both times the Queen was
behaving correctly and refusing correctly. Four causes, all outside her, all
measured.

**The chain was failing from its own timer while looking healthy.** Every
railway-calling step - reap, lease, push-work, close-done - failed on every
timer run with `Must provide project when setting service or environment`, while
the read-only steps passed. So the summary read mostly `ok`, nothing was pushed,
nothing closed, no fence released, and the swarm moved only when the chain was
triggered by hand. `railway ssh --service X` resolves the project by walking up
from wherever it runs until it finds a linked directory: fine from a shell a
person sits in, useless from launchd. Name the project explicitly.

**The refill was the LAST link.** `author` - the one step that decides whether
four workers have anything to start - sat behind five read-only steps whose
entire output is something for a person to read later. Everything that FREES the
swarm must run before everything that only REPORTS on it.

**The chain could outlive its own cadence.** Eleven steps at a 10-minute
per-step timeout is 110 minutes worst case against a timer firing every 10. One
run held the lock for 21 minutes - 6.5 of them assembling 31 judging packets -
and every fire during it stood down. A chain that can outrun its cadence
schedules its own outage. Give the CHAIN a deadline, skip rather than truncate,
and name what was skipped.

**Accepted work that is never closed strangles authoring.** `completed` reached
21: twenty-one issues whose work the Queen had accepted, still open, still
holding their boundaries - so the disjoint selector could find no free paths and
the author filed almost nothing. The pipeline is push -> close -> release ->
file, in that order, and skipping the first step disables the last.

## The laptop fills too

`git worktree add` failed mid-checkout with `No space left on device` at 100%
full, while `reap.mjs` reported the container volume healthy - which it was.
Eight PRs in a night is eight 205 MB checkouts, one of them 2.4 GB with
node_modules, none removed after merging.

`reap-local.mjs` removes a worktree only when its HEAD is already contained in
the base AND the tree is clean. That rule is safe without knowing who created
the tree: a merged, clean worktree holds nothing that is not already in the
repository. Never `--force`; a dirty tree is somebody's unfinished thought.

Two lessons it learned about itself, both about ORDER:

- it priced every worktree with `du` before classifying any, spending its whole
  budget measuring things it would never touch;
- it asked `git status`, which walks the working tree, before
  `merge-base --is-ancestor`, which is two ref lookups - and an unmerged tree is
  kept whatever its state, so its dirtiness was never worth asking.

**Ask the cheap question first, and only price what you might actually take.**
It timed out twice before every shell call was bounded. A step that can hang for
ever hangs the whole chain.

## A rate over a window that has not finished is not a rate

The worst reporting error of this whole run, and it was mine.

I measured a three-hour window and reported: **17% of dispatches accepted, 33%
sent back, 28% answered wait, 50% got no judgement at all.** I called it the
dominating defect of the system, wrote it into this skill, and offered it to the
operator as the thing to work on next.

The window was still in flight. Most of those rows simply had no verdict YET -
`wait` and a null verdict are what a dispatch looks like while it is being
judged, not what it looks like when judgement is done. Measured again once the
same window had settled:

| window | accepted |
|---|---|
| as I reported it, mid-flight | 17% |
| the same window, judged | **80%** |
| the following three hours | **96%** |

The swarm was healthy and I called it broken. The fix is not subtle: **filter to
work that has FINISHED, and print how many were excluded**, so a reader can see
the denominator rather than trust it. `tri verdicts` does both and says in words
that an unfinished window has no rate yet.

### What survived the correction, and what did not

The transcript evidence was real and is worth keeping: #1429 discussed all four
of its criteria in prose - "Criterion 4 ... Met." - then wrote a VERDICT block
of TWO lines, and got `wait`. #1427 the same; #1430 three of four. The accepted
ones wrote exactly one line per criterion.

So moving the block to the FRONT of the last message is still right - the only
machine-read part of a 25-35 kB report sat where a turn that runs short loses it
first. But its justification is "a wait costs six hours per occurrence", not
"most work fails". Getting the reason right matters even when the fix is the
same, because the reason is what decides the NEXT thing to build.

## The catalogue: every reason the swarm stands still

Asked four times in one night, answered by hand four times, differently each
time. None of these is guessable from `RUNNING 0`, and several look identical
from outside - a held boundary, an unclosed issue and an empty queue all present
as "nothing to choose". `tri why` checks them in this order and stops at the
first that explains what is seen.

| # | cause | how it looks | what actually fixes it |
|---|---|---|---|
| 1 | the supervisor is unreachable | everything is unknown | `railway logs` |
| 2 | the scheduler is off | no round ever starts | turn it on |
| 3 | nothing is wrong - workers are busy | | `tri verdicts` - load is not health |
| 4 | a run holds the loop lock | every timer fire stands down | check the pid; it expires at 45 min |
| 5 | the disk is full | dispatches die at 0 s | `tri reap-local --reap` |
| 6 | the queue is empty | "nothing to choose" | `tri feed --act` |
| 7 | accepted work never closed | "nothing to choose" | `tri push-work --push && tri close-done --close` |
| 8 | candidates all claimed | "nothing to choose" | `tri unpark && tri lease` |
| 9 | boundaries collide | `fileConflict` | `tri holds`, and file disjoint work |
| 10 | issues are not delegatable | `missingBoundary` | give them a Boundary and criteria |
| 11 | the detectors have run dry | the author files nothing | widen a detector, or add one |
| 12 | **the workers cannot BEGIN** | identical to a healthy idle swarm | read `outcome` on a dispatch that died in under 5 s |

### The twelfth is the one no aggregate could ever show

Asked a fifth time why the bees were idle, and this time I had broken them
myself.

```
Queen tick decided  chosen=1470  refusal=null  candidates=34
Queen tick decided  chosen=1470  refusal=null  candidates=34
```

The same issue chosen in consecutive rounds, one worker of four, and NOTHING in
the skip summary wrong. The dispatch row said it plainly:

```
git fetch failed: error: cannot update the ref 'refs/remotes/origin/queen-1329':
unable to append to '.git/logs/refs/remotes/origin/queen-1329': Permission denied
```

`push-work.mjs` enters the container as **root**. Every ref it updated left a
reflog file owned by root, and the worker runs as `bee`, which cannot append to
them. **112 such files.** Every new bee died at `git fetch`, instantly, for
hours. The tick chose correctly, dispatched correctly, and recorded the failure
that nothing was reading.

**A worker that cannot BEGIN looks exactly like a healthy swarm with nothing to
do.** No count distinguishes them. The only place the reason exists is the
`outcome` column of the dispatch row, and reading it is now the twelfth check.

The tool that maintains the fleet must give the repository back: ownership is
restored after every push, read from `.git` itself rather than assumed.

**A permanent, correct skip is not a cause.** #380 and #957 each declare in
their own body that no worker can start them. They carry a `not-a-task` label -
machine-readable in a way prose is not - and the diagnosis subtracts them.
Reporting a true and permanent fact as the reason the swarm is idle is the same
mistake `fp-check` made counting NEVER ACTED as a false accusation.

**An undiagnosed idle swarm exits 2, not 0.** Silence must never read as health,
and a cause this tool does not know is worth ADDING to it rather than diagnosing
by hand a fifth time.

## Feeding is not auditing, and must not queue behind it

The chain takes 480 s of its 600 s cycle; four workers drain the queue in 13
minutes. The audits are worth running and are not worth making the workers wait
for. `tri feed` is the three steps that decide whether a worker has anything to
start - push, close, author - on a cadence of their own, taking the same lock so
the two never write at once.

## A detector with a finite corpus is a detector that stops

The L3 detector ran down to FOUR candidates across all three signals. It covered
`apps/server/src`; the same law governs the whole repository. Widened to `apps`,
`packages`, `scripts` and `tools` it went 44 -> 111 usable files, and the
backlog from 4 to 71.

**Generated files are refused, by path AND by the marker the generator writes.**
`packages/cdp-protocol` alone is 114 files opening with "AUTO-GENERATED from CDP
protocol. DO NOT EDIT." Filing against them would have been 114 tasks a correct
worker must refuse, and L0 says a diff that changes a generated file is itself a
defect. The marker is only believed near the TOP: a file that mentions generated
code two hundred lines down is not generated, and refusing it would shrink the
corpus in a way nobody would notice.

## Two ways a batch takes itself down

**A step killed by a timeout is not a step that failed.** Reporting it as FAILED
sent me hunting a bug in `close-done` that did not exist. Being slower is not the
failure; being cut off is - and what a half-run step did before the cut still
stands.

**`git push` exits non-zero when ANY ref is rejected, and push-work pushes a
batch.** One branch whose remote history had diverged made `execSync` throw
before the reporting the tool already had, so NONE of the other branches reached
the remote. That is the exact defect the tool exists to fix, committed by the
tool. A partly-rejected push is an outcome, not an exception.

## Load is not health, and health is not value

The swarm looked perfect by every measure I had built: **4 of 4 running, 100%
acceptance, zero unjudged.** And all forty of the last authored issues were one
thing - replacing box-drawing characters in comments.

```
the last 40 authored issues, by KIND
  ascii cleanup   40  100%  #################################
```

Goodhart in miniature: "keep the workers busy" became the target and produced
busy workers on the cheapest available work. **Not one of load, acceptance,
queue depth or latency could see it** - they all count TASKS, and a monoculture
is invisible to anything that counts tasks rather than kinds.

`tri mix` counts kinds, and exits 3 when one is more than four fifths of the
backlog.

### The cause was not what I first assumed

I read it as an exhausted corpus - ascii had 111 candidates, untested 9, length
5, so the big one wins. Wrong. The `untested` template had been failing
`brief-gate` the whole time:

```
!! a criterion asks for a count ... but does not require that command to be independent
!! 2 criterion(s) name a command but none asks for its raw output
```

So the only detector that COULD file was the cheapest one. **Fifth time one of my
own gates refused honest work, and the first time it silently shaped what the
swarm did for a day.** A gate that refuses is loud; a gate that refuses one
PRODUCER while another keeps working is silent, and shows up as a preference.

### Three repairs, and one refusal to claim

- no detector may take more than half a round - a corpus of 111 and one of 25
  are not equally urgent, and the larger must not win by being larger;
- the untested bar drops 250 -> 120 lines: at 250 the tree holds 9 such modules
  and all 9 were already filed, so the bar was set by where the fuel ran out
  rather than by what deserves a test;
- the template now carries the independence clause and demands raw stdout.

And the refusal: the verdict-first brief has **n=3 after the cut against n=67
before**. That is not a measurement, and reporting it as one would be the same
error as the 17% figure - a rate over a window that has not happened yet.

## Finished, accepted, closed - and never in the branch

The largest single gap found in this whole run, and every metric was blind to it.

**174 queen branches on the remote. FIVE contained in `feat/queen-supervisor`.**
The other 169 all carried a real diff; not one was empty against the base.

The swarm ran at full load for a day, the Queen accepted the work, and
`close-done` closed the issues on the strength of a branch **existing**. A closed
issue whose code is not in the branch is a false statement about the repository,
and the loop had been making 169 of them.

This is the oldest defect in this project wearing its third face. First the work
never left the container. Then it reached the remote and stopped there. Now it
reaches the remote, the issue closes, and the code still stops there.

`tri land` merges only a branch whose issue is CLOSED, only when `git merge-tree`
says it applies cleanly, only into the supervisor branch, a bounded number per
run, never forcing and never deleting - the branch is the evidence that the work
happened.

### "Merged" is three different questions, and I got two of them wrong

| question | right for | wrong for |
|---|---|---|
| `merge-base --is-ancestor` | a real merge | **a squash**, for ever |
| `git diff BASE...branch` | nothing here | three-dot measures from the divergence point |
| merged tree == base tree | **everything** | - |

A squash merge writes a NEW commit, so the source is never an ancestor. Asking
ancestry made this tool land **the same five branches four times** - twenty pull
requests, fifteen commits that changed zero files. The tell was there from the
second run: *"landed 5 of 5"* then *"146 still waiting"*, unchanged. I read it on
the fourth.

Comparing the merged tree with the base tree is route-blind: real merge, squash,
cherry-pick, or a change somebody applied by hand all give the same tree.

### So the lesson is mechanical now

**A count that does not move after a successful act stops the tool.**

```
REFUSING to continue: the count did not move after a successful merge.
Fix the measure, not the batch.
```

That guard caught a real bug on its *first* run - it was re-measuring against a
local ref that had not been told about the merges. Re-measure against a freshly
fetched remote, or the comparison proves nothing.

`reap-local` needed the same repair: a worktree whose work landed by squash
looked unmerged for ever and was never reaped, which is how a disk fills while
every branch on it is already in the base.

### Three times in one hour, one shape

An **outcome treated as an exception**:

- `git push` exits non-zero when any ref is rejected - one diverged branch took
  the whole batch down;
- a step killed by my own timeout was reported as FAILED;
- `git merge-tree` exits non-zero **on conflict**, which is its answer - reading
  it as a failure made every real conflict say "the merge could not be computed".

## Close what LANDED, not what was pushed

The root of the 169. `close-done` closed an issue when its branch existed on the
remote - so the pipeline was **push, then lie**. It now asks the only question
that survives a squash (would merging change the base at all?) and refuses
otherwise, naming the command that fixes it.

The chain and the fast feed both run **push -> land -> close**, each step the
precondition of the next.

### The deadlock I built in the same hour

`land` took only a CLOSED issue. `close-done` was changed to close only LANDED
work. So an issue the Queen had **accepted but not yet closed** could move in
neither direction: land refused it for being open, close refused it for not
having landed.

Two rules, each defensible alone, that together said **never** - and the result
would have looked exactly like a healthy quiet pipeline. Nothing errors, nothing
warns, the counts simply stop moving.

**"Closed" was only ever a proxy for "the Queen accepted this".** Ask the thing
itself: a dispatch whose `review_state` is `accept` is accepted, whatever the
forge says about the issue. Landable went 49 -> 68 the moment the proxy was
dropped.

> When two guards each refuse for a good reason, check what is left that can
> still pass. A proxy is where deadlocks come from, because a proxy is true
> *most* of the time and nobody notices the gap it leaves.

### A test that pins a rule must be re-aimed when the rule is wrong

One selftest case read *"it never lands an OPEN issue"* and failed the moment
that rule was corrected - it was pinning the deadlock. Re-aim it deliberately,
in the same change, or a test becomes an argument for keeping the bug.

## Work that CAN proceed must never be held hostage by work that cannot

Four times in one round, the same shape:

| what happened | how it looked |
|---|---|
| `git push` exits non-zero when ANY ref is rejected | one diverged branch, and none of the batch reached the remote |
| a step killed by my own timeout | reported as FAILED, sending me after a bug that did not exist |
| `git merge-tree` exits non-zero **on conflict** | every real conflict said "the merge could not be computed" |
| `slice(0, BATCH)` off a newest-first list | 35 clean branches waited behind 10 stuck ones, landing ONE per run |

The first three are an **outcome treated as an exception**. The fourth is the
same idea in a queue: take the first N and the blocked ones at the head consume
every slot. Fill the batch with what can actually proceed, and bound the scan so
a wall of conflicts does not become a full survey every run.

## Cause thirteen, added the round after I created it

`close-done` now closes only work that has LANDED. That makes landing
**load-bearing**: if it stops, nothing closes, every accepted issue keeps holding
its boundary, and the swarm starves behind a wall of its own finished work.

**The failure is silent, because refusing to close is the CORRECT behaviour of a
healthy `close-done`.** Every repair that makes a step depend on another step
creates one of these, and it is worth adding the cause the same day.

## Two ways a diagnostic lies while being right

**A check that FIRED is never `ok`.** Under `--all` it printed
`ok  the landing pipeline is moving (also true)` for a check that had just
detected a stalled pipeline. The word `ok` is the first thing an eye lands on.

**An all-clear must be scoped to NOW and name what is coming.** It said "nothing
is wrong" while all ten remaining branches conflicted. That does not make a busy
swarm idle today - it makes it idle in an hour. It reads *"nothing is wrong RIGHT
NOW"* and carries an `AHEAD:` clause.

## A scan that asks "does this file contain X" must ask it of the CODE

Three times in one night a check of mine matched its own documentation: it
counted `evidence:` inside a printing block, found `--delete-branch` in a comment
saying not to use it, and found `also true` in a comment quoting the behaviour
just removed. **Each time the code was right and the test was reading prose.**

There is a `codeOf` helper now that strips comments, and every such scan goes
through it - the class is closed rather than fixed a fourth time.

## A quota can hold a ratio; it cannot invent work

The backlog was 80% comment cleanup again, a round after the quota was added.
The quota was doing its job - the valuable detector simply had 25 findings
against the cheap one's 111.

```
apps/server   447 ts files, 161 tests
apps/agent    457 ts files,  18 tests
apps/eval     115 ts files,  27 tests
```

**`apps/agent` is the same size as the server and has a ninth of the tests.**
Pointing the untested detector only at `apps/server` was never a judgement about
where tests matter - it was where I happened to start, and it stayed there
because the number it produced was never zero. Widened: **25 -> 153**, now larger
than the cheap detector, and the mix went 100/0 to 60/40.

> A detector that still returns findings is not a detector that is looking
> everywhere. Zero is the only signal that forces the question, and it never
> comes.

### And an upper bound, because a task has to be finishable

Widening immediately produced *"prompt-input.tsx exports 40 symbols and no test
names any of them"*. A brief demanding all forty be exercised or excused is one
no honest work can satisfy - **the same defect as the typecheck criterion,
arriving this time from the SIZE of the task rather than from its wording.**

Capped at 12 exports; #1489 withdrawn with that reason. Two details that would
have bitten later: the test now goes where *that app* keeps its tests, and
generated files are refused here too - a test written against generated output
tests the generator, and L0 forbids editing it.

## Report the denominator, or a narrow scope is invisible

Three detectors, three rounds, three narrowings - and every one hid for the same
reason: **the number it produced was never zero.**

| detector | what it actually covered |
|---|---|
| L3 / ascii | one directory of five apps |
| untested | one app of five |
| length | the **top level** of its own six directories |

The last is the sharpest. `git ls-tree` without `-r` reads only the top level, so
the detector saw **107 of the 234** `.ts` files inside the six directories it
already claimed - 127 files invisible for want of one flag, in a tool that
reported findings every single run.

A count of findings cannot show that. A count of findings against the number of
files **looked at** can, and costs one number per detector:

```
signals: length=11/830 seen  untested=145/830 seen  ascii=71/938 seen
```

### The denominator got the denominator wrong

On its first attempt the counter sat *after* the filters, printing
`ascii=71/71 seen` - a denominator that can never differ from its numerator and
therefore says nothing at all. **The exact failure it was added to prevent,
committed inside the fix for it.** Count at the READ, before any filter, and pin
it with a case that asserts the order.

### A self-inflicted alarm worth remembering

Investigating this I ran `git ls-tree` from the loop directory, got zero files
for the whole server tree, and for a minute believed 135 landings had damaged the
branch. **`git ls-tree <ref> <path>` resolves the path relative to the CWD**, so
from a subdirectory it silently returns nothing. The alarm was mine; the branch
was fine. Every git command in these tools passes an explicit `cwd` for this
reason - the one I typed by hand did not.

## The change I argued for did nothing measurable

I moved the VERDICT block to the front of the report on the strength of three
transcripts, deployed it, and promised to measure once the sample was comparable.
It is, and it does not support the change:

```
before   166/177   93.8%   95% 89.2% to 96.5%
after     19/22    86.4%   95% 66.7% to 95.3%

no detectable difference - the intervals overlap
about 125 observations in EACH window would be needed to tell
```

Eyeballed, 94% -> 86% is a regression. Measured, it is **three incomplete reports
where 1.3 were expected**, and the sample cannot distinguish a small improvement
from a small regression at all.

**I compared percentages by eye all night and was wrong twice in ways that
changed what I recommended**: the "17% accepted" that was a window still in
flight, and this. So `tri ab` exists, with Wilson score intervals - the ones that
stay inside [0,1] at small n and near the edges, where the normal approximation
runs outside the range exactly when the question is being asked.

### What it refuses to say

- **Never** better or worse from overlapping intervals. *"No detectable
  difference"* is a real answer and the honest one far more often than a
  dashboard suggests; treating it as a null result to be talked around is how a
  change gets credit for noise.
- *"Not significant"* always arrives with the sample size that would settle it,
  because without that it reads as *"no effect"*, and those are different claims.

### What I kept anyway, and why

The block-first instruction is **not reverted**. The parser change that came with
it - try every occurrence of the heading, keep the fullest parse - is strictly
better than `lastIndexOf` under either convention, and the position itself costs
nothing. But it gets **no credit**, and this section is here so it never quietly
acquires any.

> A story that explains three transcripts is a hypothesis, not a result. Ship it
> if it is harmless, measure it before you believe it, and say plainly when the
> measurement comes back empty.

## Widening a scope must never narrow it somewhere else

Three detectors were narrowed; the guards were too. `clocks.mjs` listed **two
files by hand** while nineteen under `apps/server/src` alone mention a time
column - a clean answer about a tenth of the question, every round.

Widening it dropped a source. The search looks for SQL column names, and
`QueenDelegation.swift` carries the same decisions under Swift property names, so
switching from the named list to the search silently lost a file that had been
read since the guard was written: **8 measurements became 7**. The named files
stay named; the search **adds** to them.

## When the method does not survive the wider corpus, say so and stop

`fields.mjs` audits one file; sixteen write SQL. I widened it, and it produced
false accusations against working code in four distinct ways:

1. SQL declared as a **named constant** and consumed a hundred lines below - the
   reads land in whichever region they fall into;
2. **quoted identifiers**: `) as "messageCount"` yielded no column at all;
3. a **subquery in the select list** whose own `SELECT` becomes a region start
   and truncates the outer column list;
4. **paren depth** that must be tracked inside the SQL literal, not across the
   surrounding JavaScript.

Its first accusation was against `queen-needs-you.ts`, claiming it failed to
select four columns its query names explicitly. **I opened the file before
believing it** - the only reason this is a reverted experiment rather than a
published false accusation, and the discipline that should have saved #1419.

Two of the four fixes were real and kept. The other two need the boundary to come
from an actual SQL parse, which is **a task, not an improvisation** - filed as
one, with the four failure modes named and an acceptance criterion pinning the
file that exposed them.

> An audit that quietly passes what it cannot resolve is the shape of the defect
> it hunts. An audit that ACCUSES what it cannot resolve is worse: the first
> wastes an opportunity, the second spends someone's afternoon.

Knowing when to revert and file is part of the loop, not a failure of it. Three
patches in one hour, each removing some false accusations and leaving others, is
the signal to stop patching.

## Two guards asked the denominator question, and only one was narrow

`coverage` came back clean - zero findings across a fan-out that had to refute
every claim. Its scope is the loop's own tools and confining it there is exactly
right. **A scope being narrow is not the same as a scope being wrong**, and after
five narrowings in a row it was worth being told so by something other than my
own expectation.

`verdict-audit` carried `select(.number >= 1347)` - one line, no comment, in a
224-line file where every other decision has a paragraph. It excluded **63 of the
189 pushed branches**, a third of the swarm's output; 57 of those briefs carry a
Success Criteria section, 15 yield a promised identifier the tool's own extractor
accepts, and eight audited by hand all returned SUPPORTED. Both defences failed
against measurement: the criteria convention reaches down to #1062, and 34
below-floor branches were committed the same day as 44 above-floor ones.

The set is the data now - every issue with a pushed branch, which is exactly what
the tool compares a claim against. Scope 126 -> 189, SUPPORTED 47 -> 64, and one
CLAIM UNSUPPORTED the floor had hidden.

## Forty-six branches of "debt" were never debt

The landing check knew three routes to *already in the base* and was missing the
fourth: a branch that was **cherry-picked and has since drifted**. The base moved
on, so merging it back would still change the tree, and it looked like debt for
ever.

`git cherry` compares patch-ids. One branch's blob was byte-identical to what the
base had landed - same author, same timestamp. Another's two commits had matching
patch-ids. A third was the squash source of a commit already in. Unmerged
**67 -> 21**, landable **49 -> 8**.

> "Merged" has at least four spellings: an ancestor, an identical tree, an
> equivalent patch-id, and a change somebody applied by hand. Ask the one that is
> route-blind.

## A carry-forward is only valid against the base it was cut from

Five conflicting branches were carried onto fresh branches - never rebased, never
force-pushed, the originals untouched. Four survived three refuters each. The
fifth was refuted by all three, and the reason was **not its content**: two base
commits had landed while the fan-out ran, so the carry was built on a base that
no longer existed.

Then landing the four in sequence made the last two stale in the same minute -
#330 and #331 touched `queen-public-status.ts`, which is exactly what #332 and
#333 also touch.

**Carries that touch the same file must land as one change, or be re-cut after
each landing.** That is the same defect these carries exist to rescue - work made
stale by a base moving underneath it - committed while fixing it.

## A guard pointed at the wrong filesystem is worse than no guard

`reap-local.mjs` asked `df -P /` from the day it was written and reported a
comfortable 55%. Every checkout it manages lives under `/private/tmp` and
`/Users`, which on macOS are on `/System/Volumes/Data` - 97% full, 393 Gi of 460.
`/` is a sealed read-only system snapshot. The two numbers have nothing to do
with each other.

So a `git worktree add` failed with "No space left on device" while the disk
guard, on the same machine, in the same minute, said there was room. It did not
fail to answer. It answered, confidently, about a filesystem nobody was writing
to.

Ask about the PATH you care about and let `df` resolve which filesystem that is:

```bash
df -P "$TARGET_DIR" | tail -1     # not df -P /
```

The general form: **a measurement whose subject is implicit will eventually have
the wrong subject, and it will not tell you.** The same round found `tri why`
checking the laptop's disk while diagnosing a container, and the audit floor
`select(.number>=1347)` deciding what "every accepted verdict" meant.

## The collector must not depend on the thing whose failure it collects for

`/workspace` reached 100% - 71 MB free of 46 GB, sixty worktrees - and every
dispatch died in its first second at `git worktree add`. A reaper existed and had
not run, because it lived OUTSIDE the container and reaches the volume through
`railway ssh`, which refuses while the application is unhealthy - which it was,
BECAUSE the volume was full. A retry thirty seconds later happened to work.
Nothing guaranteed it would.

Every system that has met this answers the same way: kubelet garbage-collects on
the NODE against high and low watermarks, not from the control plane; CI runners
clean their own disks; ext4 reserves 5% so root can still act on a full
filesystem. Put the collector inside, give it watermarks, and let it refuse with
a number rather than die at a git command:

    volume 97% full after reaping 4 worktree(s); 2 held uncommitted work and were kept

Note what it will never remove: a worktree holding uncommitted work. The worker
container carries no push credential by design, so unpublished work in a tree is
the only copy of it. Unreadable status counts as dirty. No `--force`, ever.

## `body.split(heading)[1]` is not the text after the heading

It is the text BETWEEN the first and the second occurrence, because `split` cuts
on every one.

`verdict-audit` read `## Success Criteria` this way for its whole life. #1090 is
a brief ABOUT brief shape, so its acceptance scenario contains the sentence
"Given a body with a `## Boundary` but no `## Success Criteria`" - and `[1]`
returned 931 characters of User Scenarios. The real criterion two sections below
was the exact phrase the tool exists to find, and it was never read. The audit
reported "the brief promised no new identifier" and meant it.

A heading is a heading only at the start of a line. Anchor it, and end the
section at the next one.

## grep speaks three languages, and the flag bundle says which

`grep -c '^  it(' <file>` is a valid criterion. In BRE - plain `grep` - the paren
is an ordinary character. Handed to `new RegExp` it throws on an unclosed group,
so the checker fell back to a literal substring search, counted 0, and accused a
bee whose test file was full of exactly that.

- `grep -P` is PCRE and reads like JavaScript.
- `grep -E` is ERE and also reads like JavaScript.
- plain `grep` is BRE, where `( ) { } | + ?` are LITERAL unless backslashed.

And when the pattern still cannot be read: **unreadable is not failed.** A checker
that convicts on its own inability to read the question is the worst failure mode
available to it.

## The number is not the whole criterion

#1326 says ``grep -c 'commands_run' <file>`` prints `2` **or more**. Read as
"exactly 2" it convicted a bee whose file had 3 - which is what the criterion
asked for. `or more`, `or fewer`, `at least`, `at most`, or nothing at all: the
words on either side of the number are the rest of the criterion, and reading
only the number is how a checker becomes confidently wrong.

While fixing it, one accusation survived and was worth keeping: #1290 asks for
`no swift compiler` and the document says "No Swift compiler". grep is
case-sensitive and so is the audit - but the note now says
`0; 1 ignoring case, so this is a capitalisation mismatch`, which sends a reader
to the one-character fix instead of to the bee.

## A test harness that does not await cannot fail

`check(name, fn)` called `fn()` inside a try/catch. For an ordinary function that
is correct. For an `async` one it starts the work, returns a promise, and the
catch sees nothing - so the case printed `ok`, the summary said `0 failed`, and
the rejection arrived AFTER the tally as an unhandled crash.

Eight checks written that same morning had all been reported passing without once
running to completion. It surfaced only because a message I had edited no longer
matched an assertion, and the crash landed after a green summary.

If a suite mixes sync and async cases, collect the promises and await them before
printing the count - and add the case that proves the harness can still fail.

## zsh eats `$ref:path` in a verification command

Checking the audit's answer by hand, I ran:

```bash
git show $b:trios/tools/x.mjs | grep -c ...     # prints 0. It is not 0.
```

In zsh `:t` is a history modifier meaning "tail", so `$b:t` expanded to the hash
and `rios/tools/x.mjs` was left dangling. The measurement compared an empty
string on both sides and agreed with itself. `:t :h :r :e :a :s :l :u :q :x :p :g`
are all modifiers, which covers `trios/`, `apps/`, `src/`, `tests/`, `lib/`,
`docs/` - most repository paths.

```bash
git show "${b}:trios/tools/x.mjs"               # braces, and quote it
```

The shipped tools are unaffected: `execSync` goes through `/bin/sh`, where `:` is
just a colon. This is a hazard of the hand-check, which is the thing you reach for
precisely when you distrust the tool - so it is the worst possible place to have
a silent one.

## A criterion that was already true proves nothing: FAIL_TO_PASS

SWE-bench builds every instance around a test that FAILS before the patch and
PASSES after, and **excludes any instance without that transition**. The reason
is blunt and worth memorising: pass-to-pass alone is satisfiable by an EMPTY
PATCH.

`verdict-audit` had only the pass-to-pass half for its whole life. It ran each
criterion against the branch, saw a pass, and printed SUPPORTED - with no idea
whether the criterion had been true all along. One had been checked by hand
(#1485: 3 non-ASCII lines at the fork point, 0 on the branch). The other 153 were
unknown, and "unknown" was printing as "supported".

Run every criterion twice. The TRANSITION is the verdict:

| before | after | verdict | meaning |
|---|---|---|---|
| fail | pass | PROVEN | the branch caused it |
| pass | pass | VACUOUS | true before the bee arrived |
| pass | fail | REGRESSION | the branch broke what it satisfied |
| fail | fail | UNSUPPORTED | claimed and not delivered |

VACUOUS is not an accusation. It is the audit saying it cannot tell, which is a
different and more useful thing than a false pass.

## A baseline is not a target, and reading it as one convicts the worker

These briefs are written test-first, so many RECORD the red state as evidence the
defect is real:

    `grep -c '[^ -~]' <file>` prints 13 today.
    The pre-edit run stays red, and that red result is the finding, not a failure.

Read as a target, #1390's 13 became a requirement. The bee removed one non-ASCII
line, the file printed 12, and the audit reported a REGRESSION - convicting a bee
for doing exactly the work.

A criterion carrying a before-marker (`today`, `currently`, `pre-edit`,
`before writing`, `as it stands`, `stays red`) is checked **at the fork point**
and never counted against the branch. If it fails there, that is the BRIEF's
premise being wrong, which is a note about the author, not a verdict on the
worker.

## Stop guessing at definition syntax; measure absence instead

A checker that scanned added lines for a declaration SHAPE produced three false
accusations in one round, was fixed with a wider pattern, and produced three more
in the next:

    #1389  connectionFailed             a Swift enum CASE
    #1380  pressCombo, dispatchDrag     methods on an object literal
    #1374  isTerminalProviderError      in a new file, reached by import

All six identifiers were really there, in 6 to 17 added lines each. Swift,
TypeScript, markdown and shell each spell "define" differently and the list has
no end - so a wider pattern is not the fix, it is the next round's bug.

The criterion says the identifier "appears nowhere in the tree today". **Absence
is checkable without knowing any language.** Present on the branch and absent at
the fork point is the whole promise, measured with `git grep -w`. Keep the
declaration pattern only to STRENGTHEN a note - "1 in a declaration" is better
evidence than a bare mention - and let it convict nobody.

## A cache must key on the rules, not only on the work

`verdict-audit` at 0.92 s per branch over 207 branches is 217 seconds, against a
per-step cap of 300 in the heal chain. It fits today; it will not at four
hundred, and the way it will stop fitting is the way steps here always do -
killed mid-way, reported as "timed out part-way", half an answer that looks
whole. So it caches on the branch tip and the fork point, and a warm pass is 10
seconds.

Then the absence vocabulary widened, a fresh pass found 6 unsupported claims
where there had been 2, and **the very next cached pass served the old 2 back** -
verdicts a different program had reached. The key now carries a digest of the
auditor's own source, so any edit to the rules invalidates every verdict reached
under the old ones. Invalidation that depends on someone remembering is
invalidation that will be forgotten.

The trade is stated where it lives: keying on the body would defeat the cache,
because reading the body IS the expensive call. A brief edited while its branch
stands still is served stale, and `--fresh` is the way through.

## A vocabulary of one phrase is a rule about the phrase

The absence check knew `appears nowhere`. Briefs also write "Verified absent
today" and "(new identifier, absent today)" - the same promise in a different
hand, and both audited as "states nothing checkable" while stating it plainly.

Two more things about reading a brief:

- **A criterion is a sentence, and sentences wrap.** #1396 and #1394 open with a
  bolded label and put the identifier on the next physical line. A line-based
  reader loses the entire promise. Join continuations before matching.
- **Widening a vocabulary widens what it wrongly catches.** The moment the
  absence phrases grew, `export` came out as a promised identifier - the
  `node_modules` accusation returning by a different door. A keyword stop-list
  goes in at the same time as the widening, not after the first false positive.

## Compare a ratio against its own variability, never against a threshold

The obvious regression detector - "this run is lower than the last, shout" - is
wrong twice over, and both failures are documented outside this project.

**A control chart of an in-control process shows nothing amiss while a
regression fit of the same points appears to trend.** Reading trend lines as
regressions is a known source of phantom findings in flaky-test dashboards. A
ratio wandering inside its own noise band is not a regression, and a tool that
says it is gets muted within a week.

**The denominator moves for reasons that are not quality.** Audit coverage rises
when briefs happen to be written in a shape the auditor can read and falls when a
batch of hand-written epics lands. Neither is the swarm doing better or worse.

So ask what canary analysis asks: is the RECENT window different from the
BASELINE this same process established? That controls for drift a static limit
cannot. Answer with Wilson intervals, and refuse to say "worse" while they
overlap.

And use TWO TIERS, from the multi-window burn-rate pattern:

    ACT NOW   the intervals are separated and recent is lower
    WATCH     recent is lower but the intervals overlap - not yet distinguishable
    (silence) recent is equal or better

Collapsing those into one alert is how the one alert stops being read. A drop
inside the noise is not nothing - it is the thing to look at twice next round -
but it is not a finding and must not be printed as one.

## One deadline for two jobs starves the cheap job

`heal` had a single eight-minute budget over twelve steps. reap, push-work, land,
close-done and author consumed all of it, and verdict-audit, proven and
judge-packet were SKIPPED - not because they are slow (a warm audit is ten
seconds) but because nothing was left. The chain then printed `heal complete`
with a third of its steps never run.

That is the house defect wearing a schedule: a confident answer about work that
did not happen.

The file had drawn the line in prose for weeks - "everything above this line
frees the swarm; everything below only reports". Make it data. Give each phase
its own budget, starting when that phase starts. A slow reap must not be able to
silence the audit that would have found what the reap was for.

## In a directory of single-purpose tools, the plausible name is taken

I wrote a new tool called `coverage.mjs`. There already was one - the guard that
asks which of the loop's own tools have never run their ACT path, the one that
caught `reap` shipping a remote script that had never executed. I wrote straight
over it.

`fp-check` crashed within the minute on `COV.coverage is not a function`, and git
had the original. Nothing was lost, and only because a guard imported the file by
name and ran every round.

Two habits follow. Check `git log -- <path>` before creating a file whose name
you find obvious. And keep the guards importing each other by name: the
dependency is what turned a silent deletion into a crash.

## Editing a live CLI in place is not atomic

A launchd timer ran `tri` while a script was rewriting it, and bash reported a
syntax error on a line that was, and is, correct. It had read a truncated file -
`open(path, 'w')` truncates first and writes second, and anything reading in that
window sees half a program.

Write a temp file in the same directory, copy the mode, and `os.replace` it.
The rename is atomic; the truncate-then-write is not. This matters for any file a
timer, cron or watchdog may execute - which in this project is `tri` and every
tool the chain invokes.

## A carry makes the original branch permanent debt, and no byte-comparison sees it

`isLanded` had four routes - ancestry, an identical merged tree, a patch-id
match, a hand-applied change. All four compare CONTENT, and all four are blind to
the thing this loop does constantly: when a bee's branch goes stale I re-cut its
change against the current base and squash-merge THAT. The carry is a new commit
with a new tree and a new patch-id, so nothing content-shaped connects it back.

The bee's original branch then becomes permanent debt: re-offered every round,
conflicting every round, holding its boundary fenced for ever. Four of the nine
branches that had jammed the pipeline were in exactly this state.

**Read the message.** L1 here is "no code merged without `Closes #N`", which makes
the commit message a load-bearing record rather than a courtesy:

    Closes #1362                                       an explicit closure
    feat(queen): explain idle paid slots (#1310) (#330)  a squash subject
    Carries the #1421 work it belongs with               a carry saying so

Two traps in the matching, both hit within a minute of each other:

- **Tighten it and you break the case it was written for.** Requiring `(#N)` at
  the end of the line - to reject "unlike (#1421), this does X" - rejected
  `(#1310) (#330)`, which is the real shape: the issue, then the pull request
  that merged it. A trailing CHAIN of references is a subject.
- **Do the matching in JavaScript, not in git's regex.** The dialect belongs
  somewhere it is known; ask git the loose question and check the boundary
  yourself.

## A rule transcribed twice is two rules that agree until someone edits one

`close-done.mjs` carried its own copy of the landing test - the tree comparison
and nothing else - while `land.mjs` grew four more routes it never learned. So
`land` recognised four finished branches and `close-done` went on refusing to
close their issues.

That is L2 of this repository, inside the file that decides whether an issue may
be closed. It asks `land.mjs` now. When you improve a rule, grep for its second
copy before you finish.

## A conflict does not say which side is behind

`land` reported nine conflicts and one remedy: rebase, or close as superseded.
Taking that advice on #1302 would have destroyed landed work.

Replaying that 205-line branch onto today's base would have deleted
`WorkerCapacityBreakdown` (#1308's carried work), deleted the tree-load-failure
handling the base gained since, and REINTRODUCED a non-ASCII ellipsis into a path
redaction the base already does in ASCII - breaking L3 in the same stroke.

That branch was not waiting for a rebase. It was superseded in part, and what
survived belonged on today's base as new work. So measure it:

```bash
git rev-list --count "$FORK..origin/$BASE" -- $CONFLICTING_PATHS
git diff --shortstat "$FORK..origin/$BASE" -- $CONFLICTING_PATHS
```

A base that has moved far on the conflicting files means a rebase would replay
OLD code over new. It is a measurement, not a verdict - the person still decides,
now with the number that decides it.

Two smaller things from the same report: `git merge-tree --name-only` interleaves
PROSE with paths (`Auto-merging X`, `CONFLICT (add/add): ...`), and counting them
doubled every conflict width printed; and truncating the reason to 96 characters
had been cutting off exactly the half that says what to do.

## Splitting a rate by category needs a correction, or the dashboard dies

`tri proven` said 186 of 190 judged verdicts prove something. True, and it hides
where the four live. Split by the detector that filed the brief, every
machine-authored kind proves at 100% and all four unproven verdicts are in
hand-written work.

But a split is several tests at once. **Four groups at 95% each carry a 19%
chance that one comes back significant with nothing wrong anywhere.** Tested at
the single-comparison threshold, a category dashboard raises a false alarm about
every fifth look, gets muted, and then misses the real one.

Bonferroni - divide the family error rate by the number of comparisons - is the
conservative choice and the right one here: a false alarm costs the tool's
credibility, a missed small effect costs one round's attention. For four groups
that is z=2.498 rather than 1.96.

Two more things a split must get right:

- **Compare each group with the REST, not with the overall.** A group inside its
  own baseline drags that baseline toward itself, shrinking every difference and
  hiding the outlier the split was made to find.
- **Print the mix.** Simpson's paradox is real: the overall rate can move
  opposite to every group if the proportions change underneath it.

## A deletion is not work, and du is not free space

Two lessons from a reaper that could not act while the disk it guards sat at 98%.

**A worktree whose entire dirty set is deletions holds nothing.** `reap-local`
spares any tree with uncommitted changes, because a dirty tree is somebody's
unfinished thought. Two workflow worktrees were spared on 1983 and 1984 changes
each, every one a DELETION of a file their own HEAD still contained. An addition
or a modification is a thought; a deletion is the shape of one already saved.

**And `git worktree remove` still refuses a dirty tree.** `--force` is not the
answer and is not used on a worktree in this project. `git checkout -- .` is: it
restores exactly what git already holds, and then the removal is ordinary.

```bash
git -C "$TREE" status --porcelain | grep -vcE '^([ D])D |^D[ D] '   # 0 = safe
git -C "$TREE" checkout -- .
git worktree remove "$TREE"                                        # no --force
```

**`du -sh` on a worktree is an upper bound, not free space.** The reaper reported
three candidates as "holding 6938 MB"; removing them returned about 600. A git
worktree shares its object store with the main checkout, so most of what du
counts is on disk once. A tool that overstates what it recovers is one nobody
believes about the disk being full either.

## A stale branch is a specification of intent, not a patch

Five branches jammed the landing pipeline for four rounds while I deferred the
one question a person has to answer: rebase, or re-do the work?

**Rebasing is the wrong default when the base has moved.** Replaying #1302 would
have deleted #1308's landed code and reintroduced a non-ASCII ellipsis into a
redaction the base already performs in ASCII, breaking L3 in the same stroke.

**And a clean rebase would not have shown it.** A SEMANTIC CONFLICT carries no
markers: git resolves the text correctly while the combined code is logically
broken - upstream renames a function your commit still calls, the changes sit on
different lines, nothing conflicts, everything is wrong. "It applied cleanly" is
not evidence.

So use the old diff as a statement of what was WANTED. Concretely: **the names
the branch introduces that the repository still does not have.**

    queen-1302   8 of 200 candidates absent   quotaAuthority, provider_quota, ...
    queen-1303   4 of 243                     started_running, plantedSecret, ...
    queen-1387  19 of 273                     specQualityHeadingParity, ...

881 added lines across three branches reduce to 31 missing names, because most of
what they carried had landed by another route. Each name becomes a criterion that
is fail-to-pass BY CONSTRUCTION - it was measured absent from the base a moment
earlier, so it cannot be satisfied by an empty patch.

Do not parse for declarations. Six false accusations in this project came from a
checker guessing at declaration syntax across Swift, TypeScript and markdown.
Take every identifier-shaped token as a candidate and let the BASE TREE decide
which are new; absence needs no knowledge of any language. Drop hex blobs - a
fake sha in a fixture offered `fedcba9876` as a capability the repository lacks.

## Three measures, two of them blind, and the one that answers

The name measure shipped and immediately gave wrong advice. On #1484 it said
"nothing here is a missing capability - close it as superseded". #1484 is an
OPEN L3 cleanup whose defect is still in the tree.

| measure | why it was blind on #1484 |
|---|---|
| names the branch adds that the base lacks | its ten names had reached the base by another route |
| lines the branch removes that the base still has | the base REWROTE the file, so nothing matched textually |
| **the issue's own criterion, run against the base** | **answered: 5 non-ASCII lines where 0 is required** |

**Ask the issue its own question.** The brief already says what done means, in a
command. Run it against the base rather than the branch. A criterion that fails
there is the strongest available statement that the work remains, and it needs no
similarity heuristic at all. It is the same extractor that checks a bee's claim,
asked of a different ref - one rule, two questions.

Exclude criteria marked as BASELINES: a baseline describes the fork point, and
asking it of the base inverts its meaning.

And delete the conclusion. "Close it as superseded" was a verdict drawn from one
measure. Say what was measured and what was not: *no missing vocabulary is not
the same as nothing left to do; a cleanup, a rename or a behaviour fix adds no
name at all.* The tool measures; the person concludes.

## Ask the record, not the run: a step failing 71% of the time reported itself fine

Every chain run reports its own steps and moves on. Nobody had ever read the
ledger backwards. Asked for the first time, over 23 hours:

    reap        45 of 63 runs failed   71%
    lease       43 of 63               68%
    push-work   46 of 70               66%
    close-done  32 of 70               46%

Those are exactly the four steps that FREE the swarm. They had been failing about
two thirds of the time for as long as the record goes back.

It was invisible because **a single failure looks like bad luck and only the
record shows it is the system.** Each run said "push-work=FAILED" once, in a
terminal, at three in the morning, and the next run started clean.

```bash
tri failures            # every step, worst first, over the whole ledger
tri failures --since 1  # the last day
tri failures push-work  # the evidence for one step
```

Corollary that cost a round: **"it worked when I tried again" is not a
diagnosis.** Two rounds before this, the chain printed `push-work=FAILED`, I
re-ran it by hand, it worked, and I wrote it off as transient without changing
anything. Three accepted pieces of work - 9 to 15 minutes of a bee each, reviewed
and ACCEPTED - then sat invisible on the far side of a dropped connection for a
whole round. A retry that only exists in your fingers is not a retry.

## One channel, one retry, and never retry an answer

The four steps above all reach the container through `railway ssh`, and each
carried its own six-line copy of the call. Copying one fix into four files is L2
all over again - a rule transcribed four times is four rules that agree until
somebody edits one - so the call lives once, in `channel.mjs`.

**Retry a CHANNEL failure. Never retry an ANSWER.**

    retry     Operation timed out, os error 60, Connection reset, SendRequest,
              ETIMEDOUT, 502, broken pipe - the transport could not deliver the
              question, so nothing was learned about it
    do not    `! [rejected] ... (non-fast-forward)`, `error: failed to push some
              refs` - the command answered, and a partly-rejected push is a
              normal outcome the caller already knows how to describe

Retrying an answer is as wrong as crashing on a dropped connection, and both
directions belong in the tests.

And mark the failure. A caller must be able to tell **"I looked and found
nothing" from "I never looked"** - the same silence, completely different facts.
A step that could not reach the container has not found nothing to push; it has
not looked, and the words it prints have to differ because the chain reads them.

## A failure whose reason is only printed is a failure nobody can diagnose

The ledger recorded `status: FAILED` for 46 push-work runs and an EMPTY summary
for every one of them, because the summary field is filled only when a
recognised pattern matches and no pattern matches a failure. The console had the
reason. The record did not, and those 46 can never now be diagnosed.

Keep the last few lines of any step that fails. Printing is for whoever is
watching; the record is for whoever asks later, and at three in the morning
nobody is watching.

## Numbers are measured, prose is written

Every instrument here measures something and refuses to guess. The dashboard did
not: it took whatever numbers its caller handed it, and its caller was me, at
three in the morning, typing from memory.

Iteration #46 says "dispatches finished 258". The last measurement had said 255.
Nothing was wrong with the swarm - the number was invented, in the one artifact
whose whole job is to say what is true, and it went out in a report.

So the dashboard asks the same tools everything else asks (`tri facts`). Two
rules follow, and they are the whole discipline:

- **A fact that cannot be taken is `null` and renders as `-`,** with a line
  naming which ones. Never filled in from memory. A missing measurement that
  silently became 0 would be worse than the typed number.
- **The delta comes from the last recorded reading,** not from what you remember
  the last one being. Then the change column is a measurement too.

The prose stays hand-written: what was done, what went wrong, what to do next are
judgements. Only the numbers are mechanical.

**And a non-zero exit is often the answer.** The first version printed `-` for
two facts it had already measured, because `failures.mjs` exits 2 when a step is
failing badly - that is the tool working - and `reap-local` exits 1 to mean
"would act". `execSync` throws on both. Only a signal or a timeout means the
measurement was not taken. Reading a deliberate exit code as a failure is the
same defect as inventing a number, only quieter.

## Excluding a hypothesis is a result

The four channel steps had been failing 46 to 71% of the time and I had a story
about why. Testing it excluded three explanations rather than confirming one:

    per-call flakiness   10 of 10 single attempts succeeded, median 4.0 s
    a few long outages   failures fall in 19 of 23 hours, not in a window
    container restarts   the process had been up 3.9 hours; failures span it

What survives is narrower and better founded: a chain run is all-ok or
all-failed, which is the shape of "the channel was unreachable for that whole
run", and 94% of the failures are in `heal` rather than `feed` - the same tools,
the same channel, a different caller.

That is not a conclusion and must not be written as one. The evidence field will
carry the reason the next time it fails, and one clean run after the fix is one
data point, not a trend. Say "three hypotheses excluded, one measurement
pending" and stop there; a story that fits the data is not the same as the data.

## du is an upper bound, twice over

Freed two dead workflow worktrees and 2.2 GB of bun modules. `du` promised 4.8 GB
and the disk moved 0.8.

A git worktree shares its object store with the main checkout, and **bun
hardlinks packages from a shared install cache** - so `du -sh` counts bytes that
exist once and will not be returned. Third time this project has met the same
arithmetic. Report the du figure as the ceiling it is, and read the real answer
from `df` before and after.

## One outage is one fact, not one failure per step

Across 62 chain runs: when `reap` - the first remote step - SUCCEEDED, the three
steps after it failed 0%, 7% and 0% of the time. When `reap` FAILED, they failed
96%, 96% and 66%.

They do not cause each other. They share a condition that holds for the whole
run - the container is not attachable - and `reap` is simply the first to find
out.

Two costs, and I had been paying both while quoting the numbers as findings:

- **The chain kept knocking.** After the first step found the door shut, three
  more knocked, each with its own retries and backoff, and the run spent minutes
  learning the same thing four times. A process-wide breaker holds the run's
  verdict; the rest inherit it. Per-process, because the next run must try again.
- **The record was inflated fourfold.** "reap 71%, lease 68%, push-work 66%" is
  ONE outage counted once per step. The honest quantity is that the channel was
  down in 47 of 62 runs. Same problem, a quarter of the drama.

A shut door is not a broken step. Record it as its own status, or the next reader
goes looking at four tools that are all working.

## Build the classifier from the record, not from the one failure you watched

I saw `Operation timed out (os error 60)` once, by hand, and wrote a retry
classifier from it - while holding a ledger with 174 recorded failures I had not
read. When the evidence field started capturing reasons an hour later:

    "Your application is not running or in a unexpected state"      x2
    "Expected welcome message, received: ServerMessage { error }"   x2
    "failed to load system trust settings: I/O error"               x1

**None matched.** The retry I had shipped, against the failure rate this project
had been chasing for two rounds, never fired for a real failure in this system.

And they are three different problems, so one retry policy cannot be right:

| kind | what it means | response |
|---|---|---|
| `app-down` | railway will not attach; the service is not in a state it accepts | retry with a LONGER wait |
| `local` | the CLI on THIS machine could not read the system trust store | do not retry; nothing about the container is wrong |
| `transport` | the connection dropped | retry soon |
| `unknown` | unrecognised | print verbatim, never retry on a guess |

**`/health` answered `ok` at the same moment railway said the application was not
running.** Two views of one service, disagreeing. A green health check is not
evidence the channel will connect, and neither one is "the truth" - they are
answers to different questions.

Pin the classifier's cases to the strings the record actually holds, verbatim, so
whoever widens it next has to widen it against evidence rather than against a
memory of one bad afternoon.

## Two statements about a service, taken a minute apart, are two anecdotes

The chain recorded three steps failing with "Your application is not running or
in a unexpected state" from `railway ssh`. Asked a minute later, `GET /health`
answered `{"status":"ok"}`.

I wrote that up as a finding. It was not one. **A minute apart proves nothing** -
by then the world has moved, and the whole discipline here is the difference
between an anecdote and a measurement. Sample both at the same moment or you have
not observed a disagreement at all.

And when you do sample them together, count **four states, not two**:

    both up                    agreement
    both down                  agreement - one story, not two
    HTTP ok, ssh REFUSED       a green health check is not evidence the channel
                               will connect. This project read it as one.
    ssh attached, HTTP down    the opposite failure, a different investigation

Neither view is the truth. HTTP asks whether the app can serve a request; the ssh
gateway asks whether the platform will attach a shell to the deployment, which
also depends on the deployment's state and on what the gateway believes about it.
Picking one and calling it health is the mistake available here.

**Measuring must not change what it measures.** The instrument asks even when the
run's breaker has already decided the channel is down - that is its job - and
then restores the verdict it found. A probe that resets state behind it produces
a system that behaves differently while observed.

## An unpaid claim is reported as unpaid

I said the breaker would turn one outage into one `channel-down` instead of four
FAILED, and recommended reading the rates next round as the test. Next round
came: no chain run had happened since it merged, the column read zero, and the
rates were unchanged.

That is neither evidence for the claim nor against it. Writing it up as though
the unchanged numbers meant something - either way - would have been the same
defect as inventing a number, with more words around it.

Say "not yet testable, and here is why", pay the claim when the data arrives, and
spend the round on something the data can answer now. A loop that always has a
result at the end of the hour will eventually manufacture one.

## Read the comment before improving the thing it defends

The swarm sat at zero bees and `why` named a chain run holding the loop lock. My
first instinct: a lock held by a dead process should be reclaimable, add a pid
liveness check.

`loop.mjs` explains at length why pid liveness was **deliberately rejected**. An
iteration is a Claude turn made of many short-lived processes, so the pid that
took the lock has always exited by the time anyone looks, and a liveness check
would hand the lock straight to a concurrent cron fire. The pid also turned out
to be alive - the chain was working normally.

Two things follow, and the second is the useful one:

- **A design with a written reason is not a defect waiting to be found.** The
  comment cost a minute to read and saved a protection that exists to stop two
  writers.
- **But the reason may be right about less than the whole.** The lock has two
  kinds of holder, and it was only ever written for one: `heal` and `feed` are
  single processes that take it, work and exit in one pid. For those a missing
  pid does mean the run is gone.

So apply the exception where it is sound and guard it three ways: the holder must
DECLARE itself single-process, there is a grace period so a run that just started
is never stolen from, and the default stays the old behaviour so nothing that has
not opted in can be affected. **A wrongly-held lock costs a wait; a wrongly-taken
one costs two writers.**

## A protection scoped wider than what it protects starves something else

The loop lock covered a whole chain run. The first half changes shared state -
reaping worktrees, releasing fences, pushing branches, closing issues - and must
not run twice at once. The second half only reads. One lock covered both, so a
run held it up to thirteen minutes, and `feed` - which fires every 300 seconds to
refill the queue - stood down every time. The swarm sat at zero for eleven
minutes while the chain was in `fp-check`, a read-only step.

Release at the boundary the file already draws. Guard it: release only a lock
THIS process took, or a chain running inside an iteration will release the
iteration's.

**This was the third round running with the same shape.** `close-done` re-deriving
a rule that lived in `land`; pid liveness rejected for turn-held locks but sound
for single-process ones; a lock scoped to a whole run when only half of it
mutates anything. In each case the protection was right and applied to more than
it should. When something correct is costing you, ask what it is actually
protecting before you weaken it - the answer is usually a narrower scope, not a
weaker rule.

## The paired probe paid its claim

Last round's disagreement - `/health` ok while `railway ssh` refused - was
recorded as an anecdote, because the two were sampled a minute apart. With them
sampled together: 7 pairs, 6 both-up, and one at 02:01:13 where HTTP returned 200
with `{"status":"ok"}` and the gateway refused in the same moment, kind
`app-down`.

Existence confirmed, rate unknown. n=1 of 7 is not a frequency and must not be
written as one - but the phenomenon is no longer a story, and a green health
check is now demonstrably not evidence that the channel will connect.

## A refusal that is right can still be the thing starving you

The swarm sat at zero. The container volume was 95% full and every dispatch died
at `git worktree add: unable to write file`. The reaper tried twenty worktrees
and removed ONE - nineteen refused, because `git worktree remove` will not take a
tree with modified or untracked files, and `--force` is not used on a worktree
here.

**Every refusal was correct, and the situation was still wrong.** The question is
never "should I force it" - it is *what is the refusal protecting, and can that
thing be moved somewhere safe?*

    52 uncommitted path(s) across 20 tree(s)

Nine were TEST FILES a bee had written and never committed. Real work, the only
copy of itself, and invisible to everything: the branch does not have it, the
issue does not mention it, `push-work` cannot publish what was never committed,
and the tree holding it was one `--force` away from being deleted to make room
for the next bee.

Commit it onto the branch it belongs to. Then the tree is ordinary, the reaper
takes it, and the work reaches GitHub like anything else.

    rescued  19 of 20 trees, 52 paths
    pushed   14 branches
    reaped   18 of 26 worktrees, 28.6 G, volume 95% -> 32%
    swarm    0 bees -> 4

## A pre-commit hook gates delivery, not preservation

Every one of the first twenty rescue commits failed. The reason was `lefthook`
running `biome-check`.

A hook exists to stop unfinished work being DELIVERED. This was unfinished work
being saved from destruction - abandoned, not reviewed, and about to be deleted
either way. Holding it to a formatter's standard means choosing deletion over an
imperfect commit.

So `--no-verify`, with the reason written where the flag is, and the gate still
standing everywhere downstream: nothing rescued can land without passing the same
checks as any other branch. **Ask what a gate is for before deciding it applies.**

## "Nobody is running" and "I could not ask" are the same empty array

The rescue refuses to write into a tree whose bee is still working. Its first
version read the board, got `[]`, and refused - because a board that says nobody
is running and a board that could not be read both produce an empty list.

An empty running-set means every tree is abandoned and ALL may be committed. An
unreadable board means nothing is known and NONE may be. Opposite conclusions
from identical data.

This project has met the same shape before - a config file of zero-length keys
that looked configured - and it will meet it again. Any time a read can fail, the
failure needs its own value, and the refusal has to name which of the two it hit.

## A fix scoped to the symptom leaves the rest of the mechanism armed

`push-work` runs `git push` inside the container as root, and root leaves what it
writes owned by root. The first outage showed 112 root-owned REFLOGS killing
every bee at `git fetch` with Permission denied, so the fix chowned `logs` and
`refs` back.

A push also writes OBJECTS, and creates the fan-out directories that hold them.
Measured a week later:

    131 root-owned entries under .git
     53 of them DIRECTORIES in objects/
        objects/be   mode 755  root:root
        objects      mode 775  bee:bee

A bee runs as uid 999 and cannot create a file in a directory it does not own.
Fifty-three doors were shut, silently, waiting for the next fetch. The fix had
been incomplete since the day it was written, in the part nobody looked at
because it had not broken yet.

Give back the whole `.git`. Proven on a live push: root-owned files went from 272
to 0.

**Fix the mechanism, not the symptom you happened to observe.** "Root wrote here"
is the mechanism; "reflogs were unwritable" was one of its outputs.

## Ask the question that can come back "no"

`rescue` found 52 stranded paths and I said the test was whether it happens
again: a second occurrence would mean the bees systematically fail to commit, and
the fix would belong upstream of the tool I had just built.

It came back `total=0`.

So the stranding was a CONSEQUENCE of the volume outage, not a habit: the volume
fills, bees die part-way through `git worktree add`, their partial work is left
uncommitted, the trees holding it cannot be reclaimed, and the volume fills
further. A cycle, broken at two points.

The value was in the question being answerable the wrong way. A test whose only
possible outcome is "my tool is still needed" is not a test.

And the one path it did find was a **submodule**, whose `M` means the checked-out
commit differs from the one the superproject records. Committing that moves the
repository's dependency - a real change, made blind, by a tool for preserving
files somebody wrote. Read the exclusion from `.gitmodules`: a hard-coded path is
a second copy of a fact the repository already states.

## A watermark is what you use when the lifetime is unknown

The volume went from 95% to 32%, and an hour later it was at 87%. Two rounds of
fixes had addressed real defects and none of them addressed this one.

Seventeen worktrees. **Two** belonged to a bee that was still running. Fifteen
were left by dispatches that had FINISHED, eleven with their branch already on
the remote - about 27 GB of pure redundancy waiting for a threshold to notice it.

A worktree is created for a dispatch and stops being needed the moment that
dispatch's work is published. That lifetime is known exactly. CI deletes a
workspace when the job ends; a Kubernetes job's pod goes when the job completes;
neither waits for disk pressure to remember. **Reaching for a watermark when the
lifetime is known is the design error**, and every round spent tuning the
watermark was a round spent on the wrong question.

Remove on completion, and require all three:

    the dispatch has FINISHED     a running bee's tree is its workspace
    the branch is ON THE REMOTE   the work has somewhere else to exist
    `git worktree remove` agrees  no --force, so anything uncommitted survives

The second is load-bearing: this removes a CHECKOUT, never a commit, and refuses
to remove a checkout whose commits nobody else has.

Keep the watermark reaper as the backstop it should always have been - for what
this cannot take, and for the case where something upstream breaks and pressure
is the only signal left. First run: 87% -> 28%.

Two habits that came with it. **Return every exclusion with its reason** - a tool
that quietly skips things reads as a tool that found nothing to do. And **refuse
entirely when the board cannot be read**: "nobody is running" and "I could not
ask" are the same empty list, and here they lead to opposite acts.

## No collection strategy wins against a duplication rate

Three rounds went into the volume - watermarks, a collector inside the container,
a rescue for stranded work, then removal on completion instead of on pressure.
Every one fixed a real defect, and the volume still climbed at 39 points an hour
with the reapers working correctly.

**When a resource keeps filling despite correct collection, stop improving the
collector and measure the production rate.** A collector can only ever be as good
as the gap between creation and removal; if creation is 10 GB a generation on a
46 GB volume, the argument is over before it starts.

The production here is `bun install` writing a private copy of the dependency
tree into every worktree - about 2.4 GB each, four bees at a time.

## Test the mechanism by intervention before shipping the fix

I had an explanation for that duplication and it was wrong.

The bee's cache lives on `overlay` and the worktrees on the volume - different
devices - and a hardlink cannot cross a filesystem boundary. It is a true fact,
it explains the observation, and I wrote the fix, the test and the commit
message on it.

Then I tested it instead of shipping it. The cache was moved onto the volume with
a symlink - no deploy, reversible in one command - and three installs were run
into three directories on that same volume:

    A: links=1 ino=655375
    B: links=1 ino=655389
    C: links=1 ino=655404   (with --backend=hardlink)
    cache entry: links=4 ino=988244

Different inodes, one link each. The cache hardlinks INTERNALLY, so the
filesystem supports links perfectly well - `bun install` simply copies out of it
into every node_modules, whatever device either is on. **The device boundary was
never the cause.**

The fix would have cost 2.5 GB of a 46 GB volume and returned nothing. It was
reverted and the pull request closed.

The habit that saved it is cheap and general: **when a fix can be simulated
without deploying it, simulate it first.** A symlink, an environment variable, a
scratch directory - anything that produces the predicted effect if the theory is
right. A true fact that explains the observation is not the same as the cause,
and the only thing that tells them apart is making the change and watching for
the effect.

## The store holds what is shared; the workspace links stay home

Eight of eleven worktrees carried their own `node_modules` at 2.5 GB - about 19
GB of identical packages on a 46 GB volume. Every lockfile hashed the same, so
the dependency set is genuinely one set and sharing is sound rather than
convenient.

**The obvious version breaks on the first test.** Move `node_modules` somewhere
shared, point at it, and:

    error: Cannot find module '@browseros/shared/constants/limits'

A bun (or npm, or yarn) workspace links its OWN packages by relative path inside
`node_modules`. Shared away, those links resolve against the store instead of the
worktree and find nothing. This is precisely the wall pnpm's virtual store was
designed for, and it is cheaper to recognise than to rediscover.

The arrangement that works:

    store/<lockhash>/.../node_modules   the external packages, once
    worktree/.../node_modules/          a REAL directory of links into the store
    worktree/.../node_modules/@scope/*  linked back to THIS worktree's packages

Key the store by the lockfile hash, so a worktree whose dependencies differ gets
its own store rather than the wrong packages.

Measured: 2536M -> 159M and 2561M -> 159M with tests passing through the farm,
then six more trees and 14.3 GB returned in one pass.

**Refuse three things.** A tree whose bee is running - rebuilding node_modules
under a live install kills the dispatch for a reason nobody can reconstruct. A
bare checkout with no private install, which has nothing to share and must not be
emptied. And everything, when the board cannot be read.

**And the shape of the whole series:** three measurements went into this volume.
A watermark, then removal on completion, then this. The first two were correct
and could not win, because they addressed collection while the problem was
production. When a resource keeps filling despite correct collection, the next
measurement is of the creation rate - not a better collector.

## Three negative results, and one of them was my own bug

The claim was that one shared package store would collapse the volume growth. An
hour later: 52% used, +133.6 points per hour. Sharing after the fact is a mop -
every dispatch still runs `bun install` and writes 2.5 GB.

So three ways to close the tap were tried, each in a scratch worktree, each
before a line of it entered the system:

| attempt | result |
|---|---|
| put the package cache on the same volume | three installs, `links=1`, three different inodes - bun copies out of its cache whatever device either is on |
| build the link farm BEFORE the install | 159M with the farm, then `bun install` wipes it and writes 2562M |
| `--backend=symlink`, and a repo `bunfig.toml` | 41M on a single-package project, **2561M on this workspace** - and the bunfig was ignored entirely |

**The second one was wrong, and it was my bug that made it look right.**

`for e in "$src"/*` does not match dotfiles in POSIX sh. The store root has
sixteen entries; that glob linked fourteen. The two it missed were `.bin` and
`.bun` - bun's entire isolated store, 2242 entries and 2.37 GB. bun could not
see the tree as satisfied, so it rebuilt everything, and I recorded "a pre-built
farm cannot survive bun install" as a measured refutation.

With the dotfiles linked, on a live farmed worktree:

    Checked 2250 installs across 2424 packages (no changes) [948.00ms]
    after install: 159M

**A negative result is only as good as the instrument that produced it.** The
discipline of testing before shipping is right and it saved two genuinely wrong
changes - but a refutation deserves the same scepticism as a confirmation, and
the tell here was available: the farm had 14 entries and the store had 16, a
number I printed in the file's own header and never compared.


## A command name silently shadowed a scheduled job for its whole life

`ai.t27.trios-feed` runs `tri feed --act` every 300 seconds. The loop's feed step
never once ran from it.

    92 command label(s), 1 SHADOWED:
      feed: first wins at line 37, unreachable at [390]

A shell `case` takes the FIRST match, and `feed)` appeared twice in `tri` - a
content feed at line 37 and the loop's own at line 390. The timer had been
calling the content feed for its entire life. That is why the timer log filled
with post titles, why the ledger held no `feed` entry, and why there were zero
`feed-skipped` records: it never reached the lock check because it never reached
the loop.

Nothing in the system could see it. Not the shell, which is happy. Not the timer,
which reported exit 0. Not the log, which filled with plausible output from the
wrong program.

**Scan for it mechanically.** The selftest now parses every `case` label in `tri`
and fails on any an earlier one shadows - and fails too if it parses fewer than
50 labels, so a scanner that stops seeing the file cannot pass as a clean result.

This is the second time in a week a scheduled job reported success while doing
something other than its job. Both were invisible for the same reason: **the
thing that runs and the thing that checks were the same thing.**

## Attempts bound how many times to ask; only a deadline bounds how long

The first two real runs of the newly-reachable feed both recorded
`share-modules: timed out`. Arithmetic, not luck: the app-down backoff waits 15
seconds then 30, multiplied by four - 180 seconds of sleeping across three
attempts - inside a caller that fires every 300 and caps a step at 300.

A retry policy expressed only in attempts has no idea what it is costing. Give
the channel a total budget and let it stop before a wait that would pass it. That
is not giving up; it is refusing to spend the caller's whole allowance on
waiting, so the caller reports what happened instead of being killed mid-sleep
with nothing to say.

Hand the budget DOWN from the caller that owns the clock - the feed passes 80% of
its own kill timer - and leave the step room to report after the channel gives
up.

## The gateway everything depends on works 39% of the time

The paired probe, 18 samples taken with both views at one moment:

    both up                  7   39%
    HTTP ok, ssh REFUSED    11   61%   app-down
    both down                0
    ssh up, HTTP down        0

Every operation that frees the swarm - reap, lease, push-work, close-done,
rescue, share-modules - reaches the container through that one gateway. It
refuses about three times in five while the service answers HTTP perfectly.

This is the explanation for the 46-71% step failure rates quoted for three
rounds, and it is now a measured rate rather than an anecdote. It also explains
why manual runs "work": a person retries until the window opens, and a timer does
not.

**When one dependency is shared by every critical path, measure its availability
before tuning anything that sits on top of it.**

## Check which binary you are running before believing anything about the service

For three rounds this loop quoted step-failure rates of 46-71%, built a retry
policy, a circuit breaker and a total budget on top of them, and measured a
"gateway availability" of 39%.

    /bin/zsh -lc 'command -v railway'   /usr/local/bin/railway   4.5.4 (Jun 2025)
    an interactive shell                nvm's railway            5.49.2

Both launchd plists run `/bin/zsh -lc`, and the login profile puts
/usr/local/bin ahead of the nvm bin. The decisive check took one command:

    LC_ALL=C grep -ac "Expected welcome message" <each binary>
    -> 1 in 4.5.4, 0 in 5.49.2

That string wraps EVERY app-down refusal in the record. Every launchd sample was
refused by a client that cannot attach; every successful attach in the entire
history came from a hand run with the newer binary.

It was not the container, not Railway, not the network, and not something to
tune. It was a PATH, and it was invisible because **the hand test and the
scheduled run were different programs** - the oldest trap there is, and the one
this loop walked into while carefully measuring everything downstream of it.

Two habits from it:

- **When a scheduled job behaves differently from your hand test, compare the
  programs before comparing the environments.** `command -v` under the job's own
  launcher, and the version, and if the failure has a distinctive string, grep
  the binaries for it.
- **Name the binary in the code**, next to wherever the project id and service
  name already live. A bare command name is a dependency on somebody's profile.

## Before measuring a change, measure when the change took effect

I named the railway binary, then tested whether it helped by splitting the
paired record at 07:30 UTC. The result looked like a refutation: 35% before, 33%
after.

`channel.mjs` was modified at **08:13 UTC**. Both "after" failures were at 08:08
and 08:14 - one before the edit existed, one from a run already in flight. The
window was chosen from memory of roughly when I had been working, not from the
file's mtime.

Split at the real boundary:

    before 08:14 (old binary)   7 of 22 attached   32%
    after  08:14 (named path)   4 of 4            100%

and the first fully clean feed run in the loop's history followed immediately -
push-work, land, close-done, share-modules, author, all ok.

**The cutoff is a measurement too.** `stat -f %Sm` on the file, or the commit
timestamp, or the deploy time - never "around when I did it". This project has
made the same error before, in the other direction: an acceptance rate of 17%
measured over a window still in flight, which read 80% once judged.

The tell is cheap: if a before/after split shows almost no change, check the
boundary before believing it. A fix that does nothing and a fix measured on the
wrong window look identical.

## Pin a capability, not a path

Naming the railway binary fixed the loop and introduced a slower defect:
`$HOME/.nvm/versions/node/v22.22.0/bin/railway` hardcodes a node version nobody
will remember to update. An adversarial reader found it within the hour.

Search the candidates and take the first that reports the version you need:

```bash
"$c" --version   # major >= 5 wins; 4.5.4 is rejected for BEING 4.5.4
```

**Reject by the property that matters.** The old client's problem was never its
location - it was that it cannot attach, and its version says so. A path is a
proxy for that, and proxies rot.

And when nothing qualifies, say so loudly and fall back. A loop that silently
picks a client which cannot attach is what cost this project three rounds of
measuring the wrong thing.

## Fixing the thing makes the steps slower, and the budgets were tuned on failure

`share-modules` was put on the 300-second timer when the channel refused three
times in five - the step did nothing, quickly. With a working client it does real
work, and its first two working runs both recorded `share-modules: timed out`.

Nothing regressed. A step that had been failing fast started succeeding slowly,
and every deadline in the chain had been calibrated against the fast failure.

**When a shared dependency starts working, re-examine every timeout that was set
while it did not.** The previous round's own design note predicted this in as
many words - "expect the first working runs to hit a deadline for an entirely new
reason" - which is worth more than the fix it accompanied.

## A crash is the end of a process nobody was watching

The service returned 502 and `railway status` said `Crashed`. The deployment log
had been saying why since forty minutes earlier:

    Filesystem tool execution failed  tool="filesystem_bash"
    error="EAGAIN: resource temporarily unavailable"

EAGAIN on `posix_spawn` means the container could not FORK. A fresh container
sits at 65 of 1000 process slots with zero zombies, so the exhaustion
accumulates: unreaped children fill the pid table, the app stops being able to
run a command, and then it dies.

Nothing about that is sudden. It was a rising number for forty minutes and
nobody had an instrument pointed at it.

```bash
cat /sys/fs/cgroup/pids.current /sys/fs/cgroup/pids.max
ps -eo stat | grep -c '^Z'
```

The paired probe already attaches every chain run, so it asks these two questions
while it is there and the dashboard carries the percentage. **When you find a
resource that a crash consumed, add its meter before you add its fix** - the
meter works without a deploy and tells you whether the fix worked.

## Fixing the instrument reveals the vocabulary you never had

Every failure this loop had ever recorded was wrapped in "Expected welcome
message" - a string that exists only in the client that could not attach. With a
working client, the container's real failures arrived at once:

    Connection to ssh.railway.com closed by remote host

classified `unknown`, therefore never retried.

That is not a new bug. It is the shape of a classifier built entirely from the
output of a broken instrument: it knew one string perfectly and the real world
not at all. **After repairing an instrument, expect its whole vocabulary to be
new, and re-derive the classifier from the first days of real output rather than
from the years of artefact.**

## PID 1 in a container must be an init, or the orphans stay forever

The service crashed because it could not fork. Measured from `/proc` on the
running deployment:

    pid 1 is: bun
    50 processes, 37 zombies
    zombies whose parent is PID 1: 37   with another parent: 0
    git (21), esbuild (16)

The bash tool spawns `sh -c <command>` and does `await proc.exited`, so its
direct child is reaped correctly. The GRANDCHILDREN are the problem: when the
shell exits, `git` and `esbuild` are orphaned and reparented to PID 1 - and PID 1
here was `bun`, an application, which never calls `wait()` for children it did
not start. They stay zombies for the life of the container, the pid table fills,
`posix_spawn` returns EAGAIN, and the service dies.

    ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]

`tini` reaps orphans and forwards signals. It is what `docker run --init`
installs. Verify by asking, not by assuming: `cat /proc/1/comm` should name the
init, not your application.

**It held.** Measured a day later, with the swarm working:

    PID1 tini
    PIDS 161/1000
    PROCS 15 ZOMBIES 0

That is 310 finished dispatches through the new PID 1 with no accumulation,
against 37 zombies of 50 processes before it - and the chain's last eight runs
show push-work, land, close-done and author all at 0%. A fresh container starts
near zero anyway, so the reading that matters is this one: zombies at zero while
161 process slots are in use.

**Awaiting your own child is not enough.** Any tool that runs a shell command
inherits that shell's children when it exits, and in a container that inheritance
lands on PID 1.

## A check whose tool is absent reports health

The meter built to watch for that crash counted zombies with
`ps -eo stat | grep -c '^Z'`. The image has no `ps`. The pipeline produced
nothing, the count was 0, and it read as "no zombies" for a full round while
there were 37.

This is the fourth instance of one shape in a week:

    df /              a sealed macOS snapshot at 55% while the real volume was 97%
    tri feed          a shell case taking an earlier match, so a timer ran another program
    railway           a client that could not attach, wrapping every failure in one string
    ps -eo stat       absent, so its absence read as zero

Every one answered confidently about the wrong thing, and none of them errored.
**Before trusting a count of zero, prove the instrument can produce a non-zero.**
Read `/proc` rather than `ps`; check `command -v` for anything you shell out to;
and report the denominator beside the count, because 37 of 50 and 37 of 5000 are
different facts and a bare 0 hides which one you are not seeing.

## Two overlapping outages make each look like it was not the cause

Naming the railway client should have collapsed the step failure rates. Split at
the fix:

    reap 73% -> 70%   lease 60% -> 70%   push-work 57% -> 67%   author 4% -> 44%

which reads as "the fix did nothing, and made one thing worse". Twelve of 147
recorded failures even named the old client.

**The window after the fix contained a three-hour service crash.** Split into the
three periods that actually happened:

    window          reap     lease   push-work  close-done   author
    old client     61/83     50/83     57/100      41/100      4/96
    crash window     6/6       6/6      22/22       16/22     16/22
    after restore    1/2       1/2       1/7         0/7       0/7

Both fixes worked. Neither could be seen while the other's window was mixed in -
and a total outage dominates every rate it touches, so the crash buried the
client fix completely.

This is sharper than "split at when the fix landed": something else may have
started between then and now. **Before reading a before/after, list every event
in the window, not just the one you are testing.**

## A rate on a dashboard must have a window, and the window needs a reason

A lifetime rate over a record containing two resolved outages describes neither
the past nor the present. The dashboard read `worst step: reap 74%` from exactly
that.

It reads the last eight chain runs now - about an hour. The size was chosen by
measurement, not by which number flattered: push-work reads

    0/5    2/8    6/12    14/20

and that gradient IS the crash receding. Eight is short enough to describe now
and long enough that a fresh incident still shows, which is the only reason to
put a rate on a dashboard at all. Changing nothing but the question moved the
number from 74% to 50%.

Say the window in the label - `worst step, last 8 runs` - so nobody has to guess
which question they are reading the answer to.

## The fifth blind instrument accused forty-two workers of silence

`judge-packet.mjs` assembles what a judge reads about a bee's work. It kept its
own `railway` with no path, so under the timers it got the client that cannot
attach, and `catch { return null }` turned the refusal into a verdict:

    ## The bee said nothing that was recorded, so every quoted-run criterion is
    ## UNVERIFIABLE by absence

Isolated by PATH alone, container healthy, same minute:

    transcriptOf(1351)                            79568 characters
    the same call under PATH=/usr/local/bin:...   null

**All 42 packets ever written carry that line. All 42 of those bees had a
transcript** - 4,476,899 characters between them, from 7,933 to 292,942 each.
Forty-two accusations of silence, produced by a tool that had never once
succeeded in asking.

A query that returned no rows and a channel that could not be reached were the
same `null` and opposite facts. Whenever a fetch can fail, its failure needs its
own value, and the rendering must say *the transcript could not be fetched* -
never something about the subject.

**And the guard for exactly this defect could not see it.** The check "the loop
names the railway binary it runs" iterated `['channel.mjs',
'stale-escalations.mjs']`. It scans the whole directory now, and found a sixth
file on its first widened run. A guard scoped to a list cannot see the file
somebody adds next; scope it to the directory and exclude only itself.

Four unused copies of the same constant were deleted from other files. **An
unused copy of a defect is how the next paste resurrects it** - which is exactly
how this one got there.

## A step the chain killed itself is not a step that succeeded

`feed.mjs` classifies its own timeout kill. `heal.mjs` never had that arm -
`git log -S ETIMEDOUT -- heal.mjs` is empty - so a step SIGTERMed at heal's own
`timeout:` produced no output, matched no pattern, and fell through to `ok`.

    heal.timer.log    62 lines reading `(no output)`, every one recorded ok
    feed.timer.log    0

Twenty-five of `land`'s thirty-six `ok` records describe a step that produced not
one byte.

**When two components do the same job, diff their vocabularies.** One had a
branch the other never grew, and the missing branch was in the part that decides
what the record says - so the record has been quietly wrong for as long as it has
existed.

The same round found the announcement line printing `${f.summary}` for FINDING
records, where `summary` is set only on SKIPPED ones. Every finding it ever
announced printed `undefined`: the one word the operator was meant to read.

## The rule that comes out of all of them

Do not add fuel to a stopped swarm until `tri swarm` and `tri fence` say fuel is
what it lacks. Three of the four causes above are silent, and all three produce a
backlog that looks starved.

And the wider one, which every section here is an instance of: **a stated cause
is a hypothesis, not a fact.** Its sharpest form, from the round that measured a
sealed snapshot instead of the disk and read a section that was not there: **a
measure that answers is not a measure that is right, and the confident answer is
the dangerous one - a broken tool that stayed silent would have been found in an
hour.** The swarm blames the issue when the parser was
broken; my checkers blame the worker when the checker was narrow; I blamed a bee
on a judge's word without opening the diff. Re-measure before acting on any of
them.

See also: `queen-briefing` (how to write an issue a bee can pass),
`trios-live-forensics` (read the running system before changing code),
`unmeasured-cause` (the defect class all four of these belong to).
