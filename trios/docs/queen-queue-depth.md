# The Queue Depth the Swarm Defends

Issue: gHashTag/trios#1333

## What this document is

The contract for the number of startable issues the Queen wants ahead of
her: the constant and the reason for its value, what counts toward the
number and what does not, the two numbers every round report carries, the
low-queue state that is distinct from `nothing to choose`, and the two
cases that prove the exclusions. The measured facts below are from the
live deployment; the report shapes are the contract the implementation
must produce. Every rule names the code it binds:

- the constant: `QueenDelegationPolicy`
  (`rings/SR-00/QueenDelegation.swift`, copied byte for byte into
  `agent-server/queen-core/Sources/QueenPolicy/QueenDelegation.swift` by
  the container build and compared by `make queen-core-sync`)
- the count and the report: the `choose` answer of `queend`
  (`agent-server/queen-core/Sources/queend/main.swift`), recorded by
  `recordTick` in
  `agent-server/apps/server/src/api/services/queen-tick.ts`
- the proving cases: the round harness
  (`agent-server/apps/server/tests/api/queen-round.test.ts`), which
  drives the real policy binary rather than a stub

## The problem, measured

2026-09-01 to 09-03, on the live deployment: every time a person fed the
backlog by hand, the Queen drained it within the hour and returned to
`nothing to choose`. The board at the moment of this issue: 41 done, 17
open, 0 she may start. The rounds keep firing every few minutes and every
one reports the same sentence.

The sentence is the defect. `nothing to choose` reads identically whether
the queue is empty, blocked, or merely between rounds, and only one of
those is a problem. It also reads identically at 0 startable and at 3
startable, and no number anywhere says which depth the swarm wants, so
nothing can say "fewer" out loud. A swarm that never stops needs a number
it defends, and a report that says when it is below it.

## The number, with its reason beside it

```swift
    /// How many delegatable, unheld issues the Queen wants ahead of her.
    ///
    /// Four, which is `maximumConcurrentWorkers` and not a new opinion.
    /// The refill gate folds a burst of completions into exactly ONE
    /// follow-up round, and that single pass hands out at most one issue
    /// per worker slot - so a queue that cannot refill every slot at once
    /// strands a freed key with nothing to refill it. Bursts are the
    /// normal mode: measured 2026-09-01..09-03, every hand-fed backlog
    /// was drained within the hour, which is a same-round burst by
    /// definition. Four is the smallest depth that survives a full burst
    /// and the largest that is not hoarding, since no single pass can eat
    /// more than four. It tracks the worker ceiling, never the provider
    /// key count: keys can be added without a deploy, issues cannot
    /// appear without a person.
    public static let targetQueueDepth = 4
```

It sits in the policy beside `maximumConcurrentWorkers`, and the
TypeScript side declares nothing: the round reads `target` out of the
recorded answer. A second declaration of the number in another language
is the drift the board's `REVIEW_BOUNDARY_HOLD_HOURS` comment already
warns about.

The four points, spelled out:

1. The refill gate coalesces a burst of completions into exactly one
   follow-up round (`docs/queen-work-conserving-swarm.md`: two, five or
   fifty completions set the same one flag), and that one pass can
   dispatch up to capacity. A queue that cannot refill every slot at
   once strands a freed key until a person feeds the backlog - and the
   only report is a sentence nobody can read a warning out of.
2. Bursts are the normal mode, not the exception. A backlog drained
   within the hour is four starts inside one or two rounds.
3. Four is the smallest depth that survives a full burst. Three leaves
   the fourth freed key stranded on the very afternoon the backlog was
   richest.
4. Four is also the largest depth that is not hoarding. The swarm cannot
   eat more than four in any single pass, so a deeper target would fire
   on inventory rather than starvation, and an alarm tuned to the wrong
   thing stops being read.

The depth defends the swarm the policy permits, not the swarm this
morning's environment permits. Provider keys can be added without a
deploy (`providerKeyCount` reads them live) while issues cannot appear
without a person; a target that tracked the key count would fall every
time a key was pulled and rise silently when one was added, and would
need watching that a constant does not.

## What counts toward the depth

Food is an issue the round may start now. Both halves are existing rules
of the `choose` loop, and the depth is their intersection:

- **delegatable**: the body's boundary section parses to at least one
  path. `QueenSpecQuality.judge` sets `delegatable` to exactly
  `hasBoundary`, and `QueenIssueBoundary.paths` does the parsing. An
  issue that is delegatable but not yet a full spec IS food - the chooser
  may take it and names the gap, which is why the loop passes it by for
  nothing.
- **unheld**: no live claim on the issue (`claimOnIssue` - a task in
  queued, running, awaitingReview or rejected state makes it spoken for)
  and no still-holding task on its paths (`conflictingTasks` over
  `pathsOverlap`; `stillHoldsBoundary` holds forever for queued, running
  and rejected, for 48 hours for awaitingReview, and never for terminal
  states).

The depth is counted in the choose loop itself, because the loop already
walks every candidate through exactly these rules: the count is the set
that survived every pass-over - the issue chosen plus every one passed
over only as `not first`. Summed where it is already decided, it adds no
second policy. A counter written in TypeScript beside the round would be
a second implementation of "which bee starts next", which is the defect
the round's own header exists to avoid.

