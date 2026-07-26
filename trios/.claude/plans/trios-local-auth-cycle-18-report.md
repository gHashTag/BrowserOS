# Cycle 18 Report — Local Authorization Gate for Agent/Skill Creation

**Date:** 2026-07-25  
**Ring:** `packages/browseros-agent/apps/server` (BrowserOS agent server)  
**Agents:** claude  
**Road:** B (balanced — security fix + tests + experience save)

## Weak spot addressed

BrowserOS server routes `POST /agents` and `POST /skills` were protected only by `requireTrustedAppOrigin()`. A malicious local webpage or compromised browser extension that could reach the loopback port could create persistent agents or skills without an additional boundary. In the AgentForger/BioShocking threat model, this is a classic "agent trust failure" that turns a local app into a persistent insider threat.

## Competitor context applied

- **Aivyx** uses an explicit operator autonomy dial and a capability-based security model; the agent cannot widen its own reach.
- **MCP-Guard (ACL 2026)** recommends defense-in-depth: guardrails + protocol security + runtime policy + human-in-the-loop for high-risk actions.
- **AIP (Agent Identity Protocol, Mar 2026)** proposes invocation-bound capability tokens to bind identity and attenuated authorization across MCP/A2A.
- **AgentForger** showed that a single malicious link can spawn a persistent agent inside an authorized workspace because there was no local confirmation boundary.

The chosen fix follows the AIP/MCP-Guard defense-in-depth pattern: add a second, in-memory, origin-bound local-authorization token.

## What was implemented

1. **Local auth service**  
   `packages/browseros-agent/apps/server/src/api/services/local-auth-service.ts` (new)  
   - Generates a 256-bit token at construction (`crypto.randomBytes(32).toString('base64url')`).  
   - Exposes `getToken()` and `validate(headerValue)`.  
   - Uses `crypto.timingSafeEqual` for constant-time comparison.  
   - Token is in-memory only; it rotates on every server restart.

2. **Local auth middleware**  
   `packages/browseros-agent/apps/server/src/api/utils/require-local-auth.ts` (new)  
   - Reads `X-TriOS-Local-Auth` header.  
   - Returns `403 { error: 'Local authorization required' }` when missing or invalid.  
   - Returns `503` if the validator is not configured.

3. **Token endpoint**  
   `packages/browseros-agent/apps/server/src/api/routes/local-auth.ts` (new)  
   - `GET /auth/local-token` returns `{ token }` only to trusted origins (mounted behind `requireTrustedAppOrigin`).

4. **Gated creation routes**  
   - `packages/browseros-agent/apps/server/src/api/routes/agents.ts` — `POST /agents` now uses `requireLocalAuth`.  
   - `packages/browseros-agent/apps/server/src/api/routes/skills.ts` — `POST /skills` now uses `requireLocalAuth`.  
   - Both routes accept an optional `localAuth` validator in their route dependencies.

5. **Server wiring**  
   `packages/browseros-agent/apps/server/src/api/server.ts`  
   - Instantiates `LocalAuthService` once.  
   - Mounts `/auth` router behind origin trust.  
   - Injects the service into `createAgentRoutes` and `createSkillsRoutes`.

6. **Tests**  
   `packages/browseros-agent/apps/server/tests/api/routes/auth-routes.test.ts`  
   - GET `/auth/local-token` from loopback returns the in-memory token.  
   - GET `/auth/local-token` from remote origin returns 403.  
   - POST to a local-auth-protected route without token returns 403.  
   - POST with wrong token returns 403.  
   - POST with valid token is allowed.  
   - All existing origin-trust tests continue to pass.

## Deliberate scope cut

The plan included a Swift client helper in `TriosMCPClient.swift` to fetch the token and attach it to future `createAgent`/`createSkill` calls. Current TriOS only **lists** agents via `A2ARegistryClient` (`/a2a/agents`) and does not call `POST /agents` or `POST /skills`. Adding unused Swift client state would be speculative and could trigger dead-code concerns, so the server-side gate and tests were landed now and the Swift helper is listed as a follow-up in Variant B.

## Files changed

- `packages/browseros-agent/apps/server/src/api/services/local-auth-service.ts` (new)
- `packages/browseros-agent/apps/server/src/api/utils/require-local-auth.ts` (new)
- `packages/browseros-agent/apps/server/src/api/routes/local-auth.ts` (new)
- `packages/browseros-agent/apps/server/src/api/routes/agents.ts`
- `packages/browseros-agent/apps/server/src/api/routes/skills.ts`
- `packages/browseros-agent/apps/server/src/api/server.ts`
- `packages/browseros-agent/apps/server/tests/api/routes/auth-routes.test.ts`

## Verification

| Gate | Result |
|------|--------|
| `bunx tsc -p apps/server/tsconfig.json --noEmit` | ✅ clean |
| `bun test apps/server/tests/api/routes/auth-routes.test.ts` | ✅ 29 pass, 0 fail |
| `cargo run --bin clade-build` | ✅ PASS |
| `cargo run --bin clade-e2e` | ✅ PASS |
| `cargo run --bin clade-seal` | ✅ SEAL VALID |
| `open trios.app` | ✅ relaunched after build |

## Variant options

### Variant A — in-memory token gate (selected and landed)
Server issues a random in-memory token; `POST /agents` and `POST /skills` require it. Fast, no persistence, low blast radius, and raises the attack bar from "compromise the browser" to "compromise the browser + read the current in-memory token".

### Variant B — Keychain-backed token + Swift client integration
Store the token in the macOS Keychain, expose it only to the signed TriOS app, and add a `TriosMCPClient.localAuthToken` fetch/inject helper. Rotate the token on app relaunch. Stronger binding to the local app identity but requires Keychain entitlements and Swift-side plumbing.

### Variant C — pending-confirmation queue with UI dialog
Creation requests become "pending" state; TriOS UI surfaces a confirmation dialog and the user must approve before the agent/skill is persisted. Strongest human-in-the-loop boundary, but requires a new UI, a pending-approval state machine, and conflict-resolution UX.

## Law compliance

- **L1 TRACEABILITY** — Report and plan capture rationale; no external issue required.
- **L2 GENERATION** — Server TS files are hand-edited TypeScript (no canon generator). Swift helper was intentionally deferred because no current create flow exists.
- **L3 PURITY** — ASCII-only identifiers.
- **L4 TESTABILITY** — build + e2e + seal + server tests all pass.
- **L5 IDENTITY** — No UI changes.
- **L6 CEILING** — No new UI constants; routes follow existing `ProjectPaths.mcpBaseURL` pattern on the Swift side if extended later.
- **L7 UNITY** — No new `.sh` scripts.

## Next options

1. Implement Variant B: Keychain-bound Swift client token fetch/injection so future TriOS create-agent/create-skill calls pass the new gate automatically.
2. Extend the gate to other high-impact routes (`PUT /soul`, `POST /shutdown`, `POST /a2a/message`) behind the same local-auth header.
3. Implement Variant C: a pending-confirmation queue surfaced in the TriOS Queen tab for agent/skill creation approval.
