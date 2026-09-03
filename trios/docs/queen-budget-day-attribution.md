# The budget's day and the boundary's day are not the same day

This document specifies how the daily swarm budget decides *which day* a
task's cost is charged to, and what a budget refusal is allowed to claim. It
is a specification, not a landed change: nothing described here exists in the
tree yet except where a line is quoted as today's behavior.

It was prompted by an incident, and the incident is worth one paragraph.
From about 07:00Z on 2026-09-03 the swarm refused every round, once every
300 seconds, with:

> `allowed: false` — "the swarm has spent about $11 today, $1.37 past its
> $10 daily limit (raise it with TRIOS_SWARM_DAILY_CAP_USD)"

That message is built from an estimate divided by the wrong midnight. A bee
dispatched at 23:50 and finished at 00:10 charges its entire estimated cost
to the day on which it did almost nothing, and the following day starts
already spent. Once enough work straddles a boundary, the cap can refuse the
whole next day on money the previous day already paid for. The defect is not
in the sum and not in the cap; it is in the single timestamp both are forced
to share, and the fix is to stop sharing it.

## One field, two clocks, opposite needs

The field is `DelegatedTask.updatedAt`, declared at
`agent-server/queen-core/Sources/QueenPolicy/QueenDelegation.swift:162` and,
in the twin copy the Mac app compiles, at
`rings/SR-00/QueenDelegation.swift:162`. Two rules read it, and they need it
to mean opposite things.

**The cost clock.** `SwarmBudget.spentToday` decides which tasks count
against today's budget at
`agent-server/queen-core/Sources/QueenPolicy/ModelPricing.swift:201-206`,
and the decision itself is line 204:

```swift
.filter { calendar.isDate($0.updatedAt, inSameDayAs: now) }
```

The twin is `rings/SR-00/ModelPricing.swift:201-206` (filter at :204).
Its callers are the container's gate,
`agent-server/queen-core/Sources/queend/main.swift:232`, and the Mac app's
registry, `rings/SR-02/QueenDelegationRegistry.swift:377-378`.

**The boundary clock.** `QueenDelegationPolicy.stillHoldsBoundary` decides
how long a finished task's file claim survives at
`agent-server/queen-core/Sources/QueenPolicy/QueenDelegation.swift:626-634`,
reading the field at line 632:

```swift
let held = now.timeIntervalSince(task.updatedAt) / 3600
```

The twin is `rings/SR-00/QueenDelegation.swift:626-634`, and the board's
TypeScript mirror `stillHoldsBoundary`
(`agent-server/apps/server/src/api/routes/queen-kanban.ts:195-208`, reading
`task.updatedAt` at :201) must agree with it or the board will draw a hold
the Queen has already released.

**Where the shared value comes from.** The container fills it in
TypeScript. `agent-server/apps/server/src/api/services/queen-tick.ts:837`:

```ts
at: finished ? row.finished_at : row.dispatched_at,
```

and `boardTask` (declared at `queen-tick.ts:390`) assigns it at
`queen-tick.ts:431`:

```ts
updatedAt: isoSeconds(task.at),
```

The issue quotes the `at:` line as 1133; the file has been edited above it
since, and in this tree the same statement stands at :837. The code is
unchanged — only the line number moved.

The comment above that line explains the choice, and it is correct for the
rule it was written for: `stillHoldsBoundary` measures the wait for a
verdict, so a finished task must date from its finish, or a long turn
expires its own boundary the moment it ends. The boundary clock must keep
exactly this behavior. What was never said out loud is that the same value
is then read by `spentToday`, which needs the opposite thing: money is spent
when the bee RUNS, so its cost belongs to the day the run began.

This is the repository's own recurring defect — "one rule in two files,
agreeing until one is edited" — applied to a field instead of a file: one
field serving two rules whose needs point in opposite directions. Any edit
that satisfies one silently injures the other, which is why the fix is a
second field rather than a corrected value.

## The proposed field: `costAttributedAt`

`DelegatedTask` gains a sibling of `updatedAt` named **`costAttributedAt`**.
The name appears nowhere in this tree before this document — it is a
proposal, not a restatement of an existing field. Its rule:

1. **Written once, at dispatch, from the dispatch timestamp.** For a
   container task that is `row.dispatched_at`, regardless of whether the row
   is finished. For a task the Mac registry records, the moment the task is
   opened for a bee. It is never rewritten when the task finishes, is
   reviewed, changes state, or is archived. The cost of a task is attributed
   to the calendar day its bee started running — the dispatch, not the
   finish. A bee dispatched at 23:50 and finished at 00:10 charges its whole
   estimated cost to the day it was dispatched on, and the new day starts at
   zero.
