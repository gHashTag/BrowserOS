# Smooth LLM Streaming and Follow-Scroll

Issue: T27-EPIC-001
Task: CHAT-STREAM-SMOOTH-001
Owner: codex-root
Status: Draft for written review; conversational design approved
Target: macOS 14 and later

## Summary

TriOS must render a streaming assistant response without moving the viewport on
every network delta. The implementation will preserve every parser action
accepted by the active stream generation while
coalescing compatible UI mutations into a bounded publication cadence. While the
user remains at the live edge, each published batch may request one
nonanimated scroll to the semantic bottom target. If the user scrolls away, TriOS
must stop following until the user explicitly returns.

This design replaces the current collection of disconnected streaming helpers
with two focused components:

1. A lossless streaming update coalescer between parser output and published chat
   state.
2. A pure auto-scroll policy that separates live-edge following from explicit
   navigation.

## Problem and Evidence

The current local chat path performs this sequence for each SSE text or reasoning
delta:

1. `SSETransport` yields an event.
2. `UIMessageStreamParser` emits one `ParserAction`.
3. `ChatViewModel.applyAction` appends the delta to one or more growing strings on
   the main actor.
4. `objectWillChange` invalidates observers.
5. `ChatPanelView`, `MessageBubbleView`, and `RichMessageView` rebuild work derived
   from the growing response, including Markdown parsing and layout.
6. Scroll geometry and content-height preferences update again.

This amplifies a high-frequency transport stream into high-frequency main-thread
publication, Markdown parsing, layout, and scroll work.

The amplification includes:

- three growing copies of response data in canonical content, segment content,
  and the usage-estimation accumulator;
- `AssistantTimelineBuilder.build` in both the panel visibility check and the
  message bubble;
- coarse `ObservableObject` fan-out through the root, workspace, sidebar, and
  panel;
- full Markdown block and inline `AttributedString` parsing for each published
  content value; and
- byte-buffer scanning in `SSETransport`, which is most visible on large tool
  payload lines.

The current scroll implementation also has correctness defects:

- `SmoothScrollManager.requestScroll` changes published trigger state, but
  `ChatPanelView` does not observe that trigger to call `ScrollViewProxy.scrollTo`.
  Streaming follow-scroll therefore does not reliably execute.
- The near-bottom calculation combines content height and a top-anchor offset as
  if they were the same coordinate. At the top of the list it can report that the
  user is near the bottom, and at the true bottom it can report the opposite.
- Streaming callbacks request an animated helper path, but the helper trigger is
  not consumed, so the spring branch is currently unreachable. Reconnecting it
  directly would make repeated corrections overlap while response height changes,
  recreating the older per-delta animation problem.
- `MessageBatchUpdater` and `StreamingThrottle` are instantiated but do not
  participate in the message update path.
- `StableMessageView` and extra string IDs duplicate the existing immutable
  `ChatMessage.id` identity and do not reduce source-model publication.
- Debug logging currently formats every SSE event, adding avoidable work to the
  hot path.

The former per-event throttler cannot be restored as-is. Its serial caller waited
inside the ingestion loop, which shifted buffering upstream and increased
latency, while its shared latest-closure design was unsafe for concurrent callers.
Parser actions are ordered data and require lossless coalescing, not delayed
replacement callbacks.

## Goals

- Preserve the exact text, reasoning, tool input, tool output, usage, completion,
  abort, and error semantics accepted from `UIMessageStreamParser` by the active
  generation.
- Bound observable UI mutations during a sustained delta stream to the
  configured publication cadence. The initial target cadence is 33 milliseconds,
  approximately 30 published UI batches per second.
- Perform no more than one automatic bottom-follow request per published UI
  batch.
- Keep automatic streaming scroll corrections nonanimated.
- Respect user intent: scrolling away from the live edge suspends following.
- Make correctness deterministic under unit tests by injecting the scheduling
  mechanism instead of relying on wall-clock sleeps.
- Keep the change within the existing SwiftUI architecture and macOS 14 target.

## Non-Goals

- Rewriting the chat surface in AppKit.
- Dropping or sampling network deltas.
- Holding the user at the bottom after they scroll away.
- Applying a global animation to message content or layout changes.
- Reworking the independent BrowserOS response stream.
- Migrating the entire application to the Observation framework.
- Guaranteeing a device-independent frame rate. The design bounds application
  update frequency; SwiftUI rendering cost still depends on content and hardware.

