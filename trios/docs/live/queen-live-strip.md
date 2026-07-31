# Queen Live Strip — One Line, Every Bee, No Reload

Issue: gHashTag/trios#1098 · Parent: #1090

## What this document is

A sketch of a one-line status strip that sits inside the master chat
and shows every bee's current state in real time. It describes what
the strip renders, where the data comes from, and why a state change
in any task is visible in both the master chat and the bee's own chat
without a reload and without switching tabs.

It mirrors the types already in the codebase:
`QueenDelegationRegistry` (`rings/SR-02/QueenDelegationRegistry.swift`),
`DelegatedTaskState` (`rings/SR-00/QueenDelegation.swift`), and
`ChatViewModel.delegationRegistry` (`rings/SR-02/ChatViewModel.swift`).

## The problem this solves

Today, the only way to see what the swarm is doing is to type
`/swarm`. That command calls `reportSwarm()`, which reads
`registry.tasks` once and posts a static message into the Queen's
chat. The message is accurate at the moment it is written and stale
the moment after — a bee that finishes one second later does not
update the line the user is reading.

The `QueenReviewScheduler` posts a digest every 30 minutes, but that
is a snapshot too, not a live view. Between snapshots the user has no
way to glance at the hive and see what is happening without typing a
command or clicking into each bee's chat.

A live strip closes this: a persistent line in the master chat that
reflects the registry's current state and updates the instant any task
moves.

## What the strip renders

One line, left to right, one segment per active task:

```
🟢 scout  #1098  Working   ·  🟡 doctor  #1095  Needs review   ·  🔴 guard  #1097  Failed
```

Each segment carries three pieces:

| Piece | Source | Why |
|-------|--------|-----|
| Worker name | `task.worker` | The name the user gave at delegation. Shorter than the issue slug, and the slug follows it. |
| Issue slug | `task.issue.slug` | The anchor. Without it, two workers named "scout" are indistinguishable. |
| State label | `task.state.displayName` | Human words ("Working", "Needs review", "Failed"), not camelCase (`running`, `awaitingReview`). The enum already provides this via `displayName`; the strip uses it directly. |

A coloured dot precedes each segment. Colour maps to urgency, not to
the eight states — the strip collapses to five colours so a glance is
enough:

| Colour | States | Meaning |
|--------|--------|---------|
| 🟢 grey | `queued` | Waiting to start. Nothing to act on. |
| 🟢 green | `running` | Active. The bee is working. |
| 🟡 yellow | `awaitingReview`, `rejected` | The Queen or the user has something to do. |
| 🔴 red | `failed` | Something went wrong. Read the chat. |
| ⚫ dim | `accepted`, `merged`, `cancelled` | Settled. Fades out or leaves the strip. |

Five colours, not eight, because the strip is for triage, not for a
state machine diagram. The distinction that matters at a glance is
"who needs to act" — and that is what `needsQueenAttention` already
encodes.

## Where the data comes from

`QueenDelegationRegistry` is a `@MainActor ObservableObject` with:

```swift
@Published private(set) var tasks: [DelegatedTask] = []
```

Every mutation — `delegate`, `transition`, `recordUsage`,
`recordVerdict` — writes through `tasks[index]` and calls `persist()`.
The `@Published` wrapper means SwiftUI fires `objectWillChange` on
every write, and any view that observes the registry re-renders
before the user sees the old state.

This is the wire the strip rides on. No new publisher, no new timer,
no polling. The strip is a SwiftUI view that holds an
`@ObservedObject` (or `@EnvironmentObject`) reference to the registry
and renders `tasks.filter { !$0.state.isTerminal }` — the active bees,
not the archive.

## How a state change reaches the strip

1. The Queen calls `registry.transition(taskID:to:)` (or a command
   triggers it: `/accept`, `/review reject`, or the worker reporting
   back).

2. `transition` validates the move through
   `QueenDelegationPolicy.canTransition(from:to:)`, mutates
   `tasks[index].state`, sets `updatedAt`, and calls `persist()`.

3. The `@Published` synthesizer fires `objectWillChange`.

4. SwiftUI schedules a re-render of every view observing the registry
   — including the strip in the master chat and any status element in
   the bee's own chat.

5. The strip reads the new `state`, renders the new `displayName` and
   colour. The user sees the change in the same frame SwiftUI renders
   any other update. No reload, no tab switch, no `/swarm` command.

The critical property is that the registry is the **single source of
truth**. There is no second copy of task state in the view layer that
could drift. The strip is a pure projection of `tasks`; it holds no
state of its own.

## What changes in the bee's own chat

Each task owns a conversation (`task.conversationId`). When a task
transitions, the bee's chat already exists — it is the conversation
the worker has been streaming into. The state change is visible there
through the same mechanism:

