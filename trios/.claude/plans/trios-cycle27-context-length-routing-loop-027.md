# Cycle 27 Plan — Context-Length-Aware Request Routing

**Issue:** #T27-EPIC-001 (continuing predictive warmup / routing epic)  
**Road:** B (balanced: fix + test + experience save)  
**Ring:** SR-00 / SR-01 / SR-02 / BR-OUTPUT  
**Agent:** claude (Queen)  
**Date:** 2026-07-24  
**Theme selected:** Context-length-aware request routing (Cycle 26 option #3)

---

## 1. Problem Statement

Cycles 22–26 built predictive warmup, stale-while-revalidate, quota gating, and failure-kind-aware volatility. The system now classifies context-length failures correctly and excludes them from generic cross-provider failover, but it still cannot **act before the provider call**. A long user message or a long conversation can hit a model's context window and fail, forcing a visible error even though a larger-context model may be configured and healthy. There is no per-model context-window catalog, no proactive routing to a larger-context candidate, and no history trimming before send.

## 2. Weak Spots (from trios codebase reconnaissance)

1. **No context-window catalog.** `ModelCostService` stores only price/tier; `ModelProvider`/`ModelCatalogService` return only identifiers. The send path does not know `maxContextTokens` for the current model.
2. **No proactive size check.** `ChatRequestBuilder.build()` serializes the full previous conversation + system prompt + current message but never estimates input tokens or compares them to a limit.
3. **No history trimming.** `ChatViewModel.sendMessage` passes `Array(messages.dropLast())` unchanged. There is no sliding-window, summarization, or drop-old-pairs policy.
4. **Context-length is excluded from failover with no alternative path.** `isEligibleForCrossProviderFailover` returns `false` for context-length errors, which is correct for same-size swaps, but the system cannot fail over to a model with a larger window.
5. **No UI visibility.** The composer status bar and Models tab show token usage but not context-window utilization or a "trimmed" indicator.

## 3. Competitor Patterns (synthesis)

- **LiteLLM:** `enable_pre_call_checks` filters deployments by `model_info.max_input_tokens`; `context_window_fallbacks` maps a model to a larger-context fallback.
- **OpenRouter:** Context-length validation errors trigger the `models` fallback array; provider-level fallback cannot fix a too-long prompt.
- **AWS Bedrock AgentCore:** Sliding window + proactive compression at ~70% usage, summarization, and custom hooks; long agent sessions use 50% threshold.
- **ZeroClaw:** `proactive_trim_turns()` estimates character count and drops oldest turns **before** the provider call, with a buffer below the window.
- **LLM Router:** History-dependence scoring prunes irrelevant old messages; middle-out compression keeps top/bottom of long blocks; strips stale media.
- **Mesh-LLM:** Peers advertise runtime context windows; router rejects too-small targets and returns 503 if none compatible.

Key takeaways:
- Proactive > reactive.
- Preserve tool-call pairs when trimming.
- Use a safety margin (not a fixed reserve).
- Allow user-visible fallback ladder and trim indicator.
- Support model-level override of public context specs.

## 4. Design

### 4.1 Data model: `ModelContextService`

New actor in `rings/SR-00/ModelContextService.swift`.

```swift
struct ModelContextProfile: Equatable, Sendable {
    let maxContextTokens: Int
    let maxOutputTokens: Int
    let provider: ModelProvider
    let model: String
}

actor ModelContextService: Sendable {
    static let shared = ModelContextService()

    /// Public specs for known models. Defaults to a conservative window when unknown.
    func profile(for model: String, provider: ModelProvider) -> ModelContextProfile

    /// True if the estimated input tokens fit within the profile's window with margin.
    func fits(_ estimatedTokens: Int, profile: ModelContextProfile, outputTokens: Int, margin: Double) -> Bool

    /// Sorted candidates that fit the estimated input, preferring same provider/family.
    func largerContextCandidates(
        estimatedInput: Int,
        outputTokens: Int,
        current: CrossProviderModelCandidate,
        candidates: [CrossProviderModelCandidate],
        margin: Double
    ) -> [CrossProviderModelCandidate]
}
```

Specs cover:
- OpenAI: gpt-5.2 (128k), gpt-5 (128k), gpt-4.1 (1M).
- Anthropic: claude-sonnet-4-5 (200k), claude-opus-4-5 (200k), claude-haiku-4-5 (200k).
- OpenRouter: mirror common slugs with provider-discovered overrides.
- Ollama: default 128k unless known otherwise; allow local override.
- Z.AI: glm-5.1 (128k), glm-5-turbo (128k), glm-5 (32k), glm-4.7 (128k), glm-4.7-flash (128k), glm-4.6 (128k).

Unknown models default to a conservative `ModelContextProfile.maxContextTokens = 4096` so the system errs on the side of routing/trimming.

### 4.2 Request-size estimation

Extend `TokenEstimator` in `rings/SR-00/TokenUsage.swift`:

```swift
enum TokenEstimator {
    static func estimate(_ text: String) -> Int
    static func estimate(messages: [ChatMessage], systemPrompt: String?) -> Int
}
```

The existing `estimate(_:)` uses `utf8.count / 4`, which is naive. Keep it as the cheap fallback but mark estimates as approximate in UI. For Cycle 27, the estimate is used only for routing/trimming decisions, not billing.

Add a new helper `ChatRequestSizer` in `rings/SR-00/ChatRequestSizer.swift` (or extend `ChatRequestBuilder`) that:
- Computes estimated input tokens = system prompt + all history messages + current message.
- Reserves `requestedMaxTokens` (or a default output budget) from the window.
- Applies a configurable safety margin (default 0.85, i.e., 85% of window, leaving 15% headroom).

### 4.3 Routing policy

Introduce `ContextRoutingDecision`:

```swift
enum ContextRoutingDecision {
    case useCurrent                  // estimated tokens fit current model
    case routeTo(CrossProviderModelCandidate) // a larger-context candidate fits
    case trimHistory(ContextTrimPolicy)         // no larger model fits; trim before sending
    case tooLargeEvenEmpty          // single message exceeds the largest available window
}
```

Decision flow in `ChatViewModel.sendMessage` before building the final request:

1. Estimate input tokens for the full history + current message + system prompt.
2. Look up current model profile.
3. If it fits with margin → `useCurrent`.
4. Else find a larger-context candidate among eligible cross-provider models that is also healthy/breaker+quota allowed.
5. If a fitting larger candidate exists → `routeTo(candidate)`. Apply the selection and record `contextRouted` reason.
6. Else compute a trim policy (drop oldest non-system messages while preserving tool pairs, down to a minimum retained turns).
7. If after trimming the request fits → `trimHistory(policy)`.
8. Else if even the trimmed/single-message request exceeds the largest window → `tooLargeEvenEmpty`, surface a user-visible error without calling the provider.

### 4.4 Trim policy

```swift
struct ContextTrimPolicy {
    let originalMessageCount: Int
    let retainedMessageCount: Int
    let droppedMessageCount: Int
    let preservedSystemPrompt: Bool
}
```

Trim rules:
- Never drop the current user message.
- Never drop the system prompt.
- Drop oldest turns first, but always keep a `toolUse` and its matching `toolResult` together.
- Stop when the estimated tokens of the retained messages fit the chosen model's window with margin, or when `minRetainedTurns` is reached (default 2 turns = 4 messages plus current message).

### 4.5 Integration points

- `ModelConfigurationStore`
  - Inject `ModelContextService`.
  - Add `resolveContextRoutingDecision(for conversationId: UUID?, estimatedInput: Int, requestedOutput: Int, candidates: [CrossProviderModelCandidate]) async -> ContextRoutingDecision`.
  - Update `selectFirstHealthyCrossProviderModel` / `runAdaptiveWarmup` to accept an optional `minContextWindow` constraint.
- `ChatViewModel`
  - Before `buildChatRequest`, call the sizer and apply the routing decision.
  - Pass the trimmed history into `ChatRequestBuilder` when `trimHistory` is chosen.
  - Set `contextRoutingReason` / `contextUtilization` for UI.
  - Record outcomes: if a context-routed model succeeds, treat it like a cached-winner success; if it fails with contextLength, record the kind and do not retry with same-size models.
- `ChatRequestBuilder`
  - Accept an explicit `history` array (already uses `previousConversation` parameter); no change needed if ChatViewModel passes trimmed history.
- `ModelsTabView`
  - Add a "Context window" column/badge per model showing `estimatedInput / maxContextTokens`.
  - Add a "Context routing" section summarizing last route/trim reason.
- `ChatPanelView` composer status
  - Show a compact context-utilization indicator (e.g., "~12%" or "~87%" color-coded).
  - Show "[trimmed N turns]" or "[routed to larger model]" when applicable.

### 4.6 Safety / L1-L7

- **L2 GENERATION:** New canon Swift files require T27-creator implementation and T27-verifier verdict. This plan targets `rings/SR-00/ModelContextService.swift` as a new canon file and edits to `ChatViewModel.swift` / `ModelsTabView.swift` / `ChatPanelView.swift` as reviewed artifacts.
- **L4 TESTABILITY:** Add unit tests for `ModelContextService`, `ChatRequestSizer`, and trim logic. Extend `ChatFailureTests` / `ModelConfigurationStoreCrossProviderTests`.
- **L6 CEILING:** UI changes must reuse `TriosTheme` colors and `ProjectPaths`; no new status surfaces outside the composer toolbar.
- **L7 UNITY:** No new `.sh` scripts. Use existing `build.sh` / cargo pipeline.

## 5. Decomposed Tasks

1. **Spec & claim**
   - Create `.trinity/specs/context-length-routing.md` with invariants, interface, and tests.
   - Acquire claim on `context_length_routing` graph node and `model-control-center.md` (read-only coordination).

2. **Context-window catalog**
   - Implement `rings/SR-00/ModelContextService.swift`.
   - Add unit tests `tests/TriOSKitTests/ModelContextServiceTests.swift`.

3. **Request sizing**
   - Extend `TokenEstimator` with multi-message estimation.
   - Implement `rings/SR-00/ChatRequestSizer.swift`.
   - Add unit tests `tests/TriOSKitTests/ChatRequestSizerTests.swift`.

4. **Trimming engine**
   - Implement history trimmer that preserves tool pairs and system prompt.
   - Add unit tests `tests/TriOSKitTests/HistoryTrimmingTests.swift`.

5. **Routing integration**
   - Inject `ModelContextService` into `ModelConfigurationStore`.
   - Add `resolveContextRoutingDecision(...)` and `minContextWindow` constraint to warmup/reliability helpers.
   - Wire into `ChatViewModel.sendMessage` before `buildChatRequest`.
   - Record context-routing outcomes in volatility.

6. **UI indicators**
   - Add context-window badge to `ModelsTabView` model rows.
   - Add context-utilization indicator and route/trim label to `ChatPanelView` composer status.
   - Ensure accessibility labels.

7. **Validation**
   - `./build.sh`
   - `cargo test --workspace`
   - `cargo clippy --workspace`
   - `cargo run --bin clade-audit` (hard gates 0)
   - `cargo run --bin clade-seal` (SEAL VALID)
   - `cargo run --bin clade-e2e`
   - Relaunch `trios.app` and verify `/health` + menu-bar logo.

8. **Report & learn**
   - Write `.claude/plans/trios-cycle27-context-length-routing-loop-027-report.md` with three Cycle 28 variants.
   - Update `.trinity/experience.md` and create episode JSON.

## 6. TDD Criteria

- `ModelContextService.profile(for:provider:)` returns correct windows for all cataloged models and a conservative default for unknowns.
- `ChatRequestSizer` correctly estimates input tokens, applies margin, and reports overflow.
- History trimmer preserves system prompt and tool pairs; drops oldest turns first.
- `ModelConfigurationStore.resolveContextRoutingDecision` prefers current model when it fits, routes to a larger healthy candidate when available, trims when no larger candidate fits, and returns `tooLargeEvenEmpty` for oversized single messages.
- `ChatViewModel.sendMessage` applies routing/trim decisions before building the request and records outcomes.
- UI shows context-utilization and trim/route indicators without duplicating status surfaces.
- All existing gates pass with 0 hard findings and SEAL VALID.

## 7. Cycle 28 Variants (preview)

1. **Per-conversation provider/model pinning** — allow the user to pin a provider/model per chat thread, constraining adaptive warmup, predictive selection, and context routing to the allowed set.
2. **Predictive warmup budget cap** — track probe spend (input tokens × cost) and cap daily/weekly budget; deprioritize or skip probes when close to cap.
3. **Advanced context management** — sliding-window summarization, retrieval-based memory compression, and per-message importance scoring instead of simple oldest-first trimming.

---

**Next action:** Create the T27 spec and coordination claim, then delegate implementation to T27-creator and T27-verifier agents.
