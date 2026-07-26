# TriOS Chat Auto-Failover Loop — Cycle 11 Plan

**Date:** 2026-07-24  
**Branch:** `dev`  
**Trigger:** `/loop` continuation — research weak spots, competitors, decomposed plan, implement, report + 3 variants.

---

## 1. Weak spots researched

After landing `ae9e33859` (provider error classification + `/doctor --model`), the chat failure path still has these gaps:

| Rank | Issue | File(s) + Line(s) | Severity | Why it matters |
|---|---|---|---|---|
| 1 | **No automatic model failover** | `rings/SR-02/ChatViewModel.swift:536-618` | P0 | When the selected model returns 503/invalid-model, the user still has to manually type `/doctor --model`. A one-shot automatic fallback would recover instantly. |
| 2 | **Fallback chain is just suggestedModels minus current** | `rings/SR-00/ModelConfigurationStore.swift:100-126` | P1 | No provider-aware ordering (cheap/reliable floor last), no cost/quality prioritization. |
| 3 | **No provider-side `models` array for OpenRouter** | `rings/SR-02/ChatViewModel.swift:520` / `ChatRequestBuilder:1905-1982` | P2 | OpenRouter natively supports an ordered `models` array for server-side failover. TriOS does not send it, missing a free reliability win. |
| 4 | **Stale `claude-opus-4-6` references remain in catalog/CLI configs** | `packages/browseros-agent/apps/server/src/lib/agents/agent-catalog.ts`, `packages/browseros-agent/apps/server/src/api/services/openclaw/openclaw-cli-providers/claude-cli.ts` | P2 | The removed/unavailable model is still advertised in agent-core configs, which will keep tripping users even after TriOS fixes. |
| 5 | **No test for end-to-end failover path** | `tests/TriOSKitTests/ChatFailureTests.swift` | P2 | Existing tests cover classification and parsing, but not the actual `ChatViewModel.sendMessage` retry-with-next-model flow. |

---

## 2. Competitor snapshot

| Competitor | Approach | Lesson for TriOS |
|---|---|---|
| **OpenRouter** | Native `models` array in chat body + provider failover (`allow_fallbacks`). Returns `response.model` to show which model served the request. | Add `models` array for OpenRouter; cheap floor model last. |
| **LiteLLM Router** | `fallbacks` map, retries first inside model group, then escalate. `402` is auth/billing (no fallback); `503` triggers fallback. | Keep 402 fatal; allow one automatic retry on model-unavailable/invalid-model. |
| **Cursor Router** | Enterprise classifier routes by Intelligence/Balance/Cost. "Switch to Auto" has known bug where it sets raw string `"auto"`. | If auto-switching, update the model picker state and notify the user; avoid silent downgrades. |
| **Claude Code** | `fallbackModel` ordered list + `/model` aliases; status line shows current model. | Surface failover in UI and expose `/model`-style command. |

---

## 3. Decomposed plan

### A — Automatic one-shot model failover in ChatViewModel
- **File:** `rings/SR-02/ChatViewModel.swift`
- **Changes:**
  - Extract request-building + streaming into `sendMessageWithModel(_:generation:...)`.
  - In `sendMessage`, on `TransportError.isModelUnavailableError` or `isInvalidModelError`, attempt one retry with `modelStore.selectNextModel()`.
  - Insert a system message: "Model `<old>` failed; retrying with `<new>`…" so the user is never surprised.
  - If the retry also fails, surface the final error with the original model restored (so the next user request starts from the known config).
  - Cap failover so it only fires once per user send to avoid cascading switches.

### B — Provider-aware fallback ordering
- **File:** `rings/SR-00/ModelConfigurationStore.swift`
- **Changes:**
  - Replace `fallbackModels` with a provider-ordered chain: e.g. for `.openrouter` put the cheapest/reliable option (`google/gemini-2.5-flash`) last as the floor.
  - Keep `fallbackModels` as the public API but compute it from `ModelProvider.fallbackModels(excluding:)`.

### C — OpenRouter native `models` array (server-side failover)
- **File:** `rings/SR-02/ChatViewModel.swift` / `ChatRequestBuilder`
- **Changes:**
  - When `provider == .openrouter`, pass the fallback chain as `models` in the request body alongside `model`.
  - This gives OpenRouter a chance to failover before the client-side retry path even runs.

### D — Clean up stale `claude-opus-4-6` references
- **Files:** `packages/browseros-agent/apps/server/src/lib/agents/agent-catalog.ts`, `packages/browseros-agent/apps/server/src/api/services/openclaw/openclaw-cli-providers/claude-cli.ts`
- **Changes:**
  - Replace `claude-opus-4-6` with `claude-sonnet-4-6` or `claude-opus-4-8` depending on intended tier.
  - Update display labels accordingly.

### E — Tests
- **File:** `trios/tests/TriOSKitTests/ChatFailureTests.swift`
- **Changes:**
  - Add a `MockFailingTransport` and a `ChatViewModel` test that verifies auto-failover inserts the retry message and advances `modelStore.selectedModel`.
  - Add a test that verifies balance/auth errors do **not** trigger failover.
  - Add `ChatRequestBuilder` test for OpenRouter `models` array.

---

## 4. Implementation order

1. Provider-aware fallback ordering in `ModelConfigurationStore`.
2. OpenRouter `models` array in `ChatRequestBuilder` / `ChatViewModel`.
3. Extract streaming helper and add auto-failover in `ChatViewModel`.
4. Update agent-core catalog/CLI configs.
5. Extend `ChatFailureTests`.
6. Run verification gates.
7. Commit and write report with three variants.

---

## 5. Verification gates

- `cargo test --workspace` — pass.
- `cargo clippy --workspace --all-targets --all-features -- -D warnings` — clean.
- `swift build` — pass.
- `bash trios/build.sh` — pass.

---

## 6. Three cooperation options for next loop

### Option 1 — Preflight model health check
Probe the provider's model list or a tiny chat request before each turn, disable unavailable models in the picker, and auto-select a healthy fallback. Highest user confidence but adds latency.

### Option 2 — Persistent model reliability scoring
Track per-model success/failure rates over time and auto-rank the fallback chain. More sophisticated but requires telemetry and convergence time.

### Option 3 — Multi-provider failover
Allow the fallback chain to cross providers (e.g., OpenRouter → Z.AI → Ollama local). Most resilient but involves multiple API keys and billing surfaces.

**Recommendation:** Option 1 next, because proactive health checks remove failure before it reaches the chat stream and build on the auto-failover landing in this cycle.
