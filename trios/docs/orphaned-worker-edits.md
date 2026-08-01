# Orphaned Worker Edits — What Happens When a Worker Times Out

Issue: gHashTag/trios#1112

## What this document is

When a worker's request times out or its stream dies mid-turn, its
file edits sit loose in the shared working tree: not committed to the
worker's branch, not reverted, not named in the log. The next worker,
the build, and the user all see them as unattributed changes with no
explanation. This document specifies the dispositions the system must
guarantee and the log that must accompany each one.

It covers `handleWorkerFinished` and `reapStalledWorkers`
(`rings/SR-02/ChatViewModel.swift`), `reconcileOrphanedWorkers`
(`rings/SR-02/QueenDelegationRegistry.swift`), and
`QueenBranchCommitter` (`rings/SR-02/QueenBranchCommitter.swift`).

## What "timeout" means here

A worker edits files in the shared checkout through tool calls streamed
over SSE. Three failures end a turn without the worker reaching its
terminal event:

| Failure | Where it originates | What the runner does |
|---------|---------------------|----------------------|
| **Request timed out** | `TransportError.requestTimedOut` in `SSETransport` (`rings/SR-01/SSETransport.swift`) — the HTTP request exceeded its interval with no response. | `transcript.failWithoutStream(Self.describe(error))` — sets a non-nil failure string. |
| **Stream ended without a terminal event** | `QueenWorkerRunner.execute` — the SSE stream closed before `[DONE]` arrived. | `transcript.failWithoutStream("The worker's stream ended without a terminal event.")` |
| **Process restart** | `QueenDelegationRegistry.reconcileOrphanedWorkers` — a task still in `.running` at launch. Its process died; the stream is gone. | Marked `.failed` in the registry. |

In every case `QueenWorkerRunner.finish` calls `onFinish(task, failure,
usage)` with a non-nil failure, which routes to
`handleWorkerFinished`. That handler's commit path is guarded by
`if failure == nil` — so the branch never receives the worker's edits,
and the edits stay in the working tree.

## The problem

Workers share one checkout. Each one's edits are isolated not by
worktrees but by a baseline tree snapshot taken before the turn starts
(`workerBaselineTrees[conversationId]`) and a commit to the worker's
virtual branch after the turn ends. The isolation depends on the
commit running.

When the turn fails:

- `handleWorkerFinished` skips the commit (the `failure == nil` guard).
- It clears the baseline (`workerBaselineTrees[...] = nil`).
- It transitions the task to `.failed`.
- It posts a notice naming only the worker and the failure reason.

What it does **not** do: name the files the worker edited, commit them
to the branch with a mark of incompleteness, or revert them. They sit
in the working tree, owned by nobody, attributed to nothing. The
boundary-committer test at `ChatSSEEndToEndTest.swift` already proves
that out-of-boundary files are "left in the working tree, not swept
onto the branch" — but it proves it for the success path, where the
omission is a safety feature. On the failure path the same omission is
a hole.

## Required disposition

When a worker fails — whether by timeout, aborted stream, or process
restart — its edits must leave the working tree in one of two states.
Both are acceptable; **leaving the tree silently dirty is not.**

### Option A: commit to the branch with a mark of incompleteness

The worker's changed paths are committed to its virtual branch with a
commit message that marks the work as unfinished. The mark is a prefix
on the commit message — for example:

```
[INCOMPLETE] queen(owner/repo#123): Add frobnicator
```

This preserves whatever the worker produced before the failure. The
Queen's reviewer sees the branch and knows the work is partial.

`QueenBranchCommitter.commitWorkerChanges` already filters changed
paths against the worker's `ownedPaths` and the baseline tree. On the
failure path the same function runs with the incomplete mark in the
message; the plumbing does not change.

After the commit, the working tree must be restored to the baseline
state so the orphaned edits do not persist for the next worker or the
build. The commit reads from the tree, not from the checkout, so
restoring it afterwards is safe.

### Option B: revert the changed paths

If the worker's edits cannot be committed (the branch does not exist,
no baseline was taken, or the changed paths are all outside the
boundary), the paths that differ from the baseline are reverted to
that baseline. The working tree returns to the state it was in before
the worker started.

### What both options have in common

Either way:

1. **The working tree is clean relative to the baseline after the
   handler returns.** No orphaned edits from a failed worker remain in
   the checkout. A subsequent `git diff` against the baseline shows
   nothing attributable to that worker.

2. **The files are named in the log.** The handler records each
   changed file by name, whether it was committed (Option A) or
   reverted (Option B), in a `TriosLogBus` entry. The log entry carries
   the worker name, the issue slug, and the list of files.

3. **The disposition is visible in the Queen's chat.** The notice
   posted by `handleWorkerFinished` says which option was taken and
   which files were affected.

## How the files are logged

The log entry for a failed worker's edits follows the same pattern as
existing worker log entries (`queen.worker.finish`,
`queen.worker.failed`) and uses a distinct event name so it is
filterable:

```
queen.worker.orphaned_edits
```

| Attribute | Value |
|-----------|-------|
| `issue` | `task.issue.slug` |
| `worker` | `task.worker` |
| `disposition` | `committed` or `reverted` |
| `files` | Comma-separated list of repository-relative paths that changed since the baseline |
| `branch` | The worker's virtual branch name (when committed) |

