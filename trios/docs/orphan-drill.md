# Orphan Drill — What a Restart Costs a Worker Mid-Task

Issue: gHashTag/trios#1187 · Parent: #1090

## What this document is

A point-by-point account of every cost a process restart imposes on a
worker that was mid-task when the process died. The worker is not
timing out, not aborting its own stream, not choosing to stop — the
application itself is restarting, and the worker's live execution
context vanishes with the old process. What remains is a set of file
edits in the shared checkout, a registry entry that flips from
`.running` to `.failed`, and a gap between what the worker produced and
what the system is willing to attribute to it.

This document complements
[`orphaned-worker-edits.md`](orphaned-worker-edits.md), which specifies
the dispositions (commit-with-mark vs. revert) and the log format for a
failed worker's edits. That document covers the *mechanism*; this one
covers the *cost* — what is lost, what is contaminated, and why a
restart must not be a silent event.

The ten points below are ordered roughly by when the cost manifests:
first the immediate loss of branch and baseline, then the contamination
of the shared tree, then the downstream effects on the build, the log,
the reviewer, and the next worker.

## The ten costs

### 1. The worker's edits lose their branch

When `reconcileOrphanedWorkers` runs at launch and marks every `.running`
task as `.failed`, the transition bypasses `handleWorkerFinished`
entirely — the registry mutates state directly, it does not call the
view model's finish handler. Even if it did, that handler's commit path
is guarded by `if failure == nil`, and a restart sets failure. So the
commit to the worker's virtual branch never happens: the changes the
worker wrote — in the observed case, 53 lines added and 22 removed
across files that compile and pass 594 checks — sit in the shared
checkout with no commit object, no branch ref, and no commit message.
The branch is the container that makes work attributable, reviewable,
and mergeable; without it the edits are anonymous bytes on disk. The
first cost of a restart is the severance of work from its institutional
container. The edits are physically present but structurally invisible:
`git log` cannot find them, `git diff <branch>` has nothing to diff
against, and the Queen's reviewer has no branch to open. The fix
specified in the issue — calling `settleFailedWorkerEdits` for each
orphan in `configureWorkerRunner` — exists precisely to close this gap:
it commits the changed paths to the worker's branch with an
`[INCOMPLETE]` mark, restoring the container the restart tore away.

### 2. The in-memory baseline is erased

The reference point for measuring what a worker changed —
`workerBaselineTrees[conversationId]`, captured by
`QueenBranchCommitter.snapshotWorkingTree` before the turn begins —
lives in the ChatViewModel's process memory. A restart zeroes that
memory. When `reconcileOrphanedWorkers` marks the task `.failed`, there
is no baseline tree to diff against: `changedPaths(since:)` has nothing
to compare, and the system cannot distinguish the worker's edits from
pre-existing changes in the checkout. This is not a minor inconvenience
— it is the loss of the ruler. Without the baseline, the handler cannot
answer three questions it must answer: which files did the worker touch,
which of those are inside the worker's boundary, and which changes
should be committed vs. reverted. The orphaned-worker-edits document
specifies a fallback for this case (`disposition = "unknown"`, logged
with a message that the baseline was never taken), but that fallback is
a confession of ignorance, not a rescue. The second cost of a restart is
that the system loses its ability to measure the damage. The persisted
delegation store and the branch tip (if a prior commit exists) are the
only recovery surfaces, and neither is guaranteed to hold the
pre-turn snapshot that `workerBaselineTrees` carried.

### 3. The orphaned edits contaminate the shared checkout for the next worker

Workers do not use separate worktrees — they share one checkout,
isolated by the baseline-commit-restore cycle that runs per turn. When a
restart interrupts that cycle and the restore step never fires, the
orphaned edits remain in the tree. The next worker, the build, and any
user command all see them as part of the working directory. A new worker
arriving on the same checkout takes its baseline snapshot from this
dirty tree, silently incorporating the dead worker's half-finished work
into its own starting point. If the next worker's task touches
overlapping files, the orphaned edits become entangled with the new
work — a merge that was never intended, performed by accident, with no
record of which lines came from which worker. The contamination is
compounding: each subsequent baseline that includes the orphan's edits
treats them as ground truth, and reverting them later looks like
deleting the next worker's work. The third cost of a restart is that the
shared checkout — the single resource every worker depends on — becomes
untrustworthy, and the distrust spreads forward through every task that
runs before the tree is cleaned.

