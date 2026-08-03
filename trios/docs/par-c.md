# Parallel Work — Pattern C

Parallel work in Trios means multiple agents (workers) operate on the same repository at the same time, each on its own branch, each confined to a tightly scoped specification. This document captures the practical rules that keep parallel streams from colliding.

## Core Principles

1. **One spec per worker.** Every worker receives a specification with explicit acceptance criteria and a boundary that lists every file path the worker may touch. Edits outside the boundary are dropped — not reviewed, not discussed, simply discarded.

2. **Shared checkout, separate branches.** The working tree is shared across all workers and the build system. Workers never check out, switch, or commit on their own branch — the Queen handles attribution after each turn. This means a worker must never assume the checkout reflects its own prior edits; always re-read files before acting.

3. **No cross-worker dependencies.** If worker A needs something worker B is producing, that is a specification problem, not a workflow problem. Specs are written so that each worker is self-contained. If you discover an unstated dependency, raise it — do not work around it quietly.

## What Goes Wrong

- **Path overlap.** Two workers editing the same file produce a conflict the Queen must resolve manually. Specs prevent this by partitioning file paths.
- **Scope creep.** A worker notices something "obviously needed" and fixes it. That edit lands outside the boundary and gets dropped — wasting the worker's effort and the reviewer's attention. Always raise scope questions instead of acting on them.
- **Stale assumptions.** Because the checkout is shared, the file you read at the start of your turn may have changed by the time you write. Re-read defensively; trust nothing between reads.
