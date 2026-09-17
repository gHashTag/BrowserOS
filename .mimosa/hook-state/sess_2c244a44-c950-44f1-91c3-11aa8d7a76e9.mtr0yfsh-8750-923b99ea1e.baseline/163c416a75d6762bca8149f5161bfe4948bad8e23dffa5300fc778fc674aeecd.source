# Cycle 28 Plan — Streaming Context Watchdog

**Theme selected:** Option A from Cycle 27 report — extend context-length awareness to the streaming response phase.

## Weak spots investigated

### Remaining failure mode after Cycle 27
Cycle 27 prevents *input-side* context-window failures by estimating history + current message before the provider call. It does not protect against *output-side* failures:
- A long assistant reply may grow until it hits the model's output-token limit or the remaining context-window budget.
- When that happens, the provider may truncate the response silently, return a 413/400 context-length error mid-stream, or emit an incomplete final message.
- The user has no signal that the response was cut off; retrying with the same model repeats the failure.

### Why this matters for TriOS
TriOS already supports multiple providers with different `maxOutputTokens` (e.g., Anthropic 8k, OpenAI 16k, zai 4k). A user on a smaller-output model who asks for a large artifact (code, summary, analysis) can hit the limit even though the input fits comfortably. Without a watchdog, the only fix is manual model switching.

### Additional weak spots
- The SSE stream parser currently treats mid-stream errors as transport errors; there is no structured `contextLength` failure kind during streaming.
- `ChatViewModel` has no concept of a "paused" streaming state waiting for user choice.
- There is no UI affordance to "continue on larger model" or "summarize so far" for an in-flight response.
- Existing `ContextRoutingDecision` only handles pre-send; it needs an analogous `StreamingContextDecision` for mid-stream.

## Competitor synthesis

| Product | Input limit handling | Output limit handling | User control |
|---------|---------------------|-----------------------|--------------|
| ChatGPT web | Implicit; may warn | Truncation marker or "Continue" button | Limited; model picker |
| Claude web | Implicit; large context | "Continue" prompt when output is long | Model picker |
| OpenRouter | Per-model window in API | No streaming intervention | None |
| Cursor / Copilot | Editor-based truncation | Often silent truncation | Manual model switch |
| Perplexity | Implicit | Output cap, no mid-stream action | None |

Gap: no competitor offers **provider-aware mid-stream continuation** that can automatically propose a larger-context/output model from a cross-provider roster. TriOS can differentiate by reusing its healthy-candidate catalog and circuit-breaker/quota gates during a stream pause.

## Goal
Detect during assistant response streaming when the accumulated response is approaching the model's effective output limit or the remaining context budget. Pause the stream cleanly, present a user choice, and execute one of:
1. **Continue on larger model** — route the conversation (including the partial assistant response so far) to a healthy larger-output/larger-context candidate.
2. **Summarize so far** — ask the same or another model to condense the partial response + history into a compact continuation.
3. **Stop here** — keep the partial response as a final assistant message and mark it truncated.

## Tasks

### 1. Spec
- Write `.trinity/specs/streaming-context-watchdog.md` with invariants and interface.

### 2. Core engine
- Extend `rings/SR-00/ModelContextService.swift` with `outputBudgetDecision(...)`.
- Add `rings/SR-00/StreamingContextWatchdog.swift` actor tracking:
  - `estimatedInputTokens` at stream start
  - `estimatedOutputTokens` accumulated during stream
  - `maxOutputTokens` and `maxContextTokens` for active model
  - projected total vs. margin-adjusted window
  - decision threshold (e.g., 90% of output limit or 95% of total window)
- Emit `StreamingContextDecision`:
  - `.ok`
  - `.approachingLimit(remainingTokens, kind)`
  - `.limitReached(partialText, suggestedAction)`

### 3. Transport integration
- `rings/SR-01/SSETransport.swift` / `rings/SR-02/ChatEvents.swift`: expose streaming token estimate hook (incremental `utf8.count / 4` over assistant deltas).
- Ensure watchdog can run on the main actor or a dedicated actor without blocking SSE parsing.

### 4. ChatViewModel integration
- Add state: `isStreamPausedForContext`, `streamingContextDecision`, `partialStreamText`.
- On `.approachingLimit`, emit a system banner warning.
- On `.limitReached`, pause `executeStream`, transition to a new state `.awaitingContextDecision`.
- Implement actions:
  - `continueOnLargerModel(candidate)`
  - `summarizeSoFar()`
  - `stopAndKeepPartial()`

### 5. UI
- `BR-OUTPUT/ChatPanelView.swift`: when stream is paused, show a compact action bar above the composer with the three choices and a warning label (e.g., "Response reached ~90% of output limit").
- `BR-OUTPUT/ModelsTabView.swift`: add a toggle "Pause stream on context limit" with default ON.

### 6. Tests
- `tests/TriOSKitTests/StreamingContextWatchdogTests.swift`: threshold math, decision transitions, output-limit vs. total-window cases.
- Extend `ChatFailureTests.swift` to simulate a mid-stream context-length error and verify the paused state.
- Extend `ModelConfigurationStoreCrossProviderTests.swift` to verify larger-output candidate selection.

## TDD criteria
- `./build.sh` PASS.
- `cargo test --workspace` PASS.
- `cargo clippy --workspace --all-targets -- -D warnings` PASS.
- `cargo run --bin clade-audit` 0 findings.
- `cargo run --bin clade-seal` SEAL VALID.
- `cargo run --bin clade-e2e` PASS.
- `open trios.app` + `/health` ok, menu-bar logo present.

## Three Cycle 29 options
1. **Per-conversation context budget + pinning** — per-chat turn/token budget and pinned messages the trimmer cannot drop.
2. **Online context-window calibration** — learn effective per-(provider, model) context limits from observed 413s and adjust with an EMA.
3. **Streaming output token budget request** — let the user set a desired max output length per send and pick a model whose `maxOutputTokens` satisfies it.