## User Experience

### Live-edge following

When a conversation opens or a local user message starts a new response, the chat
enters follow mode and targets the semantic bottom marker. As long as that marker
is the scroll view's positioned target and the user has not begun a live scroll,
every published response batch keeps it positioned at the bottom anchor without
animation.

### User detachment

When a user-initiated scroll moves the bottom marker outside the live-edge
threshold, the chat enters detached mode. New response batches continue to
render, but they do not move the viewport. A small user scroll that leaves the
marker within 32 points of the viewport bottom remains in follow mode. Target or
geometry changes caused by a published batch, programmatic correction, text
reflow, or window resizing must not be interpreted as intentional detachment.

### Re-entering follow mode

Follow mode resumes when either:

- the user scrolls until the bottom marker becomes the positioned target, or
- the user invokes a "jump to latest" action.

An explicit user jump may use one short animation when Reduce Motion is disabled.
Streaming updates after that jump remain nonanimated.

### Conversation restoration

Switching to a different conversation or opening the fullscreen chat uses the
existing explicit restoration request to position the new conversation at the
bottom without animation. Restoration is distinct from a user "jump to latest"
and is not inferred from streaming content changes.

## Architecture

### 1. Lossless streaming update coalescer

Add a focused `@MainActor StreamingUpdateCoalescer` in SR-02. It accepts every
`ParserAction` in parser order and owns a pending delta buffer plus a single
scheduled flush. Each accepted action is tagged with the stream generation and
originating conversation ID.

The coalescer may merge only adjacent, compatible delta actions:

- `appendText` actions with the same message ID.
- `appendToSegment` actions with the same message ID and segment kind.
- `appendToolInput` actions with the same message ID and tool-call ID.

Merging happens at enqueue time and concatenates deltas in arrival order. It
never deduplicates, samples, or reorders text. The pending buffer also tracks its
UTF-8 byte count. Reaching the configurable 64 KiB high-water mark causes an
immediate lossless flush instead of unbounded accumulation.

All other actions are ordering barriers. Before applying a structural or terminal
action, the coalescer synchronously flushes pending deltas, then applies the
barrier action:

- `appendMessage`
- `finishMessage`
- `startSegment`
- `addToolCall`
- `finalizeToolInput`
- `setToolOutput`
- `setToolError`
- `recordUsage`
- `streamComplete`
- `streamAborted`
- `streamError`

`ChatViewModel` exposes one internal `flushCurrentGeneration(reason:)` boundary.
It is required before any operation outside normal rendering reads, replaces, or
persists canonical messages, including:

- save, recovery export, and session-recovery snapshot;
- parser reset, cancellation, regeneration, and history rebuild or load;
- new, switch, and both delete-conversation paths;
- A2A message or task-state mutations; and
- every existing application/session shutdown hook that persists chat. This task
  does not add a new shutdown hook when none exists.

All enqueue and flush operations are main-actor isolated, and
`flushCurrentGeneration(reason:)` is synchronous. This avoids sending
reference-model `ParserAction` payloads through a second concurrency domain and
guarantees that state readers and saved history observe all accepted content.
Operations that invalidate a generation flush it before invalidation.

The production scheduler uses one cancellable task and the configured 33
millisecond cadence. Tests use a manual scheduler that advances explicitly. A
scheduled task carries a generation and schedule token. A synchronous barrier,
cancellation, or generation change cancels that token; a stale task becomes a
no-op. This makes a timer racing a barrier apply each delta exactly once.

`StreamingUpdateCoalescer` is not a transport throttle. Parsing continues for
every event, and its buffer is lossless. A cadence flush hands one merged delta
batch to `ChatViewModel`; the barrier that caused a synchronous flush is applied
afterward in parser order.

### 2. Published chat-state boundary

`ChatViewModel` remains `@MainActor` and `ObservableObject` for this change. The
coalescer reduces the frequency at which streaming mutations cross the observable
boundary without requiring an application-wide state migration.

Within one published delta batch:

- the assistant's canonical `content`, segment content, and tool input are
  updated in parser order;
- output-token estimation receives the same exact concatenated text it would
  receive without coalescing;
