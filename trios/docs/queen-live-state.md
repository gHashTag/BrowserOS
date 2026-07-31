# Queen Live State — Bee State in the Master Chat

Issue: gHashTag/trios#1098 · Parent: #1090

## Problem

The master chat only changes when the Queen posts a message. A bee can
transition from `running` to `awaitingReview` (or `failed`, or `rejected`)
without a single line appearing in the chat — because nothing in that
pipeline calls `appendSystemMessageToQueenChat`.

Meanwhile, the sidebar redraws instantly. `ChatSidebarView` holds
`@ObservedObject QueenDelegationRegistry.shared`, so every `transition()`
fires `objectWillChange` through the `@Published tasks` array, and the
status dots and counts update live.

Two surfaces, two truths. The sidebar says a bee finished; the chat says
nothing happened.

## Goal

Each bee's current state is visible in the master chat and changes
**without a reload and without switching chats**. A state transition in
the registry is reflected in the chat surface within one runloop tick.

This is **not** a message feed. The project has treated chat noise as a
defect (`ChatSSEEndToEndTest` has tests for message-deduplication and
context-isolation). The requirement is a **live status strip**: a compact,
non-message view that reads from the registry and redraws when it
changes. Think of it as "what is true right now" sitting above "what was
said", in the same window.

## What Exists Today

### Registry → Sidebar (working)

```
QueenDelegationRegistry.transition()
  → tasks[index].state = newState
  → @Published tasks  (triggers objectWillChange)
      ↳  ChatSidebarView (ObservedObject)       → redraws ✓
      ↳  QueenDashboardView (ObservedObject)     → redraws ✓
      ↳  QueenCompactSupervisorBar (ObservedObject) → redraws ✓
```

Three views already observe the registry directly and update live. The
sidebar's status dots, the Queen's dashboard strip, and the compact
supervisor bar all show current state without a reload.

### Registry → Chat Message List (the gap)

```
QueenDelegationRegistry.transition()
  → tasks[index].state = newState
  → @Published tasks  (triggers objectWillChange)
      ↳  ChatViewModel.messages  — NO OBSERVER
```

`ChatViewModel` holds `messages: [ChatMessage]` — an array that only
grows via `appendSystemMessageToQueenChat()`. The registry is injected
as `let delegationRegistry: QueenDelegationRegistry` (a plain `let`,
not `@ObservedObject`). The view model does not subscribe to
`registry.$tasks`, so a transition does not trigger `objectWillChange`
on the view model, and the chat surface does not redraw.

There is one partial bridge: `configureWorkerRunner()` sets up
`workerLivenessObservation` — it subscribes to
`runner.$runningConversationIds` and calls `self.objectWillChange.send()`
when a worker's stream starts or stops. This covers the "running → not
running" liveness signal but **not** the other transitions
(`queued → running`, `awaitingReview → accepted`, `rejected → running`,
etc.).

### Supervisor Surfaces

Two non-message views already render above the chat transcript:

| View | Where it appears | Width gate | Registry observed? |
|------|-----------------|------------|-------------------|
| `QueenDashboardView` | Queen's chat, fullscreen | > 760pt | Yes |
| `QueenCompactSupervisorBar` | Any chat, narrow panel | < 760pt | Yes |

Both draw status pills, issue slugs, branch names, and accept/cancel
buttons directly from the registry. They are the "live status strip"
the issue asks for — they already exist and already update live.

The remaining gap is coverage: the dashboard only renders above 760pt,
and the compact bar is one line unless expanded. A user on a 400pt panel
sees a collapsed bar that may not show every bee's state at a glance.

## Mechanism: How State Should Reach the Chat

### The existing path is correct — it just needs to be wired everywhere

The registry is `ObservableObject` with `@Published tasks`. Any view
that holds `@ObservedObject registry` already gets live updates. The
sidebar, dashboard, and compact bar prove this works.

### What `ChatViewModel` is missing

`ChatViewModel` does not observe `registry.$tasks`. Adding a Combine
subscription — analogous to the existing `workerLivenessObservation` —
would make the view model's `objectWillChange` fire on every registry
mutation:

```swift
// In configureWorkerRunner() or a new configureRegistryObservation():
registryObservation = delegationRegistry.$tasks
    .receive(on: RunLoop.main)
    .sink { [weak self] _ in self?.objectWillChange.send() }
```

This ensures that when a transition happens, any view bound to the view
model (including the chat transcript area and any inline status strip)
redraws.

### What should NOT happen

