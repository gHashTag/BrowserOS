# Cycle 27 Report — Context-Length-Aware Request Routing

**Branch:** feat/zai-provider
**Date:** 2026-07-27
**Claim:** claim-CONTEXT-ROUTING-027

## Summary
TriOS now estimates request size before sending, routes oversized conversations to larger-context healthy models, trims older turns when no larger model fits, and refuses the request only when even a single message exceeds every available window. The goal is to turn reactive context-window failures into proactive routing decisions.

## What changed

### Core routing engine
- `rings/SR-00/ModelContextService.swift`
  - `ModelContextProfile` per `(model, provider)` with advertised `maxContextTokens` and `maxOutputTokens`.
  - Conservative 4096/1024 defaults for unknown models.
  - `fits(...)` applies the configurable safety margin.
  - `largerContextCandidates(...)` ranks eligible larger-context candidates by window size.
- `rings/SR-00/ChatRequestSizer.swift`
  - `ChatRequestSize`, `ContextRoutingDecision`, `ContextTrimPolicy`.
  - Token estimation via `utf8.count / 4` fallback (routing/trimming only, never billing).
  - Trimmer preserves the system prompt, the current message, and tool-use/tool-result pairs.
- `rings/SR-00/ModelConfigurationStore.swift`
  - `contextWindowMargin` (default 0.85, user-adjustable 50–95%).
  - `resolveContextRoutingDecision(...)` with four outcomes: `.useCurrent`, `.routeTo(...)`, `.trimHistory(...)`, `.tooLargeEvenEmpty`.
  - `isCandidateAllowed(...)` gates routing by health, circuit breaker, and quota.
  - `contextWindowUtilizationPercent(...)` for UI badges.

### UI
- `BR-OUTPUT/ChatPanelView.swift`
  - Composer status indicator shows estimated context utilization % and routing label (trimmed/routed/too large).
  - Color-coded dot: green ≤70%, yellow ≤85%, red above.
- `BR-OUTPUT/ModelsTabView.swift`
  - "Context routing" section with margin stepper.
  - Per-model context-utilization badges in the catalog list.

### Tests
- `tests/TriOSKitTests/ModelContextServiceTests.swift` — profile lookup, margin math, candidate ranking/filtering.
- `tests/TriOSKitTests/ChatRequestSizerTests.swift` — fit/overflow, trimming policy, tool-pair preservation, oldest-first drop.
- `tests/TriOSKitTests/ModelConfigurationStoreCrossProviderTests.swift` — routing to a larger candidate and trimming when none fit.

### Verification
- `./build.sh` — [OK]
- `cargo test --workspace` — 101 passed
- `cargo clippy --workspace --all-targets -- -D warnings` — [OK]
- `cargo run --bin clade-audit` — 0 findings across all 8 checks
- `cargo run --bin clade-seal` — SEAL VALID
- `cargo run --bin clade-e2e` — report generated, no errors
- `open trios.app` + `/health` — `{"status":"ok","cdpConnected":true}`
- Menu-bar logo present after relaunch.

## Weak spots addressed
- Proactive routing removes the surprise 413/context-length failure path.
- Tool-use/tool-result pairs are never split during trimming.
- Unknown models get a conservative window so we never over-promise.
- Routing candidates must pass the same health/breaker/quota gates as normal sends.
- Utilization is computed against the *usable* window (advertised × margin), not raw advertised tokens.

## Competitor synthesis
OpenAI/Claude apps handle context limits implicitly or with error banners. OpenRouter exposes per-model context windows but does not auto-route. The TriOS approach is distinguished by:
1. Pre-send estimation and routing in one actor call.
2. Cross-provider failover + context routing layered together.
3. User-visible margin control and per-model utilization.
4. Safety-first conservative defaults for custom/unknown models.

## Cycle 28 options

### Option A — Streaming context watchdog
Extend routing to monitor token growth **during** streaming. If the assistant response grows toward the remaining window, pause the stream and offer: continue on a larger model, summarize so far, or stop. This covers the case where the *output* is what exhausts the window, not the input.

### Option B — Conversation-level context budget + pinning
Add a per-conversation "context budget" setting (e.g., "keep last N turns or M tokens"). Power users can pin critical messages so the trimmer never drops them. This moves control from global margin to explicit conversation governance.

### Option C — Online context-window calibration
Track actual provider behavior (when do we get 413 vs. when do we not) and adjust the effective window per `(provider, model)` using an EMA. This learns real-world context limits instead of trusting advertised numbers, especially valuable for OpenRouter/self-hosted endpoints that sometimes advertise optimistic windows.

## Recommended next cycle
**Option A (streaming watchdog)** is the highest leverage because it closes the remaining reactive failure path — the one case Cycle 27 still cannot catch, where a long streaming reply hits the output limit. It reuses the same `ModelContextService` and `ChatRequestSizer` and layers cleanly on top of the send-path work already landed.

## Files touched
- `rings/SR-00/ModelContextService.swift` (new)
- `rings/SR-00/ChatRequestSizer.swift` (new)
- `rings/SR-00/ModelConfigurationStore.swift`
- `rings/SR-00/TokenUsage.swift`
- `rings/SR-02/ChatViewModel.swift`
- `BR-OUTPUT/ChatPanelView.swift`
- `BR-OUTPUT/ModelsTabView.swift`
- `tests/TriOSKitTests/ModelContextServiceTests.swift` (new)
- `tests/TriOSKitTests/ChatRequestSizerTests.swift` (new)
- `tests/TriOSKitTests/ModelConfigurationStoreCrossProviderTests.swift`
- `.claude/plans/trios-cycle27-context-length-routing-loop-027-report.md` (this file)

## Experience note
Token estimation must stay cheap and never be treated as exact. The margin, trim policy, and candidate health checks need to be kept in one decision actor so race conditions between routing and the actual send do not re-introduce reactive failures.