- `objectWillChange.send()` occurs exactly once, immediately before mutating any
  nested `ChatMessage` reference;
- the batch does not assign an `@Published` property, so it cannot emit a second
  automatic notification; and
- a non-`@Published` monotonic `streamRevision` increments within the same batch
  so `ChatPanelView` can recognize that one batch completed.

Structural and terminal barriers continue to use the existing `@Published`
properties and may produce their own semantically necessary publications after a
pending delta batch. Redundant manual sends are removed from barriers that did
not mutate observable state. Tests count ObservableObject publications; they do
not assert a SwiftUI render count because SwiftUI may coalesce publications.

### 3. Semantic auto-scroll policy

Add a pure `ChatAutoScrollPolicy` in SR-00. The policy has two states:

- `following`: automatic published batches may target the bottom.
- `detached`: automatic published batches do not move the viewport.

Inputs are semantic events rather than guessed absolute offsets:

- positioned scroll target changed;
- user scroll activity was observed;
- bottom-marker layout for a render revision became ready;
- a local message began a response;
- a render revision was published;
- a nonanimated restoration request arrived;
- a user "jump to latest" request arrived with Reduce Motion state;
- the conversation changed.

Outputs are commands:

- no action;
- jump to bottom without animation;
- jump to bottom with user-navigation animation when Reduce Motion permits it.

On macOS 14, `ChatPanelView` gives each message and the bottom marker a typed
`ChatScrollTarget` value. The bottom marker is a direct child of the
`LazyVStack`, has explicit `.bottom` identity, and has a small nonzero extent.
The lazy stack uses `scrollTargetLayout`, and the scroll view binds its current
target through `scrollPosition(id:anchor:)` with a bottom anchor.

The ID binding is a semantic position signal, not a documented user-intent
signal. A minimal `NSViewRepresentable` monitor observes
`willStartLiveScrollNotification`, `didLiveScrollNotification`, and
`didEndLiveScrollNotification` from its enclosing `NSScrollView` only.
`didLiveScrollNotification` is the definitive user-origin signal because AppKit
also sends it for user input, such as legacy mouse scrolling, that is not
bracketed by start and end notifications.

Each user-scroll notification increments an interaction epoch and latches it
until SwiftUI reports the corresponding semantic target and bottom-marker
layout. The policy does not assume synchronous ordering between AppKit
notifications and SwiftUI binding or preference callbacks. During
reconciliation, a missing marker, a non-bottom semantic target, or a direct
marker-to-viewport distance greater than 32 points detaches. The distance uses
the bottom marker's own frame in the scroll coordinate space, not estimated
`LazyVStack` content height. Without a latched user interaction, target and
geometry changes cannot detach. This bridge observes input only; SwiftUI
continues to own rendering, layout, targets, and scroll commands.

Each automatic command uses `ScrollViewProxy.scrollTo(.bottom, anchor: .bottom)`.
Writing the same value to a `scrollPosition` binding is not used as a command
because SwiftUI does not guarantee that assigning an unchanged ID retriggers a
scroll. The implementation must not derive bottom proximity by subtracting a
`LazyVStack` content height from a top-anchor offset because lazy containers use
estimated offscreen geometry.

One published streaming batch records its revision as pending but does not scroll
from `onChange` immediately. The bottom marker publishes a layout preference that
contains the latest generation, revision, visibility, and direct viewport
distance. The policy emits at most one command when layout for the latest pending
revision is ready; stale revision callbacks do nothing. Multiple revisions that
arrive before layout coalesce to the latest command. This pins automatic scrolling
to committed layout during bursty Markdown height changes.

The model flush and later post-layout scroll callback are separate SwiftUI
updates, so each operation uses its own narrowly scoped nonanimated transaction.
Automatic operations use `Transaction(animation: nil)` with
`disablesAnimations = true`; only an explicit navigation request uses
`withAnimation`.

### 4. Stable view identity and rendering cost

`ChatMessage.id` is the canonical identity for each row. The message list uses
that UUID directly. Redundant wrapper views and derived string IDs are removed.
Timeline items that can change position must use deterministic model identity
rather than random IDs.

