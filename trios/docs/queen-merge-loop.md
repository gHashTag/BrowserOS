# Queen Merge Loop

Issue: gHashTag/trios#1096 · Parent: #1090

## What this document is

A description of the rules that govern when the Queen may merge a
pull request and when she must wait. It mirrors the logic in
`pollPullRequests()` (`rings/SR-02/ChatViewModel.swift`) and
`QueenDelegationPolicy` (`rings/SR-00/QueenDelegation.swift`), so that
the policy is readable without tracing code.

## The loop at a glance

```
QueenReviewScheduler.beforeReport
  → pollPullRequests()
      for each task where state == .accepted AND pullRequestNumber != nil:
        1. fetchPullRequest(repo, number)   — ask the forge
        2. outcome = outcome(merged:closedUnmerged:)
        3. if outcome == .pending → attempt mergePullRequest (squash)
        4. transition state based on final outcome
      pruneArchive(limit: 50)               — trim settled tasks
```

The loop runs on the review scheduler's wake cycle — the same tick that
produces the spending digest. A task enters the loop only after the
Queen has reviewed the worker's output and marked it `.accepted`. No
task is polled before the Queen has judged it.

## When the Queen MAY merge

All of the following must be true:

| Condition | Checked by | Why it matters |
|-----------|-----------|----------------|
| Task state is `.accepted` | `pollPullRequests` filter | The Queen reviewed the work against the acceptance criteria and approved it. The merge is the last step of a decision already made. |
| Task has a `pullRequestNumber` | `pollPullRequests` filter | Without a PR there is nothing to merge. A task accepted without a PR settles immediately — there is no forge gate to wait on. |
| PR outcome is `.pending` (open, not merged, not closed-unmerged) | `QueenDelegationPolicy.outcome` | The PR is still open, which means the forge has not answered yet. This is the only state in which the Queen attempts a merge. |

When all three hold, the Queen calls `mergePullRequest` with
`merge_method: "squash"` and a commit title of
`"<task title> (<issue-slug>)"`.

Squash is the default: a worker's branch is a session's worth of
intermediate commits, and the history that matters afterwards is one
change with the issue attached, not eleven attempts at it.

A successful merge returns HTTP 200. The Queen then:

1. Logs `queen.pr.merged` via `TriosLogBus`.
2. Transitions the task to `.merged`.
3. Posts a system message to the Queen's chat.
4. The task is now `isSettled` → it moves to the archive on the next
   `pruneArchive` call (limit: 50 settled tasks retained).

## When the Queen MUST wait

### Forge refuses the merge (HTTP 405 or 409)

| Status | Meaning | What happens |
|--------|---------|-------------|
| **405** | Not mergeable — branch protection rules block it, or a required CI check is failing | `mergePullRequest` returns `false`. The task stays `.accepted` with an open PR. Next poll tries again. |
| **409** | Head moved — the base branch advanced and the PR is out of date | Same: returns `false`, task stays open, next poll tries again. |

Both are normal answers, not errors. The function returns `false`
rather than throwing, because "not allowed to merge yet" is expected
during the loop's lifetime. The task remains visible in the working
view and is polled again on the next scheduler wake.

### Forge cannot be reached

If `fetchPullRequest` throws (network failure, auth error, rate limit),
the loop logs `queen.pr.poll_failed` and **continues to the next task**.
No state change is made. The forge said nothing, so the task stays
exactly where it is — guessing in either direction (marking it merged
or abandoned) would be worse than leaving it alone. The next poll asks
again.

### PR is closed without merging

When the forge reports `state == "closed"` and `merged == false`
(`isClosedUnmerged`), the outcome is `.abandoned`. The Queen does
**not** attempt a merge. Instead:

- The task transitions from `.accepted` back to `.awaitingReview`.
- A warning is posted to the Queen's chat.
- The branch still holds the work — the task needs a decision, not an
  archive.

This is the safety net against premature archival: closing a PR
without merging means nothing landed, and the work is still open.

### PR is already merged

