# The work-conserving Queen swarm

This document explains, for an operator, when the swarm refills itself and
when it must not. It describes the mechanism as it exists in this repository:
the durable close that earns a refill signal (#1295), the single-flight round
gate that carries it, the lease and fence every round already uses, the
shutdown stop, and the periodic timer that remains the backstop. Nothing here
is aspirational; every state transition named below is also stated in the code
that performs it (`queen-dispatch.ts` for the close, `queen-tick.ts` for the
gate and the loop), and held by tests in `queen-round.test.ts`.

The one-paragraph version:

    A bee that finishes writes that fact to the database. Only a close that
    landed - the row really moved from running to finished - is treated as a
    freed slot, and a freed slot asks, immediately, for one Queen round. The
    gate guarantees at most one local round at a time and coalesces every
    request that arrives mid-round into exactly one follow-up. Each round,
    whether woken by a bee or by the timer, is the same leased and fenced
    round that has always run. The periodic timer is unchanged and remains
    the guarantee that rounds happen even when nothing finishes.

## The problem this exists to remove

Before the refill, the only thing that woke a Queen round was the periodic
tick. A bee's completion frees a healthy paid key, and until #1295 the next
eligible mission waited for the next tick to claim it. On the deployment this
was measured the interval was 1,800 seconds, so a bee finishing just after a
tick left a paid key idle for the best part of half an hour - per finished
bee, on a swarm whose whole point is that no laptop has to be awake to keep
it busy.

The timer is not the defect and is not removed. The timer is the backstop
that keeps rounds happening when nothing signals: long-running bees, stalls,
restarts, a signal that failed to land. What was missing was the other half -
a finished bee waking the Queen immediately - and that is what the durable
close listener and the round gate add, and all they add.

## Durable close: the database decides, nothing else

When a bee's turn ends, `closeDispatch` writes the ending with a single
UPDATE that finishes the dispatch row (`finished_at = now()`, the outcome,
the token counts). The UPDATE is guarded by `finished_at IS NULL` and by the
turn's conversation, so it can only ever convert a running row into a
finished one. Its row count is the verdict, and the verdict has exactly two
values:

- **One row changed** - a durable running-to-finished transition. This is the
  one moment a healthy paid key provably becomes free, and the only condition
  under which a refill signal may be emitted.
- **Zero rows changed** - no durable transition exists. Either the row was
  not there yet or another writer already closed it. An update that changed
  nothing is not an ending, and it does not throw, so the zero is checked
  explicitly and logged as an error. **No refill signal is emitted.**
- **The statement throws** (a database blip, a dropped connection) - exactly
  one retry is attempted. A retry that lands closes the row as surely as a
  first attempt and signals too: a flaky database is no reason to hand the
  slot back half an hour late. A retry that fails or returns zero rows means
  **no refill signal is emitted** - the round that would have been woken
  would look at the board, still see the bee as running, and skip the very
  work the signal promised.

The durability gate is the whole authority of the signal. A signal about a
row that still says `running` is worse than no signal, because it spends a
round to discover nothing. The listener may only be told the truth the
database just confirmed.

## The immediate request

On a durable close, the listener is called once, with the issue number. The
listener is a function, not a queue and not a policy: it may not dispatch, it
may not retry, it may not decide anything. It may only ASK for a round, and
the round it asks for is the same `runQueenTickOnce` the periodic timer runs
- lease, fencing, `queend` and dispatch loop all included.

Two edges worth knowing:

- The listener is installed only by the tick loop (`refillOnBeeCompletion`).
  A deployment running without the loop - local development, the app
  alongside - closes dispatches exactly as before. A completion with no
  listener is a normal minute, not an error: there is simply nobody local to
  refill.
- A listener that throws does not take the ending with it. The row is closed
  and that fact stands; the failure is logged (`Queen refill signal failed`)
  and the periodic timer covers the gap.

What the signal says is narrow: a slot freed. It does not say the work
succeeded, and it does not say what to do with the slot. Both of those are
the Queen's decision, made inside the round, exactly as the timer's rounds
always made them.

## The single-flight round gate

The gate (`createRoundGate`) holds one rule for every wake path it owns:
**one gate-owned round at a time, maximum gate-owned concurrency one.** A
round here means one full
`runQueenTickOnce` - lease acquisition, board read, `queend` choice, dispatch
loop, release.

- **A request while the gate is idle** starts a round at once. No clock, no
  delay, no debounce: the completion has already proven the slot free, and
  waiting would only re-create the gap the gate exists to remove.
- **A request while a round is running** sets one flag. Not a count - the
  flag is a single boolean, so a burst of two, five, or fifty completions
  sets the same one flag.
- **When the round ends and the flag is set**, exactly one follow-up round
  starts. The flag is cleared first, so a completion landing during the
  follow-up sets it again and gets its own round afterwards: work-conserving
  cuts both ways, and nothing that asks is ever dropped.
- **When the round ends and no flag is set**, the gate is idle again and
  waits. The gate runs nothing on its own; without the timer or a
  completion, nothing happens, and that is correct.

Why one at a time, and not merely "usually one": two rounds in one process
is a reachable state, not a theoretical one. The gate serializes the three
production wake paths wired through it - startup, periodic timer, and durable
Bee completion - so a completion cannot race the timer or another completion.
It enforces that structurally: `maxInFlight()` must be 1, a property the tests
measure both inside the gate and from the round's own books.

The protected on-demand operator route is a pre-existing exception: it calls
`runQueenTickOnce` directly and does not pass through this gate. It can still
overlap a gate-owned round, because both calls use the same in-process holder
and the lease treats that as renewal. Operators must avoid invoking the manual
tick while a round is active until that route is joined to the gate. The
completion-driven contract proved here does not conceal or solve that separate
diagnostic-route risk.

Coalescing follows from the same rule. The follow-up round reads the board
once, and the board is the database - every completion that landed during the
previous round is already visible in it. Two completions during a running
round therefore cost one follow-up, not two, and the follow-up can dispatch
up to capacity in a single pass of its dispatch loop.

## Lease and fence are reused, not redefined

A refill round is indistinguishable on the wire from a periodic one, because
it is the same code. Every round, whatever woke it:

1. Acquires the Queen lease in one upsert statement (acquisition and renewal
   are the same statement; the loser gets zero rows, never a second lease).
   Every grant increments the fence.
2. Renews through a heartbeat while the round runs (60-second beats against
   a 180-second TTL), and stands down mid-round if the lease moves.
3. Records its decision fenced: the tick record only overwrites a term with
   a fence at least as high, so a stalled old Queen that wakes up and writes
   is refused by the database, not by the caller's goodwill.
4. Releases the lease at the end, even when the round threw.

The gate adds no lease of its own, no fencing of its own, and no writes of
its own. If it did, there would be two authorities for "who may decide", and
the second one would eventually disagree with the first.

## Shutdown stop

On SIGTERM or SIGINT the tick loop clears its timer, and the gate is stopped
with it, for the same reason: **no round may start after the process has
given the hive away.** Stopping the gate refuses every later request and
drops a queued follow-up flag; a round already running finishes. A refill
round that started after handover would re-acquire the lease from a dying
container and pin the hive to it for the TTL, which is exactly the failure
the handover exists to prevent.

## The periodic timer backstop

The timer is unchanged by the refill: same interval (`TRIOS_QUEEN_TICK_SECONDS`,
off unless set), an initial round when the service starts, and a request
every interval since. It remains the only clock in the system and the only
thing that wakes the gate on its own. The gate holds no clock, no delay, and
no queue that outlives a round - it is a queue of at most one, in process
memory.

The backstop is what covers every path the signal does not:

- Nothing has finished (all bees still running) and the board changed anyway
  - new issues opened, a verdict released one.
- A close was not durable (zero rows, or failed twice) and emitted no signal.
- A dispatch stopped without saying so - the container died, the redeploy
  killed the stream. The next periodic round reaps it (below).
- The process restarted: the boot sweep clears the previous container's
  phantom rows before the first round reads the board.

So the two wake-up paths are complements, not competitors: the bee says
"now", the timer says "regardless".

## What the gate does not do

Stated explicitly, because a mechanism this central invites scope creep: **the
gate changes when a round starts, not what the Queen decides.** Choosing
which issue, judging specs and boundaries, the spend ceiling, retries, review
verdicts - every policy remains where it was, in `queend` and in the round
itself, applied identically to timer rounds and refill rounds. The gate adds
**no second policy and no external queue**: nothing is persisted, nothing
leaves the process, and nothing in it can start work, retry work, or rank
work. A gate that could dispatch would be a second supervisor wearing the
first one's name.

## Capacity, and what idle means

Provider capacity is not a fixed number. **Runtime capacity is the count of
healthy unique credentials this deployment actually holds**: for the first
configured provider in preference order, every non-empty key value, with
identical values collapsed into one slot (#1293 - a duplicated variable is
one account with one rate limit, not two bees' worth of width). Empty
strings are skipped, not counted: a name saved with an empty box supplies
nothing.

Inside a round, two limits apply, and whichever binds first is the swarm's
real width:

- The Queen's own concurrency ceiling, applied by `queend`'s choose: it
  refuses to start another worker when enough are running, and the round's
  dispatch loop keeps asking until the policy says stop.
- The key count, applied at dispatch: keys are handed out one per concurrent
  bee, lowest free index first, so no two bees share one rate limit. When
  every key is already carrying a bee, the dispatch is recorded as not
  started, with a remedy naming the next key variable to add - a named,
  actionable refusal, not a crash and not a retry loop.

Healthy idle - keys free, no eligible specification - is not a defect, and it
is **not a reason to invent fake work or to duplicate a completed issue**. A
round that finds nothing eligible skips every candidate with a named reason
(a live claim holds it; the work already landed; it is not a spec; it
declares no boundary; the boundary is held) and dispatches nothing, and that
round is recorded and reported so the operator can see "nothing happened,
and here is why". Releasing an issue the moment its turn ended was tried,
unintentionally, and produced six verification records for one finished
issue in a single afternoon. A finished dispatch now holds its claim until
the Queen's own review decides, and only an escalation reaches a person. The
swarm stays honest by accepting idle; the periodic tick keeps checking, and
the next eligible specification - or the next verdict that releases one -
is picked up by whichever round comes first.

## The three scenarios as ASCII state flows

### 1. One durable completion, gate idle: immediate refill

```
 [ BEE RUNNING on issue #N, holding one healthy key ]
                        |
                  turn ends (any outcome)
                        v
 closeDispatch: UPDATE ... WHERE finished_at IS NULL
                        |
                 row count = 1  --> DURABLE FINISHED
                        |         (the key is provably free)
                        v
 refill signal: gate.request("bee #N finished")
                        |
                 gate IDLE --> round starts AT ONCE
                        |   (no clock, no delay)
                        v
 the same leased and fenced Queen round:
   acquire lease (fence +1) -> heartbeat -> read board
   -> queend choose (capacity, money, boundaries, order)
                        |
        +---------------+----------------+
        v                                 v
 new bee dispatched on a free key    recorded refusal
 (loop repeats until policy stops)   ("nothing to choose",
 -> release lease                    named per candidate)
                        |
                        v
 gate IDLE again -- waits for the next signal or tick
```

### 2. Two completions during one running round: coalescing

```
 [ ONE GATE-OWNED ROUND RUNNING ]<-- request("bee #A finished") -- set FLAG
                      <-- request("bee #B finished") -- FLAG (already set:
                           one flag, not a count; two bees or fifty,
                           same single flag)
                        |
                  the round ends
                        v
 exactly ONE follow-up round starts ("a bee finished
 while a round was running")
                        |
 reads the board ONCE: BOTH finished rows already visible
 (the board is the database; no per-bee queue exists)
                        |
                        v
 dispatches up to capacity in its own loop -> release
                        |
                        v
 [ gate IDLE ]  gate-owned round concurrency stayed at ONE
 throughout; rounds started: 2, never 3, never 2-at-once
```

### 3. Zero-row or twice-failed close: no signal, recovery instead

```
 [ BEE RUNNING on issue #N ]
                        |
                  turn ends
                        v
 UPDATE returns 0 rows (row absent, or already closed
 by another writer)      OR   UPDATE throws, one retry,
                              retry fails or returns 0
                        |
      NO durable transition exists in the database
                        |
   NO REFILL SIGNAL IS EMITTED (a signal would wake a
   round that still sees the bee as running and would
   skip the very work it promised)
                        v
 the failure is logged loudly:
   "dispatch ending matched no row" / "could not be closed"
                        |
                        v
 recovery, on the paths that do not need a signal:
   - the PERIODIC TIMER keeps requesting rounds on its
     own clock regardless of any completion;
   - the next round's STALL REAPER releases a row that
     is started but unfinished past 120 minutes
     ("reaped: no completion within ..."), and a reaped
     dispatch releases its issue for RETRY;
   - a thrown close already had its one in-place retry;
     the stall reaper is the real backstop, not a loop
     that would hold a dead stream open.
                        |
                        v
 the re-eligible issue is chosen by a later round
 (periodic, or woken by some other bee's durable close)
```

## Where each piece lives

For a reader who does want to verify against source: the durable close and
its single retry are `closeDispatch`/`finishDispatch` in
`agent-server/apps/server/src/api/services/queen-dispatch.ts`; the listener
contract is `setDurableCloseListener` there. The gate, the wiring, the timer
and the handover are `createRoundGate`, `refillOnBeeCompletion` and
`startQueenTick` in `agent-server/apps/server/src/api/services/queen-tick.ts`;
the lease and fence are `agent-server/apps/server/src/api/services/queen-lease.ts`;
the choice policy is `queend` in `agent-server/queen-core`. The suite that
pins the behavior - one round per durable close, zero rounds for a zero-row
close, exactly one coalesced follow-up for a two-completion burst,
`maxInFlight` of one, and refusal after stop - is
`agent-server/apps/server/tests/api/queen-round.test.ts`.
