# Cycle 27 Report — Admin Token-Family Lifecycle

## Summary
Completed the admin-facing token-family lifecycle for BrowserOS local auth: operators can now list active/rotated/revoked families, revoke a family by ID, and run retention cleanup that deletes old revoked families, audit rows, and rate-limit buckets. All changes are server-side and self-contained within the existing SQLite-backed `TokenFamilyStore`.

## Scope
- **Ring:** SR-01 / BrowserOS server
- **Agent:** claude
- **Road:** B (fix + test + experience save)
- **Date:** 2026-07-25

## What was implemented

### 1. Store-level list + cleanup (`token-family-store.ts`)
- Added `ListFamiliesOptions`, `CleanupResult`, `listFamilies()`, and `cleanup()` to the `TokenFamilyStore` interface.
- Implemented SQLite pagination, status filtering, and retention cleanup in `SqliteTokenFamilyStore`.
- Cleanup deletes:
  - Revoked families whose `rotated_at` (or `created_at` if never rotated) is older than the retention window.
  - Audit rows older than the audit retention window.
  - Rate-limit buckets older than the rate-limit retention window.
- All cleanup operations run inside a single SQLite transaction.

### 2. Service-level retention config (`local-auth-service.ts`)
- Added `LocalAuthRetentionConfig` with sensible defaults (24h for families/audit/rate-limits).
- Exposed `listFamilies()` and `cleanup()` on `LocalAuthService`.
- Updated `checkRateLimit()` to record `rate-limited` audit events.

### 3. Admin routes (`local-auth.ts`)
- `GET /auth/admin/families` — list with optional `status`, `limit`, `offset`; hashes are redacted to `abcdefgh...wxyz`.
- `POST /auth/admin/families/:familyId/revoke` — revoke an active, rotated, or already-revoked family.
- `POST /auth/admin/cleanup` — run retention cleanup with optional body overrides.
- All admin routes require `requireLocalAuth`.

### 4. Tests (`auth-routes.test.ts`)
- Added 5 new tests:
  - lists families with redacted hashes
  - revokes a family by id
  - returns 404 for unknown family
  - cleans up old revoked families and audit rows
  - rejects admin routes without local-auth header
- Fixed the subtle interaction where revoking the family used for admin auth invalidates that same token; tests now fetch a fresh admin token after revocation.

## Competitor / weak-spot research
- **Weak spot:** Without admin visibility, a revoked family or old audit data accumulates forever, and operators cannot investigate which loopback token families are active.
- **Competitor patterns:** OAuth2 token introspection endpoints (RFC 7662) and Keycloak's admin session/tokens APIs provide list/revoke/cleanup. We kept the surface intentionally smaller: no public introspection, only loopback-authenticated admin callers.
- **Three variants evaluated:**
  - **A — In-memory admin view:** Fast, lost on restart; rejected.
  - **B — SQLite-backed list/revoke/cleanup:** **Implemented**, consistent with existing store, durable, no new dependencies.
  - **C — External admin dashboard + Postgres:** Strongest for multi-node, adds ops burden; deferred.

## Verification
- `bun test /Users/playra/BrowserOS/packages/browseros-agent/apps/server/tests/api/routes/auth-routes.test.ts` — **45 pass, 0 fail**
- `bun run test:api` — **250 pass, 0 fail**
- `cargo run --bin clade-build` — PASS
- `cargo run --bin clade-audit` — hard gates **0 findings**
- `cargo run --bin clade-seal` — **SEAL VALID**
- `cargo run --bin clade-e2e` — PASS
- `open trios.app` relaunched; `curl http://127.0.0.1:9105/health` returns `{"status":"ok","cdpConnected":true}`

## Files changed
- `packages/browseros-agent/apps/server/src/api/services/token-family-store.ts`
- `packages/browseros-agent/apps/server/src/api/services/local-auth-service.ts`
- `packages/browseros-agent/apps/server/src/api/routes/local-auth.ts`
- `packages/browseros-agent/apps/server/tests/api/routes/auth-routes.test.ts`
- `.claude/plans/trios-cycle27-admin-token-lifecycle-plan.md`
- `.claude/plans/trios-cycle27-admin-token-lifecycle-report.md` (this file)

## Learnings
- Revoking a family must also invalidate its access token; admin tooling must account for this by using a different family's token for subsequent admin queries.
- SQLite `COALESCE(rotated_at, created_at)` works for retention, but tests need a small time gap when using `retentionMs = 0` because `Date.now()` has millisecond precision.
- Keeping admin endpoints behind the same `requireLocalAuth` middleware avoids a separate admin credential scheme and reuses the existing trusted-loopback model.

## Next options
1. Expose admin family lifecycle in the TriOS Queen dashboard (`QueenStatusViewModel` + Swift UI).
2. Add automated retention cleanup cron inside `clade-monitor`.
3. Export local-auth audit events to the Akashic log for long-term traceability.