### 4. The build compiles phantom work

`swift build`, the test suite, and any linting or type-checking run
against the shared checkout. When orphaned edits sit in the tree, the
build compiles them as if they were intentional changes. If the edits
are complete and correct — as they were in the observed case, where 594
checks passed — the build succeeds and gives a false signal of health:
the tree looks green, but the green is built on unattributed work that
no branch owns and no reviewer approved. If the edits are incomplete — a
half-written function, an unbalanced brace, a missing import — the build
fails, and the failure message points at code the current worker did not
write and cannot account for. Either way, the build's output is
meaningless: it does not reflect the state of any branch, any task, or
any reviewer's judgement. The fourth cost of a restart is that the
build — the system's primary feedback loop — becomes unreliable, and
the unreliability is invisible because the build does not know it is
compiling an orphan's work.

### 5. The log records the orphan but not the rescue

The `queen.worker.orphaned` event fires with the worker's name and the
failure reason ("Worker did not survive a restart"). What it does not
carry is the list of files the worker edited, the disposition taken
(committed, reverted, or unknown), or the count of files rescued. A
reader of the log knows that a worker was orphaned — the timestamp, the
task, and the reason are all there — but cannot tell whether the edits
were saved or lost, how many files were involved, or what happened to
them after the orphan event. The gap is not in the event's existence
but in its content: it says "did not survive" and stops, as if the work
evaporated with the process. In reality the work sits in the tree,
unexamined, until someone runs `git diff` by hand and discovers changes
they cannot attribute. The fifth cost of a restart is an audit trail
that names the casualty but not the triage — a log entry that answers
"who died?" without answering "what was saved?" The issue's requirement
that the system record the number of rescued files as a separate event
(`queen.worker.orphaned_edits` with `disposition` and `files`
attributes) exists to close exactly this gap.

### 6. The reviewer has no surface to judge

The Queen's reviewer evaluates work by reading the diff on the worker's
branch: the criteria, the changed files, the evidence brief assembled
from the branch's contents. When no branch exists — because the commit
was skipped on the failure path — the review pipeline has nothing to
run. `QueenAcceptancePolicy.mechanicalVerdicts` reads changed paths
from the branch; with no branch, it reads nothing.
`QueenAcceptancePolicy.verdicts` fills every criterion with
`.unchecked`, and `acceptanceBlockReason` returns "an unchecked
criterion is not a pass." The task is blocked not because the work is
bad but because the work is inaccessible. The reviewer never sees the
53 lines the orphan produced, never judges whether they satisfy the
criteria, never reaches a verdict. The task sits in `.failed` — a state
that is terminal and deliberately not archivable, so it stays in the
working view — but it is `.failed` by process death, not by judgement.
The sixth cost of a restart is that the review gate, the system's guard
against unexamined work, is bypassed in the wrong direction: it blocks
acceptance of work it never examined, and the work rots in the failed
state until someone manually inspects the tree or the task is re-run
from scratch.

### 7. The token spend is sunk and unrecoverable

Eight minutes of compute — reading the issue, exploring the codebase,
planning an approach, writing edits, running tool calls — consumed
tokens that cannot be refunded. The output of that spend is a set of
file changes that, without the rescue path, benefit nobody: no branch
carries them, no reviewer reads them, no merge includes them. When the
task is picked up again — by the Queen choosing it from the queue, or by
a human re-assigning it — the new worker starts from zero. It re-reads
the same issue, re-explores the same codebase, re-plans the same
approach, and re-writes the same edits, paying for the work a second
time. The previous worker's reasoning — its intermediate tool calls,
its exploration of dead ends, its discovery of the right function to
change — is gone with the process; only the raw file diff survives, and
even that is at risk of being reverted or overwritten before anyone
reads it. The seventh cost of a restart is the doubling of compute: the
work is paid for once and thrown away, then paid for again, and the
second payment produces work that may be identical or inferior to the
first.

