# How many bees run in parallel, and what actually stops them

Measured 2026-08-29 against the live Railway container and the live Queen.
Re-run every command here before acting on it.

## The answer in one line

**The container could run dozens. The Queen is running zero.** What binds is
not hardware, not the cap, and not the cloud: it is three parked reviews
holding path boundaries that nothing releases.

## The container is nowhere near its limit

```
cpu.max        2400000 / 100000  = 24 vCPU   (nproc says 48 - that is the host)
memory.max     24 GB             (283 MB at idle)
pids.max       1000
/workspace     1.8 TB free       (154 MB per worktree, 115 MB blobless .git)
```

Concurrency measured by firing real tool calls at it:

| concurrent calls | wall | ok | median | max |
|---:|---:|---:|---:|---:|
| 1 | 3.2 s | 1/1 | 3.2 s | 3.2 s |
| 8 | 1.5 s | 8/8 | 1.5 s | 1.5 s |
| 24 | 1.7 s | 24/24 | 1.5 s | 1.7 s |
| 48 | 1.7 s | 48/48 | 1.5 s | 1.6 s |
| 96 | 2.6 s | 96/96 | 1.7 s | 2.0 s |
| 200 | 3.1 s | 200/200 | - | - |

No degradation from 8 to 96. Under 100 sustained concurrent commands:

```
memory   1244 MiB of 22888 MiB   (5%)
pids      100 of 1000            (10%)
load     11.49 on 24 vCPU        (~48%)
cpu      throttled 17 times, 11.3 s total
```

A first run showed 63 failures at N=200. It did not reproduce: with the git
call removed, 200/200 succeeded in 3.1 s, and with git restored 200/200
succeeded again. Transient, and recorded here rather than quoted as a ceiling.

**Worktrees are free.** Three cut in 1 second. Isolation proven end to end:
bee 1 wrote `docs/bee-proof.md` in its own tree, read it back, its git reported
`?? docs/bee-proof.md`, and the neighbouring worktree reported **zero**
changes.

## What actually binds

`QueenDelegation.swift:551-563` - `conflictingTasks` guards on
`!task.state.isTerminal`, and `awaitingReview` is **not** terminal
(`:83-88`). A task parked in review therefore holds its path boundary
permanently, and every issue overlapping those paths is skipped forever.

Measured in the live registry and log, this session:

```
tasks 61:  35 cancelled  11 accepted  6 merged  6 failed  3 awaitingReview

#1286  awaitingReview  held 5d 9h
#1127  awaitingReview  held 5d 9h
#1174  awaitingReview  held 0d 11h

queen.autonomy.tick            13
queen.delegate                  0
queen.worker.start              0
queen.choose.boundary_taken    78
queen.choose.exhausted         13
```

Thirteen ticks, every one of them ending "capacity free", and **not one
delegation**. Three tasks are the whole blockade. `maximumConcurrentWorkers`
is 4 and mean live concurrency is 0.00.

Raising the cap changes nothing at this step. Draining the three does.

## The ceilings behind it, in the order they would be met

Once admission produces work again:

| N | what fails first |
|---:|---|
| ~4 | nothing - this is a policy number, and its stated reasons do not hold. "Queen context per review" is false: verdicts are one-shot requests with empty history. "Merge conflicts scale with concurrency" is already solved structurally by `pathsOverlap` / `conflictingTasks`. |
| ~10 | **one shared API key.** `QueenWorkerRunner` takes the *active* key. Multi-key rotation exists (`ModelConfigurationStore+KeyRotation.swift:44-59`) and has **no caller on the request path**. Worse, a 429 is charged to the issue: `QueenRetryPolicy.swift:88-108` classifies it `producedNothing` and `:67` retires the issue after two. Throttling silently destroys work. |
| ~19 | **pids**, for bees that compile. 1000 minus ~29 for the runtime leaves 971; a `swift build`/`make` bee holds ~50. With `make -j` reading the host's 48 rather than the cgroup's 24, it is ~9. |
| ~27 | **memory** - and only because of one bug, now fixed. See below. |
| ~50 | **the Mac's main actor.** `QueenWorkerRunner` is `@MainActor` and runs `QueenObserver.evaluate` on *every SSE delta*, O(all accumulated tool-argument bytes) - a `filesystem_write` argument carries a whole file body. 13.1 s of main-thread CPU for one 100-turn worker. The UI freezes long before the container notices. |
| ~100 | **one JS thread.** `filesystem_bash` scales 18.9x across 20 calls (real child processes); `filesystem_grep` scales 1.41x across 8 (CPU-bound, single-threaded). 23 of 24 vCPU idle. `SessionStore` also never evicts: 1,317 agents created, **0 deleted**, and the only free path has no caller. |
| ~242 | pids, for bees that only read, edit and run git. |

## The memory ceiling, measured and lifted

`filesystem_bash` read its child with `new Response(stream).text()` -
everything materialised before `truncateTail` ever saw it. A 257 MB `cat` cost
**889.8 MB of RSS** to return 51,018 characters, stalling the single JS thread
428 ms. 24 GB / 890 MB = **27 bees**, set by whoever ran the least careful
command, with a cgroup OOM taking the whole swarm and the Queen together.

Now a bounded 5 MB tail. Proven on the deployed container with 40 MB of output:

```
before                                    430 MiB
(Output truncated. Showing last 528 of 51715 lines held;
 a further 33783808 characters were discarded while the command ran)
after                                     443 MiB     (+13 MiB, was +75)
```

The note is the second half of the fix: `totalLines` no longer quietly means
"the part that fitted".

Also capped: `timeout` was model-supplied and unbounded, so a command asking
for a day and hanging held its slot for a day. 900 s now, and the timeout
message names the timeout that fired rather than the one that was asked for.

## What must change, smallest first

1. **Drain the three parked reviews.** Nothing else matters until this is done.
   Either rule on #1286, #1127 and #1174, or add a review-age eviction so
   `conflictingTasks` stops honouring a five-day-old boundary.
2. **Wire key rotation onto the request path**, and stop charging a 429 to the
   issue. Concurrency is what makes 429s certain, so this must precede any
   raise of the cap.
3. **Kill the process group, not just `su`.** `proc.kill()` signals the parent
   only, and the read then waits on a pipe every surviving child still holds -
   measured: a 3 s timeout still pending at 25 s. One `bun run dev &` costs a
   slot until the process restarts. **Not fixed.**
4. **Move `QueenObserver.evaluate` off the main actor**, or make it incremental
   rather than O(everything so far) per frame.
5. Only then raise `maximumConcurrentWorkers`, and to a number the pids
   arithmetic supports: **19** if bees compile, more if they do not.

## What is not measured

- No bee has actually run in the cloud. Every number above is either the
  container under synthetic load or the Queen's own registry; a real
  delegation end to end has not happened, because of the blockade in §2 and
  because publishing a branch still needs the Mac.
- Cost. Nothing here estimates what 19 concurrent bees spend, and the
  `SwarmBudget` is $10/day.
- LLM provider concurrency limits per key, which item 2 makes decisive.
