# Cycle 18 Plan — Local Authorization Gate for Agent/Skill Creation

## Weak spot
BrowserOS server routes `POST /agents` and `POST /skills` are protected only by `requireTrustedAppOrigin()`. A malicious local webpage or compromised browser extension that can reach the loopback port can create persistent agents or skills without a second factor. In the AgentForger/BioShocking threat model, this is exactly the kind of "agent trust failure" that turns a local app into a persistent insider threat.

## Competitor context
- **Aivyx** uses an explicit **operator autonomy dial** (manual → assisted → supervised → autonomous → unleashed) and a capability-based security model. The agent cannot widen its own reach.
- **MCP-Guard (ACL 2026)** recommends defense-in-depth: guardrails + protocol security + runtime policy + human-in-the-loop for high-risk actions.
- **AIP (Agent Identity Protocol, Mar 2026)** proposes invocation-bound capability tokens to bind identity and attenuated authorization across MCP/A2A.
- **AgentForger** showed that a single malicious link can spawn a persistent agent inside an authorized workspace because there was no local confirmation boundary.

## Goal
Add a local-app-only authorization token to agent/skill creation so that a request must both (1) come from a trusted origin and (2) present the current server-issued local token. This raises the bar for AgentForger-style creation attacks from "compromise the browser" to "compromise the browser + read the current in-memory token".

## Decomposition

### 1. Server — local auth service
**File:** `packages/browseros-agent/apps/server/src/api/services/local-auth-service.ts` (new)
- Generate a 256-bit token at service construction (`crypto.randomBytes(32).toString('base64')`).
- Expose `getToken()` and `validateToken(headerValue: string | undefined): boolean`.
- Token is in-memory only; rotates on server restart.

### 2. Server — token endpoint
**File:** `packages/browseros-agent/apps/server/src/api/routes/local-auth.ts` (new)
- `GET /auth/local-token` returns `{ token }` to trusted origins.
- Mount under `/auth` in `server.ts` with `requireTrustedAppOrigin`.

### 3. Server — gate create routes
**Files:**
- `packages/browseros-agent/apps/server/src/api/routes/agents.ts`
- `packages/browseros-agent/apps/server/src/api/routes/skills.ts`
- Accept an optional `localAuthService` in route deps.
- Before `service.createAgent(...)` / `createSkill(...)`, require `X-TriOS-Local-Auth` header and validate it.
- Return 403 `{ error: 'Local authorization required' }` when missing/invalid.

### 4. Server — wiring
**File:** `packages/browseros-agent/apps/server/src/api/server.ts`
- Instantiate `LocalAuthService` once.
- Mount `/auth/local-token`.
- Pass the service into `createAgentRoutes` and `createSkillsRoutes`.

### 5. Swift — token fetch + header injection
**File:** `trios/BR-OUTPUT/TriosMCPClient.swift`
- Add `localAuthToken: String?` property.
- Add `fetchLocalAuthToken()` using `ProjectPaths.mcpBaseURL` + `/auth/local-token`.
- Add helper `requestWithLocalAuth(url:)` that sets `X-TriOS-Local-Auth` when token is known.

### 6. Swift — use token when creating agents/skills (if TriOS ever does)
**File:** `trios/BR-OUTPUT/TriosMCPClient.swift`
- Any future `createAgent`/`createSkill` methods include the header.
- For this cycle, the Swift app only lists agents; the gate is enforced server-side.

### 7. Tests
**File:** `packages/browseros-agent/apps/server/tests/api/routes/auth-routes.test.ts`
- Add `LocalAuthService` mock.
- Assert `POST /agents` returns 403 without token and 200/201 with token.
- Assert `POST /skills` returns 403 without token and 201 with token.
- Assert `GET /auth/local-token` returns token from loopback and 403 remotely.

## Road
Road B (balanced): security fix + tests + experience save.

## Variant options
1. **Variant A — in-memory token gate (selected)**
   Server issues an in-memory token; create routes require it. Fast, no persistence, low blast radius.
2. **Variant B — Keychain-backed token + rotation**
   Store token in macOS Keychain, rotate periodically, bind token to app code signature. Stronger but requires Keychain entitlements and more Swift work.
3. **Variant C — pending-confirmation queue with UI dialog**
   Create requests become "pending"; TriOS UI shows confirmation dialog; user must approve. Most user-visible and strongest HITL, but requires new UI and state machine.

## Law compliance
- L1 TRACEABILITY: plan and report capture rationale; no external issue required.
- L2 GENERATION: server TS files are hand-edited (no canon generator); Swift edits to `TriosMCPClient.swift` under existing BR-OUTPUT waiver.
- L3 PURITY: ASCII-only identifiers.
- L4 TESTABILITY: build + e2e + seal + server tests.
- L5 IDENTITY: no UI changes.
- L6 CEILING: uses `ProjectPaths.mcpBaseURL`.
- L7 UNITY: no new `.sh` scripts.
