# Cycle 25 Report: Persistent Server-Side Token-Family Store

## Summary

Cycle 25 made BrowserOS local-auth token families durable across server restarts by moving them from an in-memory `Map` to a SQLite store (`bun:sqlite`). The store keeps only SHA-256 hashes of access and refresh tokens, wraps refresh-token rotation in an immediate transaction so concurrent `/auth/refresh` requests cannot both win, and adds a token-family lifecycle audit table. TriOS clients can now recover from a server restart using their refresh token instead of being forced back through a full `/auth/local-token` bootstrap.

## Weak spots closed

1. **Token families were purely in-memory.** A BrowserOS restart destroyed every active family, forcing background loops (A2A heartbeat, SSE stream, Queen audit) to fall back to bootstrap.
2. **No administrative visibility.** There was no durable record of active families, rotation history, or revocation events.
3. **`validate()` had a side effect.** `isExpired()` called `getTokenInfo()`, which auto-issued a new family when none existed. Validation should never mutate state.
4. **No atomic rotation guard.** Concurrent `/auth/refresh` requests could race and produce multiple valid token pairs.

## Competitor / best-practice research

- **OWASP ASVS 5.0 V10** and **RFC 9700 (OAuth 2.0 Security BCP)** treat server-side sessions as first-class objects, store hashed refresh tokens, rotate them, and detect reuse to revoke families. ([OWASP ASVS V10](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x19-V10-OAuth-and-OIDC.md), [RFC 9700](https://www.ietf.org/rfc/rfc9700.html))
- **Postgres + Redis pattern:** Postgres is the durable source of truth for families; Redis accelerates lookups and revocation flags with TTL-driven expiry. ([Session Management and Token Storage](https://amanksingh.com/blog/session-management-token-storage))
- **Atomic rotation:** Guides recommend `SELECT ... FOR UPDATE` or a Redis Lua check-and-swap to stop concurrent rotations from issuing multiple valid sessions. ([Refresh Token Rotation & Reuse Detection Guide](https://nileshblog.tech/refresh-token-rotation-reuse-detection/))
- **Production reference** `auth-api-node` shows Postgres + Redis hashed refresh tokens, family revocation, and metrics. ([auth-api-node](https://github.com/gabedalmolin/auth-api-node))
- For a single-server loopback app, SQLite (`bun:sqlite`) provides atomic transactions and durability without an external dependency.

## Implemented variant: B — SQLite-backed family store with WAL + atomic rotation

### New files

- **`packages/browseros-agent/apps/server/src/api/services/token-family-store.ts`**
  - `TokenFamilyStore` interface and `SqliteTokenFamilyStore` implementation.
  - Tables:
    - `local_auth_families` — family_id, status, access/refresh token hashes, rotated refresh hashes (JSON), created/rotated/issued/expires timestamps, `is_active` flag.
    - `local_auth_family_audit` — lifecycle events (created, rotated, revoked, revoked-all).
  - `rotateRefreshToken()` runs inside a `BEGIN IMMEDIATE` transaction:
    - Current refresh hash → atomically rotate to new hashes and append old hash to rotated list.
    - Rotated/revoked hash → mark family revoked and return `'revoked'`.
    - Unknown hash → return `'not-found'`.
  - `revokeFamily()` and `revokeAllFamilies()` clear the `is_active` flag.
  - Default DB path falls back to `process.cwd()/.trinity/state/local-auth.sqlite`; production receives an explicit path from `createHttpServer` based on `executionDir`.

### Modified files

- **`packages/browseros-agent/apps/server/src/api/services/local-auth-service.ts`**
  - Replaced in-memory `Map<string, TokenFamily>` and `activeFamilyId` with `TokenFamilyStore`.
  - Constructor accepts `{ ttlSeconds?, store?, dbPath? }`.
  - `issueInitialTokens()` persists the new family and sets it active.
  - `rotateRefreshToken()` delegates to the store's atomic rotation.
  - `validate()` and `isExpired()` no longer create families; they return `false`/`true` when none is active.
  - `getTokenInfo()` returns a default expired info object when no active family or no in-memory access token exists.
  - Removed unused `detectRefreshReuse()`.
  - Added token-family lifecycle audit logging.

- **`packages/browseros-agent/apps/server/tests/api/routes/auth-routes.test.ts`**
  - Updated tests to use `SqliteTokenFamilyStore(':memory:')` so they are isolated and do not write to the production DB path.
  - Added three new tests:
    - Token families persist across service restarts.
    - Concurrent refresh with the same token is detected as reuse (atomicity).
    - `validate()` does not create a family when none is active.

### No client-side changes

The TriOS Swift client already calls `/auth/refresh` before the access token expires and falls back to `/auth/local-token` on family revocation. With durable families, a server restart no longer invalidates refresh tokens, so the client recovers via `/auth/refresh` instead of bootstrap. No Swift changes were required.

### Post-land runtime fix: DB path

The first version of the store resolved its default DB path by walking up from the source file (`token-family-store.ts`). That produced the wrong directory in this monorepo layout (`/Users/playra/trios/.trinity/state/local-auth.sqlite` instead of `/Users/playra/BrowserOS/trios/.trinity/state/local-auth.sqlite`). The fix:

1. `token-family-store.ts` now uses `process.cwd()/.trinity/state/local-auth.sqlite` as the default fallback.
2. `api/server.ts` computes the trios state dir from the configured `executionDir` (`.../packages/browseros-agent` → sibling `.../trios/.trinity/state`) and passes it explicitly to `LocalAuthService`.
3. After relaunching `trios.app`, the verified DB file is at `/Users/playra/BrowserOS/trios/.trinity/state/local-auth.sqlite`.

## Verification

| Check | Result |
|-------|--------|
| `bun test .../auth-routes.test.ts` | 36 pass, 0 fail |
| `bunx tsc -p .../apps/server/tsconfig.json --noEmit` | clean |
| `cargo run --bin clade-build` | PASS |
| `cargo run --bin clade-audit` | 0 findings |
| `cargo run --bin clade-seal` | VALID |
| `cargo run --bin clade-e2e` | PASS |
| `open trios.app` + `curl /health` | `{"status":"ok","cdpConnected":true}` |
| Runtime DB file | `/Users/playra/BrowserOS/trios/.trinity/state/local-auth.sqlite` created and populated |

(`swift test` remains unavailable in this CommandLineTools-only environment; verification uses the clade pipeline per `CLAUDE.md`.)

## Three variants

| Variant | Name | Summary | Trade-off |
|---------|------|---------|-----------|
| A | File-based JSON snapshot | Snapshot the family `Map` to JSON on every write; load on startup. Simple and dependency-free, but not atomic and can corrupt on crash. |
| B | SQLite-backed family store with WAL + atomic rotation | Use `bun:sqlite` with WAL, relational table, and immediate transaction for rotation. Durable, queryable, and self-contained. **Implemented.** |
| C | Postgres-backed store with Redis cache | Integrate with existing `pg-agent-store` and add Redis for hot revocation flags. Best for multi-instance deployments, but requires external services. |

## Lessons

- A token-family store must store hashes only, never raw tokens, and expose atomic rotation so reuse detection cannot be raced.
- Validation must be read-only; auto-issuing a family inside `getTokenInfo()` or `isExpired()` creates surprising side effects and breaks persistent stores.
- SQLite `BEGIN IMMEDIATE` transactions serialize rotation attempts; only the first rotation wins, and the second sees the now-rotated hash as reuse.
- When a family is revoked, clear its `is_active` flag so `getActiveFamily()` never returns a revoked family.
- Tests should use `:memory:` SQLite stores and pass them explicitly; default file paths are for production runtime only.
- Source-file-relative path math is fragile in monorepos; pass explicit paths derived from the server's configured `executionDir` and verify the runtime file location after launch.

## Artifacts

- Plan: `.claude/plans/trios-cycle25-token-family-store-plan.md`
- Report: `.claude/plans/trios-cycle25-token-family-store-report.md`
- Episode: `.trinity/experience/YYYY-MM-DD_hh-mm-ss_CYCLE25-TOKEN-FAMILY-STORE.json`
