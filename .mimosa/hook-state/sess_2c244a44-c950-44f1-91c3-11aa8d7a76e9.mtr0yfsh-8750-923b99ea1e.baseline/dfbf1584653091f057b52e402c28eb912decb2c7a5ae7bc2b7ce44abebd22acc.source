# Cycle 19 Plan — Fix Local-Auth Test Regressions and Extend Gate to High-Impact Routes

## Weak spot

Cycle 18 added a `requireLocalAuth` gate to `POST /agents` and `POST /skills`. The server-level integration tests were not updated to pass the new `X-TriOS-Local-Auth` header, so existing tests now fail with `503 Local authorization not configured`:

- `apps/server/tests/api/routes/agents.test.ts`
  - `creates and lists harness agents` → 503 instead of 200
  - `rejects overlong agent names` → 503 instead of 400

This is a regression: the security control works in production but breaks the test contract and any legitimate server consumer that was not yet taught how to fetch the token. More importantly, several other high-impact routes remain protected only by origin trust:

- `POST /a2a/agents` (A2A agent registration)
- `POST /a2a/message` (broadcast arbitrary A2A messages)
- `PUT /soul` (overwrite agent soul / system prompt)
- `POST /shutdown` (server shutdown)
- `POST /chat` (start a chat / tool invocation session)

These are exactly the routes an AgentForger-style attacker would target after bypassing or coercing origin trust.

## Competitor context

- **Google ADK A2A Human-in-the-Loop sample** uses a remote approval agent that returns `status: "pending"` plus a ticket ID; the workflow pauses until a human approves or rejects. This maps cleanly onto local agent/skill creation approval.
- **A2A Protocol v1.0 (March 2026)** formalizes `input-required` as a first-class Task pause state for approvals or missing information.
- **DVARA A2A Governance** ships a durable approval queue for cross-agent hops: pending tab, audit log, sidebar badge, timeout-default-deny, tamper-evident `A2A_APPROVAL_*` events.
- **Agent Authorization Profile (AAP, Feb 2026 IETF draft)** defines `agent`, `task`, `capabilities`, `delegation`, `oversight`, and `audit` JWT claims; strongly recommends server-side enforcement, short-lived tokens, and proof-of-possession.
- **Agent Identity Protocol (AIP, Mar 2026)** proposes a two-layer model: Layer 1 registers each agent with a unique Agent ID and key pair; Layer 2 interposes an enforcement proxy for identity verification and policy decisions.
- **AgentROA (Apr 2026)** uses signed Route Origin Authorization envelopes and Agent Route Attestations for monotonic scope-narrowing across delegation chains.
- **Microsoft agent-framework #3645** showed that calling `RequireAuthorization()` on a route group can silently fail if the builder convention is wrong — auth middleware must be applied directly to the relevant HTTP method handlers, not assumed via route-group composition.

## Goal for this cycle

1. Fix the test regressions introduced by Cycle 18 so that existing agent/skill creation tests pass by supplying the local-auth token in tests.
2. Extend the local-authorization gate to the other high-impact routes that are still origin-trust-only.
3. Add a reusable Swift-side token fetch helper so future TriOS code can call these gated routes without each developer reinventing the plumbing.

This follows the defense-in-depth pattern (MCP-Guard, AAP, AIP) while keeping the implementation minimal enough to land in a single cycle.

## Decomposition

### 1. Server — add `localAuth` to route dependencies that need it
**Files:**
- `packages/browseros-agent/apps/server/src/api/routes/a2a.ts`
  - Add optional `localAuth` to `A2aRouteDeps`.
  - Gate `POST /a2a/agents` and `POST /a2a/message` with `requireLocalAuth`.
- `packages/browseros-agent/apps/server/src/api/routes/soul.ts`
  - Add optional `localAuth` to route deps.
  - Gate `PUT /soul` with `requireLocalAuth`.
