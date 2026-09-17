# Cycle 26 Plan: Rate Limiting + Route Audit for Local-Auth Endpoints

## Weak spots

1. **No rate limiting on `GET /auth/local-token`.** Any loopback caller can repeatedly issue new token families, filling the SQLite store and forcing the server to generate fresh token hashes on every request.
2. **No rate limiting on `POST /auth/refresh`.** An attacker (or a buggy client) can hammer refresh attempts, causing constant rotation, audit noise, and unnecessary SQLite writes.
3. **No route-level audit events.** `LocalAuthService` logs family lifecycle events internally, but `createLocalAuthRoutes` does not record token issuance, refresh attempts, refresh reuse, or rate-limit hits to the durable audit table.
4. **No socket-address tracking on auth endpoints.** The audit table has a `socket_address` column and the middleware already extracts the IP, but the auth routes do not pass the client address into the service/store.
5. **Generic 403 for every failure.** Missing body, missing refresh token, and invalid token all return the same message, which is acceptable for security but offers no differential signal for operators.

## Competitor / best-practice research

- **OWASP ASVS 5.0 V6.1.1 / V6.3.1** require documentation and implementation of rate limiting/anti-automation controls on authentication endpoints as a Level-1 baseline. ([OWASP/ASVS V6 Authentication](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x15-V6-Authentication.md))
- **OWASP Bot Management & Anti-Automation Cheat Sheet** recommends dual independent buckets (per-account and per-IP), sliding-window algorithms, generic `429 Too Many Requests` responses, and layered edge + application controls. ([OWASP Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Bot_Management_and_Anti_Automation_Cheat_Sheet.html))
- **Hono ecosystem** has packages such as `@hono-rate-limiter/hono-rate-limiter` and `hitlimit`, but they target in-memory or Redis stores. For a single-server loopback auth surface, a custom SQLite sliding-window limiter reuses the existing durable store and keeps the dependency graph unchanged.
- **Sliding-window vs fixed-window:** Sliding window prevents burst abuse at window boundaries and is the recommended algorithm for auth endpoints.

## Three variants

| Variant | Name | Summary | Trade-off |
|---------|------|---------|-----------|
| A | In-memory per-IP rate limiter | Simple `Map<ip, attempts>` with fixed or sliding window. No dependencies, but counts reset on server restart and are not shared across processes. | Fastest, least durable. |
| B | SQLite-backed sliding-window rate limiter | Reuse the existing `bun:sqlite` token-family database to store per-IP sliding-window counters and route-level audit events. Survives restarts and stays consistent with the token store. **Implemented.** | Durable, self-contained, slightly more I/O per request. |
| C | Redis-backed distributed rate limiter | Use Redis for cross-instance rate-limit counters and audit aggregation. Best for multi-instance BrowserOS deployments. | Requires external service and network dependency. |

## Selected variant: B

### Implementation steps

1. **Extend `TokenFamilyStore` interface** (`token-family-store.ts`)
   - Add `checkRateLimit(key: string, windowMs: number, maxAttempts: number): RateLimitResult`.
   - Add `recordAuthAudit(event: AuthAuditEvent): void` for route-level events.

2. **Add SQLite tables**
   - `local_auth_rate_limits` (`key TEXT PRIMARY KEY`, `window_start INTEGER`, `attempts INTEGER`).
   - `local_auth_audit` generic events (`event_type TEXT`, `family_id TEXT`, `refresh_hash TEXT`, `socket_address TEXT`, `timestamp INTEGER`, `details TEXT`).
   - Keep the existing `local_auth_family_audit` table for family lifecycle events, or unify into `local_auth_audit`. Decision: add `local_auth_audit` as a general table; family lifecycle stays in `local_auth_family_audit` for now to minimize migration risk.

3. **Update `LocalAuthService`** (`local-auth-service.ts`)
   - Accept optional rate-limit windows in `LocalAuthServiceOptions`.
   - In `issueInitialTokens()`, check the per-IP `local-token` bucket; throw/return a rate-limit result if exceeded.
   - In `rotateRefreshToken()`, check the per-IP `refresh` bucket before attempting rotation.
   - Add audit calls for issued token, refresh attempt/success/revoked.

4. **Update `createLocalAuthRoutes`** (`local-auth.ts`)
   - Extract client IP using the same helper pattern as `requireLocalAuth`.
   - Pass the IP into service methods.
   - Map rate-limit results to `429 Too Many Requests` with `Retry-After` seconds.
   - Differentiate missing body vs missing token in responses while keeping security-generic messages.

5. **Update `server.ts` wiring**
   - Pass `dbPath` to `LocalAuthService` (already done in Cycle 25 path fix).

6. **Tests** (`auth-routes.test.ts`)
   - Add `:memory:` store tests for:
     - Repeated `/auth/local-token` calls from the same IP are blocked after the limit.
     - Repeated `/auth/refresh` calls with the same old refresh token are blocked by either reuse detection or rate limiting.
     - Route audit events are recorded in SQLite.
     - `429` response includes a `Retry-After` header.

7. **Verification**
   - `bun run typecheck`
   - `bun test ./tests/api/routes/auth-routes.test.ts`
   - `cargo run --bin clade-build`
   - `cargo run --bin clade-audit`
   - `cargo run --bin clade-seal`
   - `cargo run --bin clade-e2e`
   - Relaunch `trios.app` and confirm `/health` + no new SQLite path regressions.

## TDD criteria

- `GET /auth/local-token` allows no more than `LOCAL_TOKEN_LIMIT` requests per `LOCAL_TOKEN_WINDOW_MS` from a single IP.
- `POST /auth/refresh` allows no more than `REFRESH_LIMIT` requests per `REFRESH_WINDOW_MS` from a single IP.
- Rate-limit violations return HTTP `429` with a `Retry-After` header in whole seconds.
- Rate-limit counters persist across service restarts when using the file-backed store.
- Route-level audit events for token issuance and refresh are stored in SQLite.
- Existing tests continue to pass; no new clade-audit hard-gate findings.
