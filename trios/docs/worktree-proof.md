# Worktree Isolation

Git worktrees provide isolated checkout directories that share a single object
database with the main repository. Each worktree maintains its own working tree
files, `HEAD`, and index, while all loose objects and packfiles live in the
common `.git` directory of the primary clone. This design lets multiple branches
be checked out simultaneously on the same machine without copying the full
repository history.

## What Isolation Means in Practice

- **Independent working files.** Editing a file in one worktree does not change
  the same path in another worktree. Two developers (or two automated agents)
  can modify the same project file on different branches without stepping on
  each other.
- **Shared object store.** Blobs, trees, and commits written by any worktree
  are immediately visible to every other worktree. `git log --all` in one
  worktree shows commits made in another.
- **Per-worktree HEAD and index.** Stage and commit operations in one worktree
  are invisible to another until those commits are merged or fetched. The index
  (staging area) is private to each worktree.

## How Trios Uses Worktree Isolation

Trios assigns each worker a dedicated worktree on its own branch. A worker
writes files, runs builds, and executes tests inside that worktree without
touching the shared checkout the user interacts with. When the worker finishes,
the Queen inspects the diff, merges or rejects, and cleans up the worktree.

This guarantees:

1. **No interference with the user's checkout.** The user's working tree stays
   on whatever branch they chose. Workers never `git checkout` or `git stash`
   inside it.
2. **Parallel workers don't collide.** Two workers editing the same file on
   different branches produce independent diffs that the Queen merges
   sequentially.
3. **Atomic review.** Each worktree's diff is self-contained — it contains only
   that worker's changes, making review straightforward.

## Verification

To confirm worktree isolation is working, you can:

```bash
# From the main repository, list active worktrees
git worktree list

# Create a test worktree on a throwaway branch
git worktree add ../tri-test-worktree -b test/isolation-check

# Make a change in the test worktree
echo "probe" > ../tri-test-worktree/PROBE.md

# Verify it does NOT appear in the main checkout
test -f PROBE.md && echo "LEAK DETECTED" || echo "isolated ✓"

# Clean up
git worktree remove ../tri-test-worktree
git branch -D test/isolation-check
```

If `PROBE.md` does not appear in the main checkout, isolation holds: the file
exists only in the test worktree's working tree and was never written to the
user's directory.
