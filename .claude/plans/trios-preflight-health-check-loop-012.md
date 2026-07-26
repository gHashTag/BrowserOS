# TriOS Preflight Model Health Check — Cycle 12 Plan

**Date:** 2026-07-26  
**Branch:** `dev`  
**Trigger:** `/loop` continuation — research weak spots, competitors, decomposed plan, implement, report + 3 variants.

---

## 1. Weak spots researched

After landing cycle 11 (auto-failover) and the LOGS tab, the chat failure path still has these gaps:

| Rank | Issue | File(s) + Line(s) | Severity | Why it matters |
|---|---|---|---|---|
| 1 | **No proactive model health check before send** | `rings/SR-02/ChatViewModel.swift:512-588` | P0 | Failover only fires *after* the user already saw a failure. A preflight probe can skip the bad model and start with a healthy one. |
| 2 | **Model picker shows models that are currently down** | `BR-OUTPUT/ModelsTabView.swift:144-166` | P1 | The user can select a model that the app already knows is unavailable. Disable unavailable rows and surface status. |
| 3 | **No per-model availability cache or TTL** | `rings/SR-00/ModelConfigurationStore.swift` | P1 | Every send would re-probe every model without caching, adding latency and cost. |
| 4 | **Preflight probe cost is unbounded** | `BR-OUTPUT/LLMClient.swift`, `rings/SR-01/SSETransport.swift` | P2 | A full chat completion probe is expensive. Need `max_tokens: 1` ping or provider-native model list. |
| 5 | **No test for preflight path** | `tests/TriOSKitTests/ChatFailureTests.swift` | P2 | Existing tests cover post-failure failover, not pre-failure avoidance. |

---

## 2. Competitor snapshot

| Competitor | Approach | Lesson for TriOS |
|---|---|---|
| **OpenRouter** | Catalog API `/models` + provider endpoints for latency/uptime; cheap `max_tokens:1` ping as final probe. Cache catalog ~5 min; require 2–3 consecutive failures before marking down. | Use model list for existence, tiny ping for liveness, cache results, threshold failures. |
| **LiteLLM Router** | Background health checks + `enable_health_check_routing` remove unhealthy deployments before routing; `enable_pre_call_checks` for context-window/region filters; cooldown + `allowed_fails_policy`. | Cache per-model health state, cooldown after N failures, disable unhealthy models in picker. |
| **Cursor Router** | Auto mode uses a different server-side path; manual selection can hit `resource_exhausted`; proposed ping probe after model switch with fallback to Auto. | If a model probe fails, auto-switch to a known healthy fallback and update picker state, never leave it on a silently broken model. |
| **Claude Code** | `--fallback-model` ordered list only triggers on overload (529), not invalid/unavailable names (GitHub #8413). | Make preflight cover invalid model names and unavailability, not just overload; surface the switch in UI. |

---

## 3. Decomposed plan

### A — Add a lightweight model health probe service
- **File:** `rings/SR-00/ModelHealthService.swift` (new)
- **Changes:**
  - `probe(model:provider:baseURL:apiKey:)` sends a tiny chat request (`max_tokens: 1`, message "ping") to the provider's chat endpoint.
  - For **Ollama** use `GET /api/tags` (list local models) to verify the model exists without cost.
  - For **OpenRouter** optionally hit `/models/{id}` first for existence, then tiny ping.
  - Return `ModelHealth` enum: `.healthy`, `.unavailable(reason)`, `.unknown(error)`.
  - Cache results in memory with TTL (default 60s) to avoid probing every send.
  - Require **2 consecutive failures** before marking a model `.unavailable` to reduce transient false positives.

### B — Track per-model availability in `ModelConfigurationStore`
- **File:** `rings/SR-00/ModelConfigurationStore.swift`
- **Changes:**
  - Add `@Published private(set) var unhealthyModels: Set<String> = []`.
  - Add `healthStatus(for model: String) -> ModelHealth`.
  - Add `markUnhealthy(_ model: String)` and `markHealthy(_ model: String)` methods.
  - Add `selectFirstHealthyModel()` that picks the first model in `fallbackModels` whose status is not `.unavailable`, falling back to the provider floor if all are unknown.
  - Expose `refreshHealth()` to re-probe all `availableModels` in parallel.

### C — Preflight check before `sendMessage`
- **File:** `rings/SR-02/ChatViewModel.swift`
- **Changes:**
  - Before building the request, call `modelStore.healthStatus(for: modelStore.selectedModel)`.
  - If `.unavailable`, call `modelStore.selectFirstHealthyModel()` and insert a system banner: "`currentModel` is unavailable; switching to `newModel`…".
  - If no healthy model found, still send but skip the preflight switch (let the existing failover catch it).
  - After any transport error, mark the model that was used as unhealthy so the next preflight avoids it.

### D — Update Models tab UI
- **File:** `BR-OUTPUT/ModelsTabView.swift`
- **Changes:**
  - Add a "Health" button next to "Refresh" that runs `store.refreshHealth()`.
  - In the model list, show a red dot + "unavailable" label for unhealthy models.
  - Disable selection of unhealthy models (unless it is the current model, to allow manual override).
  - Show the overall health status summary in the active model section.

### E — Tests
- **File:** `tests/TriOSKitTests/ChatFailureTests.swift`
- **Changes:**
  - Add `MockModelHealthService` returning controlled health states.
  - Add `testPreflightSwitchesAwayFromUnavailableModel` verifying banner + model change before `executeStream`.
  - Add `testTransportErrorMarksModelUnhealthy` verifying post-failure health cache update.
  - Add `testHealthyModelDoesNotSwitch` verifying no banner when selected model is healthy.

---

## 4. Implementation order

1. Create `ModelHealthService.swift` with ping probe + cache + failure threshold.
2. Extend `ModelConfigurationStore` with health state and `selectFirstHealthyModel()`.
3. Wire preflight check into `ChatViewModel.sendMessage` and post-error health marking.
4. Update `ModelsTabView.swift` with health status and disabled unavailable rows.
5. Add `ModelHealthService.swift` to `build.sh` `LEAN_BR_OUTPUT`.
6. Extend `ChatFailureTests.swift`.
7. Run verification gates.
8. Commit and write report with three variants.

---

## 5. Verification gates

- `cargo test --workspace` — pass.
- `cargo clippy --workspace --all-targets --all-features -- -D warnings` — clean.
- `bash trios/build.sh` — pass.
- `swiftc` standalone `trinity_999_tab_map_test.swift` — pass.
- Chat SSE E2E — pass.

---

## 6. Three cooperation options for next loop

### Option 1 — Background health poller
Run a periodic background task (every 60s) that probes all known models and updates the picker proactively, so failures are detected before the user sends a message. Adds steady background load but maximizes confidence.

### Option 2 — Persistent reliability scorecard
Store per-model success/failure counts in `agent-memory.sqlite3` or UserDefaults, compute a rolling reliability score, and use it to rank `fallbackModels` automatically. Learns from real usage but needs convergence time and telemetry consent.

### Option 3 — Provider-native status integration
For OpenRouter, consume the `/models/{id}/endpoints` latency/uptime feed; for Anthropic/OpenAI/Z.AI, use their status pages or model list endpoints. Avoids paid pings but is provider-specific and fragile when providers change shape.

**Recommendation:** Option 1 next, because it removes the need for on-send latency entirely and builds directly on the preflight health cache landed in this cycle.
