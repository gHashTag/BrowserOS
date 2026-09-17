# Cycle 20 Weak-Spot Report — Local-Auth Client Wiring

## Executive Summary

Cycle 20 focused on the trust boundary between the trios macOS client and the BrowserOS local server. Cycles 18–19 moved high-impact server routes behind an in-memory `X-TriOS-Local-Auth` token, but the Swift client still sent chat SSE and A2A requests without the header. This cycle closed the loop: a shared `LocalAuthProvider` now fetches and caches the token once per process, and both `SSETransport` and `A2ARegistryClient` attach it automatically.

## Weak Spot

- **Symptom:** `POST /chat`, `POST /a2a/register`, `POST /a2a/message`, `PUT /soul`, and `POST /shutdown` started returning 503 after Cycle 19 because the Swift client omitted `X-TriOS-Local-Auth`.
- **Impact:** Queen chat, A2A registration, task assignment, and remote shutdown were unreachable from trios.
- **Root Cause:** Two independent request builders (`SSETransport.sendMessage` and `A2ARegistryClient`) constructed their own `URLRequest`s; neither had access to the token.

## Competitor Patterns Reviewed

| System | Auth Pattern | Relevance to trios |
|--------|--------------|--------------------|
| Google ADK (Cloud Run) | `Authorization: Bearer <google-id-token>`; identity token bound to the deployed service identity. | Confirms that local-loopback agents should still present a proof-of-identity token, not rely on IP alone. |
| AWS A2A Gateway | OAuth 2.0 client-credentials or Cognito JWT with `scope` claims per action. | Suggests future route-scoped capability tokens rather than one global secret. |
| A2A Multi-tenancy | `tenant` routing via URL path, header, or body. | Less directly relevant now, but important once trios hosts multiple Queen instances. |

Key takeaway: origin-trust is a necessary but insufficient guard for high-impact local routes. A server-issued, app-bound token is the minimal next step; scoped action tokens are the next maturity level.

## Variant A — Implemented

**Approach:** Shared in-memory provider with process-lifetime cache.

- `LocalAuthProvider` actor conforms to `LocalAuthProviding` and exposes `validToken(forcingRefresh:)`.
- It calls `GET /auth/local-token` once and caches the 256-bit token in an actor-isolated property.
- `CompositionRoot` in `main.swift` creates one provider and injects it into both `SSETransport` and `A2ARegistryClient`.
- `SSETransport.sendMessage(body:)` attaches `X-TriOS-Local-Auth` before POSTing.
- `A2ARegistryClient` uses `makeAuthorizedRequest`, `makeAuthorizedGetRequest`, and `makeAuthorizedStreamRequest` helpers that attach the header uniformly.

**Why this variant won:**
- Smallest blast radius — no server changes.
- Fixes both chat and A2A in one place.
- Keeps the token out of Keychain/defaults; it is ephemeral and bound to the running BrowserOS server.
- Matches the existing `NetworkRetrier` pattern (fail-soft, no UI blocking if token fetch fails).

## Verification

- `./build.sh` PASS
- `cargo run --bin clade-build` PASS
- `cargo run --bin clade-e2e` PASS (after relaunching `trios.app` to preserve the menu-bar logo invariant)
- `cargo run --bin clade-audit` — hard gates 0 findings
- `cargo run --bin clade-seal` — SEAL VALID
- BrowserOS targeted auth/integration tests PASS
- Full `bun test` shows 4 pre-existing failures unrelated to this change (semantic-payment fixture, navigation CDP errors, ContainerCli)

## Three Future Variants

### Variant B — Keychain-Backed Token Persistence + Proactive Refresh

Move token storage from process memory to the macOS Keychain (`KeychainSecrets` ring). On app launch, trios reads the cached token; if missing or if a 401/403 is returned, it refreshes from `/auth/local-token`. This removes the first-request latency and survives app restarts, but adds Keychain access control and entitlements complexity.

**When to choose:** When users expect trios to reconnect instantly after restart without re-acquiring a fresh token from BrowserOS.

### Variant C — Route-Scoped Capability Tokens

Instead of one global local-auth token, BrowserOS issues short-lived capability tokens bound to specific actions (`chat:post`, `a2a:register`, `a2a:message`, `soul:put`, `shutdown`). The client requests a capability token from a new `POST /auth/capability` route, presents it on the corresponding route, and the server validates both signature and scope. This follows the AWS A2A JWT-scope pattern and limits blast radius if one token is leaked.

**When to choose:** When the number of high-impact routes grows or when third-party agents need limited, auditable permissions.

### Variant D — Human-in-the-Loop Confirmation for High-Impact A2A Mutations

Keep the global or capability token, but add a UI confirmation dialog in trios before the client sends `POST /a2a/register`, `POST /a2a/message` with destructive payloads, or `POST /shutdown`. The confirmation is signed with the local token and the server verifies a `X-TriOS-Confirmed-By: user` header. This counters AgentForger/BioShocking even if a malicious local page somehow obtained the token.

**When to choose:** When safety budget or human oversight is the dominant requirement and a small latency increase is acceptable.

## Recommended Next Step

Implement Variant B (Keychain-backed persistence) as Cycle 21 unless the current ephemeral-token behavior causes user-visible reconnect latency. Variant C should follow once additional high-impact routes are added; Variant D should be reserved for destructive actions.

## Files Changed

- `trios/rings/SR-01/LocalAuthProvider.swift` (new)
- `trios/rings/SR-01/SSETransport.swift`
- `trios/rings/SR-02/A2ARegistryClient.swift`
- `trios/main.swift`
- `trios/tests/TriOSKitTests/SSETransportTests.swift`
- `packages/browseros-agent/apps/server/tests/server.integration.test.ts`

## Episode

- Markdown: `trios/.trinity/experience.md`
- JSON: `trios/.trinity/experience/2026-07-25_17-57-35_LOCAL-AUTH-CLIENT-20.json`
- Akashic event: `trios/.trinity/events/akashic-log.jsonl`

---

Phase complete: Phase 6 — Learn
