# Queen Escalation Kinds — What an Escalation Is Waiting On

Issue: gHashTag/trios#1332

## What this document is

The rule that every escalation the Queen records carries a **reason
class** — `issue-defective` or `needs-a-person` — derived from the
policy's own escalation sentence, and what each class means for the
48-hour file-boundary hold an escalation otherwise keeps.

Escalation as a policy does not change. Some work genuinely needs a
human, and only an escalation reaches one — the review sweep leaves the
task exactly where a person will look for it (`queend` maps `escalate`
to `awaitingReview`; `queen-tick.ts:376`). What changes is that
escalations stop being one undifferentiated queue only a person can
drain, because one of the two kinds is not waiting on a person's
judgement of the work at all. Its ISSUE is what is defective, and
rewriting an issue is work a bee can do.

## The problem, measured

2026-09-03, from the issue: 12 issues in review, 41 done, and the
board's own sentence — *"Nothing is running, and there is nothing she
may start"* (`queen-kanban.ts:911`). Twelve verdicts waiting on a
person, and the swarm could move none of them.

Earlier the same day three dispatches escalated with the identical
sentence — *"the task has no acceptance criteria, so there is nothing
to judge it against"* — and each held its file boundary for 48 hours
under the review rule (`QueenDelegationPolicy.reviewBoundaryHoldHours`,
`rings/SR-00/QueenDelegation.swift:618`; mirrored at
`queen-kanban.ts:185`). Nothing on the record distinguished those three
from an escalation that means *"a bee failed this twice and a person
must look."* The two kinds have opposite remedies:

| | `issue-defective` | `needs-a-person` |
|---|---|---|
| What is wrong | The **issue**. It states no acceptance criteria, so no contract exists to judge the work against. | The **work**, or the loop around it. Returned twice and the conversation has not moved; or two real attempts have failed on their own merits. |
| Remedy | Rewrite the issue — state the acceptance criteria. Work a bee can do; nobody needs to look at the work. | A person looks at it. No bee may close it. |
| File boundary | Holds nothing, at once (FR-003) | The existing 48-hour hold, unchanged (FR-004) |

Both kinds still end in a person's verdict — only a person accepts work
judged against nothing, or abandons it. The class does not change who
decides; it changes what the escalation costs the swarm while it waits,
and what the remedy line says.

## The reason class (FR-001)

Every escalation carries one of exactly two classes. The class is an
enum, not a free string: `issue-defective` or `needs-a-person`, and
nothing else. It is therefore never empty by construction — the
derivation below has a default arm, so a sentence nobody has seen yet
still classifies, conservatively, as `needs-a-person`.

Where it is recorded: the same UPDATE that writes the verdict and the
note (`reviewFinishedDispatches`, `queen-tick.ts:1418-1423`). One
write, not two — a class kept by a second statement is a class that a
crash between the two leaves empty, and an escalation with an empty
class is the undifferentiated queue again. The same discipline already
applies to the send-back count in that statement, for the same reason:
an undercounted class, like an undercounted send-back, is wrong in the
direction that never escalates properly.

Rows recorded before this rule exist and already carry a note. A row
read with no class derives it from `review_note` by the same table
below, so the guarantee — every escalated dispatch ever recorded
classifies, non-empty — covers old rows too, not only new ones.

An `escalate` row's note is never empty to begin with: the verdict
comes from queend, which returns the reason as the note
(`queend/main.swift:365-368`), and the only path that stores an empty
note lands in `wait`, not `escalate` (`queen-tick.ts:1403, 1427`).

## Derivation: the policy's own sentence, and nothing else (FR-002)

The class is derived from the reason string the policy itself emitted —
by plain substring containment, in this order:

1. If the note contains `no acceptance criteria` → **`issue-defective`**.
   Checked first: the phrase names the defect's location unambiguously —
   the issue, not the work.
