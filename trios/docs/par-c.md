# Parallel Work — Line C (`par-c`)

Line C of the parallel split (#1090) covers the discipline of the shared checkout: how several workers, one build, and the user coexist in a single working copy without stepping on each other.

## The checkout is read-everything, write-scoped

Every party reads the same checkout: the build reads it, the user reads it, sibling workers read it. Reading is free — gathering context from any file is always allowed, because context prevents wrong work. Writing is not: a worker may only create or edit the paths named in the boundary of its specification. Anything written outside the boundary is dropped rather than reviewed, so an out-of-bounds edit costs the worker its turn and the project nothing.

## No branch ceremony in the checkout

Workers do not check out task branches, do not create them, and do not commit. Attribution is the Queen's job: after a worker's turn, the Queen maps the edits to the task branch (`queen/<issue>-<line>`) and lands what survives review. The working tree stays stable for the user and the build while parallel work happens around it.

## Stopping is a report, not a summary

A worker stops by answering its acceptance criteria one at a time — met, not met, or could not check — and never compresses that part. An unchecked criterion is not a pass; the review reads the answers first and the diff second.
