# Queen Escalation Kinds — What an Escalation Is Waiting On

Issue: gHashTag/trios#1332

## What this document is

The rule that every escalation the Queen records carries a **reason
class** — `issue-defective` or `needs-a-person` — derived from the
policy's own escalation sentence, and what each class means for the
48-hour file boundary hold an escalation otherwise keeps.

Escalation as a policy does not change. Some work genuinely needs a
human, and only an escalation reaches one (`queen-tick.ts:772`). What
changes is that escalations stop being one undifferentiated queue that
only a person can drain, because one of the two kinds is not waiting on
a person's judgement of the work at all.

## The problem, measured

2026-09-03, from the issue: 12 issues in review, 41 done, `she may
start` at 0. Twelve verdicts waiting on a person, and the swarm could
move none of them.

Earlier the same day three dispatches escalated with the identical
sentence — *"the task has no acceptance criteria, so there is nothing to
judge it against"* — and each held its file boundary for 48 hours under
the review rule (`QueenDelegationPolicy.reviewBoundaryHoldHours`,
`rings/SR-00/QueenDelegation.swift:618`). Nothing on the record
distinguished those three from an escalation that means *"a bee failed
this twice and a person must look"*. The two kinds have opposite
remedies, and one of them does not need the person it was handed to:

| | `issue-defective` | `needs-a-person` |
|---|---|---|
| What is wrong | The **issue**. It states no acceptance criteria, so no contract exists to judge the work against. | The **work**, or the loop around it. A bee was returned twice and the conversation has not moved; or two real attempts have failed on their own merits. |
| Remedy | Rewrite the issue — state the acceptance criteria. Work a bee can do. | A person looks at it. No bee may close it. |
| File boundary | Holds nothing, at once (FR-003) | The existing 48-hour hold, unchanged (FR-004) |

## The reason class (FR-001)

Every dispatch recorded with `review_state = 'escalate'` carries a
`reason_class` column on `queen_dispatch`, written by the same UPDATE
that records the verdict and the note (`reviewFinishedDispatches`,
`queen-tick.ts:1312-1329`). One write, not two: a class kept by a second
statement is a class a crash between the two leaves empty, and an
escalation with an empty class is the undifferentiated queue again.

`reason_class` is never empty and never NULL:

- The derivation below has a default arm, so a reason nobody has seen
  still classifies — as `needs-a-person`, the conservative direction.
  The cost of the default is a 48-hour hold, bounded, and exactly the
  behaviour today; the cost of an empty class is an escalation nobody
  can sort.
- Rows recorded before this rule exist and carry a note already. A row
  read with `reason_class` NULL derives it from `review_note` by the
  same table, so the guarantee covers every escalated dispatch ever
  recorded, not only new ones.

## Derivation: the policy's own sentence, and nothing else (FR-002)

The class is derived from `review_note` — the reason string `queend`
already returned — by plain substring containment. There is no second
judgement here: no re-reading the issue, no new policy question, no
call to anything that can disagree with the policy that escalated. For
an escalation, `queend` emits the reason as both `note` and `refusal`
(`queend/main.swift:365-368`), so the input exists whenever the verdict
is `escalate`. Derive before the 900-character slice that stores the
note (`queen-tick.ts:1326`), so the anchors cannot be truncated away.

The policy emits exactly four escalation sentences today. The table is
closed over them:

| Policy site | Sentence (as emitted) | Anchor | Class |
|---|---|---|---|
| `QueenReviewDecision.swift:56-61` | "the task has no acceptance criteria, so there is nothing to judge it against - it can only be abandoned or accepted on faith" | contains `no acceptance criteria` | `issue-defective` |
| `QueenReviewDecision.swift:80-86` | "returned N time(s) already and M criterion(s) are still unmet; a third return would repeat a conversation that has not moved" | contains `returned` **and** `already` | `needs-a-person` |
| `QueenReviewDecision.swift:69-76` | "every criterion is marked met but nothing was committed; a reviewer that passes an empty diff has judged the absence of work rather than the work" | neither anchor — default | `needs-a-person` |
| `QueenRetryPolicy.swift:140-147` | "N attempts have already failed on their own merits (...); a third would be the same brief against the same issue, so this one needs you rather than another bee" | neither anchor — default | `needs-a-person` |

The rules, in order:

1. If the note contains `no acceptance criteria`, the class is
   `issue-defective`. Checked first: the phrase names the defect's
   location unambiguously — the issue, not the work.
2. Else, if the note contains both `returned` and `already`, the class
   is `needs-a-person`. Both words, because together they are the
   ceiling's signature: the loop has already gone round.
3. Else, the class is `needs-a-person`. Never empty, never absent.

The two defaults are deliberate. The empty-diff escalation is a
statement about the work and the review's inputs, not about the issue
text — the criteria were present; the work is what is missing — and the
retry-ceiling sentence names its own need: *"this one needs you rather
than another bee"*. A future escalation reason lands on the same
conservative default until this table is widened for it.

The anchors are fixed strings in the Swift policy source, and this
table moves when they do. That is the same discipline as
`REVIEW_BOUNDARY_HOLD_HOURS` being checked against the Swift source by
`queen-board.test.ts` (`queen-kanban.ts:180-183`): when these drift, the
failure mode is silent.