2. Else, if the note contains both `returned` and `already` →
   **`needs-a-person`**. Both words, because together they are the
   send-back ceiling's signature: the loop has already gone round.
3. Else → **`needs-a-person`**. Never empty, never absent.

There is no second judgement here: no re-reading the issue, no new
policy question, no call to anything that can disagree with the policy
that escalated. The anchors are the policy's own words, fixed string
literals in the Swift source. Derive before the 900-character slice
that stores the note (`queen-tick.ts:1427`), so a long sentence cannot
have its anchor truncated away.

The policy emits exactly four escalation sentences today. The table is
closed over them — every one of them classifies:

| Policy site | Sentence (as emitted) | Anchor hit | Class |
|---|---|---|---|
| `QueenReviewDecision.swift:56-61` | "the task has no acceptance criteria, so there is nothing to judge it against - it can only be abandoned or accepted on faith" | `no acceptance criteria` | `issue-defective` |
| `QueenReviewDecision.swift:70-76` | "every criterion is marked met but nothing was committed; a reviewer that passes an empty diff has judged the absence of work rather than the work" | neither — default | `needs-a-person` |
| `QueenReviewDecision.swift:80-86` | "returned N time(s) already and M criterion(s) are still unmet; a third return would repeat a conversation that has not moved" | `returned` **and** `already` | `needs-a-person` |
| `QueenRetryPolicy.swift:140-147` | "N attempts have already failed on their own merits (...); a third would be the same brief against the same issue, so this one needs you rather than another bee" | `already` only — default | `needs-a-person` |

The two defaults are deliberate:

- The empty-diff escalation is a statement about the **work** and the
  review's inputs — the criteria were present; the work is what is
  missing. Nothing about it says the issue text is defective.
- The retry-ceiling sentence names its own need: *"this one needs you
  rather than another bee."* A bee failed twice; that is the second kind
  the issue names, and it does need a person. Note it contains `already`
  but not `returned` — it reaches the default arm, not the ceiling
  anchor, and classifies the same either way.
- A future escalation sentence lands on the same conservative default
  until this table is widened for it. The cost of the default is a
  bounded 48-hour hold — exactly today's behaviour; the cost of an
  empty class is an escalation nobody can sort.

Because the class is a pure function of the stored sentence, it cannot
drift after the fact: a `needs-a-person` escalation stays that way
(scenario 2), and nothing re-judges a recorded escalation later.

The anchors are pinned to the Swift source by the same discipline that
keeps `REVIEW_BOUNDARY_HOLD_HOURS` honest — `queen-board.test.ts`
checks the constant against `QueenDelegation.swift` because "the
failure mode when these drift is silent" (`queen-kanban.ts:176-184`).
When the Swift sentences change, the anchors change with them, by test.

## What the round records (User Story 1)

When the sweep records an escalation it now records the class with it,
and the notice names the remedy the class implies:

- **`issue-defective`** — the round's line says the defect is in the
  issue and the remedy is to rewrite it, not to look at the work:
  the issue stated no acceptance criteria, so there was no contract to
  judge against; a rewritten issue can be re-dispatched to a bee.
- **`needs-a-person`** — the round's line stays what it is today:
  "ESCALATED n to you - the policy would not decide these on its own"
  (`queen-tick.ts:1530-1534`). A person, no remedy a bee can perform.

Both stay on the report with `needs_you`, because both still wait on a
person's verdict. What differs is what the waiting costs and what it
asks for.

## The hold (FR-003, FR-004)

Today every escalation maps to `awaitingReview`
(`dispatchState`, `queen-kanban.ts:632-638`), and `awaitingReview` ages
its file claim out after 48 hours (`stillHoldsBoundary`,
`queen-kanban.ts:195-207`, mirroring `QueenDelegation.swift:626-634`).
Under the class rule:

