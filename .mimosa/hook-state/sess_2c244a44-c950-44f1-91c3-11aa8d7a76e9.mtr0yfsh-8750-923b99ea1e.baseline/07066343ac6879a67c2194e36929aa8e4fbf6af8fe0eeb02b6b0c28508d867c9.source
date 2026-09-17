# Cycle 28 Report — Streaming Context Watchdog

**Date:** 2026-07-27  
**Branch:** `feat/zai-provider`  
**Claim:** `claim-STREAMING-WATCHDOG-028` (released)  
**Spec:** `.trinity/specs/streaming-context-watchdog.md`

## What was built

Cycle 27 closed the pre-send context-window gap. Cycle 28 extends that protection into the assistant response phase by watching token growth as SSE deltas arrive.

### Core engine
- `rings/SR-00/StreamingContextWatchdog.swift` — new actor that tracks the active model's `maxOutputTokens` and `maxContextTokens`, accumulates cheap `utf8.count / 4` estimates as assistant deltas stream in, and emits one of:
  - `.ok`
  - `.approachingLimit(remainingTokens, kind)`
  - `.limitReached(partialText, suggestedAction)`
- Default thresholds: warn at 80% of output limit or 90% of total context; pause at 95% of output or 98% of total context. Ratios are clamped to `[0, 1]` and pause is never below warn.

### State machine
- `rings/SR-01/ChatEvents.swift` — added `.awaitingContextDecision(messageId:partialText:)` to `ConversationState`.
- `rings/SR-02/ConversationStateMachine.swift` — allowed transitions into and out of the new state.

### ChatViewModel integration
- `executeStream` now calls `contextWatchdog.beginStream` with the active model profile and `pendingEstimatedInputTokens`.
- Every `textDelta` and `reasoningDelta` is fed through `feedWatchdog(event:)`.
- On `.approachingLimit`, a transient system banner warns the user.
- On `.limitReached`, the stream is invalidated, the transport cancelled, the assistant streaming indicator finalized, and the state machine moves to `.awaitingContextDecision`.
- User actions:
  - `continueStreamOnLargerModel(_:)` — picks a healthy candidate with a larger context window or output limit and re-sends the last user message.
  - `summarizeStreamSoFar()` — sends a compact summary prompt for the partial response.
  - `stopStreamAndKeepPartial()` — finalizes the partial assistant message with a truncation note.

### Model store + candidate selection
- `rings/SR-00/ModelContextService.swift` — added `largerModelCandidates(...)` that ranks by `maxContextTokens`, then `maxOutputTokens`, then stable provider/model order.
- `rings/SR-00/ModelConfigurationStore.swift` — added `isStreamingContextWatchdogEnabled` (default `true`, persisted to `UserDefaults`) and `selectLargerModelCandidate(...)` applying health, breaker, and quota gating.

### UI
- `BR-OUTPUT/ChatPanelView.swift` — shows a compact action bar above the composer when `isStreamPausedForContext` is true: "Continue on larger model", "Summarize so far", "Stop and keep partial".
- `BR-OUTPUT/ModelsTabView.swift` — added "Pause stream on context limit" toggle in the Context routing section.

### Tests
- `tests/TriOSKitTests/StreamingContextWatchdogTests.swift` — ok, approaching-limit, output-limit pause, total-context pause, re-pause after limit, end-stream reset, and ratio clamping.

## Verification

| Gate | Result |
|------|--------|
| `./build.sh` | PASS (Swift integration tests exit 0, no `[FAIL]`) |
| `cargo test --workspace` | PASS (101 Rust tests passed) |
| `cargo clippy --workspace` | PASS |
| `cargo run --bin clade-audit` | **0 findings** across all 8 checks |
| `cargo run --bin clade-seal` | **SEAL VALID** |
| `cargo run --bin clade-e2e` | PASS — report generated, server healthy, app running |
| `open trios.app` + `curl http://127.0.0.1:9105/health` | `{"status":"ok","cdpConnected":true}`, menu-bar logo present |

`swift test` is unavailable in this CommandLineTools-only environment; verification follows the clade pipeline defined in `CLAUDE.md`.

## Files touched

- `trios/rings/SR-00/StreamingContextWatchdog.swift` (new)
- `trios/rings/SR-00/ModelContextService.swift`
- `trios/rings/SR-00/ModelConfigurationStore.swift`
- `trios/rings/SR-01/ChatEvents.swift`
- `trios/rings/SR-02/ConversationStateMachine.swift`
- `trios/rings/SR-02/ChatViewModel.swift`
- `trios/BR-OUTPUT/ChatPanelView.swift`
- `trios/BR-OUTPUT/ModelsTabView.swift`
- `trios/tests/TriOSKitTests/StreamingContextWatchdogTests.swift` (new)
- `.trinity/experience.md`
- `.trinity/experience/2026-07-27_streaming-context-watchdog-loop-028.json` (new)
- `.trinity/claims/released/claim-STREAMING-WATCHDOG-028.json`

## Three Cycle 29 options

1. **Per-conversation context budget + pinning** — let the user set a per-chat turn/token budget and pin messages that the context trimmer must never drop.
2. **Online context-window calibration** — learn effective per-(provider, model) context/output limits from observed `413`/context-length and `finish_reason=length` events, and adjust the watchdog thresholds or effective windows with an EMA.
3. **Streaming output token budget request** — expose a per-send output-token budget in the composer and route to a model whose `maxOutputTokens` satisfies it, preventing the watchdog from pausing short replies on small-output models.