The count is taken against the board the round's FIRST `choose` answer
sees - the registry mirror plus the container's own in-flight dispatches
- before this round starts anything. The issue the round is about to
dispatch is still startable at the moment of the count and is counted;
the dispatch makes it held for the next round, not for this report. The
dispatch loop's later answers, each folded with the previous dispatch,
feed the loop and are not the report.

A truncated candidate list counts what the round saw: `openIssues`
already marks such a list `complete: false` and the round already logs it
loudly. The depth never invents the issues a page cap hid.

## The round report: both numbers, always

Every `choose` answer - and so every decision the round records in
`queen_tick.decision` - carries:

```json
"queue": { "delegatable": 2, "target": 4 }
```

`delegatable` is this round's depth. `target` is the constant, verbatim
from the policy, so the report and the code cannot drift. Always means
every answer the round can produce, including the refusals that fire
before a candidate is ever walked:

She chose, and the queue is low anyway - allowed, chosen, AND low,
because the state is about what is left, not what she did:

```json
{ "kind": "choose", "allowed": true, "chosen": 1337, "refusal": null,
  "skipped": ["#1338: not first"],
  "queue": { "delegatable": 2, "target": 4, "low": true,
             "phrase": "queue low: 2 of 4 delegatable and unheld" } }
```

Nothing startable - the refusal stands, unchanged, and the pair rides
with it:

```json
{ "kind": "choose", "allowed": false, "refusal": "nothing to choose",
  "skipped": ["#1401: not yet a spec - missing boundary"],
  "queue": { "delegatable": 0, "target": 4, "low": true,
             "phrase": "queue low: 0 of 4 delegatable and unheld" } }
```

Full, by capacity - no low state at or above target, even though nothing
was started:

```json
{ "kind": "choose", "allowed": false,
  "refusal": "4 workers already running (limit 4)",
  "queue": { "delegatable": 6, "target": 4 } }
```

The pair is a fact about every round, not an alarm bell: carrying it
always is what makes `low` mean something when it appears.

## The low-queue state: distinct, and silent until it matters

Below target, the `queue` object gains `low: true` and a phrase naming
the depth it has and the depth it wants:

    queue low: 2 of 4 delegatable and unheld

At or above target the state is absent - no `low`, no `phrase` - so the
signal means something when it appears.

Distinct from `nothing to choose`, three ways, each checkable:

1. Different field. The phrase is carried in `queue.phrase`. The
   `refusal` field keeps the chooser's own sentences, unchanged, and the
   capacity and money refusals keep theirs. The low-queue state never
   replaces a refusal and never travels inside one.
2. Different list. `skipped` stays one pass-over line per candidate
   issue; the phrase is never appended there, so the public skip
   categories (`classifySkipReason`) and their counts are untouched.
3. Different words. The phrase and `nothing to choose` share no word -
   queue, low, of, delegatable, and, unheld, plus the two numbers,
   against nothing, to, choose - so no substring or word matcher can
   file one as the other, and the `/queen/status` voucher for
   `healthy_idle` (an explicit no-choice decision, read off `allowed`
   and its refusal) reads exactly as it always has.

The two MAY appear together - a depth of 0 reports both the refusal and
the phrase - but they are never the same string, and neither contains
the other.

## The two exclusions, proven

Two cases, one per excluded shape, both riding the round harness that
drives the real `queend` binary. Each asserts the depth from the
recorded decision, never from a recomputation.

### Case 1 - a boundary-less issue does not count

Given the candidate list is `[#1400, #1401]`; `#1401`'s body has no
boundary section, so its paths parse empty and `delegatable` is false
(and a body never supplied reads `no issue body was supplied, so its
boundary is unknown` - same exclusion); `#1400` names
`docs/queue-note.md` and nothing holds it,
When a round runs,
Then the report carries `"queue": { "delegatable": 1, "target": 4 }`
with the low-queue phrase (1 is below 4), and `#1401` appears in
`skipped` as `#1401: not yet a spec - missing boundary, ...`.

The count is 1, not 2. An issue that names no files cannot be reserved
for anyone, and counting it is how a board of 17 open and 0 startable
would read as "17 of 4, healthy".

### Case 2 - a held issue does not count

Given the candidate list is `[#1400, #1402]`; both bodies carry boundary
sections, `#1400` claiming `docs/queue-note.md` and `#1402` claiming
`rings/SR-00/Queue.swift`; a running task on `#1286` already owns
`rings/SR-00`, which overlaps by path component,
When a round runs,
Then the report carries `"queue": { "delegatable": 1, "target": 4 }`,
and `#1402` appears in `skipped` as `#1402: rings/SR-00/Queue.swift held
by gHashTag/trios#1286`.

The count is 1, not 2. A held issue is not food even though it is
delegatable - a bee started on it would collide with the holder, and the
48-hour review hold means "held" can outlast the day. This is the
measured case: it is why a backlog can be non-empty while the depth is
zero.

## What this does not change

- No value of `swarmState`. The `/queen/status` vocabulary is closed by
  its own contract (`docs/public-swarm-state.md`); the low-queue state
  is a field of the round's decision, not a public swarm state. Joining
  the numbers to that endpoint would be a revision of that contract,
  not of this one.
- No refusal sentence and no pass-over rule. The depth observes the
  choose loop; it does not steer it. Order, capacity, money and holds
  are untouched.
- No new author of issues. What the Queen does when she has fewer than
  the target is this report: the low-queue state, both numbers, every
  round, until a person feeds the backlog. Filling the queue remains a
  person's act - this issue asked for the defended number to be visible,
  and that is all this specifies.