## The hold (FR-003, FR-004)

Today every escalation maps to `awaitingReview`
(`stateOfDispatch`, `queen-tick.ts:374-388`; `dispatchState`,
`queen-kanban.ts:632-638`), and `awaitingReview` ages its file claim out
after 48 hours (`stillHoldsBoundary`, `queen-kanban.ts:195-207`,
mirroring `QueenDelegation.swift:626-634`). Under the class rule:

- **`needs-a-person` keeps exactly that.** Nothing about it changes:
  state `awaitingReview`, boundary held 48 hours from the moment the
  turn ended — measured from finish, not dispatch, per the long-task
  rule at `queen-tick.ts:833-837`. The hold exists for a reason here:
  a person may yet inspect the files, and two days is the bound that
  keeps a forgotten escalation from freezing the swarm for ever.
- **`issue-defective` holds nothing, at once.** Nobody is working those
  files — the bee is finished, and its work cannot be judged because
  the issue never stated a contract. The thing that is wrong is the
  issue text, not the files, and the remedy needs no exclusive access
  to those paths. There is no clock to wait out: the boundary releases
  in the same round that records the verdict.

Both implementations must agree — the Swift policy
(`QueenDelegationPolicy.stillHoldsBoundary`) and its TS board mirror
(`queen-kanban.ts:195-207`). The reason is the one already written
there (`queen-kanban.ts:176-184`): when these drift, the failure mode
is silent — the board says BLOCKED and names a holder while the Queen
has already released the hold and will start a bee on the path at the
next tick.

The escalation itself still reaches the person: the report line and
`needs_you` are unchanged in kind. The report now says which kind, and
for `issue-defective` it names the remedy rather than the work: *the
issue, not the work, is what is wrong — rewrite its acceptance
criteria.* The release is what makes that remedy executable without
waiting on anyone: a boundary released while the issue stayed
unchoosable would trade file starvation for issue starvation, so an
`issue-defective` escalation does not keep its issue out of the pool
either — the next brief against it is the rewrite.

## The board

The acceptance shape, mirroring the existing *"keeps holding when the
verdict was escalate"* (`queen-board.test.ts:286-308`), which under
this rule becomes two tests:

Build a board with one escalation of each kind, both finished now,
each owning one path, plus an untouched issue claiming each path:

- a dispatch with `review_state = 'escalate'`,
  `reason_class = 'issue-defective'`, owning `docs/issue-broken.md`
- a dispatch with `review_state = 'escalate'`,
  `reason_class = 'needs-a-person'`, owning `docs/issue-fine.md`

Then the issue overlapping `docs/issue-broken.md` shows **backlog** —
the path is free, from the moment the board is composed, not after a
wait — and the issue overlapping `docs/issue-fine.md` shows
**blocked**, naming the escalation as the holder.

Alongside it, the classification itself is checked directly: an
escalation whose note contains "no acceptance criteria" classifies as
`issue-defective`; one whose note contains "returned" and "already"
classifies as `needs-a-person`; and every escalated dispatch row —
built, legacy, or defaulted — carries a non-empty class.

## Acceptance scenarios

1. **An escalation caused by an issue with no acceptance criteria.**
   Given the policy's no-criteria sentence, when the round records the
   verdict, the row is marked `issue-defective` — a DEFECT IN THE
   ISSUE — and the remedy named is to rewrite the issue rather than to
   look at the work. Its file boundary holds nothing.
2. **An escalation caused by reaching the send-back ceiling.** Given
   the policy's returned-already sentence, when the round records the
   verdict, the row is marked `needs-a-person` and stays that way: no
   reclassification, no release, the 48-hour hold unchanged.

Mapped to the issue's success criteria:

- *Every escalated dispatch carries a non-empty reason class* — the
  same-write column, the default arm, and the on-read derivation for
  legacy rows.
- *"no acceptance criteria" → `issue-defective`* — derivation rule 1.
- *"returned" and "already" → `needs-a-person`* — derivation rule 2.
- *One of each on a board: the first not holding, the second holding*
  — The board, above.

## What does not change

- The four verdicts, the send-back ceiling
  (`QueenReviewDecision.maximumSendBacks`), the retry ceiling
  (`QueenRetryPolicy.maximumRealAttempts`), and the empty-diff guard:
  untouched. This document classifies their outputs; it does not add a
  second opinion to them.
- An escalation still reaches a person and still appears on the board
  in review.
- `accept`, `sendBack` and `wait` hold exactly as they do today.
- The remedy for a `needs-a-person` escalation remains a person. No
  escalation of that kind is ever closed automatically.

## Where the rules live

| Rule | Site |
|---|---|
| Reason strings | `QueenReviewDecision.swift:56-86`, `QueenRetryPolicy.swift:138-148` |
| Recording the class | `reviewFinishedDispatches`, `queen-tick.ts:1239-1333` — same UPDATE as the verdict |
| Hold, policy | `QueenDelegation.swift:618-634` |
| Hold, board mirror | `queen-kanban.ts:185-207` |
| State mapping | `stateOfDispatch`, `queen-tick.ts:374-388`; `dispatchState`, `queen-kanban.ts:632-638` |
| Test precedent | `queen-board.test.ts:286-308`; review-escalate parity rows r12/r14, `tests/t27/ring00_parity.sh:159-161` |