Coalescing bounds how often the active response reaches `RichMessageView`, so the
full growing Markdown string is no longer reparsed for every transport delta.
The panel replaces its duplicate `AssistantTimelineBuilder.build` visibility
check with a cheap `hasVisibleTimelinePayload` predicate. The predicate covers
nonempty text, nonempty reasoning or error segments, referenced or standalone
tool calls and their current state, and the existing empty-stream loading rule.
Reasoning-only and tool-only assistant rows must remain visible. The bubble
remains the only timeline builder for that row.
Incremental Markdown parsing is outside this change unless profiling after
coalescing shows that it remains the dominant cost.

`SSETransport` consumes asynchronous lines rather than rescanning a growing
buffer after every byte. Per-event `NSLog` calls are removed or placed behind a
disabled debug-only flag. Request lifecycle and terminal error logs remain.

### 5. Diagnostics

Debug builds may expose signposts or counters for:

- parser actions received;
- published UI batches;
- observable streaming revisions;
- automatic scroll commands;
- maximum pending action count and UTF-8 byte count;
- flush reason;
- delta-batch apply duration;
- timeline and Markdown parse duration for the active row;
- transport line-parse duration for large payloads;
- terminal finalization count by generation.

Diagnostics must not log response content and must be inactive in release builds.
They support validation with the SwiftUI Instruments template without adding work
to the production hot path. The next-generation SwiftUI Instruments trace
requires Xcode 26 and a compatible tracing runtime; the deterministic counters
remain the verification path when that tooling is unavailable.

## Data Flow

```text
SSETransport
  -> UIMessageStreamParser (every event, original order)
  -> StreamingUpdateCoalescer
       -> merge adjacent compatible deltas
       -> flush before barriers, after 33 ms, or at 64 KiB
  -> ChatViewModel published UI batch on MainActor
       -> mutate canonical message state
       -> publish one streaming revision
  -> ChatPanelView
       -> observe one render revision
       -> ChatAutoScrollPolicy
            -> zero or one semantic bottom command
```

## Error, Abort, and Cancellation Semantics

Each send creates a generation context containing an immutable generation ID,
originating conversation ID, input-acceptance state, and terminal outcome.
`ChatViewModel` owns the ingestion task for that generation. Terminal work is
guarded by the generation context rather than by mutable global conversation
state.

The terminal claim begins as `open`, can be reserved exactly once for
`completed`, `aborted`, `failed`, or `cancelled`, and then becomes finalized.
Reservation and input closure happen synchronously on the main actor before the
first suspension point:

- `streamComplete` flushes pending content before clearing `isStreaming`,
  finalizing usage, transitioning to idle, and saving history.
- `streamAborted` flushes pending content before clearing `isStreaming`,
  clearing pending usage, transitioning to idle, and saving history.
- `streamError` flushes pending content before appending the system error,
  clearing pending usage, transitioning to error, and saving history.
- Transport EOF performs completion only while the outcome is still `open`.
  An explicit complete, abort, or error action suppresses generic EOF
  finalization.
- A thrown transport failure transitions an open generation to `failed`; a
  transport error represented as a parser action followed by EOF finalizes only
  from the parser action.

Usage finalization, `isStreaming` clearing, state transition, and persistence
therefore run once per generation. Every terminal continuation validates both
the generation ID and originating conversation ID, and persistence receives the
captured conversation ID explicitly instead of reading the current
`conversationId`.

Cancellation is a serialized lifecycle operation, not a fire-and-forget
transport call:

1. Atomically reserve the `cancelled` outcome and close the generation to new
   parser input. EOF, error, and completion can no longer claim the generation.
2. Cancel transport input and the owned ingestion task.
3. Await the ingestion task so no parser or coalescer delivery remains in flight.
4. Cancel the scheduled timer and flush all actions accepted before closure.
5. Finalize the generation once and persist the exact partial response against
   its originating conversation.

Conversation switching and new/delete-conversation commands await that lifecycle
operation before changing `conversationId` or replacing `messages`. After
invalidation, an old-generation timer, parser result, EOF continuation, or
terminal callback is a no-op and can never mutate or save the newly selected
conversation.

## Alternatives Considered

### Throttle only the scroll calls

This reduces `scrollTo` frequency but leaves per-delta main-actor publication,
Markdown parsing, and layout intact. The current helper also publishes a trigger
that no view consumes. It does not address the primary render amplification.

### Debounce parser or transport events

