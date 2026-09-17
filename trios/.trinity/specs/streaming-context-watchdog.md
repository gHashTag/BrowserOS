---
name: streaming-context-watchdog
domain: Language
agent: L
priority: P1
status: active
claim_id: STREAMING-WATCHDOG-028
task_id: STREAMING-WATCHDOG-028
issue: "#T27-EPIC-001"
---

# Spec: Streaming Context Watchdog

## Purpose

Extend Cycle 27 context-length routing to the assistant response phase. Detect when a streaming reply is approaching the model's effective output limit or the remaining context budget, pause the stream cleanly, and let the user continue on a larger model, summarize so far, or stop and keep the partial response.

## Invariants

### INV-1: Never silently truncate
If the response must be cut off because of a model limit, the UI must make the cutoff visible and actionable.

### INV-2: Preserve accumulated text
When pausing, all assistant text received before the pause must be retained in the conversation history.

### INV-3: Current message still protected
Any continuation (larger model or summarization) must include the original user message and the partial assistant response so far.

### INV-4: Health gates still apply
A "continue on larger model" candidate must pass the same health, circuit-breaker, and quota checks as pre-send routing.

### INV-5: No polling loop
The watchdog must be event-driven from SSE deltas, not a periodic timer.

### INV-6: Estimate is approximate only
Streaming token estimates are `utf8.count / 4` over delta text, used only for the watchdog, never for billing or exact limit enforcement.

### INV-7: User can disable
A toggle in `ModelsTabView` allows disabling the pause behavior; when disabled, the stream continues and the existing error path handles any failure.

### INV-8: Paused UI always surfaces
Once `.limitReached` is emitted, the view-model must transition to `.awaitingContextDecision` and set `isStreamPausedForContext` even after the active stream generation is invalidated.

### INV-9: Continuation includes partial assistant response
When continuing on a larger model, the next request's history must include the paused partial assistant message; the original user message must not be duplicated.

### INV-10: Transient warnings are not persisted
Approaching-limit warnings must appear as a transient banner, not as a persisted `ChatMessage(role: .system, ...)` in conversation history.

### INV-11: Outcome records context-limit pause distinctly
A context-limit pause is not a successful completion and must be recorded as a failure with reason `"context limit"` so reliability scoring does not treat it as a provider success.

### INV-12: Learn effective limits per endpoint tuple
TriOS must learn effective output and total-context limits per `(provider, baseURL, model)` tuple, because the same model slug can behave differently on OpenRouter vs. a native provider endpoint.

### INV-13: `finish_reason=length` tightens the output ceiling
When a streamed response ends with `finish_reason="length"` and an observed output-token count, that observation updates the learned effective `maxOutputTokens` for the tuple.

### INV-14: Context-limit pauses tighten the total-context ceiling
When a stream pauses because it hit the context/output limit, the estimated total tokens at pause update the learned effective `maxContextTokens` for the tuple.

### INV-15: Default action for output-limit hits is continue on larger model
When the watchdog pauses because the response hit the output-token limit, the default suggested action must be `continueOnLargerModel` so users can recover without losing the partial response.

### INV-16: Learned limits are visible in the Models tab
When TriOS has learned effective limits for a model tuple, the Models tab must surface them as compact badges (e.g. "learned out: 7.8k", "learned ctx: 118.8k").

## Interface

```swift
enum StreamingContextLimitKind {
    case outputTokens
    case totalContext
}

enum StreamingContextDecision: Equatable {
    case ok
    case approachingLimit(remainingTokens: Int, kind: StreamingContextLimitKind)
    case limitReached(partialText: String, suggestedAction: StreamingContextSuggestedAction)
}

enum StreamingContextSuggestedAction: Equatable {
    case continueOnLargerModel(CrossProviderModelCandidate)
    case summarizeSoFar
    case stopHere
}

actor StreamingContextWatchdog: Sendable {
    static let shared = StreamingContextWatchdog()

    func beginStream(
        modelProfile: ModelContextProfile,
        estimatedInputTokens: Int,
        margin: Double
    )

    func append(deltaText: String) -> StreamingContextDecision

    func endStream()
}
```

## Behavior

1. `ChatViewModel` calls `beginStream` when `executeStream` starts, passing the active model profile and the pre-send estimated input tokens.
2. For each SSE delta, `append(deltaText:)` increments the running output estimate and returns:
   - `.ok` while below the warning threshold.
   - `.approachingLimit(remainingTokens, kind)` once a threshold is crossed (default 80% of output limit or 90% of total window).
   - `.limitReached(partialText, suggestedAction)` once a higher threshold is crossed (default 95% of output limit or 98% of total window), or when the transport signals a context-length error.
3. On `.approachingLimit`, `ChatViewModel` shows a transient banner that is not persisted to history.
4. On `.limitReached`, `ChatViewModel` cancels the current stream task, transitions to `.awaitingContextDecision`, and exposes the decision to the UI.
5. The UI presents three actions. Selecting one resumes processing:
   - **Continue on larger model** — route to a candidate with larger `maxOutputTokens` or `maxContextTokens` and re-send the conversation including the partial response.
   - **Summarize so far** — send a system-like request to condense the partial response + retained history; replace the paused partial message with the summary.
   - **Stop here** — finalize the partial response as the assistant message and mark it with a truncation indicator.

## Thresholds

- Warning: 80% of `maxOutputTokens` or 90% of usable total window.
- Pause: 95% of `maxOutputTokens` or 98% of usable total window.
- When `maxOutputTokens` is unknown, use a conservative default (1024) and rely on total-window math.

## UI

- `ChatPanelView`: when `isStreamPausedForContext` is true, render a compact contextual action bar above the composer with the three choices and a warning label.
- `ModelsTabView`: add toggle "Pause stream on context limit", default ON, persisted to `UserDefaults`.

## Tests

- `StreamingContextWatchdogTests`: threshold math, `.ok` → `.approachingLimit` → `.limitReached` progression, output-limit vs. total-window kind selection, unknown-model conservative default.
- Extend `ChatFailureTests` with a mid-stream context-length SSE error and verify the paused state.
- Extend `ModelConfigurationStoreCrossProviderTests` with larger-output candidate selection.
