# Merge Truth — How a Merge Is Proven

Issue: gHashTag/trios#1146 · Parent: #1090

## What this document is

A description of the evidence chain that proves a merge is real. The
chain runs from the worker's commit through the review gate, the
acceptance decision, and the forge's merge confirmation. Each link
converts a claim into a fact; missing any one leaves the merge
unproven.

This document complements
[`queen-verdicts.md`](queen-verdicts.md) (which verdicts exist),
[`reviewer-scope.md`](reviewer-scope.md) (what evidence the reviewer
receives), and [`queen-archive-rules.md`](queen-archive-rules.md)
(when a settled task may leave the working view). It focuses on one
question: **what makes a merge true rather than merely asserted?**

## The chain

A merge is proven when every link in the chain holds. Each link is
testable independently; if any one fails, the merge is not proven.

### 1. The worker's diff exists on an isolated branch

The worker commits to its own branch inside a dedicated worktree. The
diff against the baseline (the commit the branch was cut from) is the
first piece of evidence: it shows exactly what the worker changed. No
diff, no work to merge. The worktree guarantees the diff reflects this
worker's changes alone, not the user's working tree or another
worker's branch. See [`worktree-proof.md`](worktree-proof.md).

### 2. The brief carries the evidence

The review brief assembles the criteria, the diff, and the full
contents of every owned file. The reviewer cannot reach a verdict
without evidence; the brief is that evidence. The
`adversaryPromptMarker` proves the brief the reviewer saw is the brief
the chain built — a swapped brief is rejected. See
[`reviewer-scope.md`](reviewer-scope.md) and the first link in
[`seven-links.md`](seven-links.md).

### 3. Every criterion receives a verdict

Each acceptance criterion carries exactly one of three verdicts:
`.met`, `.unmet`, or `.unchecked`. Mechanical verdicts settle criteria
that name a file path (does the file exist on the branch?). The
reviewer settles criteria the path check cannot reach (does the code
do what the criterion asks?). Criteria neither check can reach stay
`.unchecked` — and an unchecked criterion is not a pass. See
[`queen-verdicts.md`](queen-verdicts.md).

### 4. The acceptance gate clears

`acceptanceBlockReason` returns `nil` only when every criterion is
`.met`. Any `.unmet` criterion blocks acceptance and lists every
offender. Any `.unchecked` criterion blocks acceptance with the note
"An unchecked criterion is not a pass." The gate does not ask the
reviewer to be thorough; it demands it. The Queen cannot mark the task
`.accepted` until the gate clears.

### 5. The Queen marks the task accepted

When the gate clears, the Queen transitions the task from
`.awaitingReview` to `.accepted`. Acceptance is the Queen's opinion:
the evidence was complete, and every criterion was satisfied. But
acceptance is not a merge — it is permission to merge. See
[`queen-archive-rules.md`](queen-archive-rules.md).

### 6. The forge confirms the merge

The Queen calls `mergePullRequest` (squash merge) or the forge reports
the PR already merged. Either way, the forge's `merged == true` is the
fact. The Queen's acceptance was an opinion; the merge confirmation is
a record on the forge that cannot be faked from inside the application.

This is the distinction at the heart of settlement: `.accepted` with
an open PR is **not settled**, because the merge has not happened yet.
`.merged` is settled, because the forge confirmed it. See
[`queen-archive-rules.md`](queen-archive-rules.md).

## What "proven" means

A merge is proven when the chain is complete:

| Link | Evidence | Who provides it | How it is checked |
|------|----------|-----------------|-------------------|
| Diff | Worker's changes on an isolated branch | Worker | `git diff <baseline> -- <ownedPaths>` |
| Brief | Criteria + diff + file contents, authenticated | Queen pipeline | `adversaryPromptMarker` |
| Verdicts | `.met` / `.unmet` / `.unchecked` per criterion | Reviewer + mechanical | `QueenAcceptancePolicy.verdicts` |
| Gate | No `.unmet`, no `.unchecked` | `acceptanceBlockReason` | Returns `nil` |
| Acceptance | Queen marks `.accepted` | Queen | Task state transitions |
| Merge | Forge reports `merged == true` | Forge (GitHub) | `fetchPullRequest` |

A break anywhere in this chain leaves the merge unproven. The review
gate is the most common breakpoint: a criterion left `.unchecked`
reads as "nobody looked," and the gate refuses to pass. The forge
confirmation is the least common breakpoint but the most damaging: a
task accepted but never merged sits in the working view with an open
PR, and archiving it would file away changes that may never reach the
branch.

## Code references

| Symbol | File | Role |
|--------|------|------|
| `DelegatedTask.isSettled` | `rings/SR-00/QueenDelegation.swift` | True only when archivable AND no open PR gate. |
| `DelegatedTaskState` | `rings/SR-00/QueenDelegation.swift` | Lifecycle: `.queued` → `.running` → `.awaitingReview` → `.accepted` → `.merged`. |
| `QueenAcceptancePolicy.acceptanceBlockReason` | `rings/SR-00/QueenCriterionVerdict.swift` | Returns the first reason acceptance is blocked, or nil. |
| `QueenAcceptancePolicy.mechanicalVerdicts` | `rings/SR-00/QueenCriterionVerdict.swift` | Auto-verdict for path-naming criteria. |
| `QueenReviewVerdictRequest.brief` | `rings/SR-00/QueenReviewVerdictRequest.swift` | Builds the evidence brief with adversary marker. |
| `ChatViewModel.mergePullRequest` | `rings/SR-02/ChatViewModel.swift` | Calls the forge to squash-merge the PR. |
| `ChatViewModel.fetchPullRequest` | `rings/SR-02/ChatViewModel.swift` | Polls the forge for PR state and merge confirmation. |