- **Do not post a system message on every transition.** The issue
  explicitly says "not a message stream for every little thing." Each
  `postQueenNotice` call adds a permanent `ChatMessage` to the
  transcript — that is a log entry, not a status indicator, and it
  never goes away.

- **Do not duplicate the sidebar inside the chat.** The sidebar already
  shows the full swarm with live state. The chat surface needs a compact
  summary, not a second list.

- **Do not couple the message list to the registry.** `messages` is a
  conversation transcript; registry state is operational metadata. They
  serve different purposes and should stay separate data sources.

## Design: Live Status Strip in the Master Chat

### What it shows

A compact, non-scrolling surface above the chat transcript, shown only
when the Queen's chat is open and the swarm is non-empty:

```
┌─────────────────────────────────────────────────────────┐
│ ⬡ SWARM   2/4 working    1 needs you                    │
│ ● Fix SSE parser   gHashTag/trios#1098  Working          │
│ ● Write docs       gHashTag/trios#1097  Needs review  ⓘ │
└─────────────────────────────────────────────────────────┘
│  [chat transcript continues below]                       │
```

- One row per open task (not settled).
- A colored status pill (reusing `QueenTaskStyle`).
- The task title and issue slug.
- The raw state word (`Working`, `Needs review`, etc.) — same
  `displayName` the sidebar uses.
- A liveness indicator when `state == .running` but the stream is dead
  (`QueenWorkerRunner.runningConversationIds`), matching the existing
  "no stream" warning in `QueenDashboardView`.

### What it is NOT

- It is not a message. It does not enter `messages`, is not persisted,
  and does not scroll away. It is always pinned above the transcript.
- It is not a feed. It shows current state, not a history of
  transitions. If a bee goes `running → awaitingReview → rejected →
  running`, the strip shows `Working`, not three events.
- It is not the sidebar. No search, no pinning, no conversation
  switching. Just state.

### Width adaptivity

The existing `QueenCompactSupervisorBar` already solves this: one
collapsed line at 400pt, expanded on tap. The same pattern applies —
the strip is a single summary line by default and expands to show
individual bees when tapped.

## Existing Code References

| File | Role |
|------|------|
| `rings/SR-02/QueenDelegationRegistry.swift` | Source of truth. `transition()` mutates `@Published tasks`. |
| `rings/SR-00/QueenDelegation.swift` | `DelegatedTask`, `DelegatedTaskState` (the state enum and its `displayName`). |
| `rings/SR-02/ChatViewModel.swift` | Holds `delegationRegistry` as a plain `let` (line 126). `configureWorkerRunner()` sets up liveness observation (line 3237). `appendSystemMessageToQueenChat()` is the only path into the Queen's chat (line 2872). |
| `rings/SR-02/QueenWorkerRunner.swift` | `@Published runningConversationIds` — the liveness signal. |
| `BR-OUTPUT/ChatSidebarView.swift` | Sidebar — already observes registry, already updates live. |
| `BR-OUTPUT/QueenDashboardView.swift` | Full-width swarm strip — already observes registry, gated at >760pt. |
| `BR-OUTPUT/QueenCompactSupervisorBar.swift` | Narrow-width supervisor bar — already observes registry, collapses to one line. |
| `BR-OUTPUT/FullscreenChatWorkspace.swift` | Layout that places the supervisor surfaces above the chat. |

## Test That Proves It

The issue requires: *"moving a task to another state changes what is
visible in its chat."*

A test should:

1. Open the Queen's chat.
2. Delegate a task (state: `queued`).
3. Transition it to `running`.
4. Assert the strip shows `Working`.
5. Transition it to `awaitingReview`.
6. Assert the strip shows `Needs review` — without reloading,
   switching chats, or posting a message.

The existing `ChatSSEEndToEndTest.runQueenHearsEveryBee()` scenario
already tests message delivery across conversations. The live-state test
is the mirror: it proves that a transition with no message still changes
what the user sees.

## Summary

| | Sidebar | Master chat (today) | Master chat (target) |
|---|---|---|---|
| Registry observed? | Yes | No | Yes |
| Updates live? | Yes | No | Yes |
| What shows? | Full swarm list | Nothing (no message) | Compact status strip |
| Persistent? | N/A | Messages are permanent | Strip is ephemeral |

The mechanism is already proven by the sidebar and dashboard. The work
is wiring `ChatViewModel` to observe `registry.$tasks` (one Combine
subscription) and ensuring the supervisor strip renders in the Queen's
chat at all widths — not building a new data path.
