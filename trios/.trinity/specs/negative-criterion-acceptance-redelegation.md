# Re-delegation of #1286, with the boundary it should have had

Prepared 2026-08-23. **Not yet dispatched** — see "When to run this" below.

## Why the first attempt could not have succeeded

#1286 was delegated with `ownedPaths = ["rings/SR-00/QueenReviewDecision.swift"]`.
The bee wrote correct, self-consistent code in that one file and touched
nothing else. Three of its four acceptance criteria are not satisfiable there:

- *"a task whose criteria have all resolved passes acceptance and frees the
  boundary, without a human"* — `QueenReviewDecision.decide` returns `accept`,
  and nothing consumes that answer. The consumer is the acceptance path.
- The marker is never honoured by `QueenAcceptancePolicy.verdicts` or by the
  auto-accept gate, both outside the boundary it was given.

So the contract was unsatisfiable in the file the bee was allowed to edit.
That was a briefing error, not a failure of the worker. The record was
cancelled to free the boundary, and its two commits are preserved on
`queen/1286-a-negative-test-parks-itself-in-the-r1` at `928fb0d2d`.

Two measurement defects were sitting on top of it, both since fixed:

- `committedFiles: 0` and an intervention reading *"it wrote outside the paths
  it was given"* were both false. The path comparison never accounted for the
  worktree a bee actually works in. Fixed at `97bfa439f`.
- `/cancel` was refused with `Cannot move … from awaitingReview to cancelled`,
  so the boundary could not be released at all. Fixed at `e1dfab690`.

## The boundary it needs

```
rings/SR-00/QueenReviewDecision.swift      the marker parse and the inverted verdict (already written at 928fb0d2d)
rings/SR-00/QueenCriterionVerdict.swift    QueenAcceptancePolicy.verdicts — the table that must honour the marker
rings/SR-00/QueenDelegation.swift          qualifiesForAutoAccept
rings/SR-02/ChatViewModel.swift            the 15 call sites that wire the above together
```

## The briefing

> A criterion can be marked as knowingly unfulfillable — a negative test. The
> marked criterion is met exactly when the behaviour it names is ABSENT, and
> unmet when the behaviour reappears. A task whose criteria have all resolved
> that way must pass acceptance and release its file boundary with no human
> involved.
>
> `928fb0d2d` on `queen/1286-a-negative-test-parks-itself-in-the-r1` already
> implements the parse and the inverted verdict inside
> `QueenReviewDecision.swift`. Read it first and build on it rather than
> starting again; it was cancelled for a boundary problem, not for its
> content.
>
> What is missing is everything downstream: `QueenAcceptancePolicy.verdicts`
> reads a marked criterion as ordinary, `qualifiesForAutoAccept` does not know
> about it, and the call sites in `ChatViewModel` never carry the distinction.
> Prove the whole path, not the decision function alone: a task with a marked
> criterion whose behaviour is absent must reach `accepted` without a human.
>
> The check must break if the marker parsing is removed. Prove that by
> removing it in a copy and showing the task sticks again.

## It has already been re-delegated wrong once

Task `67CFF1DF-0237-4E11-B4BF-50BA21DEF79E`, created 2026-08-23T08:06:15Z —
after the cancellation above — carries `ownedPaths =
["rings/SR-00/QueenReviewDecision.swift"]`. That is the same boundary, so it
will reach the same wall: it can satisfy criterion 2 and nothing else, and it
will sit in `awaitingReview` until someone widens the boundary or cancels it.

It has one committed file at `3bbd1c567c` and one completed turn, so it is not
idle — it is doing correct work against a contract it cannot finish.

Whoever picks this up: widen the boundary as below rather than returning that
task again. A send-back cannot fix a contract whose remaining criteria live in
files the worker may not open.

## When to run this

Not while `rings/SR-02/ChatViewModel.swift` is dirty or owned by another live
task — it is the most contended file in the repository, and a bee holding it
blocks every other agent. Check first:

```
git status --porcelain rings/SR-02/ChatViewModel.swift
uptime
```

At the time of writing the machine was at load 132 with eight `make` processes
from another agent's gate, and `QueenDelegation.swift` was dirty under someone
else. Dispatching then would have starved an already-saturated machine and
taken a lock others needed. That is the only reason this is a document rather
than a running task.

## Dispatch

The delegation channel applies only at app launch. Kill, verify dead, then:

```
open --env TRIOS_E2E_DELEGATE="gHashTag/trios#1286|queen-swift|Honour a knowingly-unfulfillable criterion through the whole acceptance path|rings/SR-00/QueenReviewDecision.swift,rings/SR-00/QueenCriterionVerdict.swift,rings/SR-00/QueenDelegation.swift,rings/SR-02/ChatViewModel.swift" trios.app
```

The title above is deliberately English. Since `e537a2a57` the commit subject
is generated from the title only when the title is English, so a Russian one
would silently become `update 4 files under rings` instead — correct, but less
useful than a title written for the purpose.
