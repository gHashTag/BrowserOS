# Queen Selection - Which Task Starts Next, and Why the Others Did Not

Issue: gHashTag/trios#1312

## What this document is

The operator's guide to the Queen's next-task decision: where candidates
come from, the order the rules fire in, and the evidence every refusal
leaves behind. It answers the two questions an operator actually asks -
"why did THAT task start while this one stayed blocked?" and "why is a
slot idle when the board is full of open issues?" - from endpoints and
issue text alone, without provider logs or transcripts. It changes no
scheduler behavior. Where a statement is a fact an endpoint shows, the
document says so; where it is an inference from the current
implementation, it says that too.

## Where candidates come from

The authoritative candidate source is the supervised repository's open
issues on GitHub. Each round lists them (`state=open`), drops pull
requests - a PR is finished work waiting for a verdict, not work to
delegate - and hands the issue numbers, with their bodies, to the
chooser, which runs in the cloud container rather than on a laptop. The
round then either dispatches what the chooser picked or records why
nothing was picked.

Two more inputs complete the decision:

- The board of delegated tasks: the registry mirror plus the cloud
  tick's own in-flight dispatches. A cloud bee the mirror has not seen
  still counts, or a round could choose the same issue again half an
  hour later and cut a second branch over the first one's work.
- Each candidate's issue body, from which the chooser reads the
  boundary section itself - one parser deciding, not two that agree
  until one of them is edited.

The request that lists the issues passes no sort parameter, so GitHub's
documented default order applies: newest created first. That ordering is
an inference (see "Facts and inferences" below) - but it matters,
because the chooser takes the first eligible candidate in list order.

## The decision order

Capacity first, then money, then per-candidate gates in candidate list
order. The first candidate that passes everything is chosen; every
candidate is still examined after a choice, so the recorded refusals
cover the whole list.

| #  | Gate           | What fires it                                                       | What the operator sees |
|----|----------------|---------------------------------------------------------------------|------------------------|
| 1  | Capacity       | Running tasks already at the concurrent-worker limit                 | Round-level refusal: `N workers already running (limit M)`. No per-candidate skip list exists for this round. |
| 2  | Budget         | The estimated daily USD cap is exhausted (metered billing only)      | Round-level refusal naming the spend, the limit, and `TRIOS_SWARM_DAILY_CAP_USD`. |
| 3  | Claim          | A live task exists on the issue: `queued`, `running`, `awaitingReview`, or `rejected` | Skip reason `claimed`. |
| 4  | Completion     | Work on the issue was `accepted` or `merged`, and nobody closed it   | Skip reason `completed`. |
| 5  | Spec/boundary  | No issue body, or the body declares no usable boundary paths         | Skip reason `missingBoundary`. |
| 6  | Spec quality   | Boundary present, other mandatory spec sections missing             | Skip reason `incompleteSpec` - recorded as a warning, NOT a refusal; the candidate stays eligible. |
| 7  | File hold      | Another task that still holds its boundary owns an overlapping path  | Skip reason `fileConflict`. |
| 8  | Order          | Eligible, but an earlier-listed candidate was already chosen         | Skip reason `notFirst`. |

Only the running count feeds gate 1. A finished dispatch waiting for
its verdict holds its issue and its files but does not occupy a worker
slot, so "busy" and "blocked" are separate readings - a swarm can be at
zero running workers and still refuse every candidate.

One answer names one bee. After a successful dispatch the round folds
the new task into the board and asks again, so a single round can start
several bees back to back until the chooser refuses. That is why one
tick sometimes leaves more than one dispatch row behind.

## The evidence for each refusal

Every refusal is a sentence. `/queen/lease` (private) returns those
sentences verbatim; they name the issue number, the paths it wanted, and
the tasks holding them. `/queen/status` (public) reduces them to the
closed category counts of `lastTick.skipSummary`. The categories:

### `claimed`

The issue is spoken for by a live task - a worker has it now or is
expected back on it (`queued`, `running`, `awaitingReview`, or
`rejected`; the sentence carries the state). `rejected` counts as live
on purpose: the Queen sent the work back and the same bee is expected to
return to those files. An issue whose every task is `cancelled` or
`failed` is NOT claimed - failure is the state that most obviously means
"do this again", and it frees the issue for a fresh attempt.

