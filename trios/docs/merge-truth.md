# Merge Truth — How a Merge Is Proven

Issue: gHashTag/trios#1146 · Parent: #1090

## What this document is

A description of the evidence Trios requires before it treats a worker's
output as merged — landed on the default branch and part of the codebase.
It covers the chain from acceptance to merge confirmation, the signals
the system reads, the signals it refuses to read, and the post-merge
build that proves the combined tree compiles.

The companion documents
[`queen-archive-rules.md`](queen-archive-rules.md) (when a task may leave
the working view) and
[`interface-drift.md`](interface-drift.md) (why the build runs after
the merge, not before) each cover one slice of this chain in more depth.
This document stands on its own as the full account.

## The central distinction

> **Acceptance is the Queen's opinion; the merge is a fact.**

The Queen reviews a worker's output, checks criteria against evidence,
and records verdicts. When every criterion is `.met`, the task
transitions to `.accepted`. That transition means: the Queen believes
the work is correct and ready to land.

It does not mean the work has landed. The task sits in `.accepted` with
an open pull request, and `DelegatedTask.isSettled` returns `false`
explicitly — accepted work with an open PR has not settled, and treating
it as settled would archive changes that may never reach the branch.

The merge is a fact because it is confirmed by the forge, not by the
Queen. The forge either says `merged == true` or it does not. There is
no opinion in it, no verdict table, no criteria to argue about. The
SHA landed or it did not.

## What proves a merge happened

Three signals, each independent:

### 1. The forge reports `merged == true`

`PullRequest.isMerged` reads the GitHub API response. It returns `true`
when the `merged` field is `true`, or when `merged` is `nil` but
`merged_at` carries a timestamp (the timestamp is only ever written
when a merge happened). This is deliberately not `state == "closed"` —
closing a pull request without merging is how work gets abandoned, and
treating abandonment as success would file away changes that never
reached the branch.

A pull request that reads `state == "closed"` and `merged == false` is
`isClosedUnmerged`. The outcome is `.abandoned`, not `.merged`. The
task goes back to `.awaitingReview`, because nothing landed and the
Queen must decide what to do next.

### 2. The merge commit SHA exists

When the forge merges a pull request (squash or otherwise), it produces
a `merge_commit_sha`. Trios records this SHA. The presence of a
`merge_commit_sha` is the forge's cryptographic receipt: a commit
object exists in the repository history that was created by the merge
operation, and it cannot be fabricated by anything short of rewriting
the repository.

`isExactPullRequestMerge` checks whether the PR's head SHA equals the
merge commit SHA — distinguishing a squash merge (which creates a new
commit) from a fast-forward (which does not) so the status card reports
the right thing.

### 3. The post-merge build passes

A merge that lands a broken tree is not a successful merge. Two workers
can each pass review individually and each compile against the baseline
they started from, yet fail when both branches land: a signature change
in one file meets a call site in another, and neither review saw the
other's change. The compiler is the only judge that can catch this,
because it is the only thing that exercises the dependency between the
two files.

After `mergePullRequest` lands the branch, the system builds the
combined tree. The build must pass. If it fails, the system names the
failing file, identifies the merge that introduced the conflict, blocks
further merges, and surfaces the failure. The tree is not "merged but
broken" — it is in a state that requires repair before anything else
lands.

## What does NOT prove a merge

- **The Queen saying `.accepted`.** Acceptance is an opinion about
  quality, not a fact about the repository. A task can be accepted and
  never merged.
- **The pull request being "closed".** A closed PR may be closed
  unmerged — abandoned, not landed. `isClosedUnmerged` exists
  precisely to catch this.
- **The worker reporting success.** A worker's own statement that its
  work is done is the same agent grading its own homework. The review
  chain exists to turn that statement into checked evidence, and the
  merge confirmation exists to turn checked evidence into a landed
  fact.

## The full sequence

1. **Worker finishes.** Changed paths are committed to the worker's
   virtual branch.
2. **Queen reviews.** The review pipeline builds a brief (criteria, diff,
   file contents), sends it to the reviewer with an adversary marker,
   and parses the verdicts.
3. **Acceptance.** Every criterion is `.met`. The task transitions to
   `.accepted`. If a PR exists, the task is not settled yet.
4. **Merge.** `mergePullRequest` lands the branch on the default base.
   The forge produces a `merge_commit_sha`.
5. **Confirmation.** The next `fetchPullRequest` reads `merged == true`.
   The task transitions to `.merged`. The PR gate releases; `isSettled`
   returns `true`.
6. **Post-merge build.** The combined tree compiles. If it fails,
   further merges are blocked and the failure is surfaced.

Only after step 6 is the merge proven: the forge confirmed it, the SHA
exists, and the tree compiles. Anything less is an opinion.

## Code references

| Symbol | File | Role |
|--------|------|------|
| `PullRequest.isMerged` | `BR-OUTPUT/GitHubModels.swift` | Reads `merged` or `merged_at` from the forge. Not `state == "closed"`. |
| `PullRequest.isClosedUnmerged` | `BR-OUTPUT/GitHubModels.swift` | Closed without merging — abandoned, not landed. |
| `GitHubAPIClient.mergePullRequest` | `BR-OUTPUT/GitHubAPIClient.swift` | Calls the forge to merge the branch. Returns success/failure. |
| `TriNetRepositoryStatus.isExactPullRequestMerge` | `rings/SR-00/TriNetRepositoryStatus.swift` | Checks whether head SHA equals merge commit SHA. |
| `DelegatedTask.isSettled` | `rings/SR-00/QueenDelegation.swift` | The PR gate: accepted + open PR → not settled. |
| `DelegatedTaskState.isArchivable` | `rings/SR-00/QueenDelegation.swift` | `.merged` is archivable; `.accepted` with a PR is not settled. |
| `QueenAcceptancePolicy.acceptanceBlockReason` | `rings/SR-00/QueenCriterionVerdict.swift` | Returns nil only when all criteria are `.met`. |