### 8. The architectural seam between the registry and the view model

`reconcileOrphanedWorkers` lives in `QueenDelegationRegistry`
(`rings/SR-02/QueenDelegationRegistry.swift`), whose role is state
management: it marks `.running` tasks as `.failed` and records the
orphan list. It does not — and per the issue's explicit design
constraint, should not — call `QueenBranchCommitter` or touch the git
index. The registry knows git exists only in the sense that tasks have
branches; it does not perform git operations. The function that can
rescue orphaned edits — `settleFailedWorkerEdits` — lives in
`ChatViewModel` (`rings/SR-02/ChatViewModel.swift`), which owns both the
task lifecycle and the git plumbing. The orphan is detected in one layer
and must be rescued in another, and the bridge between them is the seam
where edits fall through. The issue's solution — having
`reconcileOrphanedWorkers` return the orphan list via
`orphansReconciledAtLaunch`, and having `configureWorkerRunner` iterate
that list and call `settleFailedWorkerEdits` for each task — is a bridge
across this seam. The eighth cost of a restart is the fragility of that
bridge: it works only if the consumer (`configureWorkerRunner`) runs at
launch, runs after the registry is ready, iterates every orphan, and
clears the list after acting. If any of these conditions is violated —
by a refactor, by a reordering of the launch sequence, by a guard clause
that returns early — the orphans sit in the list forever, their edits
still in the tree, and the silence is indistinguishable from success.

### 9. The orphan list is a deferred obligation, not a guarantee

`orphansReconciledAtLaunch` is populated by `reconcileOrphanedWorkers`
at launch and consumed by `configureWorkerRunner` shortly after. Between
population and consumption, the list is an unfulfilled promise: the
registry has identified the orphans, but nobody has acted on them. The
list is not a transaction — there is no atomic "mark failed and commit
edits" operation. It is a deferred obligation that the consumer must
discharge, and deferrals are the class of operation most likely to be
skipped during a refactor. The issue specifies that the list must be
cleared after processing, so that a repeated call to
`configureWorkerRunner` does not re-rescue the same edits — a guard
against double-committing. But clearing the list without processing it
is equally easy: a line that sets `orphansReconciledAtLaunch = []`
before the loop, or a conditional that skips the loop under some launch
condition, would clear the obligation without fulfilling it, and the
silence would be total. The ninth cost of a restart is that the rescue
depends on a deferred, mutable, in-process list that has no external
witness — no persisted record that says "these orphans were found and
not yet rescued." If the list is cleared without processing, the edits
are lost and the log does not say so.

### 10. The user sees unexplained changes in their working directory

The shared checkout is also the user's working directory — the place
where they edit files, run builds, and inspect output. When orphaned
edits sit in the tree, the user sees files they did not modify,
appearing as changed in `git status` or in their editor's diff view.
There is no marker — no `[INCOMPLETE]` commit message in the log, no
`.orphaned` tag on the task in the sidebar, no banner in the chat —
that says "these changes are from a worker that died mid-task, not from
your work or the current task." The user has three options, all bad:
they can ignore the changes, accepting contamination they did not
author; they can revert them, destroying work that may be complete and
correct; or they can try to attribute them, running `git diff` and
`git log` and reading the Queen's chat to reconstruct what happened. The
tenth cost of a restart is that the cost is externalised onto the human:
the system created the orphan, the system failed to rescue it, and the
human is left to discover the damage by accident, with no tool to tell
them which changes are theirs and which are ghosts.

## How these costs map to the acceptance criteria

The three acceptance criteria for issue #1187 each address a subset of
the costs above:

**Criterion 1 — "The orphaned worker leaves its edits in the task's
branch."** This addresses costs 1 (lost branch), 6 (no review surface),
and 7 (sunk token spend). When `settleFailedWorkerEdits` commits the
orphan's changed paths to its virtual branch with an `[INCOMPLETE]`
mark, the edits regain their container, the reviewer has a diff to
judge, and the token spend produces a reviewable artifact rather than
anonymous bytes. The mechanism is `QueenBranchCommitter.commitWorkerChanges`,
which already filters paths against the worker's `ownedPaths` and the
baseline tree — the same function the success path uses.

