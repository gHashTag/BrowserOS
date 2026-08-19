# Cycle 30 Plan — Adaptive Watchdog Thresholds

**Date:** 2026-07-27  
**Branch:** `feat/zai-provider`  
**Claim target:** `claim-ADAPTIVE-WATCHDOG-THRESHOLDS-030`

## Weak spots in the current watchdog

1. **Static warning/pause ratios.** `StreamingContextWatchdog` hardcodes 80%/95% output and 90%/98% total-context ratios. A model that reliably stops at 6k tokens despite an advertised 8k output limit wastes 2k tokens of useful work before pausing; a model that routinely fills 120k of a 128k context window is already too late at 90%.
2. **`continueOnLargerModel` is never suggested.** `defaultSuggestedAction` returns `.stopHere` for `.outputTokens` and only `.summarizeSoFar` for `.totalContext` when little output remains. The action bar therefore almost never offers the most useful recovery path.
3. **Advertised limits are trusted blindly.** `ModelContextService` uses a static catalog. Providers and model versions often enforce lower effective limits than advertised (e.g., OpenRouter routing, provider-specific `max_tokens` caps, ollama quantized models).
4. **No learning from observed truncation.** The SSE parser drops `finish_reason`; the reliability service records success/failure but not `observedOutputTokens` or `finishReason`. A stream that ends with `finish_reason=length` is a precise signal that the effective output limit is at most the observed token count.
5. **Context-length errors are wasted signal.** `TransportError.isContextLengthError` correctly classifies 413/context-length failures, but the failure is only recorded as a generic reliability failure. It should tighten the learned effective context window for that tuple.
6. **Watchdog pauses are not fed back.** When the watchdog pauses at 95% output, that observation itself should update the learned effective output limit, making future warnings earlier and pauses closer to the true ceiling.
7. **No per-(provider, baseURL, model) calibration.** The same model slug on OpenRouter vs. native Anthropic may have different effective limits. The learner must key on the full endpoint tuple.
8. **No UI visibility into learned limits.** The Models tab shows advertised context/output badges but does not surface how much of that window the app has learned is actually usable.

## Competitor patterns