A trailing-edge debouncer can overwrite intermediate deltas or indefinitely
delay display during a continuous stream. It is rejected because parser actions
are ordered data, not replaceable UI hints.

### Animate every bottom correction

Repeated spring animations overlap as the response height changes and make the
viewport chase a moving target. Automatic corrections are therefore
nonanimated; animation is reserved for an explicit user navigation.

### Replace SwiftUI scrolling with AppKit

An AppKit bridge could provide lower-level offset control, but it would add
substantial lifecycle, accessibility, and interoperability cost before the
existing publication bottleneck is fixed. It is outside this change.

## Implementation Scope

Expected source changes:

- Add `trios/rings/SR-02/StreamingUpdateCoalescer.swift`.
- Add `trios/rings/SR-00/ChatAutoScrollPolicy.swift`.
- Modify `trios/rings/SR-00/AssistantTimelineBuilder.swift` and
  `trios/rings/SR-00/ChatLoadingIndicatorLayout.swift` for the allocation-free
  visible-payload predicate.
- Modify `trios/rings/SR-02/ChatViewModel.swift`.
- Modify `trios/rings/SR-01/SSETransport.swift` to consume its asynchronous line
  sequence instead of repeatedly scanning and copying a byte buffer, and remove
  raw per-event logging.
- Modify `trios/BR-OUTPUT/ChatPanelView.swift`.
- Modify chat-sidebar or workspace call sites only where lifecycle methods become
  asynchronous.
- Define a small private `ChatScrollInteractionMonitor` in
  `trios/BR-OUTPUT/ChatPanelView.swift` for macOS 14 live-scroll phase only.
- Delete `trios/BR-OUTPUT/SmoothStreamingEnhancements.swift` after its useful
  behavior is represented by the two focused components.
- Remove the deleted helper's special-case entry from `trios/build.sh`.
- Add `trios/tests/swift/streaming_update_coalescer_test.swift` and
  `trios/tests/swift/chat_auto_scroll_policy_test.swift`.
- Extend `trios/tests/swift/ChatSSEEndToEndTest.swift` and its existing mocks for
  lifecycle and publication integration coverage.
- Extend the existing assistant-timeline and loading-layout standalone tests for
  reasoning-only and tool-only visibility.
- Modify the existing Swift test runner only if required; do not add a new shell
  script.

`ChatAutoScrollPolicy.swift` owns the shared target, state, event, and command
types so its test remains independent of SwiftUI. `ChatPanelView` removes
`scrollOffset`, `contentHeight`, both geometry preference trackers, and all three
unused helper objects. A new bottom-marker layout preference replaces the old
content-height arithmetic. The panel's assistant-bubble visibility check must not
build the full timeline a second time.

Changes to the BrowserOS stream, server protocol, persistence schema, and
unrelated fullscreen-history work are outside this task.

## Test Strategy

Implementation follows test-driven development. Each behavior is first expressed
as a failing focused test.

### Coalescer tests

1. Feed 1,000 single-character `appendText` actions, advance the manual scheduler,
   and assert exact final text and order.
2. Feed mixed Unicode grapheme clusters written with ASCII Swift escapes and
   assert byte-for-byte UTF-8 concatenation.
3. Assert that compatible adjacent deltas merge while different message IDs,
   segment kinds, and tool-call IDs do not.
4. Assert that each structural action observes every preceding delta and retains
   its original position.
5. Assert that the scheduled flush racing a barrier or cancellation applies each
   delta exactly once.
6. Assert that an invalidated old-generation timer cannot emit into a new
   generation.
7. Assert that the high-water mark flushes without data loss and bounds pending
   storage.
8. Assert that a sustained stream publishes no more frequently than the injected
   cadence unless a barrier or high-water flush is required, and that a burst
   completed within one cadence produces one batch.

### Auto-scroll policy tests

1. A render revision produces no command until matching post-layout marker data
   arrives, then produces one nonanimated bottom command while following.
2. Stale layout for an older revision produces no command; several revisions
   before layout coalesce to the latest command.
3. Repeated position or geometry updates without a render revision produce no
   scroll command.
4. A programmatic target change, text reflow, or window resize does not detach.
5. A `didLiveScroll` event without start/end bracketing still detaches after the
   target or direct marker distance moves beyond the 32-point threshold.
