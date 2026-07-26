# Cycle 17 Plan — TriOS Chat Feedback Endpoint

## Context
- `clade-seal` is green but still permits one TODO: `rings/SR-02/ChatViewModel.swift:510` — `sendFeedback(messageId:isPositive:)` logs feedback locally and has the comment `// TODO: wire to server feedback endpoint when available`.
- Competitor landscape (Aivyx, Kairo Phantom, Moirai, AgentForger/BioShocking incidents) shows increasing pressure for **auditable, local-first autonomy with explicit human feedback loops**. Wiring thumbs-up/down feedback into persistent history is a small but high-leverage trust signal.
- Active claim `TRIOS-PORTABLE-LAND-001` (codex-root) is scoped to portable root path resolution and installation landing; chat feedback is outside that scope.

## Goal
Implement a server-side feedback endpoint and wire the Swift client so that the `ChatViewModel` TODO can be removed, leaving `clade-seal` with **zero permitted TODOs**.

## Decomposition

### 1. Server API — feedback route
**File:** `packages/browseros-agent/apps/server/src/api/routes/chat.ts`
- Add `POST /:conversationId/messages/:messageId/feedback`.
- Validate params with `ConversationIdParamSchema` plus a new `MessageIdParamSchema`.
- Validate JSON body `{ isPositive: boolean }`.
- Call `chatHistoryService.storeFeedback(...)`.
- Return `{ success: true }` or typed error.
- Mount under existing trusted-origin middleware used by the rest of `/chat`.

**File:** `packages/browseros-agent/apps/server/src/api/services/chat-history-service.ts`
- Add `storeFeedback(conversationId, messageId, isPositive)`.
- Find message row by `conversationId` + `"rowId" = messageId`.
- Update `metadata` JSONB: set `feedback.isPositive` and `feedback.updatedAt` (ISO-8601), preserving existing metadata keys.
- Return `{ updated: boolean }`.

**File:** `packages/browseros-agent/apps/server/src/api/utils/validation.ts` (or adjacent)
- Add `MessageIdParamSchema` = z.object({ messageId: z.string().uuid() }).
- Add `FeedbackBodySchema` = z.object({ isPositive: z.boolean() }).

### 2. Swift client — `ChatViewModel.sendFeedback`
**File:** `trios/rings/SR-02/ChatViewModel.swift`
- Replace TODO with an actual POST to `\(ProjectPaths.mcpBaseURL)/chat/\(conversationId.uuidString)/messages/\(messageId.uuidString)/feedback`.
- Build JSON body `{"isPositive": true/false}`.
- Use `NetworkRetrier` with `NetworkRetryPolicy.default` and `URLSession`.
- Surface errors via `NSLog` (non-blocking; feedback must not break chat flow).
- Keep the call `async` and idempotent: sending the same feedback twice overwrites the stored value.

### 3. Tests
**Server:** `packages/browseros-agent/apps/server/tests/api/routes/chat-feedback.test.ts` (new)
- POST feedback for a message, assert 200 + metadata update.
- POST feedback for missing message, assert 404.
- POST invalid body, assert 400.
- POST from untrusted origin, assert 403.

**Swift:** `tests/TriOSKitTests/ChatViewModelFeedbackTests.swift` (new)
- Mock transport/retrier or use a local `URLProtocol` stub to assert the request body and path.
- Assert that `sendFeedback` completes without throwing and logs appropriately.

### 4. Seal cleanup
**File:** `rings/RUST-08/clade-promote/src/seal.rs`
- Remove the allowed TODO fingerprint array (or leave it empty) once `ChatViewModel.swift:510` TODO is deleted.

### 5. Verification
- `cargo run --bin clade-audit` → TODO gate 0 findings.
- `cargo run --bin clade-seal` → SEAL VALID.
- `cargo run --bin clade-build` → PASS.
- `cargo run --bin clade-e2e` → PASS.
- `cargo test --workspace` → PASS.
- `bun test packages/browseros-agent/apps/server/tests/api/routes/chat-feedback.test.ts` → PASS.
- `open trios.app` + `curl http://127.0.0.1:9105/health` → ok.

## Road
Road B (balanced): fix + tests + experience save.

## Variant Options (for final report)
1. **Variant A (minimal)** — Add route, store feedback in existing `metadata` JSONB, wire Swift, no new table.
2. **Variant B (auditable)** — Add a dedicated `message_feedback` table with hash-chained receipt (Ed25519-signed) like Aivyx/Kairo; bigger scope, harder seal.
3. **Variant C (defer)** — Keep TODO but move it to a tracked issue and implement in Cycle 18; not recommended because seal is already positioned for zero TODOs.

## Law Check
- L1 TRACEABILITY: will close the TODO with no remaining issue, but should reference this plan in commit/experience.
- L2 GENERATION: Swift canon files (`rings/SR-02/ChatViewModel.swift`) are hand-edited; Agent V waiver already present for Queen direct-chat hardening.
- L3 PURITY: ASCII-only identifiers.
- L4 TESTABILITY: build + e2e + seal + unit tests.
- L5 IDENTITY: no UI changes beyond existing feedback logging.
- L6 CEILING: uses `ProjectPaths.mcpBaseURL`.
- L7 UNITY: no new `.sh` scripts.
