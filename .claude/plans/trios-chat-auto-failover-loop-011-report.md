# TriOS Chat Auto-Failover Loop — Cycle 11 Report

**Date:** 2026-07-24  
**Branch:** `dev` (commit `7fbf0521d`)  
**Scope:** Automatic one-shot model failover for chat provider failures.

---

## 1. What was implemented

### A — Automatic model failover in `ChatViewModel`
- **File:** `trios/rings/SR-02/ChatViewModel.swift`
- Extracted the streaming attempt into a private `executeStream(...)` helper.
- `sendMessage` now catches `TransportError.isModelUnavailableError` or `TransportError.isInvalidModelError` and retries **once** with `modelStore.selectNextModel()`.
- Inserts a user-visible system banner: `[↻] Model \`<old>\` failed; retrying with \`<new>\`…`.
- If the retry also fails, the original model selection is restored so the next user turn does not inherit a broken fallback.
- Balance (402), auth (401), and other fatal errors do **not** trigger failover.

### B — Provider-aware fallback ordering
- **File:** `trios/rings/SR-00/ModelProvider.swift`
- Added `fallbackModels(excluding:)` that orders OpenRouter candidates with `google/gemini-2.5-flash` as the cheap/reliable floor model last.
- Added the floor model to the OpenRouter `suggestedModels` list.
- `ModelConfigurationStore.fallbackModels` now uses this provider-aware ordering.

### C — OpenRouter native `models` array
- **Files:** `trios/rings/SR-00/ModelProvider.swift`, `trios/rings/SR-02/ChatViewModel.swift`
- Extended `ModelRuntimeConfiguration` with an optional `fallbackModels` field.
- `runtimeConfiguration` now passes the ordered fallback chain.
- `ChatRequestBuilder` emits `models: [primary, ...fallbacks]` when `provider == .openrouter`, enabling server-side provider failover before the client-side retry path runs.

### D — Cleaned stale `claude-opus-4-6` references
- **Files:**
  - `packages/browseros-agent/apps/server/src/lib/agents/agent-catalog.ts`
  - `packages/browseros-agent/apps/server/src/api/services/openclaw/openclaw-cli-providers/claude-cli.ts`
- Replaced the unavailable `claude-opus-4-6` with `claude-opus-4-8` so BrowserOS agent-core configs stop advertising a removed model.

### E — Tests
- **File:** `trios/tests/TriOSKitTests/ChatFailureTests.swift`
  - `testAutoFailoverOnModelUnavailable` — verifies two transport calls, banner insertion, model switch, and assistant response.
  - `testBalanceErrorDoesNotFailover` — verifies 402 remains fatal and does not switch models.
- **File:** `trios/tests/TriOSKitTests/ChatRequestBuilderTests.swift`
  - `testOpenRouterIncludesModelsArray` — asserts `models` array is emitted for OpenRouter.
  - `testNonOpenRouterOmitsModelsArray` — asserts other providers omit it.

---

## 2. Verification

| Gate | Command | Result |
|---|---|---|
| Swift app build | `TRIOS_SKIP_CHAT_E2E=1 TRIOS_SKIP_SWIFT_TEST=1 bash build.sh` | ✅ Pass |
| Rust clippy | `cargo clippy --workspace --all-targets --all-features -- -D warnings` | ✅ Clean |
| Rust tests | `cargo test --workspace` | ✅ 101 passed |
| Swift XCTest | `swift test --package-path /Users/playra/BrowserOS` | ⚠️ Skipped — this environment has CommandLineTools only; `xctest` is not installed. The test target compiles against the same `TriOSKit` sources and will run on the full Xcode toolchain. |

---

## 3. Weak spots still present

| Rank | Issue | Why it remains |
|---|---|---|
| 1 | No preflight model health probe | We failover *after* the first failure; a proactive check could avoid the failed turn entirely. |
| 2 | Single retry only | A transient provider blip may need more than one hop, but multiple automatic switches risk silent downgrades. |
| 3 | No per-model reliability scoring | The fallback order is static; it does not learn from actual success/failure history. |
| 4 | Cross-provider failover absent | A fallback chain is scoped to one provider; if the provider itself is down, the user must switch manually. |
| 5 | UI does not show which model finally served the response | OpenRouter returns `response.model`, but TriOS does not surface it in the chat timeline. |

---

## 4. Three cooperation options for the next loop

### Option 1 — Preflight model health check (recommended)
Before each user send, make a lightweight probe (e.g., a tiny non-streaming request or the provider's `/models` endpoint). Mark unhealthy models in `ModelConfigurationStore`, skip them in `fallbackModels`, and only stream against a model known to be reachable.

- **Pros:** Prevents the user from ever seeing the first failure; builds directly on the auto-failover landing now.
- **Cons:** Adds ~50–200 ms latency before the first token; requires per-provider probe logic.
- **Files likely touched:** `ModelConfigurationStore.swift`, `ModelCatalogService.swift`, `ChatViewModel.swift`, `SSETransport.swift`.

### Option 2 — Persistent model reliability scoring
Track per-model success/failure counts and average latency per provider. Use the score to dynamically re-rank `fallbackModels` and to blacklist a model after repeated failures.

- **Pros:** Learns real-world behavior; improves ordering over time.
- **Cons:** Needs telemetry storage, score convergence, and a decay/reset policy; more complex than a probe.
- **Files likely touched:** New `ModelReliabilityScorer.swift`, `ModelConfigurationStore.swift`, `.trinity/experience/`.

### Option 3 — Multi-provider failover
Allow the fallback chain to cross providers: e.g., OpenRouter → Z.AI → local Ollama. Store provider-specific credentials and switch `modelStore.selectedProvider` when the current provider is globally unavailable.

- **Pros:** Most resilient against provider outages.
- **Cons:** Multiple API keys, billing surfaces, and potentially different model behavior; high UX complexity.
- **Files likely touched:** `ModelConfigurationStore.swift`, `ChatViewModel.swift`, `ChatRequestBuilder.swift`, settings UI.

**Recommendation:** Take **Option 1** next. It removes failures before they reach the stream, which is the natural follow-up to the reactive failover just shipped, and it keeps the change localized to the model-selection layer.

---

## 5. Key files changed

```
trios/rings/SR-00/ModelProvider.swift
trios/rings/SR-00/ModelConfigurationStore.swift
trios/rings/SR-02/ChatViewModel.swift
trios/tests/TriOSKitTests/ChatFailureTests.swift
trios/tests/TriOSKitTests/ChatRequestBuilderTests.swift
packages/browseros-agent/apps/server/src/lib/agents/agent-catalog.ts
packages/browseros-agent/apps/server/src/api/services/openclaw/openclaw-cli-providers/claude-cli.ts
.claude/plans/trios-chat-auto-failover-loop-011.md
```

---

φ² + 1/φ² = 3 | TRINITY
