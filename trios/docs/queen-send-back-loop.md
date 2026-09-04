# The Send-Back Loop — a Verdict That Reaches the Bee

Issue: gHashTag/trios#1329

## What this document is

The specification for the send-back loop: what must happen in the round
after the Queen's review answers `sendBack`, so that work which is nearly
right goes back to the bee that made it instead of waiting for a person.

It is written against the code as it stands. Every claim about present
behaviour names the file and symbol that holds it, and the ones that were
checked by running something say how they were checked (see
[Verification](#verification-of-the-present-state)). The companion
document [`queen-verdicts.md`](queen-verdicts.md) describes the verdicts
a criterion can carry and how the Queen may set them; this one describes
what the `sendBack` verdict must DO.

**Status, stated plainly because a quiet skip is how a gate comes to
report success it never earned.** This document specifies; the mechanism
it specifies is not in the code. The boundary of the issue that asked for
it is this file alone, so the implementation is future work under the
paths named here. Of the four success criteria in the issue, two hold in
the code today (verified below) and two do not; the specification exists
to make the other two landable without a second design conversation.

## The problem

`QueenReviewDecision.decide`
(`agent-server/queen-core/Sources/QueenCore/QueenReviewDecision.swift`)
answers `.sendBack(unmet:)` with the unmet criteria named, and
`reviewFinishedDispatches`
(`agent-server/apps/server/src/api/services/queen-tick.ts`) records the
verdict — `review_state = 'sendBack'`, the note, and the count — and
stops. The header of `queen-tick.ts` says so in its own words: *"What the
loop still does NOT do: send a bee back."*

Nothing reopens the worker on the named gaps. What the swarm has instead
is a release valve, not a loop:

- A fresh send-back reads as `rejected` on the board
  (`stateOfDispatch`), and `QueenDelegationPolicy.claimOnIssue` counts
  `rejected` as a live claim — *"the same bee is expected to return to
  those files"*. Nothing returns, so the issue is held by its own failed
  attempt. That was measured in production on 2026-09-04: 18 of 28 open
  issues skipped as `claimed`, the send-backs among them holding
  themselves.
- After `SEND_BACK_IDLE_FLOOR_MS` (one hour) with attempts left, the
  valve maps the row to `failed`, and the generic choose loop may pick
  the issue up again — an hour late, through the same door as a first
  attempt, and with the FULL brief: every criterion, met and unmet
  alike (`briefFor` lists whatever `criteria` it is handed, and the
  dispatch loop hands it the issue's whole set).

So a bee that missed two criteria out of nine parks its issue exactly
like one that failed outright, and the person the system exists to not
need is the only path from "nearly done" to "done".

## The design

Six rules: five carry the requirements of the issue, and the sixth is
owed by the file's own header, which has recorded the same lesson twice.

### 1. The verdict names the unmet criteria; the row keeps them (FR-003, FR-004)

`queend`'s review answer carries the unmet criteria as a structured list
(`unmet: [String]`, `queend/main.swift`, the `.sendBack` arm). The
container drops them on the floor today; only the prose note survives,
and the note is truncated to 900 characters when stored
(`String(answer?.note ?? ...).slice(0, 900)`). `parseVerdictBlock`
slices each criterion to 300 characters, so four unmet criteria of honest
length can overflow the note — parsing the note back would be reading a
list through a keyhole that is known to clip it.

The round must persist the structured list in the SAME `UPDATE` that
records the verdict and increments the count:

- New column, added where the other queen columns are
  (`ensureQueenColumns`): `unmet_criteria jsonb NOT NULL DEFAULT
  '[]'::jsonb`.
- The review statement sets `unmet_criteria = CASE WHEN $2::text =
  'sendBack' THEN $n::jsonb ELSE '[]'::jsonb END`, so the column always
  means "the unmet criteria of the verdict now on the row" and never a
  stale list from an earlier pass.

One write, not two. The count is already in that statement for the
reason its own comment gives — a count kept by a second write is a count
a crash between the two makes wrong in the direction that never
escalates — and the unmet list joins it for the same reason: a return
briefed on a partial list is a return that will be sent back again for
the part nobody named.

### 2. A return is a dispatch, not a release (FR-001)

A new step in `runRound` — `returnSentBackDispatches`, say — that
dispatches the due returns before the round chooses anything new.

**Which rows are due.** `started = true`, `finished_at IS NOT NULL`,
`review_state = 'sendBack'`, `coalesce(outcome, '') NOT LIKE 'reaped%'`,
and `unmet_criteria <> '[]'::jsonb`. The issue must still be open —
intersect with the round's candidate list, which the round has already
fetched. A send-back recorded before the column existed (the default
`'[]'`) is not due: it has no brief to return with, and the existing
idle valve already releases it after an hour on today's terms. A row
with an empty list is not a special case to patch over; it is a verdict
this loop never made.

**Placement is the whole of "the next round".** The step runs after the
open-issue list is known and BEFORE `reviewFinishedDispatches`. A
verdict is therefore recorded in round N and dispatched in round N+1 —
exactly the acceptance scenario ("when the next round runs") — with no
timestamp fence to keep honest. The sweep re-reads only `NULL` and
`'wait'` rows, so a `'sendBack'` row is stable between the round that
records it and the round that returns it.

**Returns come before new work, under the same ceiling.** A return is
work already paid for once and nearly right; a new issue is neither. The
step counts running tasks on the merged board (registry mirror plus this
container's dispatches) and dispatches returns only while below
`QueenDelegationPolicy.maximumConcurrentWorkers`. Leftovers stay due and
go next round — nothing is dropped, nothing is queued.

**Every dispatch rule applies.** The step goes through `dispatchBee`
with the round's `takenKeys`, folds each return into the board and the
key set as the generic loop does, pushes into the same `started` array
the round returns (that array is the "started list" the acceptance
criterion names), and checks `watch.held` before each dispatch — every
write below the choice is unfenced, which is the whole reason the
lease-lost cases in `queen-round.test.ts` exist.

### 3. The same worktree, the same branch (FR-002)

`prepareWorktree` is already idempotent: an existing
`.worktrees/queen-<issue>` is reused, the branch `queen-<issue>` keeps
the previous pass's commits, and the leftovers are counted and reported
rather than cleaned — the container holds no push credential, so
unpushed work in that tree is the only copy of it. A return therefore
needs no new code here. What it must not do is route around
`dispatchBee`: a bespoke path that cut a fresh tree would hand the bee a
clean checkout and hide its own previous work from it, which is the one
thing FR-002 exists to prevent.

### 4. The return brief: every unmet criterion, none of the met ones (FR-003)

The same skeleton as `briefFor` — the issue in full, the boundary, the
branch and worktree sentences, verification, out of scope, finishing,
the verdict block — with two differences:

- A return header naming the pass: *"This is your second pass. Your
  previous pass was reviewed against the issue's criteria and met all
  but these; the Queen is returning the work on them."* The pass number
  is `send_backs` as it stands on the row: the increment is part of the
  verdict statement, so the count has already moved by the time the
  return is dispatched — the first return reads 1, the second reads 2,
  matching `sendBackNote`'s `attempt` arithmetic without a `+1` at this
  layer.
- The "What you will be judged by" block is `criteriaBlock` fed exactly
  `unmet_criteria`, with the row's `criteria_source` so the provenance
  sentence stays true.

**The dispatch row's contract narrows with the brief.** `recordDispatch`
is called with `criteria = unmet_criteria`, not the full set. This is
not a convenience; the alternative is a loop that cannot converge. The
next review reads `totalCriteria = max(promised.length,
verdicts.length)`: a row that promised nine while the brief named two
would get a two-line verdict block back and the policy would answer
`wait` — "2 of 9 criteria judged so far" — for ever, because the
transcript of a finished bee never changes. The narrowed row is what
keeps the second pass decidable. The trade-off is stated rather than
hidden: a criterion met on pass one that regresses on pass two is
outside the pass-two verdict contract (it remains in the issue body the
bee is handed in full, and the boundary check still runs on the commit);
the contract is judged across passes, and the alternative is no loop at
all.

**The fallback path must keep the same promise.** A return that cannot
dispatch — every key busy, a worktree failure — is recorded with
`started = false`, and that path of the `recordDispatch` upsert
preserves `review_state`, so the next round retries it. If it sits past
`SEND_BACK_IDLE_FLOOR_MS`, the valve maps it to `failed` and the GENERIC
loop may choose it; that loop builds its brief from the issue body
unless it checks. So the brief construction for any dispatch of an issue
whose row still carries `review_state = 'sendBack'` with a non-empty
`unmet_criteria` must be the return brief. FR-003 binds every path that
dispatches an undischarged return, not only the happy one.

### 5. The ceiling is the policy's alone (FR-004, FR-005)

`send_backs` is incremented by exactly one statement in the system — the
review `UPDATE` — and by nothing else. The return step does not touch
it; the `recordDispatch` upsert does not name it, so it accumulates
across attempts, which is why it lives on the row.

The return step does not re-check `maximumSendBacks`, on purpose. The
ceiling is enforced where the verdict is made: at `priorSendBacks = 2`
the policy answers `escalate` and no third `'sendBack'` is ever
recorded, so a row can hold `review_state = 'sendBack'` with
`send_backs` of at most 2 — and 2 is precisely the count of the second
return, which must still go. A second counter in the container is two
statements of one rule agreeing until someone edits one of them.

After an escalation, three independent doors keep the issue still:

1. `escalate` maps to `awaitingReview` (`stateOfDispatch`), which
   `claimOnIssue` counts as live — the generic loop skips it.
2. The idle valve never releases an escalation — its own test's words:
   *"it asks for a person, and a timer is not a person."*
3. The return step selects `review_state = 'sendBack'` only, and an
   escalation wrote `'escalate'`.

### 6. The header sentence dies in the same commit

The implementing commit must remove or narrow *"What the loop still does
NOT do: send a bee back"* from the `queen-tick.ts` header. That file's
own header records, twice, a "does not do" claim outliving its truth and
being caught by a sweep rather than a reader. A third entry for the same
reason is a choice, not an accident.

## The acceptance criteria, as checkable claims

The four success criteria of the issue, each with where it stands today
and what makes it true.

| # | Criterion | Today | Made true by |
|---|-----------|-------|--------------|
| 1 | A dispatch whose review answered sendBack appears again in the following round's started list | **Not met.** A fresh send-back is `rejected`, `claimOnIssue` holds it, `queend` skips the issue (verified by probe, below); release comes an hour later through the generic door | Rule 2: the return step, next round, into `started` |
| 2 | Its brief contains every unmet criterion and none of the met ones | **Not met.** `briefFor` lists the full criteria set on every dispatch; the structured `unmet` is discarded | Rules 1 and 4: the stored list, the return brief, the fallback |
| 3 | `send_backs` on the row increments by exactly 1 per return | **Met.** The increment is a `CASE` inside the statement that records the verdict; held by the test *"increments only on a send-back, in the statement that records it"* | Rules 1 and 5 keep it: no other writer, preserved across re-dispatch |
| 4 | After two returns a third review answers escalate and no further dispatch occurs | **Met.** The policy escalates at `priorSendBacks = 2` (verified by probe); an escalated row is `awaitingReview`, live to `claimOnIssue`, never released by the valve; held by *"escalates at the ceiling instead of returning for ever"* and *"never releases an escalation"* | Rule 5 keeps it: no second ceiling, three doors stay shut |

## Tests the implementation must add

In `queen-round.test.ts`, beside the send-back cases that already run
against the real binary:

1. **Next round, not this one.** A finished row whose transcript yields
   `sendBack`: the round that reviews records the verdict and starts
   nothing for the issue; the round after has the issue in its started
   list.
2. **The brief is the gap and only the gap.** The return brief contains
   each unmet criterion verbatim and none of the met ones; the dispatch
   row recorded `criteria` equal to the unmet list.
3. **The count does not move on a return.** `send_backs` is unchanged by
   the return dispatch, and exactly one `UPDATE ... send_backs + 1`
   exists per `sendBack` verdict.
4. **The ceiling holds.** At `send_backs = 2` with
   `review_state = 'sendBack'`, the return dispatches (it is the second
   return); with `review_state = 'escalate'`, nothing dispatches, on any
   path, however long the row sits.
5. **The fallback briefs the gap too.** A `'sendBack'` row released to
   `failed` by the idle valve and chosen by the generic loop still gets
   the return brief.

## What this change does not do

Out of scope, raised here rather than done quietly:

- **The Mac app's own send-back count.** `DelegatedTask.sendBacks`
  (`rings/SR-00/QueenDelegation.swift`) and the container's
  `queen_dispatch.send_backs` are counted in two places that never see
  each other. Unifying them is a registry question, not a round
  question, and belongs to its own issue.
- **Escalation delivery.** `escalate` records and reports; how the
  person it asks for is told is unchanged by this loop.
- **No new policy arms, no new states.** `stateOfDispatch`, the idle
  valve, and the frozen-wait valve stay exactly as they are; the return
  step is a caller of the pieces that exist.

## Verification of the present state

How the "Today" column above was checked, on this checkout, with the
real policy binary (`/usr/local/bin/queend`, the same build the
container runs):

- `queen-round.test.ts`: 22 pass, 0 fail — including *"returns a first
  failure for a second pass"*, *"names the pass it is actually asking
  for"*, *"escalates at the ceiling instead of returning for ever"*,
  *"increments only on a send-back, in the statement that records it"*.
- `send-back-lease.test.ts`: 16 pass, 0 fail — the valve holds a fresh
  send-back, releases it past the floor with attempts left, holds it at
  the ceiling, and never releases an escalation.
- `queen-dispatch.test.ts`: 50 pass, 0 fail — including worktree reuse.
- Direct probes of the binary: `review` at `priorSendBacks` 0, 1, 2
  answers `sendBack`, `sendBack`, `escalate`; `choose` with a task in
  state `rejected` skips the issue (*"a worker has it or is expected
  back"*) and picks another; with state `awaitingReview` likewise.

What was NOT run: any implementation of this specification — none
exists. The two unmet criteria above are unmet in code, and this
document, not a behaviour change, is the deliverable the issue's
boundary permits.
