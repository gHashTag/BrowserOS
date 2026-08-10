# Parallel Work — Layer A

1. Parallel work in Trios means that multiple workers operate on the same repository at the same time, each on an isolated branch that the Queen provisions. No worker checks out another worker's branch, merges anything, or commits to shared lines. The shared checkout is the arena: every worker reads from it, nobody writes to it directly, and the Queen is the only entity that lands completed work.

2. The Queen prevents collisions by scoping each task to explicit file paths. A worker may only create or edit files listed in the boundary section of its specification. If two workers need the same file, the Queen sequences them rather than running them concurrently, so that the second worker starts from the landed state of the first. This makes conflicts a planning failure rather than a merge problem.

3. Verification is individual, not collective. Each worker answers its own acceptance criteria before stopping, and the Queen reviews every criterion against the actual diff before landing anything. A worker does not assume that a sibling task passed, nor does it depend on another worker's output. Independence is the invariant: the result of one task must not depend on the outcome of another task that ran in parallel.
