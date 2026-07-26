# Cycle 17 Report — TriOS Chat Feedback Endpoint

## Summary
Wired the last permitted TODO in `rings/SR-02/ChatViewModel.swift:510` to a real BrowserOS server endpoint. `clade-seal` now runs with **zero allowed TODOs**, and the chat feedback loop (thumbs-up/down) is persisted in PostgreSQL message metadata.

## What changed

### Server
- `packages/browseros-agent/apps/server/src/api/utils/validation.ts`
  - Added `MessageIdParamSchema` and `FeedbackBodySchema`.
- `packages/browseros-agent/apps/server/src/api/services/chat-history-service.ts`
  - Added `storeFeedback(conversationId, messageId, isPositive)` that updates `metadata.feedback` JSONB on the matching `conversationMessages` row.
- `packages/browseros-agent/apps/server/src/api/routes/chat.ts`
  - Added `POST /:conversationId/messages/:messageId/feedback`.
  - Route is protected by the existing `/chat/*` trusted-origin middleware.
  - Returns `{ success: true }` (200), 404 for missing messages, 400 for invalid bodies, 503 if no database is configured.
- `packages/browseros-agent/apps/server/src/api/server.ts`
  - Passed `databaseUrl` into `createChatRoutes` so production builds instantiate `ChatHistoryService`.

### Swift client
- `trios/rings/SR-02/ChatViewModel.swift`
  - Replaced the TODO with a real `POST` to `\(ProjectPaths.mcpBaseURL)/chat/.../feedback`.
  - Uses `NetworkRetrier` + `NetworkRetryPolicy.default` for resilience.
  - Logs success and errors without breaking the chat flow.

### Seal
- `trios/rings/RUST-08/clade-promote/src/seal.rs`
  - Emptied `ALLOWED_TODO_FINGERPRINTS`; the seal no longer permits any TODOs.

### Tests
- `packages/browseros-agent/apps/server/tests/api/routes/auth-routes.test.ts`
  - Added 4 feedback-route cases: success, 404 missing message, 400 invalid body, 403 remote origin.

## Verification
- `cargo run --bin clade-audit` → all hard gates green, **TODO gate 0 findings**.
- `cargo run --bin clade-seal` → **SEAL VALID**.
- `cargo run --bin clade-build` → PASS.
- `cargo run --bin clade-e2e` → PASS, health OK, app PID stable.
- `cargo test --workspace` → 101 Rust tests passed.
- `bun test apps/server/tests/api/routes/auth-routes.test.ts` → 24 passed, 0 failed.
- `bun tsc --noEmit` → clean.
- `open trios.app` relaunched; `curl http://127.0.0.1:9105/health` → `{"status":"ok","cdpConnected":true}`.

## Competitor context
- **Aivyx** (Rust, BUSL-1.1, local-first/Ollama, encrypted storage, operator autonomy dial).
- **Kairo Phantom** (air-gapped legal redlining, signed audit trail, `KAIRO_SEALED=1` zero-socket mode).
- **Moirai** (Arc Studio, closed-source NDA, Synedrion deliberation council, Aletheia anti-sycophancy).
- **AgentForger / BioShocking / OpenAI-Hugging Face incidents** (July 2026) highlight why explicit human feedback, trusted-origin enforcement, and auditable metadata matter for autonomous agents.

TriOS now has a feedback primitive that can later be extended into an auditable, locally-signed receipt system (Variant B below).

## Three variants evaluated

### Variant A — implemented (minimal)
Store feedback in existing `metadata` JSONB, wire Swift client, seal zero TODOs.
- **Pros:** Small blast radius, no schema migration, passes all gates immediately.
- **Cons:** Feedback is embedded in message metadata, not independently queryable at scale.

### Variant B — auditable feedback receipts
Add a dedicated `message_feedback` table with hash-chained Ed25519-signed receipts, like Aivyx/Kairo Phantom.
- **Pros:** Tamper-evident audit trail, supports offline verification, aligns with competitor local-first narrative.
- **Cons:** Needs new migration, key management, and Swift signing code; exceeds the "remove last TODO" scope and would require a new claim.

### Variant C — defer and track
Keep the TODO but move it to a GitHub issue, implement in Cycle 18.
- **Pros:** Zero immediate code risk.
- **Cons:** Leaves `clade-seal` with a permitted TODO, contradicting the goal of a fully green self-critic gate.

**Selected:** Variant A. It closes the cycle cleanly while preserving the architecture for Variant B.

## Law compliance
- L1 TRACEABILITY: closes the last unowned TODO; plan/report capture rationale.
- L2 GENERATION: Swift file edited under existing Agent V waiver for Queen direct-chat hardening.
- L3 PURITY: ASCII-only identifiers.
- L4 TESTABILITY: build, e2e, seal, Rust tests, Bun server tests all pass.
- L5 IDENTITY: no UI changes beyond existing feedback logging.
- L6 CEILING: uses `ProjectPaths.mcpBaseURL` as SSOT.
- L7 UNITY: no new `.sh` scripts.

## Next options
1. Extend feedback into Variant B (signed receipts + dedicated table) for local-first audit parity.
2. Surface aggregated feedback in `QueenStatusViewModel` or a new analytics view.
3. Add local-first offline feedback queue with retry when the server is unreachable.