2. **Optional: `Date?`.** Records written before the field existed must
   still decode, for the same reason `inputTokens` is optional (the comment
   at `QueenDelegation.swift:163-164`). Absent means "unknown, fall back".
3. **Read by `spentToday` as a fallback chain.** Line 204 of both
   `ModelPricing.swift` copies becomes, in effect:

   ```swift
   .filter { calendar.isDate($0.costAttributedAt ?? $0.updatedAt, inSameDayAs: now) }
   ```

   so an old payload behaves exactly as it does today and a new payload is
   charged to its dispatch day.
4. **Carried on the wire as the camelCase key `costAttributedAt`**, like
   every other `DelegatedTask` property. Swift's `JSONDecoder` ignores
   unknown keys, so the TypeScript half can ship first and the old `queend`
   binary simply will not see it; the Swift half decodes the optional and
   falls back when the key is absent. No ordering of the two deployments is
   worse than today's behavior.

Why not reuse `createdAt`: it already means "when this record was created"
on the Mac side, and `boardTask` sets it from the same finish-derived
`task.at` (`queen-tick.ts:430`), so it carries the identical distortion.
Reusing it would rebuild the shared-field defect one name over. A field
whose only job is cost attribution is what stops the two clocks from ever
disagreeing again.

**The boundary clock is untouched by all of this.** `updatedAt` keeps its
meaning — the moment this record last changed, which for a finished
container task is its finish — and every existing reader keeps it:
`stillHoldsBoundary` at `QueenDelegation.swift:632` in both copies, the
board's TypeScript mirror at `queen-kanban.ts:201`, and anything else that
wants "how long since this task changed". The two needs are named
separately, so the next person who must adjust one cannot accidentally bend
the other.

## `TRIOS_SWARM_BILLING_MODE`: what it must do when read