### `completed`

The work already landed - a task on this issue is `accepted` or `merged`
- but the issue is still open, so the chooser would otherwise redo
finished work. This category has landed duplicates in this repository
before. The operator action is to close or re-scope the issue, not to
wait: no amount of idle capacity makes this candidate eligible.

### `missingBoundary`

The issue never said what it touches, so nothing can be reserved for
it: either no body was supplied at all, or the body has no boundary
section the parser can read. This is not an empty conflict set - it is a
task whose scope is unknown, and starting a bee on it means finding out
by collision. It is also, historically, the commonest reason a swarm
looked starved. The fix is an edit to the issue, not to the scheduler.

### `incompleteSpec`

The issue declares a boundary - so it is delegatable - but is missing
one or more of the other mandatory spec sections (user scenarios,
requirements written as obligations, or measurable success criteria).
The sentence names the gap. This reason is recorded while the candidate
REMAINS eligible: refusing outright would stall the swarm on paperwork,
and the next review is the right place to judge substance. So an
`incompleteSpec` count never, by itself, explains an idle slot - if it
appears alongside `allowed: false`, something else blocked every
candidate too.

### `fileConflict`

The candidate's declared paths overlap a boundary another task still
holds. Overlap is by path component, not by string: `docs` holds
everything beneath it, so `docs/live/queen/` conflicts with a task
holding `docs/`, while `docs` and `docsite` share a prefix and nothing
else. A task holds its boundary while `queued`, `running`, or
`rejected`; an `awaitingReview` task holds it for a bounded wait (48
hours in the current implementation) so a forgotten review cannot freeze
the swarm forever; terminal tasks hold nothing. The operator action
depends on the holder's state: review the finished work, or wait for the
active bee.

### `notFirst`

The candidate was eligible, but this round's answer already chose an
earlier-listed one. It is not a defect in the candidate; the next answer
(or the re-ask inside the same round) may well choose it. A `notFirst`
count above zero means the round DID choose something.

One candidate can contribute more than one reason in one answer - an
`incompleteSpec` warning plus a `notFirst`, for instance - so
`skippedCount` counts reasons, not candidates.

## Diagnosing an idle slot

Queen reports `nothing to choose` only when capacity and budget passed
and every candidate was individually skipped. Read `/queen/status`:

| Observation | Reading | First action |
|-------------|---------|--------------|
| `lastTick.refusal` is `N workers already running (limit M)` | Capacity is full - this is NOT `nothing to choose` | Nothing; slots free as bees finish |
| `lastTick.refusal` names the daily spend and limit | The estimated-USD gate refused (metered mode only) | Raise `TRIOS_SWARM_DAILY_CAP_USD` or wait for the day to roll |
| `lastTick.refusal` is `nothing to choose`, `skipSummary.completed` > 0 | Work landed but issues were never closed | Close or re-scope those issues |
| ... `skipSummary.claimed` > 0 | Workers hold the issues now or are expected back | Check `dispatches.running` and `dispatches.unreviewed` |
| ... `skipSummary.fileConflict` > 0 | Boundaries are held by other tasks | Review the finished holds; active bees release on completion |
| ... `skipSummary.missingBoundary` > 0 | Issues lack a boundary section | Edit the issues to declare their paths |
| ... only `incompleteSpec` and nothing blocking | Should not occur: incomplete specs stay eligible | Treat as an anomaly and read `/queen/lease` |
| `swarmState` is `unavailable` | No readable decision vouches for the quiet | Check the scheduler is enabled and a tick exists |
| `swarmState` is `healthy_idle` | The round ran and honestly found nothing eligible | Nothing; this is health, not failure |

A refusal is a sentence and its absence is the permission; `lastTick.allowed`
says which, and never needs inferring.

## A smaller boundary is not a bypass

A narrow boundary - one file, not a directory - buys nothing. The spec
gates read the issue's own text and fire regardless of how few paths it
declares: a one-file task with no boundary section is still
`missingBoundary`, and a one-file task missing its spec sections still
carries the `incompleteSpec` warning. Likewise the hold check is by
overlap: if that one file lies beneath a directory another task holds,
the candidate is `fileConflict` however small its footprint. There is no
size of boundary that lets a task skip the spec or the hold.