6. User activity arriving before or after the SwiftUI target callback reconciles
   to the same state.
7. A small user scroll within the threshold remains following; a missing marker
   after user activity detaches.
8. A render revision while detached produces no command.
9. A user scroll that returns to the bottom re-enters following.
10. A user "jump to latest" re-enters following and animates only when Reduce
   Motion is disabled.
11. A restoration request, conversation change, or local-message start produces
   one nonanimated restoration command.

### View-model integration tests

The existing mock transport, parser, coalescer, and `ChatViewModel` test path
covers behavior that is outside the pure coalescer:

1. A 1,000-delta stream produces exact final content with publication count
   bounded by the manual cadence.
2. Mixed reasoning, text, and tool-input actions retain parser order.
3. `finish -> EOF`, `error -> EOF`, `abort -> EOF`, and a thrown transport error
   each finalize state, usage, and persistence exactly once.
4. Cancellation racing EOF, parser error, stream completion, and a
   `finishMessage` barrier preserves accepted deltas and finalizes the reserved
   outcome exactly once.
5. Cancellation persists the exact accepted partial response against the
   originating conversation.
6. Conversation switch, parser reset, regeneration, recovery export, history
   load, and external message mutation flush before reading or replacing content.
7. An old-generation timer and post-loop continuation cannot mutate or persist a
   newly selected conversation.
8. Consecutive barriers do not emit redundant manual publications.
9. Token estimation receives the same ordered text and reasoning input as an
   uncoalesced baseline.
10. The real `SSETransport` path handles CRLF, a final unterminated line, split
    multibyte UTF-8, cancellation, and transport-error termination through a
    chunked `URLProtocol` fixture rather than a mock `ChatTransportProtocol`.
11. Reasoning-only and tool-only messages pass the cheap visible-payload
    predicate without constructing a timeline in `ChatPanelView`.

### Executable verification commands

Run these commands from the `trios/` project directory.

```bash
swiftc \
  tests/swift/streaming_update_coalescer_test.swift \
  rings/SR-00/AgentIdentity.swift \
  rings/SR-00/ChatMessage.swift \
  rings/SR-01/A2AMessage.swift \
  rings/SR-01/ChatEvents.swift \
  rings/SR-02/StreamingUpdateCoalescer.swift \
  -o /tmp/trios_streaming_update_coalescer_test
/tmp/trios_streaming_update_coalescer_test

swiftc \
  tests/swift/chat_auto_scroll_policy_test.swift \
  rings/SR-00/ChatAutoScrollPolicy.swift \
  -o /tmp/trios_chat_auto_scroll_policy_test
/tmp/trios_chat_auto_scroll_policy_test

swiftc \
  tests/swift/assistant_timeline_builder_test.swift \
  rings/SR-00/AgentIdentity.swift \
  rings/SR-00/AssistantTimelineBuilder.swift \
  rings/SR-00/ChatMessage.swift \
  rings/SR-01/A2AMessage.swift \
  -o /tmp/trios_assistant_timeline_builder_test
/tmp/trios_assistant_timeline_builder_test

swiftc \
  tests/swift/chat_loading_indicator_layout_test.swift \
  rings/SR-00/ChatLoadingIndicatorLayout.swift \
  -o /tmp/trios_chat_loading_indicator_layout_test
/tmp/trios_chat_loading_indicator_layout_test

swiftc \
  tests/swift/chat_scroll_restoration_policy_test.swift \
  rings/SR-00/ChatScrollRestorationPolicy.swift \
  -o /tmp/trios_chat_scroll_restoration_policy_test
/tmp/trios_chat_scroll_restoration_policy_test

bash tests/swift/run_chat_sse_e2e.sh

TRINITY_ROOT=/Users/playra/trinity TRIOS_SKIP_SWIFT_TEST=1 ./build.sh
```

The focused commands are required because the active Command Line Tools do not
provide XCTest and `Package.swift` does not compile `ChatPanelView`. The direct
application build is therefore mandatory for the SwiftUI API integration.

### Manual SwiftUI checks

- In a manual debug run, stream a long Markdown response, scroll upward during
  generation, return to the bottom, cancel once, and switch conversations once.
- Resize the window and trigger text reflow while following; neither operation
  may detach the viewport.