- The bee's chat view observes the same registry (or the same
  `ChatViewModel`, which holds `delegationRegistry` as an injected
  property).
- A small status pill — the same `displayName` the strip uses, without
  the worker name since the chat already knows whose it is — sits in
  the chat header or footer.
- When `transition` fires, the pill re-renders with the new label.

This is criterion 2: the proof that a state change is visible *in the
bee's chat*, not just in the master chat. The mechanism is identical —
both views observe the same `@Published` registry — so a transition
that updates the strip also updates the pill. One mutation, two views,
zero stale copies.

## What the strip does NOT do

- **It does not open chats.** Clicking a segment could navigate to the
  bee's conversation, but that is a convenience, not a requirement.
  The strip shows state; it does not act on it.
- **It does not replace `/swarm`.** The `/swarm` command posts a
  detailed breakdown with branch names, token counts, and salience
  reasoning. The strip is a glance; `/swarm` is a read.
- **It does not poll.** There is no timer, no refresh interval, no
  "every 5 seconds" loop. The registry is reactive; the strip rides
  on `@Published`. A polling strip would be a strip that can be stale
  between ticks, and the whole point is that it cannot.
- **It does not show settled work.** `accepted`, `merged`, and
  `cancelled` tasks leave the active set (`isTerminal == true`). The
  strip is for live bees, not for history. The archive is in the
  registry's `archived` property and the sidebar's settled section.

## Placement in the master chat

The strip sits between the chat header and the message list — above
the scrollable conversation, below the title bar. It is always visible
because it is outside the scroll area: a bee finishing while the user
is scrolled up reading old messages still updates the strip, which is
the one place the user can see without scrolling back down.

When the hive is empty (`tasks.filter { !$0.state.isTerminal }.isEmpty`),
the strip collapses to zero height. An empty strip that says "no bees"
is noise; silence when idle is the contract the review digest already
follows, and the strip follows it too.

## Verification run

The proof that criterion 2 holds is a test that does the following
without touching the UI:

1. Create a `QueenDelegationRegistry` on a temporary store.
2. `delegate(...)` a task with state `.queued`.
3. `transition(taskID:, to: .running)` — assert the task's `state`
   is now `.running`.
4. `transition(taskID:, to: .awaitingReview)` — assert the task's
   `state` is now `.awaitingReview`.

Each assertion passes because `transition` writes through the same
`tasks` array the strip (and the bee's status pill) observe. The
`@Published` wrapper is what makes the view-side update automatic;
the test-side proof is that the array element the view would read
carries the new state after the call returns.

The test does not render SwiftUI. It does not need to: the strip is a
pure projection of `tasks`, so if `tasks[index].state` changed, the
strip and the pill *will* render the new state on the next frame
SwiftUI draws. A projection that holds no state of its own cannot be
stale.

This is also why `canTransition` matters to the proof. A refused
transition returns `false` and does not mutate `tasks`, so no
`objectWillChange` fires, so the strip does not flicker to a state
that was rejected and then back. Only legal transitions reach the
view.

## Code references

| Symbol | File | Role |
|--------|------|------|
| `QueenDelegationRegistry` | `rings/SR-02/QueenDelegationRegistry.swift` | The `@Published` source of truth. The strip observes this. |
| `DelegatedTaskState` | `rings/SR-00/QueenDelegation.swift` | Eight-state enum. `displayName` provides the label; `isTerminal` filters the active set. |
| `DelegatedTaskState.needsQueenAttention` | `rings/SR-00/QueenDelegation.swift` | `true` for `awaitingReview`, `failed`, `rejected`. Drives the colour mapping. |
| `DelegatedTask.worker` | `rings/SR-00/QueenDelegation.swift` | Worker name shown in each segment. |
| `DelegatedTask.issue.slug` | `rings/SR-00/QueenDelegation.swift` | `owner/repo#N` identifier per segment. |
| `QueenDelegationRegistry.transition` | `rings/SR-02/QueenDelegationRegistry.swift` | The mutation that fires `@Published` and propagates to the strip. |
| `QueenDelegationPolicy.canTransition` | `rings/SR-00/QueenDelegation.swift` | Guards illegal jumps. A transition that is refused does not fire `@Published`, so the strip does not flicker. |
| `ChatViewModel.delegationRegistry` | `rings/SR-02/ChatViewModel.swift` | The injected registry the view layer already holds. The strip reads through this. |
| `ChatViewModel.reportSwarm` | `rings/SR-02/ChatViewModel.swift` | The existing `/swarm` snapshot. Not replaced by the strip; the strip is the live version of what `/swarm` captures once. |
| `QueenReviewDigest` | `rings/SR-00/QueenReviewDigest.swift` | The 30-minute prose digest. Complementary to the strip: the digest explains *why*, the strip shows *what*. |