The issue reports that `TRIOS_SWARM_BILLING_MODE=coding_plan` is set on the
Railway service and that nothing in the tree read it. That was true when the
issue was written. Since then, commit `f22902c1` ("fix(queen): respect
Coding Plan billing mode", #1300) landed the read, and the current state is:

- `SwarmBillingMode` is declared at `rings/SR-00/ModelPricing.swift:97-119`
  and its twin `agent-server/queen-core/Sources/QueenPolicy/ModelPricing.swift:97-119`.
  `parsed` (:101) normalizes; `current` (:110-114) reads the
  `TRIOS_SWARM_BILLING_MODE` environment variable (:113); unknown, missing,
  or unparsable values fall back to `api_metered`, because an unreadable
  contract must not license spending.
- `enforcesEstimatedUSDCap` (:119) is true only for `api_metered`.
- The container's gate consults it at
  `agent-server/queen-core/Sources/queend/main.swift:230-234`.
- The public status surface reads it at
  `agent-server/apps/server/src/api/routes/queen-public-status.ts:62`.
- `agent-server/apps/server/tests/api/queend-choose.test.ts` pins the
  behavior ("does not turn Coding Plan telemetry into a metered API
  refusal").

The contract, stated so it survives future edits:

1. **`api_metered`** (and every value the parser does not recognize): the
   per-token dollar figure is treated as a real bill, and the daily cap may
   refuse rounds on it.
2. **`coding_plan`**: the account is flat-rate. The per-token dollar figure
   is telemetry computed at list rates — an estimate of what the traffic
   *would* have cost, not a charge — and it must never produce
   `allowed: false` on dollar grounds. The plan's real limits are the
   provider's quota responses and reset windows, which the swarm does not
   see today; until it does, a coding plan simply has no synthetic dollar
   gate. Every other Queen gate — concurrency, boundaries, spec quality —
   is unaffected by the mode, exactly as the enum's doc comment promises.
3. **Resolved fresh on every round**, so flipping the environment variable
   takes effect without a redeploy.

### What a refusal must say under a flat-rate plan

A refusal is the swarm's only account of itself in the log, so it must say
what it measured. Under `api_metered` the current wording stands — the
message assembled at `queend/main.swift:236-240`, quoted verbatim as the
existing metered message:

> the swarm has spent about {spent} today, {overBy} past its {limit} daily
> limit (raise it with TRIOS_SWARM_DAILY_CAP_USD)

Under `coding_plan`, no message may assert that dollars were spent, because
none were. Three rules:

1. **The USD-cap refusal is not emitted at all.** Already true in the
   container since #1300; the test above holds it there.
2. **Any other stop that wants to mention the day's usage must say what it
   measured** — tokens — must label any dollar figure as a list-rate
   estimate the plan does not charge, and must name the rule that actually
   refused. Shape of the sentence, for a Mac-side notice:

   > I am not opening new work right now. Estimated swarm usage today is
   > about {tokens} tokens (about {dollars} at list rates — the coding plan
   > is not charged per token). Stopped by: {rule}. Anything already
   > running continues.

3. **The word "spent" is reserved for money that was charged.** Under a
   flat-rate plan the swarm "used" tokens; it did not "spend" dollars.

### The residual gap this specifies

#1300 fixed the container path only. Two Mac-side sites still refuse or
defer on `SwarmBudget.verdict` with dollar wording and no billing-mode
check:

- `rings/SR-02/ChatViewModel.swift:4913-4920` — refuses new work with
  "The swarm has spent about {spent} … past the daily ceiling".
- `rings/SR-02/ChatViewModel.swift:8208-8216` — defers a send-back with
  "the day's swarm budget is spent ({spent})".

Both must acquire the same `enforcesEstimatedUSDCap` gate the container
got, and, if they ever speak under `coding_plan`, the wording rules above.
That is the remainder of the work the issue's second half asks for.

## What is TypeScript and what is Swift

The worker container runs the Node service and a prebuilt `queend` binary.
It has no Swift compiler, so it can make exactly the TypeScript half
itself; the Swift half must be built where Swift lives — the Mac app build
or a Linux CI with a Swift toolchain — and shipped as a new binary and a
new app build.

**TypeScript** (buildable and deployable by the worker container):

- `agent-server/apps/server/src/api/services/queen-tick.ts`, `boardTask`
  (:390): accept an optional `costAttributedAt?: string` on the task
  parameter and emit `costAttributedAt: isoSeconds(task.costAttributedAt ?? task.at)`
  in the returned payload, beside the existing `updatedAt` (:431). The
  fallback keeps any call site that forgets the field on today's behavior.
- `queen-tick.ts`, the `containerTasks` call site (:828-854): pass
  `costAttributedAt: row.dispatched_at` for finished and running rows
  alike. `at` stays `finished ? row.finished_at : row.dispatched_at`
  (:837) — the boundary clock's rule is not touched.
- Nothing else in TypeScript. The sum and the price table stay in Swift;
  the container deliberately has no pricing ("the caller is TypeScript and
  has no price table", `queend/main.swift`), and this change must not give
  it one.

**Swift** (cannot be built in the worker container; two synchronized
copies, one rule):

- `DelegatedTask` gains `public var costAttributedAt: Date?` in both
  twins: `rings/SR-00/QueenDelegation.swift:162` (beside `updatedAt`) and
  `agent-server/queen-core/Sources/QueenPolicy/QueenDelegation.swift:162`.
- `SwarmBudget.spentToday` filters on
  `$0.costAttributedAt ?? $0.updatedAt` in both twins:
  `rings/SR-00/ModelPricing.swift:201-206` and
  `agent-server/queen-core/Sources/QueenPolicy/ModelPricing.swift:201-206`.
- The Mac registry writes `costAttributedAt` once, at dispatch, when it
  records a task, and never rewrites it.
- The two Mac refusal sites above (`ChatViewModel.swift:4913-4920`,
  `:8208-8216`) gain the billing-mode gate and the flat-rate wording rules.
- The `rings/SR-00` copy and the `queen-core` copy are the repository's
  "one rule in two files" made literal, so both must receive the identical
  edit in the same commit — the drift-guard precedent is
  `queen-board.test.ts` checking the board's hours against the Swift
  source. A change that lands in one copy only is a disagreement waiting
  for its first boundary-crossing bee.

Either half may ship first. Old `queend` ignores the new key; new `queend`
falls back to `updatedAt` when the key is absent. No intermediate state is
wronger than today's, and the boundary clock never moves at any point in
the sequence.

## What this document does not decide

The value of the cap is the operator's. `SwarmBudget`'s own doc comment
says it plainly — "the cap is their budget decision, not the code's" — and
`TRIOS_SWARM_DAILY_CAP_USD`, the knob file, and the $10 default are all
untouched by everything above. This document proposes no figure, raises
nothing, lowers nothing, and takes no position on whether the current
limit is right; it only specifies *which day* the existing figure is
measured against and *what a refusal is allowed to claim*. Any decision to
change the number belongs to the operator, made with the knob that already
exists.