- Verify content growth while `.bottom` remains selected, repeated same-target
  `ScrollViewProxy` commands, re-entry from a distant message, and a long
  `LazyVStack` history on macOS 14.
- Detach with a trackpad, legacy mouse wheel, scrollbar thumb, keyboard page
  command, and accessibility scroll action; each user path must suspend follow
  mode after leaving the 32-point live edge.
- When Xcode 26 tracing is available, profile the manual run with the SwiftUI
  Instruments template and compare parser action count, published batch count,
  scroll command count, batch duration, and main-thread stalls. This optional
  trace supplements, but does not replace, deterministic counters and tests.

## Acceptance Criteria

- A 1,000-delta fixture produces exact canonical output with no missing,
  duplicated, or reordered content.
- Structural and terminal actions cannot overtake pending deltas.
- During a sustained delta stream, published UI batches are bounded by the
  configured cadence rather than transport event frequency, except for explicit
  barriers and the memory high-water mark.
- A published UI batch emits at most one automatic scroll command.
- A delta batch emits exactly one ObservableObject publication; SwiftUI render
  count is not asserted.
- Automatic commands run only after layout for the latest pending revision;
  stale layout callbacks cannot scroll.
- Automatic streaming scroll is nonanimated.
- The viewport remains stationary after the user detaches and stays detached as
  more content arrives.
- All AppKit user-scroll notifications, including an unbracketed
  `didLiveScrollNotification`, reconcile against direct bottom-marker layout.
- Explicit navigation and conversation restoration reach the bottom reliably.
- Existing tool call, reasoning, token usage, cancellation, persistence, and
  conversation-switch behavior remains correct.
- Each stream generation reserves and finalizes one terminal outcome, including
  cancellation races with EOF, errors, and completion.
- CRLF, unterminated final lines, split UTF-8, cancellation, and errors pass
  through the real transport line path.
- Reasoning-only and tool-only assistant messages remain visible without a
  duplicate timeline build in the panel.
- Debug counters expose batch duration and main-thread stalls on a long Markdown
  fixture; a batch that systematically exceeds the cadence blocks acceptance and
  requires further rendering optimization.
- Focused tests and the TriOS build pass from a clean worktree, apart from any
  documented pre-existing baseline failure that is fixed or independently
  reconciled before merge.
- No unused streaming manager, throttle, batch updater, or redundant message-ID
  wrapper remains in the production view tree.

## Constraints

- Swift source and first-party documentation remain English and ASCII.
- No new shell scripts are introduced.
- The coalescer intentionally drops neither parser actions accepted by the
  active generation nor response content. Results arriving after that generation
  is atomically closed are rejected as stale lifecycle input rather than
  coalesced.
- All UI mutations remain main-actor isolated.
- Existing user changes and unrelated dirty-worktree changes are preserved.

## References

- Apple, Understanding and improving SwiftUI performance:
  https://developer.apple.com/documentation/xcode/understanding-and-improving-swiftui-performance
- Apple, Discover Observation in SwiftUI:
  https://developer.apple.com/videos/play/wwdc2023/10149/
- Apple, Demystify SwiftUI performance:
  https://developer.apple.com/videos/play/wwdc2023/10160/
- Apple, Explore SwiftUI animation:
  https://developer.apple.com/videos/play/wwdc2023/10156/
- Apple, Beyond scroll views:
  https://developer.apple.com/videos/play/wwdc2023/10159/
- Apple, `scrollPosition(id:anchor:)`:
  https://developer.apple.com/documentation/swiftui/view/scrollposition%28id%3Aanchor%3A%29
- Apple, `ScrollViewProxy.scrollTo`:
  https://developer.apple.com/documentation/swiftui/scrollviewproxy/scrollto%28_%3Aanchor%3A%29
- Apple, `Transaction`:
  https://developer.apple.com/documentation/swiftui/transaction
- Apple, `NSScrollView.willStartLiveScrollNotification`:
  https://developer.apple.com/documentation/appkit/nsscrollview/willstartlivescrollnotification
- Apple, `NSScrollView.didLiveScrollNotification`:
  https://developer.apple.com/documentation/appkit/nsscrollview/didlivescrollnotification
- Apple, `NSScrollView.didEndLiveScrollNotification`:
  https://developer.apple.com/documentation/appkit/nsscrollview/didendlivescrollnotification
