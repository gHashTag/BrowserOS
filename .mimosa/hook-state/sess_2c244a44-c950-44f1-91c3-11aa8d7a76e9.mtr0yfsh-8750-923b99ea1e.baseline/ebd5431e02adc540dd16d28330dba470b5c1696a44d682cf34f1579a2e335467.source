# Cycle 26 Report: SQLite-backed Rate Limiting + Route Audit for Local Auth

**Date:** 2026-07-25  
**Branch:** `feat/zai-provider`  
**Selected variant:** B — SQLite-backed sliding-window rate limiter + durable route audit

---

## 1. Weak spots addressed

| # | Weak spot | How it was closed |
|---|---|---|
| 1 | No rate limiting on `GET /auth/local-token` | Added per-IP sliding-window bucket keyed by `local-token:<ip>`. |
| 2 | No rate limiting on `POST /auth/refresh` | Added per-IP sliding-window bucket keyed by `refresh:<ip>`, checked before rotation. |
| 3 | No route-level audit events | Added `local_auth_audit` SQLite table and `recordAuthAudit` for token issuance, refresh attempts, success, reuse, not-found, and rate-limit blocks. |
| 4 | No socket-address tracking on auth endpoints | Auth routes now pass the loopback socket address into service calls and audit records. |
| 5 | Generic 403 for every failure | `POST /auth/refresh` now differentiates malformed JSON (400) from missing refresh token (400) with security-neutral messages. |

---

## 2. Competitor / best-practice research

- **OWASP ASVS 5.0 V6.1.1 / V6.3.1** mandate rate limiting/anti-automation on authentication endpoints as a Level-1 baseline.
- **OWASP Bot Management Cheat Sheet** recommends sliding-window buckets, per-IP isolation, generic `429` responses, and layered controls.
- **Hono ecosystem** offers `@hono-rate-limiter/hono-rate-limiter` and `hitlimit`, but they target in-memory or Redis stores. Reusing the existing `bun:sqlite` token-family database keeps the dependency graph unchanged and the counters durable.

---

## 3. Three variants considered

| Variant | Approach | Trade-off |
|---|---|---|
| A | In-memory `Map<ip, attempts>` | Fastest, but counts reset on restart and are not shared across processes. |
| **B** | **SQLite sliding-window rate limiter + route audit** | **Durable, self-contained, consistent with token store. Implemented.** |
| C | Redis-backed distributed limiter | Best for multi-instance deployments, but adds external dependency. |

---

## 4. Implementation summary

### 4.1 `TokenFamilyStore` interface (`token-family-store.ts`)

- Added `AuthAuditEvent`, `RateLimitResult`, `RateLimitError` types.
- Extended `TokenFamilyStore` with:
  - `checkRateLimit(key, windowMs, maxAttempts): RateLimitResult`
  - `recordAuthAudit(event): void`

### 4.2 SQLite schema (`SqliteTokenFamilyStore`)

- Added `local_auth_rate_limits` table (`key TEXT PRIMARY KEY`, `window_start INTEGER`, `attempts INTEGER`).
- Added `local_auth_audit` table (`event_type`, `family_id`, `refresh_hash`, `socket_address`, `timestamp`, `details`).

### 4.3 `LocalAuthService` (`local-auth-service.ts`)

- Added `LocalAuthRateLimitConfig` and merged defaults:
  - `localTokenWindowMs = 60_000`, `localTokenMaxAttempts = 100`
  - `refreshWindowMs = 60_000`, `refreshMaxAttempts = 100`
- `issueInitialTokens(socketAddress?)` now checks `local-token:<ip>` bucket and records `local-token-issued`.
- `rotateRefreshToken(refreshToken, socketAddress?)` checks `refresh:<ip>` bucket before rotation and records `refresh-attempt`, `refresh-success`, `refresh-revoked`, `refresh-not-found`.
- Re-exports `RateLimitError`.

### 4.4 Routes (`local-auth.ts`)

- Added `getSocketAddress(c)` helper using `c.env.server.requestIP()`.
- Added `rateLimitResponse(c, retryAfterMs)` returning `429` with `Retry-After` in whole seconds.
- `GET /auth/local-token` catches `RateLimitError` and returns 429.
- `POST /auth/refresh` catches malformed body, missing token, and `RateLimitError` with distinct 400/429 responses.

### 4.5 Tests

- `auth-routes.test.ts`: fixed 9 occurrences of `new SqliteTokenFamilyStore(':memory:')` to `new SqliteTokenFamilyStore({ dbPath: ':memory:' })` and added 4 new tests:
  - local-token rate limit
  - refresh rate limit
  - route audit events persisted in SQLite
  - per-IP bucket independence
- `agents.test.ts`: aligned with the newly required `X-TriOS-Local-Auth` header on `POST /agents` and made the authorization test use an in-memory `LocalAuthService` with issued tokens.

---

## 5. Verification results

| Gate | Result | Notes |
|---|---|---|
| `bun run typecheck` (server) | ✅ pass | No TS errors. |
| `bun test ./tests/api/routes/auth-routes.test.ts` | ✅ 40 pass, 0 fail | Rate-limit, audit, and IP-isolation tests pass. |
| `bun run test:api` | ✅ 245 pass, 0 fail | All API route tests pass. |
| Full `bun test` | ✅ 1119 pass, 1 skip, 3 fail | Remaining failures are unrelated pre-existing/flaky tests: `acl-scorer.test.ts` semantic-payment fixture, `navigation.test.ts` `show_page`/`move_page` CDP behaviors. |
| `cargo run --bin clade-build` | ✅ pass | `trios_app` and `trios.app` rebuilt. |
| `cargo run --bin clade-audit` | ✅ pass | 8/8 hard gates at zero findings. |
| `cargo run --bin clade-seal` | ✅ valid | Seal artifact saved. |
| `cargo run --bin clade-e2e` | ✅ report generated | `/health` OK; prod app PID active. |
| `curl http://127.0.0.1:9105/health` | ✅ `{"status":"ok","cdpConnected":true}` | App relaunched after build. |

---

## 6. Remaining unrelated test failures

The full server suite still shows 3 failures outside the local-auth surface:

1. `fixture: semantic-payment (semantic match) > blocks "Proceed to Checkout"` — ACL fixture returns `blocked=false` instead of `true`.
2. `navigation tools > show_page errors on an already-visible page` — `show_page` no longer returns an error for a visible page.
3. `navigation tools > move_page moves a tab to a different window` — CDP rejects moving a hidden tab.

These are not caused by the Cycle 26 changes and should be tracked separately.

---

## 7. Conclusion

Cycle 26 closes the local-auth rate-limit and route-audit weak spots by implementing a durable, SQLite-backed sliding-window limiter inside the existing `TokenFamilyStore`. No new dependencies were added, all local-auth tests pass, and the trios clade gates remain clean. The menu-bar app was relaunched after `clade-build` and reports healthy.

**Phase complete: VERIFY**  
→ Phase 9: LEARN (save experience episode and update `.trinity/experience.md`)
