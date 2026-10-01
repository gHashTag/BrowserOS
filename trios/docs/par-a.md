# Parallel Work — Track A

Parallel work in Trios is the Queen splitting one effort into slices that run at the same time, each slice pinned to exact file paths before any worker starts. The boundary is the whole safety story: a worker may create or edit only the paths named in its specification, and anything it writes elsewhere is dropped rather than reviewed. Two workers are never pointed at the same file — when needs overlap, the Queen sequences them, so the second begins from the landed state of the first. Collision prevention is a planning act, not a merge act.

Independence is deliberate. A worker does not read a sibling's output, wait on it, or assume it passed: each task must stand on its own acceptance criteria whatever the others did. Verification follows the same line — every worker answers its own criteria, one by one, plainly, and the Queen reviews the actual edit against the spec before anything lands. Work that looks obviously needed but is not in the spec gets raised in the report rather than done quietly, because unstated scope is where a review turns into an argument.

Workers write files and nothing else: no branch switches, no branch creation, no commits. The checkout is shared with the user, the build, and every other worker; attribution happens after the turn, when the Queen lands the work on the worker's branch.

One practical lesson from this very track: the specification's paths are relative to the project the issue belongs to, not to wherever a worker's shell happens to open. Reading the boundary against the wrong root sends the edit outside the owned paths, and the Queen's committer rightly sweeps up nothing. Resolve every path against the repository root before writing.