- **`needs-a-person` keeps exactly that.** Nothing about it changes:
  state `awaitingReview`, boundary held 48 hours from the turn's finish.
  The hold exists for a reason here — a person may yet inspect the
  files, and two days is the bound that keeps a forgotten escalation
  from freezing the swarm for ever.
- **`issue-defective` holds nothing, at once.** Nobody is working those
  files — the bee is finished, and its work cannot be judged because
  the issue never stated a contract. The thing that is wrong is the
  issue text, and rewriting it needs no exclusive access to those
  paths. There is no clock to wait out: the boundary releases in the
  same round that records the verdict. A task holding no paths holds
  nothing against anyone — the same principle the dispatch store
  already states (`queen-tick.ts:866-867`).

The card itself does not move: both classes sit in the `review` column
(`dispatchColumn`, `queen-kanban.ts:258-265`) with the verdict and note
in the detail line (`dispatchDetail`, `queen-kanban.ts:266-277`), which
now carries the class too. The class changes what the boundary does,
not where the card is or who closes it.

## A board with one of each (the acceptance test)

Two dispatches, both finished one hour ago, both escalated — identical
in every column the board reads today except the note:

| | #2001 | #2002 |
|---|---|---|
| `review_state` | `escalate` | `escalate` |
| `review_note` | "the task has no acceptance criteria, so there is nothing to judge it against - ..." | "returned 2 time(s) already and 3 criterion(s) are still unmet; ..." |
| `owned_paths` | `docs/spec-a.md` | `docs/spec-b.md` |
| `finished_at` | 1 hour ago | 1 hour ago |
| Derived class | contains `no acceptance criteria` → **`issue-defective`** | contains `returned` + `already` → **`needs-a-person`** |

And two untaken issues wanting those paths: #3001 names `docs/spec-a.md`,
#3002 names `docs/spec-b.md`. What the board shows:

- **#2001 does not hold.** Its class releases the boundary in the round
  that recorded it, so it is not among the holders
  (`addUntakenIssues`, `queen-kanban.ts:640-700`). #3001 draws in
  **`backlog`** — counted in "she can take". The path is free for the
  bee that rewrites the issue, and for whatever follows.
- **#2002 holds.** `dispatchState` reads `awaitingReview`;
  `stillHoldsBoundary` finds 1 hour < 48. #3002 draws **`blocked`**,
  held by #2002 — exactly as today. At hour 47 it still holds; at hour
  49 it ages out by the existing rule, unchanged. FR-004 means
  literally that: the same clock, the same number, no second behaviour.

One hour in, the first shows not holding and the second holding — the
sentence this whole rule exists to make true on the one screen built to
explain what the swarm is waiting on.

## Where the rule lands

The sentences are defined once, in the Swift policy, and shared by the
Mac app and the cloud round through queend — so the class is defined
once too, against those sentences:

- **The writer** — `reviewFinishedDispatches` (`queen-tick.ts:1321`)
  derives and stores the class in the verdict UPDATE; its report lines
  name the per-class remedy.
- **The reader** — the board (`queen-kanban.ts`) reads the class with
  the verdict it already reads, and `stillHoldsBoundary` consults it
  for `awaitingReview` rows only. A NULL class on an old row derives
  from the note by the same table — one definition, no second opinion.
- **The Mac mirror** — the review sweep (`ChatViewModel.swift:8228`)
  logs and notices the class beside the reason it already carries, and
  the Mac's own `stillHoldsBoundary` consults it the same way.
- **The pin** — `queen-board.test.ts` holds the anchors against the
  Swift literals and the two-class hold behaviour against this table,
  the way it already holds `REVIEW_BOUNDARY_HOLD_HOURS`.

## What does not change

- An escalation still reaches a person, and only an escalation does.
- The task still sits in `awaitingReview` — escalation is the absence
  of a state change, not a new state.
- The verdict is still the operator's: accept or abandon, on both
  classes.
- The 48-hour number is untouched, and no `needs-a-person` escalation
  holds one hour longer or shorter than it does today.
