# Interface Drift — When a Signature Change in One Bee Breaks Another

Issue: gHashTag/trios#1111 · Parent: #1090

## What this document is

A description of interface drift: how a worker that changes a function
signature in its own file can silently break a different file owned by a
second, concurrent worker — and what the system must do about it so the
shared checkout never ends up in a state that does not compile.

It covers `QueenDelegationPolicy.conflictingTasks` and
`QueenDelegationPolicy.pathsOverlap` (`rings/SR-00/QueenDelegation.swift`),
which today detect *path* conflicts between two workers but cannot detect
*call-site* conflicts that cross file boundaries. It also covers
`QueenBranchCommitter.commitWorkerChanges`
(`rings/SR-02/QueenBranchCommitter.swift`), which commits each worker's
files onto its branch independently, and `BuildVariantPolicy`
(`rings/SR-00/BuildVariantPolicy.swift`), which governs what a build
produces.

The companion document
[`orphaned-worker-edits.md`](orphaned-worker-edits.md) describes what
happens when a single worker fails mid-turn. This document focuses on a
different failure: two workers each succeed, each in their own lane, and
the combination is broken.

## The problem

Workers share one checkout. Each one's edits are isolated not by worktrees
but by:

1. A **file-ownership boundary** (`DelegatedTask.ownedPaths`) that says
   which paths a bee may write.
2. A **baseline tree snapshot** taken before the turn
   (`QueenBranchCommitter.snapshotWorkingTree`) so a diff can measure what
   changed.
3. A **virtual-branch commit** (`QueenBranchCommitter.commitWorkerChanges`)
   that carries only the worker's files onto its own ref, never touching
   HEAD or the real index.

This isolation is structural for *file* conflicts. `conflictingTasks`
detects when two bees would write the same path before they start, and
`pathsOverlap` catches the subtle case where one bee owns `rings` and
another owns `rings/SR-02/ChatViewModel.swift` — both inside their
boundary when they touch that file, but the paths overlap by containment.

But the isolation is blind to **interface** conflicts, which cross file
boundaries without touching the same file:

```
Bee A owns: rings/SR-00/QueenBriefing.swift
            — changes func briefingText() -> String
              to func briefingText(for conversationId: UUID) -> String

Bee B owns: BR-OUTPUT/FullscreenChatWorkspace.swift
            — still calls briefingText() with no arguments
```

Both files are in separate lanes. No path overlap. Both workers compile
against the baseline tree — each one's branch contains only its own files
laid over the unchanged baseline, so Bee B's file still has the old call
site and the old signature is still in the baseline. Each branch builds.
Each passes review.

But when both branches merge, the combined tree has the new signature from
Bee A and the old call site from Bee B. The tree does not compile. Nobody
saw it because nobody compiled the combination — only each branch alone.

## Why path ownership cannot catch this

`pathsOverlap` is path-component comparison: `a == b || a.hasPrefix("b/")
|| b.hasPrefix("a/")`. It answers "do these two boundaries reach the same
file?" That is necessary and sufficient for *write* conflicts — two bees
writing the same file produce a merge conflict that git itself surfaces.

Interface drift is different. The two files are unrelated by path. The
dependency between them is a compile-time fact known only to the compiler:
`FullscreenChatWorkspace.swift` references `briefingText()` because Swift's
type system says it exists in the module. No amount of path comparison
discovers that dependency. The only thing that discovers it is compiling
the tree with both changes present.

## How the drift is detected

After the Queen merges a worker's branch, the combined tree must be built.
The build is the check: it is the only reliable signal that a signature
change and its call sites are consistent. A path check cannot substitute,
and a review that only reads the diff cannot substitute, because neither
one exercises the dependency the compiler would catch.

### The sequence

1. **Worker finishes.** `handleWorkerFinished` commits the worker's changed
   paths to its virtual branch via `QueenBranchCommitter.commitWorkerChanges`.

2. **Queen reviews and accepts.** The task transitions to `.accepted`.

3. **Branch merges.** `mergePullRequest` lands the branch on the default
   base (`QueenBranchCommitter.baseBranch`).

4. **Post-merge build.** The checkout now carries the merged changes. The
   system runs `./build.sh` (or the ring-appropriate compilation step) against
   the combined tree. This is the point where a call site in Bee B's file
   meets the changed signature in Bee A's file.

5. **Build passes → done.** No drift, or the drift did not cross into a
   compilation dependency. The tree is consistent.

6. **Build fails → drift detected.** The merge introduced a compilation
   error. The system names the failing file and the merge that introduced
   it, blocks further merges until the error is resolved, and surfaces the
   failure in the Queen's chat.

### Why the build must run *after* the merge, not before

Each worker's branch is built against the baseline during its own review.
That build proves the worker's changes are consistent with the tree as it
was when the worker started. It cannot prove the changes are consistent
with the tree as it will be *after* another worker's branch also merges —
because that other branch did not exist in the baseline.

The post-merge build is the only point where both sets of changes coexist
in one tree and the compiler can judge their interaction. Running it
before the merge would compile the same branch the review already compiled
and discover nothing new.

## What happens when the tree does not compile

When the post-merge build fails, the system must not leave the checkout in
a broken state. The failure means the merged tree has a signature mismatch
that neither worker's individual review could have caught.

### Required disposition