**Criterion 2 — "The log shows how many files were saved."** This
addresses cost 5 (log records the orphan but not the rescue) and
partially cost 9 (deferred obligation has no external witness). When
the handler emits a `queen.worker.orphaned_edits` event with
`disposition = "committed"` and a comma-separated `files` list, the log
answers "what was saved?" in addition to "who was orphaned?" The count
of files is the headline number: it tells the reader at a glance whether
the orphan produced one file of notes or twenty files of code, and it
makes the rescue auditable — a log that says "3 files committed" can be
checked against the branch's changed-paths list.

**Criterion 3 — "The check breaks if orphan edits are lost again."**
This addresses costs 3 (contaminated tree), 4 (phantom build), 8
(architectural seam), and 10 (user sees unexplained changes). The check
is a test that sets up a scratch repository, runs a worker whose process
is simulated as restarting (the task is `.running` in the registry at
launch), and asserts two things after `configureWorkerRunner` completes:
(a) the worker's branch carries the edited files with an `[INCOMPLETE]`
mark, and (b) the working tree is clean relative to the baseline — no
orphaned edits remain. If the rescue path is removed, the test fails on
assertion (a): the branch is empty because nobody committed. If the
rescue commits but does not restore the tree, the test fails on
assertion (b): the tree is dirty because the edits were copied to the
branch but not reverted from the checkout. The test is the enforcement
mechanism for all ten costs: it converts the costs from documentation
into a build-breaking regression.

## Code references

| Symbol | File | Role |
|--------|------|------|
| `reconcileOrphanedWorkers` | `rings/SR-02/QueenDelegationRegistry.swift` | Runs at launch; marks `.running` tasks as `.failed`; populates `orphansReconciledAtLaunch`. Must return the orphan list for the view model to process. |
| `orphansReconciledAtLaunch` | `rings/SR-02/QueenDelegationRegistry.swift` | The deferred-obligation list. Consumed and cleared by `configureWorkerRunner`. |
| `configureWorkerRunner` | `rings/SR-02/ChatViewModel.swift` | First place after registry readiness where both the orphan list and `settleFailedWorkerEdits` are available. Must iterate the list, rescue each orphan, and clear it. |
| `settleFailedWorkerEdits` | `rings/SR-02/ChatViewModel.swift` | Commits a failed worker's changed paths to its branch with an `[INCOMPLETE]` mark, then restores the working tree to baseline. Already used by the "give up after exhausted restarts" path (`reapStalledWorkers`). |
| `handleWorkerFinished` | `rings/SR-02/ChatViewModel.swift` | Decides disposition on normal completion or failure. Commit path guarded by `failure == nil`. Not called by `reconcileOrphanedWorkers`. |
| `workerBaselineTrees` | `rings/SR-02/ChatViewModel.swift` | Per-worker baseline snapshot. In-memory; lost on restart. The ruler for measuring what changed. |
| `QueenBranchCommitter.commitWorkerChanges` | `rings/SR-02/QueenBranchCommitter.swift` | Commits changed paths to the worker's branch using a temporary index. Filters against `ownedPaths` and the baseline. Never touches HEAD or the real index. |
| `QueenBranchCommitter.changedPaths` | `rings/SR-02/QueenBranchCommitter.swift` | Measures which paths differ from the baseline. Used for logging the rescued file count. |
| `QueenBranchCommitter.snapshotWorkingTree` | `rings/SR-02/QueenBranchCommitter.swift` | Captures the tree object ID before the worker starts. The baseline reference. |
| `DelegatedTaskState.failed` | `rings/SR-00/QueenDelegation.swift` | Terminal, deliberately not archivable. A failure nobody looked at stays in the working view. |
| `queen.worker.orphaned` | TriosLogBus event | Fires on orphan detection. Currently carries worker name and reason; must be supplemented with file count and disposition. |
| `queen.worker.orphaned_edits` | TriosLogBus event (specified) | The rescue event. Carries `issue`, `worker`, `disposition` (`committed`/`reverted`/`unknown`), `files` (comma-separated paths), and `branch`. |
