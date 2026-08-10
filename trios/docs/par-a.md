# Parallel Work — Three Notes

1. Parallel work starts long before the first branch is cut. The real cost of concurrency is not the merge conflict — it is the silent divergence, where two workers build incompatible mental models of the same system. Write the spec, name the boundary, and freeze the interface before anyone types a line of code. A spec that fits on one screen is worth more than a design document nobody reads.

2. Isolate the workspace, not just the branch. Every worker needs their own checkout, their own build, and their own failing tests. Shared state is the enemy of parallelism: a dirty working tree, a global config, a hot-reload server bound to one port — any of these can turn a clean merge into an hour of blame and bisect. The machine is cheap; the human hour is not.

3. Land in small, reviewable increments. A branch that lives for two weeks will accumulate enough drift to require a rewrite. Ship partial work behind a feature flag, merge the boring refactor first, and keep the diff readable. The goal is not to finish fast — it is to finish in a state where the next worker can pick up the thread without reading your diary.
