# Interrupted Stream Fail-Closed Implementation Plan

> **For Codex:** Use `sup-test-driven-development` for implementation and
> `sup-verification-before-completion` before reporting success.

**Goal:** Prevent transport EOF without an explicit terminal SSE event from
completing the TODO plan or writing partial assistant output to durable memory.

**Architecture:** Keep the transport protocol unchanged and enforce the domain
outcome at the `ChatViewModel` stream consumer, where all transports converge.
Track whether the current sequence produced `.finish`, `.abort`, or `.error`.
If it ends without one, route the turn through the existing failure lifecycle,
stop the streaming UI, persist partial chat history only, and leave a visible
error. This protects production transport, mocks, and future transport
implementations without a broad protocol migration.

**Tech Stack:** Swift 6, SwiftUI, `AsyncStream`, XCTest-style executable E2E
harness, SQLite-backed memory and planner stores.

**Primary sources:**

- Swift `AsyncStream` proposal:
  https://github.com/swiftlang/swift-evolution/blob/main/proposals/0314-async-stream.md
- WHATWG Server-Sent Events:
  https://html.spec.whatwg.org/multipage/server-sent-events.html
- ChatGPT Memory FAQ:
  https://help.openai.com/en/articles/8590148-memory-faq
- Claude memory controls:
  https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- Gemini activity controls:
  https://support.google.com/gemini/answer/13278892

---

### Task 1: Lock the terminal outcome contract

**Files:**

- Modify: `.trinity/specs/memory-control-center.md`
- Create: `.llm/plans/2026-07-24-memory-controls-interrupted-stream.md`

- [x] Specify that sequence exhaustion is not domain success.
- [x] Specify explicit `.finish` as the only successful terminal outcome.
- [x] Specify failed planner, no memory write, stopped streaming UI, and visible
      error for unterminated EOF.
- [x] Preserve explicit abort and error behavior.

### Task 2: Reproduce the regression

**Files:**

- Modify: `tests/swift/ChatSSEEndToEndTest.swift`

- [x] Add `runUnterminatedStreamFailsClosed()` to the executable test list.
- [x] Feed `.start` and `.textDelta` without a terminal event through
      `MockChatTransport`.
- [x] Assert the plan is failed.
- [x] Assert recent durable memory is empty.
- [x] Assert the assistant is no longer streaming.
- [x] Assert the state machine is visibly `.error`.
- [x] Run `bash tests/swift/run_chat_sse_e2e.sh` and capture the expected RED
      failures before changing production code.

### Task 3: Implement the minimum fail-closed guard

**Files:**

- Modify: `rings/SR-02/ChatViewModel.swift`

- [x] Record whether `.finish`, `.abort`, or `.error` was observed in the active
      stream.
- [x] After sequence exhaustion, route an unterminated stream through a stable
      `"Response stream ended before a terminal event"` failure.
- [x] Stop the last assistant message's streaming state before saving history.
- [x] Reuse `failPendingTurn` so the planner fails and memory persistence is
      skipped.
- [x] Preserve generation guards and existing explicit terminal semantics.
- [x] Run `bash tests/swift/run_chat_sse_e2e.sh` and require all scenarios green.

### Task 4: Verify the complete increment

**Files:**

- Create: `.trinity/experience/<timestamp>_memory-controls-*.json`
- Modify: `.trinity/events/akashic-log.jsonl`

- [x] Run `./build.sh`.
- [x] Verify `codesign --verify --deep --strict trios.app`.
- [x] Relaunch `trios.app` after the build.
- [x] Run the relevant live BrowserOS health and runtime flow.
      The freshly rebuilt app was relaunched as PID 58983 after the explicit
      macOS Keychain authorization decision. Production health on port 9105,
      BrowserOS CDP connectivity, the Chat workspace accessibility tree, and a
      fresh screenshot all passed. Agent V independently approved release.
- [x] Save a structured checkpoint after each build, E2E, or audit.
- [x] Request an independent Agent V review of only this increment.
- [x] Resolve every blocking review finding and repeat affected verification.
- [x] Update queue, experience, claim release, and a handoff with exactly three
      future options.
- [x] Do not stage, commit, merge, or push in this wave.

### Task 5: Resolve pre-landing lifecycle and scroll review

**Files:**

- Modify: `rings/SR-02/ChatViewModel.swift`
- Create: `rings/SR-00/ChatScrollPolicy.swift`
- Modify: `BR-OUTPUT/ChatPanelView.swift`
- Modify: `BR-OUTPUT/SmoothStreamingEnhancements.swift`
- Modify: `tests/swift/ChatSSEEndToEndTest.swift`
- Modify: `.trinity/specs/chat-tab-bottom-restoration.md`

- [x] Reproduce navigation deleting a started completed-turn memory write.
- [x] Preserve that write unless an explicit conversation-scoped memory
      revision or clear operation invalidates it.
- [x] Reproduce missing scroll-request delivery and invalid near-bottom math.
- [x] Publish a consumable throttled scroll request and observe it from the
      `ScrollViewReader`.
- [x] Measure viewport height and final-anchor position independently.
- [x] Reproduce stale streaming indicators after SSE error, explicit Stop, and
      thrown transport error.
- [x] Route all terminal paths through one assistant streaming finalizer.
- [x] Repeat full build, signature, runtime, visual inspection, and independent
      Agent V review before landing.

### Task 6: Close terminal history persistence races

**Files:**

- Modify: `rings/SR-02/ChatViewModel.swift`
- Modify: `tests/swift/ChatSSEEndToEndTest.swift`
- Modify: `tests/swift/ChatSSETestMocks.swift`
- Modify: `.trinity/specs/memory-control-center.md`

- [x] Reproduce loss of completed history when navigation overlaps a long-term
      memory write after `.finish`.
- [x] Reproduce loss of a finalized partial response after explicit Stop.
- [x] Capture the original conversation ID and finalized messages before the
      first long `await` or stream-generation invalidation.
- [x] Persist that immutable snapshot without reading mutable live chat state.
- [x] Preserve delete/clear barriers and prevent a stale snapshot from
      resurrecting an explicitly deleted conversation.
- [x] Reproduce failed active-chat deletion losing its partial history and
      retaining a stale streaming indicator.
- [x] Persist a finalized snapshot with the failure receipt only when private
      cleanup fails; discard the snapshot after successful deletion.
- [x] Seed successful deletion with non-empty persisted history and assert the
      record is absent, so the no-resurrection proof cannot pass vacuously.
- [x] Repeat focused E2E, full build, signature, runtime, visual inspection, and
      independent Agent V review before landing.
