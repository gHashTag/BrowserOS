# Spec-driven delegation - the Queen supervises against a contract

Status: SPECIFY (no implementation yet)
Shape: GitHub Spec Kit - Constitution / Specify / Plan / Tasks / Implement.
This document is the **Specify** stage: what and why, not how.

## The complaint this answers

Observed by the user, watching a real worker chat: the work is garbage, it gets
interrupted, and the chat hangs unfinished.

That is three separate failures wearing one coat, and they need separating
before anything is built.

1. **Nothing defines done.** A worker receives a prose brief. There is no
   statement of what finished looks like, so neither the worker nor the Queen
   can tell completion from abandonment. Work that stops is indistinguishable
   from work that finished badly.
2. **Stalling is answered by giving up.** `reapStalledWorkers` finds a task
   whose stream has been silent past `stallThreshold` (one hour) and transitions
   it to `cancelled`. That is the code doing exactly what it was written to do,
   and it is precisely the behaviour being complained about: a hung chat, closed
   without a result. The current design treats a stall as terminal rather than
   as a condition to correct.
3. **Watching is not steering.** `QueenObserver` reads the transcript for
   looping, spinning, out-of-bounds writes and overspending. All four are
   pathologies of *process*. None is a judgement about whether the work is
   correct, because there is no contract to judge it against.

## What must become true

### R1 - Every delegated task carries a specification

Opening a worker chat must produce a specification document before the worker
is briefed. Its required sections:

- **Intent** - one sentence, what changes for a user of the system.
- **Acceptance criteria** - a numbered list, each item independently checkable
  by running something. Prose that cannot be checked is not a criterion.
- **Boundary** - the paths this task may write, restating `ownedPaths`.
- **Out of scope** - what a reasonable reader might assume is included and is
  not. This section exists because unstated exclusions are where scope creep
  enters.
- **Verification** - the exact commands that decide the criteria, and their
  expected output.

The specification is the worker's brief. It is not a summary attached to the
brief; it replaces prose instruction as the contract.

### R2 - Completion is measured against the criteria, never asserted

A worker may not move itself to `awaitingReview` by declaring success. The
transition requires each acceptance criterion to be evaluated and recorded as
met, unmet, or unevaluated. A task with an unevaluated criterion is not ready
for review, and the Queen's review shows the criterion table rather than the
worker's own summary of it.

Rationale: the current failure is not that workers lie. It is that "I have
finished" and "I have stopped" produce identical signals.

### R3 - A stall is corrected before it is abandoned

When a worker goes silent past the threshold, the Queen must first attempt
correction: re-state the unmet criteria into the same chat and let the worker
resume. Only after a bounded number of correction attempts, recorded on the
task, may the task be cancelled - and cancellation must name which criteria
were never met.

This is the direct answer to "the chat hangs unfinished". Today the hour of
silence ends in a closed chat and nothing learned. It should end in either
finished work or a written statement of what could not be done.

### R4 - Correction is continuous, not only at the end

The Queen observes the worker's transcript while it runs and intervenes when
the work diverges from the specification - not only when it loops or overspends.
Divergence means: editing outside the boundary, or a criterion that the current
approach cannot satisfy.

An intervention is a message into the worker's chat, and it is recorded on the
task so that "the Queen corrected this three times" is visible afterwards.

### R5 - The chat closes when the PR merges, not when the Queen is satisfied

Today a task archives on `accepted`. Acceptance is the Queen's opinion; a merged
PR is a fact. The lifecycle must extend: `awaitingReview -> accepted -> merged
-> archived`, where `merged` is established by asking the forge, not by
inference. A task whose PR is closed unmerged returns to the review queue rather
than archiving.

### R6 - The main chat shows live state and nothing stale

Every open task appears in the main chat with its current state, its unmet
criterion count, and whether its stream is alive. A task whose worker has gone
silent must read as silent within one poll interval, never as "working".

## Non-goals

- Replacing the existing `QueenObserver` pathology checks. They stay; R4 adds a
  contract check beside them.
- Automating merge. R5 observes the merge, it does not perform it.
- A new specification format. This uses Spec Kit's shape so that a worker chat
  and this repository speak the same language.

## Open questions, requiring a human answer

1. **Who writes the specification?** The Queen drafting it from an issue is
   fastest and is also how a misunderstood issue becomes a confidently wrong
   contract. The alternative is that a task cannot start until a person approves
   its criteria.
2. **What is the correction budget in R3?** Too low and it is today's behaviour
   with extra steps; too high and a confused worker burns the daily budget.
3. **Which forge fact counts as merged in R5** when the work lands by a route
   other than a PR - a direct push, or a squash that closes the PR without the
   branch merging.

## How this will be judged

The feature is done when a task can be pointed at and these are all true:
its specification exists and lists checkable criteria; the criteria were
evaluated, not asserted; any stall produced either resumed work or a written
account of what failed; and the chat archived because a PR merged.

Until then, partial implementations must not claim R2 - a criterion table that
the worker fills in itself is the current problem with a table drawn round it.
