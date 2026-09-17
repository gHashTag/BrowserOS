# Cycle 19 Report — Fix Local-Auth Test Regressions and Extend Gate to High-Impact Routes

**Date:** 2026-07-25  
**Ring:** `packages/browseros-agent/apps/server` + `trios/BR-OUTPUT`  
**Agents:** claude  
**Road:** B (balanced — regression fix + security extension + tests + Swift helper + experience save)

## Weak spot addressed

Cycle 18 added a `requireLocalAuth` gate to `POST /agents` and `POST /skills`. The existing server tests were not updated to supply the new `X-TriOS-Local-Auth` header, so they began failing with `503 Local authorization not configured`:

- `apps/server/tests/api/routes/agents.test.ts`
  - `creates and lists harness agents` → 503 instead of 200
  - `rejects overlong agent names` → 503 instead of 400

At the same time, several other high-impact routes remained protected only by origin trust, leaving the same AgentForger/BioShocking attack surface open for:

- `POST /a2a/register` and `POST /a2a/message`
- `PUT /soul`
- `POST /shutdown`
- `POST /chat`

## What was implemented

1. **Fixed test regressions in `agents.test.ts`**
   - Added a default `localAuth` validator that always returns `true` for existing tests.
   - Added explicit tests for the local-auth gate: missing token → 403, invalid token → 403, valid token → 200.

2. **Extended local-auth gate to additional high-impact routes**
   - `packages/browseros-agent/apps/server/src/api/routes/a2a.ts`
     - Gated `POST /a2a/register` and `POST /a2a/message`.
   - `packages/browseros-agent/apps/server/src/api/routes/soul.ts`
     - Gated `PUT /soul`.
   - `packages/browseros-agent/apps/server/src/api/routes/shutdown.ts`
     - Gated `POST /shutdown`.
   - `packages/browseros-agent/apps/server/src/api/routes/chat.ts`
     - Gated `POST /chat`.

3. **Wired services in `server.ts`**
   - Passed `localAuth: localAuthService` into `createA2aRoutes`, `createSoulRoutes`, `createShutdownRoute`, and `createChatRoutes`.

4. **Added Swift local-auth helper in `TriosMCPClient.swift`**
   - `fetchLocalAuthToken()` — GET `/auth/local-token` and cache the token.
   - `requestWithLocalAuth(url:method:body:contentType:)` — constructs a request with `X-TriOS-Local-Auth` when a token is known.
   - This helper is ready for future TriOS code that calls the gated routes.

## Files changed

- `packages/browseros-agent/apps/server/src/api/routes/a2a.ts`
- `packages/browseros-agent/apps/server/src/api/routes/soul.ts`
- `packages/browseros-agent/apps/server/src/api/routes/shutdown.ts`
- `packages/browseros-agent/apps/server/src/api/routes/chat.ts`
- `packages/browseros-agent/apps/server/src/api/server.ts`
- `packages/browseros-agent/apps/server/tests/api/routes/agents.test.ts`
- `packages/browseros-agent/apps/server/tests/api/routes/auth-routes.test.ts`
- `trios/BR-OUTPUT/TriosMCPClient.swift`

## Verification

| Gate | Result |
|------|--------|
| `bunx tsc -p apps/server/tsconfig.json --noEmit` | ✅ clean |
| `bun test apps/server/tests/api/routes/agents.test.ts` | ✅ 17 pass, 0 fail |
| `bun test apps/server/tests/api/routes/auth-routes.test.ts` | ✅ 29 pass, 0 fail |
| `bun test apps/server/tests/api/routes/` | ✅ 69 pass, 0 fail |
| `cargo run --bin clade-build` | ✅ PASS |
| `cargo run --bin clade-e2e` | ✅ PASS |
| `cargo run --bin clade-seal` | ✅ SEAL VALID |
| `open trios.app` | ✅ relaunched |

## Variant options

### Variant A — extend local-auth gate to high-impact routes + fix tests + Swift helper (selected and landed)
Apply the same second-factor token to all high-impact creation/mutation routes, fix the resulting test regressions, and add a reusable Swift helper. This maximizes defense-in-depth with a small, mechanical change set.

### Variant B — route-scoped capability tokens
Issue per-route or per-action capability tokens (e.g., `agent:create`, `skill:create`, `shutdown`, `soul:write`) instead of one global local token. The token endpoint would accept a requested scope and return a signed capability. Stronger attenuation, but adds complexity and key management.

### Variant C — pending-confirmation queue with UI
High-impact actions become `pending` state items; TriOS UI shows an approval queue; the user must confirm before the server commits. Strongest human-in-the-loop boundary, but requires durable queue state, new UI, and timeout handling.

## Law compliance

- **L1 TRACEABILITY** — Report and plan capture rationale.
- **L2 GENERATION** — Server TS files and Swift helper are hand-edited; no canon generator involved.
- **L3 PURITY** — ASCII-only identifiers.
- **L4 TESTABILITY** — build + e2e + seal + server tests all pass.
- **L5 IDENTITY** — No UI constants changed.
- **L6 CEILING** — Uses `ProjectPaths.mcpBaseURL` in the Swift helper.
- **L7 UNITY** — No new `.sh` scripts.

## Next options

1. **Variant B** — replace the single global token with route-scoped capability tokens for finer attenuation.
2. **Variant C** — build a pending-confirmation queue and UI for the most sensitive actions.
3. **Teach TriOS to call gated routes** — add actual Swift flows that create agents/skills and use `fetchLocalAuthToken()` + `requestWithLocalAuth()`.