1. **The failing file is named.** The build output identifies the file with
   the call site (Bee B's file) and the symbol it cannot resolve. The
   Queen's chat records both the file and the merge that introduced the
   incompatible signature.

2. **The checkout is restored to a building state.** The broken merge is
   either reverted or the call site is updated to match the new signature.
   Leaving the checkout in a non-compiling state blocks every subsequent
   worker and every subsequent build.

3. **The task is routed back.** The worker whose file has the stale call
   site is reopened (or a new task is opened) to update it to the new
   signature. The task that changed the signature is not at fault — it was
   inside its boundary — but its review must now note that it broke a caller
   and the caller needs to catch up.

### What does not happen

- The signature change is **not** automatically reverted. The change was
  legitimate work inside the worker's boundary. Reverting it would discard
  correct work because a *different* file has not caught up.

- The caller is **not** silently fixed. Editing Bee B's file from Bee A's
  branch would be a boundary violation — exactly the thing `ownedPaths`
  exists to prevent. The fix belongs on a new turn or a new task that owns
  the caller's file.

## The test that enforces this

A post-merge build that catches interface drift is enforced by a test that
reproduces the two-worker scenario:

1. Set up a scratch repository with a module containing two files:
   `Provider.swift` with `func provide() -> String` and `Consumer.swift`
   with a call to `provide()`.

2. Create two branches from the baseline:
   - Branch **A**: changes `provide()` to `provide(count: Int) -> String`.
   - Branch **B**: adds an unrelated function to `Consumer.swift` without
     updating the call to `provide()`.

3. Both branches build individually against the baseline.

4. Merge branch A, then merge branch B.

5. Run the build on the combined tree.

6. **Assert the build fails** — the call site in `Consumer.swift` does not
   match the new signature in `Provider.swift`.

7. Assert that the failure names the file and the merge that introduced the
   incompatible signature.

8. Restore the checkout to a building state and assert the tree compiles
   again.

### Criterion 2: the check breaks if old behaviour returns

If the post-merge build step is removed — for example by skipping the
`./build.sh` call after merge, or by compiling only the merged branch
instead of the combined tree — step 6 no longer fails. The test expects a
failure and does not get one, so the test itself breaks. That is the
enforcement: the test cannot pass unless the post-merge build runs against
the full combined tree.

If someone restores the old behaviour — merging without building, or
building only the branch in isolation — the test fails because it asserts
on a compilation error that the old behaviour does not produce. A passing
test is proof the check exists; a failing test is proof it was removed.

## Concrete example

```
Baseline tree:
  rings/SR-00/QueenBriefing.swift
    static func briefingText() -> String { ... }

  BR-OUTPUT/FullscreenChatWorkspace.swift
    let text = QueenBriefing.briefingText()

Two tasks delegated in parallel:

Task #1 — "Add conversation scoping to briefing"
  owns: rings/SR-00/QueenBriefing.swift
  change: briefingText() → briefingText(for conversationId: UUID)

Task #2 — "Add dark-mode accent to workspace header"
  owns: BR-OUTPUT/FullscreenChatWorkspace.swift
  change: new colour constant, unrelated to briefingText()
```

Both tasks run. Both compile against the baseline. Both pass review. Both
branches merge.

The combined tree now has:

```swift
// QueenBriefing.swift (from Task #1)
static func briefingText(for conversationId: UUID) -> String { ... }

// FullscreenChatWorkspace.swift (from Task #2)
let text = QueenBriefing.briefingText()  // ← no longer compiles
```

The post-merge build catches this. Without it, the broken call site would
sit in the tree until the next `./build.sh` — which might be the user's,
the next worker's, or nobody's.

## Why this is not the same as a merge conflict

A git merge conflict occurs when two branches change the **same lines** of
the **same file**. Git refuses to merge and leaves conflict markers.

Interface drift occurs when two branches change **different files** that
have a **compile-time dependency**. Git merges cleanly — there is no
textual conflict. The breakage is semantic: the call site and the
signature disagree, and only the compiler knows.

This is why a post-merge build is needed even when `git merge` reports no
conflicts: git checks text, the compiler checks types, and the gap between
them is exactly the size of one undetected interface drift.

## Code references

| Symbol | File | Role |
|--------|------|------|
| `QueenDelegationPolicy.conflictingTasks` | `rings/SR-00/QueenDelegation.swift` | Detects path overlaps between two workers' boundaries. Catches write conflicts; cannot catch interface conflicts. |
| `QueenDelegationPolicy.pathsOverlap` | `rings/SR-00/QueenDelegation.swift` | Path-component containment check. The basis for `conflictingTasks`. Path-only — no knowledge of compile-time dependencies. |
| `DelegatedTask.ownedPaths` | `rings/SR-00/QueenDelegation.swift` | The file boundary each worker is confined to. Prevents write conflicts; does not prevent call-site drift. |
| `QueenBranchCommitter.commitWorkerChanges` | `rings/SR-02/QueenBranchCommitter.swift` | Commits each worker's files to its branch independently. Builds the commit tree from the branch tip plus the worker's changed paths. Never compiles the combined tree. |
| `QueenBranchCommitter.snapshotWorkingTree` | `rings/SR-02/QueenBranchCommitter.swift` | Baseline tree snapshot. The reference point each branch is built against in isolation. |
| `QueenBranchCommitter.baseBranch` | `rings/SR-02/QueenBranchCommitter.swift` | The trunk branch a worker's PR merges onto. After merge, the checkout carries the combined changes. |
| `QueenDelegationPolicy.outcome(merged:closedUnmerged:)` | `rings/SR-00/QueenDelegation.swift` | Determines task state from the forge's merge result. The post-merge build must run after `.landed` and before the task settles. |
| `BuildVariantPolicy` | `rings/SR-00/BuildVariantPolicy.swift` | Governs which application a build produces and which variant the default build targets. |
| `DelegatedTask.isSettled` | `rings/SR-00/QueenDelegation.swift` | Whether a task may leave the working view. A task whose merge broke the tree must not settle until the tree compiles. |
