# Parallel Work (Branch B)

Parallel work is the practice of splitting a large task into smaller, independent subtasks that progress at the same time. In the Trios project, parallel work happens at two levels: across branches and across agents.

## Why Parallel Work Matters

When tasks are independent, running them concurrently reduces total wall-clock time. A task that would take six hours sequentially can finish in two hours when three workers pick up disjoint slices. The key constraint is **independence** — if two workers edit the same file or depend on each other's output, they are no longer parallel; they are serialized with extra coordination overhead.

## Branch-Level Parallelism

Each worker owns a dedicated Git branch (e.g. `queen/1148-write-docs-par-b-md-about-parallel-work`). The Queen assigns slices of work to branches, and workers never cross boundaries. This prevents merge conflicts and keeps review focused — each branch tells a single, coherent story.

## Agent-Level Parallelism

Multiple agents can run simultaneously, each on its own branch. The Queen coordinates: it assigns tasks, tracks progress, and merges results. Workers do not communicate with each other directly; all coordination flows through the Queen.

## Pitfalls

- **Hidden coupling**: Two tasks that seem independent may share an underlying file or interface. Surface these early.
- **Review bottlenecks**: If every branch needs the same reviewer, that reviewer becomes the serial constraint.
- **Merge thrash**: When branches touch overlapping code, merges produce conflicts that consume the time parallelism saved.

## Summary

Parallel work succeeds when tasks are truly independent, boundaries are explicit, and coordination is centralized. The Queen model enforces all three: branches isolate changes, criteria define scope, and the Queen handles merging.
