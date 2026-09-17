---
name: context-length-routing
domain: Language
agent: L
priority: P1
status: active
claim_id: CONTEXT-ROUTING-027
task_id: CONTEXT-ROUTING-027
issue: "#T27-EPIC-001"
---

# Spec: Context-Length-Aware Request Routing

## Purpose

Prevent context-window failures by estimating request size before the provider call, routing to a larger-context healthy model when available, and trimming conversation history as a last resort. The behavior must be transparent to the user and never silently drop the current message or the system prompt.

## Invariants

### INV-1: Current message is never dropped
The routing/trimming engine may drop old conversation turns but must always include the message the user is currently sending.

### INV-2: System prompt is never dropped
If a system prompt is configured, it must remain in the request after any trimming.

### INV-3: Tool pairs stay together
A `toolUse` message and its matching `toolResult` message must either both be retained or both be dropped.

### INV-4: Proactive before reactive
Routing or trimming decisions must be made before the request is sent. The engine must not wait for a 413 / context-length error response.

### INV-5: Prefer larger healthy model over trimming
If an eligible, healthy, quota-allowed candidate with a larger context window exists, route to it before trimming history on the current model.

### INV-6: Safety margin is configurable
The default usable window is 85% of the advertised context window. The user may adjust this margin via `ModelsTabView` (range 50%...95%).

### INV-7: Unknown models are conservative
If a model's context window is not cataloged, the engine uses a conservative default (4096 tokens) and may route/trim more aggressively.

### INV-8: No silent fallback to smaller windows
The engine must never select a model whose context window is smaller than the current model when the current model already fails the fit test, unless the smaller model is explicitly pinned by the user.

### INV-9: Token estimates are approximate
Token estimates are used only for routing/trimming, never for billing. Provider-reported usage remains authoritative for token accounting.

## Interface

```swift
struct ModelContextProfile: Equatable, Sendable {
    let maxContextTokens: Int
    let maxOutputTokens: Int
}

actor ModelContextService: Sendable {
    static let shared = ModelContextService()
    func profile(for model: String, provider: ModelProvider) -> ModelContextProfile
    func fits(_ estimatedInput: Int, profile: ModelContextProfile, outputTokens: Int, margin: Double) -> Bool
}

struct ChatRequestSize {
    let estimatedInputTokens: Int
    let requestedOutputTokens: Int
    let margin: Double
    let fitsCurrentModel: Bool
}

enum ContextRoutingDecision: Equatable {
    case useCurrent
    case routeTo(CrossProviderModelCandidate)
    case trimHistory(ContextTrimPolicy)
    case tooLargeEvenEmpty
}

struct ContextTrimPolicy: Equatable {
    let originalMessageCount: Int
    let retainedMessageCount: Int
    let droppedMessageCount: Int
    let preservedSystemPrompt: Bool
}
```

## Behavior

1. Before building the chat request, `ChatViewModel` computes `ChatRequestSize` for the full history + current message + system prompt.
2. If the current model fits, proceed with `useCurrent`.
3. Otherwise, `ModelConfigurationStore` asks `ModelContextService` for all eligible healthy candidates with a larger context window, sorted by reliability × latency score (same score used for cross-provider failover). The first fitting candidate becomes `routeTo(candidate)`.
4. If no larger candidate fits, compute a `ContextTrimPolicy` that drops oldest turns until the retained history fits or `minRetainedTurns` is reached.
5. If trimming succeeds, proceed with `trimHistory(policy)`.
6. If even the single current message exceeds the largest available window, return `tooLargeEvenEmpty` and surface a user-visible error without calling the provider.

## Trimming Policy

- Start with the full message array (excluding current message).
- Keep the system prompt at index 0 if present.
- Iteratively remove the oldest non-system, non-current turn.
- A "turn" is a pair of messages; never split a `toolUse`/`toolResult` pair.
- Stop when the estimated tokens of retained messages + current message fit the chosen model's usable window, or when only `minRetainedTurns` (default 2) plus the current message remain.

## UI

- `ModelsTabView` shows a context-window badge per model: `~N%` of window used, color-coded by threshold (green ≤70%, yellow ≤85%, red >85%).
- `ChatPanelView` composer status shows a compact context-utilization percentage and a route/trim label when applicable (e.g., "routed to larger model", "trimmed 4 turns").
- No standalone status surface is added; all indicators reuse the integrated composer toolbar.

## Tests

### T-1: Unit tests
- `ModelContextServiceTests`: known profiles, unknown default, fits/margin math.
- `ChatRequestSizerTests`: multi-message estimation, margin application, overflow detection.
- `HistoryTrimmingTests`: preserves system prompt, preserves tool pairs, drops oldest first, respects minimum.
- `ContextRoutingDecisionTests`: current fits, route to larger, trim, too-large-single-message.

### T-2: Integration tests
- Extend `ChatFailureTests` to verify proactive routing before a context-length error.
- Extend `ModelConfigurationStoreCrossProviderTests` with a context-window constraint.

### T-3: Build and gates
- `./build.sh` PASS.
- `cargo test --workspace` PASS.
- `cargo clippy --workspace` PASS.
- `cargo run --bin clade-audit` hard gates 0 findings.
- `cargo run --bin clade-seal` SEAL VALID.
- `cargo run --bin clade-e2e` PASS.
- `open trios.app` relaunched and `/health` ok, menu-bar logo present.

## Constraints

- Foundation only for core logic (`ModelContextService`, `ChatRequestSizer`, trimmer); SwiftUI only in BR-OUTPUT.
- ASCII-only source; English identifiers and comments.
- No hardcoded absolute paths.
- No new shell scripts (L7 UNITY).
- Secrets never enter `UserDefaults` or rendered text.

## Change Flow

Any change to this spec or the canon Swift files it governs must pass:

1. Spec update (this file).
2. t27-creator implementation.
3. t27-verifier L1-L7 verdict.
4. `/t27-tri-pipeline seal`.
5. Land with `Closes #T27-EPIC-001`.
6. `/t27-experience-save`.
