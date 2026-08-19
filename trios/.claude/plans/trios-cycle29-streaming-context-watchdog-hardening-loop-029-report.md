# Cycle 29 Report — Streaming Context Watchdog Hardening

**Date:** 2026-07-27  
**Branch:** `feat/zai-provider`  
**Claim:** `claim-STREAMING-WATCHDOG-HARDEN-029`  
**Spec:** `.trinity/specs/streaming-context-watchdog.md`

## What was built

Cycle 28 introduced a streaming context watchdog that monitors assistant-token growth mid-stream and offers to continue on a larger model, summarize so far, or stop. Cycle 29 hardens that implementation so the pause state reliably surfaces, the final triggering delta is preserved, continuation includes the partial response, warnings stay transient, and context-limit pauses are recorded as failures rather than successes.

The work was driven by four new invariants in `.trinity/specs/streaming-context-watchdog.md`:

- **INV-8:** After a context-limit pause, the paused UI must surface even though `invalidateActiveStream()` has bumped `streamGeneration`.
- **INV-9:** Continuing on a larger model must include the partial assistant message in the next request.
- **INV-10:** Approaching-limit warnings must be transient UI banners, not persisted system messages.
- **INV-11:** The delta that triggers `.limitReached` must be applied to `messages` before the stream pauses.

## Core fixes

### Pause UI surfacing (INV-8)
`pauseStreamForContextLimit` in `rings/SR-02/ChatViewModel.swift` now invalidates the active stream, finalizes the assistant streaming state, cancels the transport, transitions the state machine to `.awaitingContextDecision`, and saves the history snapshot directly. It does **not** re-check `isCurrentStream(generation)` after invalidation, because that guard would always fail once `streamGeneration` has been incremented.

### Final delta preservation (INV-11)
`executeStream` now applies each SSE event through `handleEvent` **before** feeding it to the watchdog. When the watchdog returns `.limitReached`, the triggering delta is already part of the partial assistant message.

### Continuation with partial response (INV-9)
`sendMessage` now builds `previousConversation` using `messages.filter { $0.id != sourceMessageId }` instead of `messages.dropLast()`. This excludes only the current user message (which the server receives separately via the `message` field) and preserves the partial assistant response when `continueStreamOnLargerModel` re-sends the last user turn with `appendUser: false`.

### Transient warnings (INV-10)
`showApproachingContextLimitWarning` no longer appends a `ChatMessage(role: .system, ...)` to the conversation. Instead it sets a new `@Published` property `streamingContextWarning`, which `ChatPanelView` renders as a transient orange banner above the composer. The warning is cleared when the stream ends, pauses, or a new send/conversation starts.

### Pause state lifecycle
`isStreamPausedForContext`, `streamingContextDecision`, `streamingContextWarning`, `streamingContextPauseLabel`, `canContinueOnLargerModel`, and `canSummarizeStreamSoFar` are now reset in:
- `sendMessage` at the start of a new send
- `cancelStreaming`
- `newConversation`
- `performConversationSwitch`

### Outcome recording
`executeStream` returns a new `StreamLatency` struct with a `didPauseForContext` flag. `sendMessage` uses this flag to record:
```swift
await modelStore.recordSendOutcome(
    model: activeModel,
    provider: activeProvider,
    baseURL: activeBaseURL,
    success: !didPause,
    reason: didPause ? "context limit" : nil,
    latencyMs: latency.totalMs,
    timeToFirstTokenMs: latency.timeToFirstTokenMs
)
```
A context-limit pause is therefore scored as a non-success with reason `"context limit"`, which keeps circuit-breaker health separate from model reliability.

### Action-bar availability
`ChatPanelView.contextLimitActionBar` now shows a descriptive label (`streamingContextPauseLabel`) and disables "Continue on larger model" / "Summarize so far" based on `canContinueOnLargerModel` and `canSummarizeStreamSoFar`. The summarize action is disabled when the partial text is too short, and the continue action is disabled when the suggested action is not `.continueOnLargerModel`.

## Tests

- `tests/TriOSKitTests/StreamingContextWatchdogIntegrationTests.swift` (new) covers:
  - pause state surfaces after output-limit reached
  - final triggering delta is preserved in the partial message
  - continuation includes both the original user message and the partial assistant
  - approaching-limit warning is transient and not persisted as a system message
  - pause state resets on `newConversation`
  - context-limit pause records a `"context limit"` failure outcome

## Files touched

- `trios/rings/SR-02/ChatViewModel.swift`
- `trios/rings/SR-02/ConversationStateMachine.swift` (verified transitions)
- `trios/BR-OUTPUT/ChatPanelView.swift`
- `trios/tests/TriOSKitTests/StreamingContextWatchdogIntegrationTests.swift` (new)
- `trios/.trinity/specs/streaming-context-watchdog.md` (INV-8 through INV-11)
- `trios/.trinity/experience.md` (Cycle 29 closure entry)
- `trios/.trinity/experience/2026-07-27_streaming-context-watchdog-hardening-loop-029.json` (new)
- `trios/.trinity/claims/active/streaming_context_watchdog_harden.json` → released

## Verification

| Gate | Result |
|------|--------|
| `./build.sh` | PASS |
| `cargo test --workspace` | PASS |
| `cargo clippy --workspace` | PASS |
| `cargo run --bin clade-audit` | **0 findings** |
| `cargo run --bin clade-seal` | **SEAL VALID** |
| `cargo run --bin clade-e2e` | PASS |
| `open trios.app` + `curl http://127.0.0.1:9105/health` | `{"status":"ok","cdpConnected":true}`, menu-bar logo present |

`swift test` is unavailable in this CommandLineTools-only environment; verification follows the clade pipeline defined in `CLAUDE.md`.

## Three Cycle 30 options

1. **Mid-stream summary memory** — persist the summary produced by "Summarize so far" as a durable memory so the user can ask follow-up questions about the truncated content without resending the full partial response.
2. **Adaptive watchdog thresholds** — learn per-(provider, model) effective output limits from observed `finish_reason=length` or context-length errors and auto-tighten/relax the warning/pause ratios with an EMA.
3. **Streaming token budget UI** — show a live output/context budget progress bar next to the streaming indicator and expose a per-send output-token cap that routes to a model whose `maxOutputTokens` can satisfy it.
