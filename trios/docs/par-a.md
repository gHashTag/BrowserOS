# Parallel Work — Strategy A

1. **Decompose first, execute second.** Before touching any code, break the task into self-contained slices that can proceed independently. Each slice gets its own branch, its own acceptance criteria, and its own definition of done. The goal is zero cross-dependencies: if slice B cannot be merged without slice A landing first, you have not decomposed far enough. Spend the extra hour at the whiteboard — it saves two days of merge-conflict surgery later.

2. **Isolate through convention, not luck.** Every worker stays inside their boundary path; shared files are read-only by agreement, not by hope. When two workers must touch the same module, one of them blocks on a queue while the other finishes. The Queen coordinates that queue; individual workers never negotiate ownership directly with each other. This keeps the shared checkout stable and the review path linear.

3. **Verify against criteria, not against intent.** When a worker stops, the Queen checks each acceptance criterion literally — met, not met, or could not check. Grand designs and clever abstractions count for nothing if the criteria are silent about them. A thirty-line file that satisfies every stated criterion beats a three-hundred-line file that misses one. Write exactly what is asked, raise everything else as scope discussion, and let the review be short.
