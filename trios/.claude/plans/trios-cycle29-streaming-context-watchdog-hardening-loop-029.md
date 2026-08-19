# Cycle 29 Plan — Streaming Context Watchdog Hardening

**Date:** 2026-07-27  
**Branch:** `feat/zai-provider`  
**Claim target:** `claim-STREAMING-WATCHDOG-HARDEN-029`

## Weak spots found in Cycle 28

1. **Pause UI never surfaces.** `pauseStreamForContextLimit` calls `invalidateActiveStream()`, then checks `isCurrentStream(generation)` again before updating `state`/`isStreamPausedForContext`. Because the stream has been invalidated, the guard fails and the method returns early, leaving the view-model in `.streaming`. The action bar never appears.
2. **Continue on larger model drops the partial assistant response.** `continueStreamOnLargerModel` re-sends the last user message with `appendUser: false`. `sendMessage` builds `historyForRequest` from `messages.dropLast()`, which excludes the paused partial assistant message, violating the spec requirement that continuation must include the partial response.
3. **The delta that triggers `.limitReached` is never applied.** `feedWatchdog` runs before `handleEvent`. When `.limitReached` is returned, `executeStream` returns immediately without applying the final delta, so `messages` ends before the limit was hit.
4. **Approaching-limit warnings become permanent system messages.** `showApproachingContextLimitWarning` appends a `ChatMessage(role: .system, ...)` to the conversation and persists it. The spec calls for a transient banner.
5. **Pause state leaks across unrelated interactions.** `isStreamPausedForContext` and `streamingContextDecision` are only cleared by the three context actions; `cancelStreaming`, `newConversation`, and `sendMessage` do not reset them.
6. **`executeStream` returns success latency after a pause, so `sendMessage` records a success outcome.** The watchdog pause path returns `StreamLatency` without marking the turn failed, so reliability scoring treats a context-limit pause as a successful send.
7. **Action bar shows all buttons regardless of availability.** There is no disabled/hidden state when no larger model exists, and no label showing which limit was hit.

## Competitor patterns (Cycle 29 context)

- **Claude Code:** `/compact`, `/context`, auto-compaction, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` env cap.
- **Cursor:** dynamic context discovery, MAX Mode for expanded budget, chat history as files, manual `continue`.
- **GitHub Copilot:** auto-summarization at ~80 %, `/compact`, `/context`, temp files for large tool outputs, no auto-continue for output truncation.
- **Continue.dev:** explicit `config.yaml` `maxTokens`, validation `input + reserved_output + buffer <= limit`, auto-pruning preserving system/tools/latest exchange, auto-injected `continue` after compaction.
- **ChatGPT:** model/plan-based limits, consumer app hides `max_tokens`, "Continue generating" button.

Key takeaways for TriOS:
- Make the paused state explicit and unmissable.
- Preserve partial output when continuing.
- Don't pollute conversation history with transient warnings.
- Disable/hide actions that cannot succeed.
- Record context-limit pauses as a distinct outcome, not success.

## Goal for Cycle 29

Harden the Cycle 28 streaming context watchdog so it reliably pauses, preserves partial output, offers valid continuation actions, and leaves the conversation history clean.

## Tasks

### 1. Spec update
- Update `.trinity/specs/streaming-context-watchdog.md` with:
  - invariant: paused UI must always be surfaced
  - invariant: continuation must include the partial assistant response
  - invariant: transient warnings must not be persisted
  - invariant: outcome recording must classify context-limit pause distinctly

### 2. Core pause bug fixes
- Fix `pauseStreamForContextLimit` in `rings/SR-02/ChatViewModel.swift`:
  - remove the second `isCurrentStream(generation)` guard that prevents UI update
  - set `isStreamPausedForContext = true` and `streamingContextDecision` unconditionally after invalidation
  - ensure the final accumulated delta is reflected in `messages` before pausing
- Update `executeStream` so that the delta that triggers `.limitReached` is applied via `handleEvent` before pausing.

### 3. Continuation with partial response
- Change `continueStreamOnLargerModel` to include the partial assistant message in the next request context.
  - Options: temporarily mark the partial assistant message as non-streaming, or pass it explicitly to the request builder.
  - Preferred: mark the partial assistant message final (`isStreaming = false`), then call `sendMessage(text: lastUserMessage, appendUser: false)`. The existing `messages.dropLast()` will now include the partial assistant as history.
  - Ensure the partial message is not duplicated.

### 4. Transient warning cleanup
- Replace persisted system-message warning with a transient banner:
  - Add a `@Published` transient warning string or a lightweight banner message type that is not persisted to history.
  - Render it in `ChatPanelView` above the action bar when `streamingContextDecision == .approachingLimit`.
  - Remove `showApproachingContextLimitWarning` system-message append.

### 5. Pause state lifecycle
- Reset `isStreamPausedForContext` and `streamingContextDecision` in:
  - `cancelStreaming()`
  - `newConversation()`
  - `sendMessage` at the start of a new send
  - conversation switch

### 6. Outcome recording
- Change the watchdog pause path to return a sentinel or throw a `TransportError`-like `ChatViewModelError.contextLimitReached` so `sendMessage` records a failure with reason `"context limit"` instead of success.
- Alternatively, return a `StreamLatency` with a `didPauseForContext: Bool` flag and update `sendMessage` to record `success: false, reason: "context limit"` when true.
- Keep the circuit breaker healthy; this is not a provider failure.

### 7. UI availability
- Update `contextLimitActionBar` in `ChatPanelView`:
  - Show a label: "Response reached ~N% of the output/context limit".
  - Disable or hide "Continue on larger model" when `viewModel.canContinueOnLargerModel` is false.
  - Disable "Summarize so far" when the partial text is empty or too short.

### 8. Tests
- Extend `tests/TriOSKitTests/StreamingContextWatchdogTests.swift` if needed.
- Add tests to `tests/swift/ChatSSEEndToEndTest.swift` or a new mid-stream pause test:
  - verify paused state surfaces after `.limitReached`
  - verify continuation includes partial assistant message
  - verify transient warning is not persisted
  - verify `isStreamPausedForContext` resets on `newConversation`

## TDD criteria
- `./build.sh` PASS.
- `cargo test --workspace` PASS.
- `cargo clippy --workspace` PASS.
- `cargo run --bin clade-audit` 0 findings.
- `cargo run --bin clade-seal` SEAL VALID.
- `cargo run --bin clade-e2e` PASS.
- `open trios.app` + `/health` ok, menu-bar logo present.

## Coordination
- Acquire claim `claim-STREAMING-WATCHDOG-HARDEN-029` in `.trinity/claims/active/`.
- Log `task.intent` and `claim.acquire` to `.trinity/events/akashic-log.jsonl`.

## Three Cycle 30 options
1. **Mid-stream summary memory** — persist the summary produced by "Summarize so far" as a durable memory and let the user ask follow-up questions about it.
2. **Adaptive watchdog thresholds** — learn per-(provider, model) effective output limits from `finish_reason=length` or context-length errors and auto-tighten/relax pause ratios.
3. **Streaming token budget UI** — show a live output/context budget progress bar next to the streaming indicator and let the user set a per-send output cap.