## Facts and inferences

Facts - directly visible, no source code required:

- From `/queen/status`: `swarmState`; `scheduler.enabled`,
  `intervalSeconds`, `billingMode`, `estimatedUSDGateEnabled`;
  `lastTick.decidedAt`, `allowed`, `refusal`, `skippedCount`,
  `skipSummary` (the closed categories above); `dispatches` counts and
  the latest dispatch's issue and timestamps.
- From `/queen/lease`: the full last decision - `chosen`, `chosenPaths`,
  `refusal`, and the `skipped` sentences naming issues, paths, and
  holders - plus the last ten dispatch rows with branch, detail, and
  outcome, and the lease holder and fence.
- From the repository: each issue's body - hence its boundary section
  and spec sections - because the chooser reads exactly that text.

Inferences - read from the current implementation, not promised by any
endpoint, and liable to change without this document noticing:

- The concurrent-worker limit (4) and the awaitingReview hold (48
  hours). The capacity refusal names its limit when it fires; the hold
  window never appears in a response.
- Candidate order. No sort parameter is sent, so GitHub's documented
  default (newest created first) orders the list; "first eligible" is
  therefore usually the newest eligible issue.
- The gate sequence itself (capacity, budget, claim, completion,
  boundary, spec quality, hold, order) and the state sets behind
  `claimed` and `completed` are the behavior of the current chooser; the
  endpoints expose its outputs, not its rules.

## Worked example

One round, capacity free (0 running), metered budget not exhausted.
Candidates in list order, newest first:

1. Candidate `#1315` - a complete spec declaring
   `docs/live/queen/`. A task from `#1290` finished 3 hours ago, sits in
   `awaitingReview` holding `docs/live/`, inside its hold window.
   `docs/live/queen/` lies beneath `docs/live/`, so the paths overlap.
   Result: `fileConflict` - `#1315: docs/live/queen/ held by trios#1290`.
2. Candidate `#1312` - a complete spec declaring
   `docs/queen-selection.md`. No task exists on the issue; no held
   boundary overlaps the path. Result: **eligible**.
3. Candidate `#1308` - a complete spec declaring the same file,
   `docs/queen-selection.md`. No holder exists yet - the choice of
   `#1312` has not been folded into this answer - so it too is
   eligible, but not first. Result: `notFirst`.
4. Candidate `#1301` - has Requirements and Success Criteria but no
   Boundary section. Nothing can be reserved for it. Result:
   `missingBoundary` - `#1301: not yet a spec - missing boundary`.
5. Candidate `#1299` - declares `docs/queen-selection.md` and
   `scripts/lint-queen.sh`, so it is delegatable, but it has no user
   scenarios section. Result: the `incompleteSpec` warning is recorded -
   and because it remains eligible and is not first, a `notFirst`
   reason is recorded too.

Final decision (this answer): `allowed: true`, `chosen: #1312`,
`chosenPaths: docs/queen-selection.md`, no refusal. `skippedCount: 5`;
`skipSummary: { fileConflict: 1, notFirst: 2, missingBoundary: 1,
incompleteSpec: 1 }` - five reasons for four passed-over candidates,
because `#1299` contributed two.

The round dispatches `#1312`, folds it into the board, and asks again.
Now `#1312` itself reads `claimed (running)`, `#1308` and `#1299` read
`fileConflict` (`held by trios#1312`), and `#1315` and `#1301` are
unchanged. Final decision (the re-ask): `allowed: false`, refusal
`nothing to choose`, `skippedCount: 6`, `skipSummary: { claimed: 1,
fileConflict: 3, missingBoundary: 1, incompleteSpec: 1 }`. The round
ends with one bee running and `swarmState: working`. The recorded tick
on `/queen/status` is the round's first answer - `allowed: true`,
`chosen: #1312` - because the re-asks are observable only through the
dispatch rows they produced.

## What this document deliberately does not contain

No credentials, no provider response bodies, no private feed or
transcript content. The public endpoint publishes counts and closed
identifiers only; the sentences that name issues, paths, and holders
stay behind `/queen/lease`, and nothing here reproduces private
material beyond the shapes an operator is authorized to read.