- **Claude Code:** dynamic three-tier `max_output_tokens` allocation, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` ceiling, model downgrade on truncation, auto-compaction via `/compact` and `/context`, `stop_reason` introspection (`max_tokens` vs `model_context_window_exceeded`).
- **Cursor:** "Dynamic context discovery" keeps large files out of the prompt; MAX mode per-model budget; no automatic "Continue generating" — users split prompts or use Composer Agent/Plan Mode manually.
- **Continue.dev:** fixed `DEFAULT_MAX_TOKENS_RATIO = 0.35` capped at 64k plus manual `config.yaml` `contextLength`/`maxTokens`; recent fixes only made YAML settings respected, no adaptive learning.
- **GitHub Copilot:** auto-summarizes around 80% context fill, `/compact`, `/context`, temp-file pattern for large tool outputs; no auto-continue after output truncation.
- **ChatGPT/consumer apps:** hide `max_tokens`, expose "Continue generating" button, rely on plan/model-based limits rather than learned per-deployment limits.

Key takeaways for TriOS:
- Learn effective limits from observed `finish_reason=length` and context-length errors.
- Use the full endpoint tuple for calibration, not just the model slug.
- Let the watchdog ratios adapt to the learned ceiling, not the advertised ceiling.
- Surface learned limits in the Models tab so users can trust the badges.
- Offer `continueOnLargerModel` as the default action when an output limit is hit and a larger model is available.

## Goal for Cycle 30

Make the streaming context watchdog adapt its warning/pause thresholds and recovery suggestions to per-(provider, baseURL, model) learned effective output and context limits. Preserve all Cycle 29 invariants (pause surfacing, final delta preservation, continuation context, transient warnings, failure outcome recording).

## Tasks

### 1. Spec update
- Add invariants to `.trinity/specs/streaming-context-watchdog.md`:
  - INV-12: The watchdog must learn effective limits per endpoint tuple.
  - INV-13: `finish_reason=length` must tighten the learned output limit.
  - INV-14: Context-length errors and watchdog pauses must tighten the learned context limit.
  - INV-15: When an output limit is hit and a larger model exists, the default suggested action must be `continueOnLargerModel`.
  - INV-16: Learned effective limits must be visible in the Models tab.

### 2. Parse `finish_reason` from SSE
- Extend `SSEEvent.finish(id: String)` to `finish(id: String, reason: String?)`.
- Extend `SSEEventParser` to read `dict["finish_reason"]` and propagate it.
- Update `UIMessageStreamParser` to map `.finish(id:reason:)` to `.streamComplete` (reason stored for learner via side channel).

### 3. Extend outcome model
- Add to `ModelOutcome`:
  - `observedOutputTokens: Int?`
  - `observedTotalTokens: Int?`
  - `finishReason: String?`
- Update `MemoryStore` outcome table/columns and decoding.
- Update `ModelReliabilityService.record()` overload to accept observed tokens and finish reason.
- Update all `ModelReliabilityStoreProtocol` implementations (MemoryStore, SQLCipher, mocks).

### 4. Create `StreamingContextLimitLearner`
New actor in `rings/SR-00/StreamingContextLimitLearner.swift`:
- Key: `ModelEndpointTuple(provider, baseURL, model)`.
- Stored `LearnedLimits`: `outputEMA`, `outputObservationCount`, `contextEMA`, `contextObservationCount`, `lastUpdated`.
- Persistence to `UserDefaults` (non-sensitive) under `trios.streamingContextLimits.v1`.
- Methods:
  - `recordObservedOutput(tokens: Int, totalTokens: Int, finishReason: String?, provider:baseURL:model:)`
  - `recordContextLimitHit(inputTokens: Int, outputTokens: Int, provider:baseURL:model:)`
  - `effectiveProfile(for:provider:baseURL:)` returns `ModelContextProfile` with learned overrides when `count >= 3`.
  - `confidence(for:)` returns observation count.
- EMA alpha default 0.3; learned output limit = `min(advertised, observedEMA * safetyBuffer)` where safetyBuffer = 0.95; learned context limit = `min(advertised, observedEMA * 0.95)`.

### 5. Integrate learner into `ModelContextService`
- Add `limitLearner: StreamingContextLimitLearner` dependency (default `.shared`).
- Make `profile(for:provider:)` async and consult the learner for the current endpoint tuple; fall back to advertised catalog.
- Update `fits(...)`, `largerContextCandidates(...)`, `largerModelCandidates(...)` to use effective profiles.
- Add `effectiveProfile(for:provider:baseURL:)` for callers that already know the endpoint.

### 6. Wire observation recording
- In `ChatViewModel.executeStream` / `sendMessage`:
  - On normal completion, read `tokenUsage.outputTokens` (or provider usage) and `finishReason` and call `recordSendOutcome(... observedOutputTokens: ... observedTotalTokens: ... finishReason: ...)`.
  - On `TransportError.isContextLengthError`, call `limitLearner.recordContextLimitHit(...)`.
  - On watchdog pause, call `limitLearner.recordContextLimitHit(...)` with the estimated input + output at pause.
- Update `ModelConfigurationStore` `recordSendOutcome` wrappers to forward new fields.

### 7. Improve watchdog recovery suggestion
- Change `StreamingContextWatchdog.defaultSuggestedAction`:
  - `.outputTokens`: return `.continueOnLargerModel(...)` when a candidate is available; otherwise `.stopHere`.
  - `.totalContext`: return `.summarizeSoFar` when partial text is long enough; otherwise `.stopHere`.
- The learner/candidate availability will be resolved by `ChatViewModel` after receiving the decision (the watchdog itself stays pure and only returns the kind).

### 8. UI in ModelsTabView
- Add "Adaptive watchdog thresholds" toggle (default ON) persisted to `UserDefaults`.
- When ON, show per-model effective output/context limits and observation count in the existing context-routing section.
- Show a small "calibrated" badge when `confidence >= 3`.

### 9. Tests
- `tests/TriOSKitTests/StreamingContextLimitLearnerTests.swift` (new):
  - EMA computation, effective limit override, observation threshold, persistence round-trip, context-limit hit recording.
- Extend `tests/TriOSKitTests/StreamingContextWatchdogTests.swift`:
  - learned-ratio behavior via injected learner stub, suggested action selection.
- Extend `tests/TriOSKitTests/ModelContextServiceTests.swift`:
  - effective profile overrides advertised when enough observations exist.
- Extend `tests/TriOSKitTests/StreamingContextWatchdogIntegrationTests.swift`:
  - simulated `finish_reason=length` updates learned limit and subsequent send uses it.

## TDD criteria
- `./build.sh` PASS (Swift integration tests exit 0, no `[FAIL]`).
- `cargo test --workspace` PASS.
- `cargo clippy --workspace` PASS.
- `cargo run --bin clade-audit` 0 findings.
- `cargo run --bin clade-seal` SEAL VALID.
- `cargo run --bin clade-e2e` PASS.
- `open trios.app` + `/health` ok, menu-bar logo present.

## Coordination
- Active claim: `claim-ADAPTIVE-WATCHDOG-THRESHOLDS-030` in `.trinity/claims/active/`.
- Log `task.intent`, `claim.acquire`, heartbeats, and `claim.release` to `.trinity/events/akashic-log.jsonl`.

## Three Cycle 31 options
1. **Per-send output token cap UI** — expose a composer slider/stepper that caps the requested output tokens for a single send and routes to a model whose learned effective output limit satisfies it.
2. **Predictive pre-send context compaction** — before sending, if predicted `input + reserved_output` exceeds the learned effective context window, proactively summarize the oldest non-pinned history turns and surface a "context compacted" banner.
3. **Cross-model limit federation** — share learned effective-limit fingerprints across the Trinity A2A ring / federated peers so a fresh TriOS install bootstraps its calibration from the collective observations of other nodes.
