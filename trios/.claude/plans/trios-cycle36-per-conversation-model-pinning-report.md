# Per-Conversation Model/Provider Pinning — Cycle 36 Report

**Date:** 2026-07-27  
**Ring:** SR-00 / SR-01 / SR-02 / BR-OUTPUT  
**Agent:** claude  
**Road:** B (fix + test + experience save)

## 1. Problem
Cycle 35 made the composer draft budget-aware, and Cycle 34 gave each conversation its own `requestedOutputTokens` and `contextWindowMargin`. However, the active model/provider/baseURL remained a single global selection. Switching between chat threads meant manually re-selecting the right provider and model every time — for example, a coding conversation that should always run on `anthropic/claude-opus-4-5` and a quick Q&A that should stay on a cheap OpenRouter model.

## 2. Root Cause
`ModelConfigurationStore` persisted exactly one `selectedProvider`, `selectedModel`, and `baseURL`. `ChatViewModel` loaded per-conversation settings for output budget and margin, but there was no `ConversationSettings` field for provider/model, and no code path to apply a conversation-specific selection on switch. The composer status menu only reflected the global selection.

## 3. Fix
Extended `ConversationSettings` (in `trios/rings/SR-01/ChatProtocols.swift`) with optional `provider`, `baseURL`, and `model` fields. `nil` continues to mean "use the global default from `ModelConfigurationStore`".

Added effective accessors and setters to `ChatViewModel`:
- `effectiveConversationProvider`, `effectiveConversationModel`, `effectiveConversationBaseURL`
- `hasConversationModelOverride`
- `setConversationModelOverride(provider:baseURL:model:)`
- `clearConversationModelOverride()`

On `performConversationSwitch`, `ChatViewModel` now calls `applyConversationModelOverrideIfNeeded()`, which invokes `modelStore.applySelection(provider:baseURL:model:)` to switch the runtime selection **without mutating the persisted global default**. Switching away from the conversation leaves the global default intact, and switching back re-applies the pinned tuple. The pre-send draft context badge uses the effective model/provider so the utilization estimate matches the pinned selection.

Updated `ChatPanelView.composerStatusControl` with a "This conversation" section in its menu:
- **Pin current model to conversation** — persists the current `modelStore.selectedProvider`, `baseURL`, and `selectedModel` into the conversation settings.
- **Clear conversation pin** — removes the override and restores the global default for the current conversation.

The composer model label gains a `📌` prefix and the help tooltip shows `Pinned to this conversation: Provider / model` when an override is active.

`ConversationPersister` already encrypts `ConversationSettings` via `ConversationEncryption.shared`; the new Codable fields roundtrip automatically, so no persistence-layer changes were needed.

## 4. Files Changed
- `trios/rings/SR-01/ChatProtocols.swift`
- `trios/rings/SR-02/ChatViewModel.swift`
- `trios/BR-OUTPUT/ChatPanelView.swift`
- `trios/tests/TriOSKitTests/ConversationEncryptionTests.swift`

## 5. Tests
- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` — PASS
- `cargo test -p trios-mesh` — PASS (101 tests)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` — PASS
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` — PASS (0 hard-gate findings)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` — SEAL VALID

`swift test` is unavailable in the CommandLineTools-only environment. `trios.app` should be relaunched from the user terminal with `open trios.app` because the agent shell lacks Aqua/GUI access.

## 6. Trinity Law Compliance
- **L1 TRACEABILITY** — closes the standing-cycle request; no GitHub issue linked because this is a standing user-defined cycle.
- **L2 GENERATION** — Swift changes follow the established canon pattern and reuse `ModelConfigurationStore.applySelection`.
- **L3 PURITY** — ASCII-only source files, English identifiers/comments.
- **L4 TESTABILITY** — all clade gates pass; XCTest updates added.
- **L5 IDENTITY** — no sacred constants touched.
- **L6 CEILING** — no new UI SSOT files; composer controls reuse `ChatPanelView`.
- **L7 UNITY** — no new shell scripts.

## 7. Next Options (Cycle 37)
1. **Conversation-level learned-limit reset** — add a menu action to clear the learned context/output ceilings for the current conversation only, without resetting the global `StreamingContextLimitLearner` history.
2. **Output-budget progress during streaming** — render a live progress indicator inside the streaming assistant message showing consumed output tokens vs. the effective budget/ceiling, with color bands and approaching-limit warnings.
3. **Pinned-model warmup/failover guardrails** — when a conversation has a pinned provider/model/baseURL, constrain adaptive warmup and cross-provider failover to that tuple, and surface a banner when the global default is being overridden by a conversation pin.