- `packages/browseros-agent/apps/server/src/api/routes/shutdown.ts`
  - Add optional `localAuth` to route deps.
  - Gate `POST /shutdown` with `requireLocalAuth`.
- `packages/browseros-agent/apps/server/src/api/routes/chat.ts`
  - Add optional `localAuth` to route deps.
  - Gate `POST /chat` with `requireLocalAuth`.

### 2. Server — wire services in `server.ts`
**File:** `packages/browseros-agent/apps/server/src/api/server.ts`
- Pass `localAuth: localAuthService` into:
  - `createA2aRoutes`
  - `createSoulRoutes`
  - `createShutdownRoutes`
  - `createChatRoutes`

### 3. Server — fix existing tests
**File:** `packages/browseros-agent/apps/server/tests/api/routes/agents.test.ts`
- Update `createMountedRoutes` to accept an optional `localAuth` validator and default to a fake one that always returns `true` (or to the real `LocalAuthService` when testing the gate itself).
- Add explicit tests for the local-auth gate:
  - `POST /agents` without token → 503 (or 403 when configured)
  - `POST /agents` with valid token → 200
  - `POST /agents` with invalid token → 403

### 4. Server — add tests for newly gated routes
**File:** `packages/browseros-agent/apps/server/tests/api/routes/auth-routes.test.ts`
- Add parameterized cases for `POST /a2a/agents`, `POST /a2a/message`, `PUT /soul`, `POST /shutdown`, `POST /chat`:
  - Without `X-TriOS-Local-Auth` → 403/503
  - With valid token → allowed

### 5. Swift — add local-auth token helper
**File:** `trios/BR-OUTPUT/TriosMCPClient.swift`
- Add `localAuthToken: String?` property.
- Add `fetchLocalAuthToken()` that `GET /auth/local-token` from `ProjectPaths.mcpBaseURL`.
- Add `requestWithLocalAuth(url:method:body:)` helper that injects `X-TriOS-Local-Auth` when token is known.
- Cache token for the session; retry once on 403 to re-fetch a rotated token.

### 6. Swift — update existing callers if any
- No current TriOS code calls the gated routes, so the helper is added for future use only.

### 7. Verification
- `bunx tsc -p apps/server/tsconfig.json --noEmit`
- `bun test apps/server/tests/api/routes/agents.test.ts`
- `bun test apps/server/tests/api/routes/auth-routes.test.ts`
- `cargo run --bin clade-build`
- `cargo run --bin clade-e2e`
- `cargo run --bin clade-seal`
- `open trios.app`

## Road

Road B (balanced): regression fix + security extension + tests + Swift helper + experience save.

## Variant options

### Variant A — extend local-auth gate to high-impact routes + fix tests (selected)
Fix regressions and apply the same second-factor token to `POST /a2a/agents`, `POST /a2a/message`, `PUT /soul`, `POST /shutdown`, and `POST /chat`. Add Swift token helper. This maximizes defense-in-depth with a small, mechanical change set.

### Variant B — route-scoped capability tokens
Instead of one global local token, issue per-route or per-action capability tokens (e.g., `agent:create`, `skill:create`, `shutdown`, `soul:write`). The token endpoint would accept a requested scope and return a JWT-like signed capability. Stronger attenuation, but adds complexity and key management.

### Variant C — pending-confirmation queue with UI
High-impact actions become `pending` state items; TriOS UI shows an approval queue; user must confirm before the server commits the action. Strongest human-in-the-loop boundary, but requires durable queue state, UI, and timeout handling.

## Law compliance

- **L1 TRACEABILITY** — plan and report capture rationale.
- **L2 GENERATION** — server TS files and Swift helper are hand-edited; no canon generator involved.
- **L3 PURITY** — ASCII-only identifiers.
- **L4 TESTABILITY** — build + e2e + seal + server tests.
- **L5 IDENTITY** — no UI constants changed.
- **L6 CEILING** — uses `ProjectPaths.mcpBaseURL` in Swift helper.
- **L7 UNITY** — no new `.sh` scripts.
