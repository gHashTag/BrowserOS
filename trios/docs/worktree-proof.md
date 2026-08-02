# Worktree Isolation Proof

## What Is a Git Worktree?

A Git worktree allows you to check out multiple branches from the same repository into separate directories on disk. Each worktree has its own working directory and index, yet they all share a single `.git` object store. This means objects, refs, and packed data exist once on disk — only the working tree and index diverge per worktree.

## Why Isolation Matters

Without worktrees, a developer who needs to switch context must either `git stash` or commit half-finished work on the current branch. Both options are fragile: stashes get lost, and throwaway commits pollute history. Worktrees eliminate the problem entirely. You create a second directory linked to the same repo, check out the target branch there, and leave the first directory untouched.

### Concrete Isolation Properties

1. **Independent index** — each worktree maintains its own staging area. Files staged in one worktree do not appear staged in another.
2. **Independent HEAD** — each worktree has its own `HEAD` ref, pointing to its own branch or commit. Switching branches in one worktree has zero effect on any other.
3. **Shared object database** — commits, blobs, and trees created in any worktree are immediately visible to all others because the underlying `.git/objects` store is shared. There is no duplication of history.
4. **Independent untracked files** — files ignored or untracked in one worktree do not leak into another. Each directory has its own `.gitignore` resolution and working set.
5. **Per-worktree refs** — branches created inside a worktree are visible across the repository (they live in `refs/heads`), but the working directory state is fully isolated.

## Worktrees in the Queen Worker Model

The Trinity Queen dispatches specs to worker agents, each of which may operate in its own worktree checkout. This gives every worker a private sandbox:

- Workers edit files without colliding with each other.
- The user's primary checkout remains undisturbed.
- The Queen merges completed worktrees by copying the allowed paths into the target branch.

Because the object store is shared, a worker in its own worktree can read any commit, branch, or tag that exists in the repository — it simply cannot write to another worker's working tree.

## Proof of Concept

```bash
# From the repository root:
git worktree add ../trios-worker -b queen/1143-write-docs-worktree-proof-md-about

# Now two directories exist:
#   ./trios          ← user's checkout, untouched
#   ../trios-worker  ← worker checkout, on its own branch

# Edits in ../trios-worker do NOT appear in ./trios until explicitly merged.
ls docs/worktree-proof.md          # absent in main checkout
ls ../trios-worker/docs/worktree-proof.md  # present in worker checkout
```

## Cleanup

```bash
git worktree remove ../trios-worker
git worktree prune
```

## Conclusion

Worktrees provide filesystem-level isolation with a shared history. They are the mechanism that makes parallel Queen workers safe: each worker edits in its own directory, the user's checkout is never disturbed, and the Queen controls what lands in the canonical branch.