The file list is produced by `QueenBranchCommitter.changedPaths(since:
baselineTree)` — the same function the success path uses to measure
boundary violations. It already filters out `.trinity/state/` and
`.trinity-dev/state/` bookkeeping, so the log shows only paths the
worker actually edited.

The Queen's chat notice carries the same information in prose, so a
user reading the chat (not just the structured log) can see what
happened without opening the worker's branch or running `git diff`.

## When the baseline is missing

If no baseline tree was captured (`workerBaselineTrees[conversationId]
== nil`), the handler cannot measure what the worker changed. In this
case:

- The handler logs `disposition = "unknown"` with the event
  `queen.worker.orphaned_edits` and a message explaining that the
  baseline was missing.
- The Queen's chat notice says the worker's edits could not be
  attributed because the baseline snapshot was never taken.
- The task still transitions to `.failed`.

This is the honest answer: the handler refuses to guess which files
belong to the worker, and it says so out loud rather than silently.

## Process restart: the reconcile path

`reconcileOrphanedWorkers` runs at launch and marks every `.running`
task as `.failed`. At this point the worker's process is gone, but its
edits may still be in the working tree — the previous process wrote
them before dying.

The reconcile path faces the same problem as the in-process failure
path, with an additional constraint: the baseline tree
(`workerBaselineTrees`) is in-memory and was lost with the process.
The only baseline available is the one persisted in the delegation
store or recoverable from the branch tip.

The required behaviour is the same: the working tree must not carry
orphaned edits from a task that failed. If a persisted baseline is
available, the handler commits or reverts using it. If not, it logs
`disposition = "unknown"` and names the worker and issue so a human
can inspect the tree.

## The test that enforces this

A worker that fails must leave the working tree clean. The test
asserts this directly:

1. Set up a scratch repository with a known HEAD tree.
2. Take a baseline snapshot.
3. Run a worker whose stream fails (a cassette with no terminal event,
   or a replay transport that throws `TransportError.requestTimedOut`).
4. Assert that the worker's `handleWorkerFinished` ran with a non-nil
   failure.
5. After the handler returns, snapshot the working tree and diff
   against the baseline.
6. **Assert the diff is empty** — no file the worker edited remains in
   the working tree.
7. Assert that a `queen.worker.orphaned_edits` log entry was emitted
   naming the files the worker wrote.

If the handler is changed to leave edits in the tree again — for
example by removing the revert, or by forgetting the commit path on
failure — step 6 breaks. The assertion fails because the tree is
dirty, and the failure message names the file that should not be
there.

This is criterion 3 in practice: the check is a test, and the test
breaks the build when the tree is left dirty after a failure.

## Summary of the guarantee

| Worker outcome | Edits committed to branch? | Working tree clean? | Files named in log? |
|----------------|---------------------------|---------------------|---------------------|
| **Finished cleanly** | Yes (full commit, normal message) | Yes — committed, tree matches baseline for the worker's paths | Yes (`queen.branch.committed`) |
| **Failed (timeout / aborted stream)** | Yes (commit with `[INCOMPLETE]` mark) or reverted if commit impossible | **Yes** — either committed-and-restored or reverted to baseline | **Yes** (`queen.worker.orphaned_edits`) |
| **Process restart** | If baseline available: committed or reverted. If not: left for a human with a named log entry. | **Yes**, or explicitly logged as unknown | **Yes** (`queen.worker.orphaned_edits`) |

The invariant: a failed worker never leaves the shared checkout in a
changed state without saying what it left, where it left it, and why.

## Code references

| Symbol | File | Role |
|--------|------|------|
| `QueenWorkerRunner.execute` | `rings/SR-02/QueenWorkerRunner.swift` | Drives the worker turn; detects aborted streams and timeouts, calls `finish` with the failure. |
| `QueenWorkerRunner.finish` | `rings/SR-02/QueenWorkerRunner.swift` | Logs `queen.worker.failed`, calls `onFinish(task, failure, usage)`. |
| `handleWorkerFinished` | `rings/SR-02/ChatViewModel.swift` | Decides disposition: commit path (failure == nil) vs. failure path. Must commit-or-revert on failure. |
| `workerBaselineTrees` | `rings/SR-02/ChatViewModel.swift` | Per-worker baseline tree snapshot. The reference point for measuring what changed. |
| `QueenBranchCommitter.commitWorkerChanges` | `rings/SR-02/QueenBranchCommitter.swift` | Commits changed paths to the worker's branch using a temporary index. Never touches HEAD or the real index. |
| `QueenBranchCommitter.changedPaths` | `rings/SR-02/QueenBranchCommitter.swift` | Measures which paths differ from the baseline. Used for logging on the failure path. |
| `QueenBranchCommitter.snapshotWorkingTree` | `rings/SR-02/QueenBranchCommitter.swift` | Captures the tree object ID before the worker starts. |
| `reapStalledWorkers` | `rings/SR-02/ChatViewModel.swift` | Handles workers that went silent. After restarts are exhausted, must clean up the tree. |
| `reconcileOrphanedWorkers` | `rings/SR-02/QueenDelegationRegistry.swift` | Marks `.running` tasks as `.failed` at launch. Must clean up or log orphaned edits. |
| `DelegatedTaskState.failed` | `rings/SR-00/QueenDelegation.swift` | Terminal, deliberately not archivable — a failure nobody looked at stays in the working view. |
| `TransportError.requestTimedOut` | `rings/SR-01/SSETransport.swift` | The timeout error the runner catches. |