If the forge reports `merged == true` on the initial fetch, the outcome
is `.landed`. The Queen does **not** call `mergePullRequest` — there is
nothing to merge. The task transitions directly to `.merged` and
archives.

This path exists because a human (or another process) may have merged
the PR between polls. The forge is the authority; the Queen does not
re-do work the forge says is done.

## The three outcomes

`QueenDelegationPolicy.outcome(merged:closedUnmerged:)` reads two
facts from the forge and returns exactly one of three values. It takes
booleans, not the GitHub model, because SR-00 is the bottom ring and
must not depend on types from BR-OUTPUT.

| Outcome | Condition | Next state | What the Queen does |
|---------|-----------|------------|---------------------|
| `.landed` | `isMerged == true` | `.merged` | Archives the chat. Posts a success message. The forge says the work landed — not the Queen's opinion. |
| `.abandoned` | `isClosedUnmerged == true` (closed, never merged) | `.awaitingReview` | Sends the task back to the review queue. Posts a warning. Nothing landed. |
| `.pending` | PR is open, not merged, not closed | attempts merge, then re-checks | If merge succeeds → `.merged`. If forge refuses → stays `.accepted`, next poll tries again. |

## Why the forge is the authority

The Queen reviews work against acceptance criteria — that is her
judgement. The merge is a fact established by the forge, not an
extension of the Queen's opinion. This is why `isSettled` returns
`false` for a `.accepted` task that has a `pullRequestNumber`: accepted
work with an open PR has not landed, and treating it as done would
archive changes that may never reach the branch.

Only `.merged` settles a task that has a PR. The task moves to the
archive only when the forge confirms the merge — not when the Queen
approves, not when the worker reports completion, not when the PR is
opened.

## Archival after merge

`pruneArchive(limit: 50)` runs at the end of every `pollPullRequests`
cycle. It drops the oldest settled tasks once the archive exceeds the
limit. "Settled" means `isSettled` is true:

- `.accepted` without a PR → settled (no forge gate to wait on).
- `.merged` → settled (the forge confirmed the merge).
- `.cancelled` → settled (abandoned by decision, not by accident).
- `.failed` → **not** settled (deliberately — a failure nobody has
  looked at is still work, and filing it away silently is how it never
  gets looked at).
- `.accepted` **with** a PR → **not** settled (the merge has not
  happened yet).

## Closed without merge: task returns to work

A PR that is closed without merging is not a completion. The outcome
`.abandoned` transitions the task back to `.awaitingReview`, where the
Queen must decide what to do next: re-open the PR, send the work back
to the worker, or cancel the task.

The branch still holds the worker's commits. Nothing was lost — the
task just needs a decision rather than an archive entry.

## Code references

| File | Role |
|------|------|
| `rings/SR-02/ChatViewModel.swift` — `pollPullRequests()` | The loop itself. Iterates accepted tasks with PRs, asks the forge, attempts merges, transitions state. |
| `rings/SR-00/QueenDelegation.swift` — `QueenDelegationPolicy.outcome / .nextState` | Reads two booleans from the forge and returns the outcome. The only decision function. |
| `rings/SR-00/QueenDelegation.swift` — `DelegatedTask.isSettled` | Determines whether a task can leave the working view. Returns false for accepted work with an open PR. |
| `rings/SR-00/QueenDelegation.swift` — `DelegatedTaskState.isArchivable` | Which states can be archived. `.failed` is deliberately excluded. |
| `rings/SR-02/QueenDelegationRegistry.swift` — `pruneArchive(limit:)` | Drops oldest settled tasks past the limit (default 50). |
| `BR-OUTPUT/GitHubAPIClient.swift` — `mergePullRequest / fetchPullRequest` | The forge calls. `mergePullRequest` returns `false` on 405/409 rather than throwing. |
| `BR-OUTPUT/GitHubModels.swift` — `GitHubPullRequest.isMerged / isClosedUnmerged` | Distinguishes a merged PR from a closed-unmerged one. List endpoints omit `merged`; only the single-PR fetch reports it. |
