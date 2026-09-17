# Cycle 25 Plan: Persistent Server-Side Token-Family Store

## Weak spots

1. **Token families are purely in-memory.** A BrowserOS server restart destroys all active families, forcing every TriOS client to fall back to a full `/auth/local-token` bootstrap. This disrupts background services (A2A heartbeat, SSE stream, Queen audit loop) and looks like a sudden auth outage.
2. **No administrative visibility.** Because families live only in a `Map`, there is no way to list active sessions, inspect rotation history, or revoke a specific family from outside the process.
3. **`LocalAuthService.validate()` can have side effects.** `isExpired()` calls `getTokenInfo()`, which auto-issues a new family when none is active. Validation should never mutate state.
4. **No atomic rotation guard.** Concurrent `/auth/refresh` requests can both see the same refresh-token hash as active and issue two new valid pairs. While the loopback client is typically single-flight, background retries or rapid UI actions can race.
5. **No durable audit of family lifecycle.** Audit logs capture route-level validation results, but not family creation, rotation, or revocation events.

## Competitors / best-practice research

- **OWASP ASVS 5.0 V10** and **RFC 9700 (OAuth 2.0 Security BCP)** treat server-side sessions as first-class objects and require refresh-token storage as a hash with rotation and reuse detection. ([OWASP ASVS V10](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x19-V10-OAuth-and-OIDC.md), [RFC 9700](https://www.ietf.org/rfc/rfc9700.html))
- **Postgres + Redis pattern:** Postgres is the durable source of truth for families, rotation history, and revocation; Redis is a fast cache / revocation flag store with TTL-driven expiry. ([Session Management and Token Storage](https://amanksingh.com/blog/session-management-token-storage))
- **Refresh-token rotation guides** recommend atomic check-and-swap (Postgres `SELECT ... FOR UPDATE` or Redis Lua) to prevent concurrent rotations from producing multiple valid sessions. ([Refresh Token Rotation & Reuse Detection Guide](https://nileshblog.tech/refresh-token-rotation-reuse-detection/))
- **Production reference** `gabedalmolin/auth-api-node` demonstrates Postgres + Redis, hashed refresh tokens, family revocation, and metrics. ([auth-api-node](https://github.com/gabedalmolin/auth-api-node))
- For a single-server loopback app, SQLite is a common durable substitute for Postgres/Redis: it provides atomic transactions, is built into Bun (`bun:sqlite`), and needs no separate process.

## Variants

| Variant | Name | Summary | Trade-off |
|---------|------|---------|-----------|
| A | File-based JSON snapshot | Persist the family `Map` to a JSON file on every write; load on startup. Simple and dependency-free, but not atomic and vulnerable to corruption on crash. |
| B | SQLite-backed family store with WAL + atomic rotation | Use `bun:sqlite` with WAL, store families in a relational table, and wrap refresh rotation in a transaction. Durable, queryable, and self-contained. **Selected.** |
| C | Postgres-backed store with Redis cache | Integrate with existing `pg-agent-store` and add Redis for hot-path revocation. Best for multi-instance deployments, but requires external services. |

## Implementation

### 1. `TokenFamilyStore` interface

```typescript
export interface TokenFamilyStore {
  createFamily(family: TokenFamily): void
  findFamilyByRefreshHash(hash: string): TokenFamily | null
  findFamilyById(familyId: string): TokenFamily | null
  getActiveFamily(): TokenFamily | null
  setActiveFamily(familyId: string | null): void
  rotateFamily(familyId: string, update: TokenFamilyRotation): void
  revokeFamily(familyId: string): void
  revokeAllFamilies(): void
  appendFamilyAudit(event: FamilyAuditEvent): void
  close?(): void
}
```

### 2. `SqliteTokenFamilyStore`

- Uses `Database` from `bun:sqlite`.
- Schema:
  - `local_auth_families` — family_id, status, access_token_hash, refresh_token_hash, rotated_refresh_hashes JSON, created_at, rotated_at, access_token_issued_at, access_token_expires_at, active.
  - `local_auth_family_audit` — event_type, family_id, refresh_hash, timestamp, socket_address.
- `rotateFamily()` runs inside `BEGIN IMMEDIATE; ... COMMIT;` so only one rotation wins per family.
- Stores hashes only; never stores raw tokens.

### 3. Refactor `LocalAuthService`

- Replace in-memory `families` Map and `activeFamilyId` with `TokenFamilyStore`.
- On construction, load the persisted active family (if any) into `currentAccessToken` as empty string (the raw access token is intentionally not persisted).
- Remove the auto-issue side effect from `getTokenInfo()`; if no active family, return a default expired info object.
- Fix `isExpired()` to return `true` when there is no active family.
- `issueInitialTokens()` revokes all families, creates a new one in the store, and sets it active.
- `rotateRefreshToken()` uses the store's atomic rotation transaction.
- Add `recordFamilyEvent()` helper for lifecycle audit.

### 4. Wire into server

- `server.ts`: pass a default file path (`trios/.trinity/state/local-auth.sqlite`) to `LocalAuthService`.
- Tests: pass `':memory:'` SQLite DB.

### 5. Tests

- Existing `/auth/local-token` and `/auth/refresh` tests still pass with in-memory store.
- Add test: after constructing a new service instance with the same DB file, a valid refresh token rotates successfully (persistence).
- Add test: two concurrent `/auth/refresh` calls with the same refresh token do not both return 200 (atomicity / reuse detection).
- Add test: `validate()` returns false and does not create a new family when no active family exists.

## TDD / verification

- `bun test apps/server/tests/api/routes/auth-routes.test.ts` passes.
- `bunx tsc -p apps/server/tsconfig.json --noEmit` clean.
- `cargo run --bin clade-build` passes.
- `cargo run --bin clade-audit` hard gates 0 findings.
- `cargo run --bin clade-seal` VALID.
- `cargo run --bin clade-e2e` passes.
- App relaunched; `/health` ok.
