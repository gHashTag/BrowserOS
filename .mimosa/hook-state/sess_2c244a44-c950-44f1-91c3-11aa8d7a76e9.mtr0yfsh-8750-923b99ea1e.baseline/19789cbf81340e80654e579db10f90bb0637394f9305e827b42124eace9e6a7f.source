# Cycle 10 Plan: Complete Trinity Queen Direct Chat + Related Hardening

**Date:** 2026-07-24  
**Branch:** `feat/zai-provider`  
**Issue anchor:** browseros-ai/BrowserOS#2023  
**Road:** B (balanced)

---

## 1. Weak spots addressed by this cycle

After Cycle 9 (security/privacy hardening) and the partial Queen Direct Chat landing, the highest-impact remaining issues are:

| Rank | Issue | File(s) | Severity | Root cause |
|---|---|---|---|---|
| 1 | `QueenProposalApplier` mutates files without consuming safety budget or human confirmation | `rings/SR-02/QueenProposalApplier.swift` | P0 | Spec requires safety-budget gating and human-in-the-loop; implementation skips both. |
| 2 | Proposed code changes are injected as comment blocks, not real edits | `rings/SR-02/QueenProposalApplier.swift` | P0 | `appendPatch` only writes a `// MARK: - Queen self-evolution proposal injection` comment, so `./build.sh` does not validate the actual change. |
| 3 | `AgentNetworkClient` force-unwraps URLs built from raw string interpolation | `BR-OUTPUT/AgentNetworkClient.swift` | P1 | No input validation or `URLComponents`; malformed base/ID crashes the app. |
| 4 | Queen A2A stream has no reconnect after transient failure | `rings/SR-02/QueenBackgroundService.swift` | P1 | Single-shot `Task` with no retry/reconnect loop at the service layer. |
| 5 | Conversation current-ID stored in `UserDefaults` plaintext | `rings/SR-02/ConversationPersister.swift` | P1 | Metadata leaks conversation identity even though payload is encrypted. |
| 6 | Inbound Queen messages persisted twice | `rings/SR-02/ChatViewModel.swift` + `rings/SR-02/QueenBackgroundService.swift` | P1 | Delegate path writes to persister, then active chat also calls `saveHistory`. |
| 7 | `QueenStatusViewModel` agents list is local processes, not online A2A agents | `BR-OUTPUT/QueenStatusViewModel.swift` | P2 | `agents` property is hardcoded; spec wants live registry list. |
| 8 | `A2AMessageRouter` accepts arbitrary payloads without sender/type validation | `BR-OUTPUT/A2AMessageRouter.swift` | P2 | Decoded with `try?` and emitted immediately. |

---

## 2. Competitor snapshot

- **OpenAI ChatGPT Atlas shutdown (July 9, 2026):** OpenAI folds Atlas into ChatGPT Work. Standalone AI browsers are not winning unless they own the OS/workspace workflow.
- **ChatGPT Work:** Desktop agent with browser, Computer Use, scheduled tasks, plugins — a direct threat to BrowserOS/TriOS's workspace positioning.
- **Perplexity Comet:** Research leader but CometJacking prompt-injection warnings show security trust issues.
- **Dia:** Still missing Spaces; no distribution.
- **OpenClaw:** WhatsApp-to-host RCE via prompt injection proves agent gateways need strict sandboxing.
- **Strategic opportunity:** BrowserOS/TriOS can own the **local-first, open, browser-integrated agent workspace** with verifiable isolation while competitors retreat or bleed trust.

---

## 3. Decomposed implementation

### 3.1 Safety-budget enforcement in `/apply`
- Before `QueenProposalApplier` runs, check `QueenSafetyBudget.isActive`.
- If halted/depleted, return system message and abort.
- On success, decrement budget by 1 and persist.

### 3.2 Real, repo-agnostic proposal application
- Replace comment-block append with actual file edits via `FileManager` / `Edit` logic.
- Derive GitHub remote and base branch from `git remote -v` and current branch (`feat/zai-provider`), with fallback to `browseros-ai/BrowserOS:dev` only when no local remote.
- Guard against dirty working tree / existing branch by appending timestamp/counter.
- Run `./build.sh` after applying; if it fails, reject and report.
- Keep PR as draft and require user confirmation before push (human-in-the-loop).

### 3.3 `AgentNetworkClient` URL hardening
- Replace `URL(string:)` force unwraps with `URLComponents`.
- Validate `conversationId`, `profileId`, `agentId` are alphanumeric/hyphen/underscore, max 64 chars.
- Return typed `AgentNetworkError.invalidInput` instead of crash.
- Percent-encode query parameters.

### 3.4 A2A stream reconnect loop
- In `QueenBackgroundService`, wrap `startA2AStream()` in a retry loop with exponential backoff (max 5 attempts, 1s initial delay).
- On each reconnect, send `Last-Event-ID` header (already tracked by `A2ARegistryClient`).
- Yield a synthetic `.error` A2AMessage after budget exhaustion.

### 3.5 Encrypt current conversation ID
- Use existing `ConversationEncryption` / `KeychainSecrets` helpers.
- Encrypt UUID string before writing to `UserDefaults` under `trios.currentConversationId.encrypted`.
- Migrate old plaintext key on first read, then delete it.

### 3.6 Deduplicate inbound Queen message persistence
- Add a transient `id` to A2A messages routed into the Queen conversation.
- In `ChatViewModel`, skip `saveHistory` for messages that originated from the A2A delegate path and are already in the persister; reload instead.

### 3.7 Online A2A agents observation
- Add `onlineAgents` publisher to `QueenStatusViewModel` driven by periodic `A2ARegistryClient.listAgents()`.
- Throttle to 30s; fall back to empty list when offline.

### 3.8 A2AMessageRouter validation
- Validate `A2AMessage.type` is in the known enum set.
- Validate `sender` is a non-empty identifier matching `[A-Za-z0-9._-]{1,64}`.
- Drop malformed messages with a log warning instead of emitting them.

### 3.9 Tests
- `QueenSafetyBudgetTests.swift` — budget active/halting/consumption.
- `QueenProposalApplierTests.swift` — confirmation gate, build validation, budget consumption.
- `AgentNetworkClientTests.swift` — invalid input returns error instead of crash.
- Update `QueenStatusViewModelTests.swift` if online-agent path exists.

---

## 4. Verification gates

- `cargo test --workspace` — pass.
- `cargo clippy --workspace --all-targets --all-features` — clean.
- `./build.sh` — pass (XCTest skipped if unavailable).
- `cargo run --bin clade-build` — pass.
- `cargo run --bin clade-e2e` — pass.
- `open trios.app` relaunch; menu-bar logo present; `curl /health` returns ok.
- Manual checks: Queen conversation visible, `/agents` returns online agents, `/evolve` generates proposals, `/apply` requires confirmation and consumes budget.

---

## 5. Three variants for the next loop (cycle 11)

### Variant A — Security depth
Finish encrypting all runtime state (`HotkeyAnalytics` full encryption, attachments, memory snapshots), add audit logging for every MCP/tool config change, implement config-change approval gate, and publish an internal OWASP ASI mapping.

### Variant B — Product/GTM push
Use the Atlas shutdown / Comet trust issues window to update README/website comparisons, ship a polished one-click macOS installer, add a public security page, and create a "BrowserOS vs closed AI agents" explainer.

### Variant C — Mesh/off-grid moat
Implement LAN/mDNS peer pinning with static keys, complete Noise-XX handshake, prototype a LoRa/radio bridge for offline agent meshes.

**Recommendation:** Variant A next, then alternate with Variant B once security gates are green.
