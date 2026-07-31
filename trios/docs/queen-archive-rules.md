# Queen Archive Rules — When a Chat May Leave the Working View

Issue: gHashTag/trios#1096 · Parent: #1090

## What this document is

The rules that determine when a delegated task's chat may be
archived — moved out of the working view and into the settled archive,
where it is eventually pruned. These rules are the human-readable mirror
of `DelegatedTask.isSettled` and `DelegatedTaskState.isArchivable`
(`rings/SR-00/QueenDelegation.swift`) and `pruneArchive`
(`rings/SR-02/QueenDelegationRegistry.swift`).

The companion document
[`queen-merge-loop.md`](queen-merge-loop.md) describes the full
poll-merge-transition cycle. This document focuses on one question:
when may a chat leave the working view?

## The core rule

> A chat may be archived when its task is **settled**: the work has
> reached a state where the Queen has no further action to take on it,
> and (if a pull request exists) the forge has confirmed the merge.

Settlement is checked by `DelegatedTask.isSettled`. It depends on two
things:

1. **`DelegatedTaskState.isArchivable`** — whether the *state* allows
   archival.
2. **`pullRequestNumber`** — whether a PR is attached. If one is, the
   state alone is not enough.

## When a chat MAY be archived

### After the PR lands (the primary path)

A pull request "lands" when the forge reports `merged == true`. This
can happen two ways:

| How | What the Queen does | Result |
|-----|---------------------|--------|
| The Queen's `mergePullRequest` call succeeds (squash) | Logs `queen.pr.merged`, transitions to `.merged`, posts a success message. | Task settles. |
| The forge reports the PR already merged on the next `fetchPullRequest` (a human or another process merged it between polls). | The Queen does **not** re-merge. Transitions directly to `.merged`. | Task settles. |

Either way, the task is now `.merged`. Because `.merged` is in the
`isArchivable` set and the PR gate no longer applies (the state is no
longer `.accepted`), `isSettled` returns `true`. The chat moves to the
archive on the next `pruneArchive` call.

### Accepted without a PR

A task accepted by the Queen that never had a pull request settles
immediately. There is no forge gate to wait on — `isSettled` checks
`state == .accepted && pullRequestNumber != nil`, finds no PR, and
falls through to `state.isArchivable`, which returns `true` for
`.accepted`.

### Cancelled

A task the Queen cancels (`.cancelled`) settles. Cancellation is a
deliberate decision, not an accident, and the `isArchivable` set
includes `.cancelled`.

## When a chat MUST NOT be archived

### Accepted with an open PR

This is the most important exclusion. A task marked `.accepted` that
has a `pullRequestNumber` is **not settled** — `isSettled` returns
`false` explicitly:

```swift
var isSettled: Bool {
    if state == .accepted, pullRequestNumber != nil { return false }
    return state.isArchivable
}
```

The Queen's acceptance is an opinion; the merge is a fact. Accepted
work with an open PR has not landed, and archiving it would file away
changes that may never reach the branch.

### PR closed without merging

When the forge reports `state == "closed"` and `merged == false`
(`isClosedUnmerged`), the outcome is `.abandoned`. The Queen does **not**
archive. Instead, the task transitions back to `.awaitingReview` —
nothing landed, and the Queen must decide what to do next.

The branch still holds the worker's commits. The task needs a decision,
not an archive entry.

### Failed

A task in `.failed` state is terminal (it reached an end) but
**deliberately not archivable**. `isArchivable` returns `false` for
`.failed`. The reasoning: a failure nobody has looked at is still work,
and filing it away silently is how it never gets looked at.

| State | Terminal? | Archivable? | Settled (no PR)? | Settled (with PR)? |
|-------|-----------|-------------|-------------------|---------------------|
| `.queued` | no | no | no | no |
| `.running` | no | no | no | no |
| `.awaitingReview` | no | no | no | no |
| `.accepted` | yes | yes | **yes** | **no** (PR gate) |
| `.merged` | yes | yes | **yes** | **yes** |
| `.rejected` | no | no | no | no |
| `.cancelled` | yes | yes | **yes** | **yes** |
| `.failed` | yes | **no** | no | no |

## How the archive works mechanically

```
pruneArchive(limit: 50)
  settled = tasks.filter { $0.isSettled }       // the archive
  guard settled.count > limit else { return 0 }  // under the cap
  doomed = Set(settled.dropFirst(limit))         // oldest beyond the cap
  tasks.removeAll { doomed.contains($0.id) }     // drop them
```

`pruneArchive` runs at the end of every `pollPullRequests` cycle. It
keeps at most 50 settled tasks, dropping the oldest beyond that. The
limit prevents unbounded growth of the persisted store and the sidebar.

A chat does not move to the archive the instant it settles. It moves
when `pruneArchive` next runs. Until then, it sits in the settled
section — visible in the archive list but no longer in the working view.

## The distinction: terminal vs archivable vs settled

Three concepts govern a task's lifecycle, and they are not the same:

- **`isTerminal`** — the task reached an end state (`.accepted`,
  `.cancelled`, `.failed`, `.merged`). It will not transition further on
  its own. But terminal does not mean archivable: `.failed` is terminal
  and stays in the working view.
- **`isArchivable`** — the state allows the task to leave the working
  view. Excludes `.failed` deliberately.
- **`isSettled`** — combines `isArchivable` with the PR gate. This is
  the single property that determines whether a chat may be archived.

## Code references

| Symbol | File | Role |
|--------|------|------|
| `DelegatedTaskState.isArchivable` | `rings/SR-00/QueenDelegation.swift` | Which states may leave the working view. `.failed` excluded. |
| `DelegatedTaskState.isTerminal` | `rings/SR-00/QueenDelegation.swift` | Which states are end-of-life. Broader than archivable. |
| `DelegatedTask.isSettled` | `rings/SR-00/QueenDelegation.swift` | The single check: archivable state AND no open PR gate. |
| `DelegatedTask.pullRequestNumber` | `rings/SR-00/QueenDelegation.swift` | The PR gate. When non-nil and state is `.accepted`, settlement is blocked. |
| `QueenDelegationRegistry.pruneArchive(limit:)` | `rings/SR-02/QueenDelegationRegistry.swift` | Drops oldest settled tasks past the limit (default 50). |
| `QueenDelegationRegistry.archived` | `rings/SR-02/QueenDelegationRegistry.swift` | `tasks.filter { $0.isSettled }` — the settled section. |
| `QueenDelegationRegistry.openTasks` | `rings/SR-02/QueenDelegationRegistry.swift` | `tasks.filter { !$0.isSettled }` — the working view. |
| `pollPullRequests()` | `rings/SR-02/ChatViewModel.swift` | The cycle that calls `pruneArchive` after processing PRs. |
