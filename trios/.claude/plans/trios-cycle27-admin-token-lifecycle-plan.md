# Cycle 27 Plan: Admin Token-Family Lifecycle + Audit Retention

## Weak spots

1. **No admin visibility into token families.** After Cycle 25, families are persisted in SQLite, but operators have no HTTP endpoint to list active/rotated/revoked families or inspect their status and age. Debugging a 401/revocation incident currently requires opening the SQLite file by hand.
2. **No programmatic family revocation.** `LocalAuthService.revokeFamily()` exists internally, but no route exposes it. If a device is lost or a refresh token is leaked, an operator cannot revoke a specific family without restarting or patching code.
3. **Unbounded audit-table growth.** `local_auth_family_audit` and `local_auth_rate_limits` accumulate rows indefinitely. On a long-running BrowserOS server this wastes disk and slows queries.
4. **No retention policy.** There is no configurable TTL for revoked families, rotated hashes, or old audit events, so sensitive metadata (even if it is only hashes) is retained forever.
5. **No alert/notification on security events.** Refresh-token reuse and rate-limit blocks are recorded in the audit table but are not surfaced to the Queen monitor or any other observer.

## Competitor / best-practice research

- **OAuth 2.0 Token Revocation (RFC 7009)** and **Token Introspection (RFC 7662)** define standard endpoints for revoking and querying tokens. BrowserOS local-auth is not OAuth2, but the operational pattern (list + revoke + introspection) is the same.
- **OWASP ASVS 5.0 V4.1.3 / V6.4** require session/token revocation capability and secure session lifecycle management.
- **AWS IAM / GitHub PAT admin APIs** list active sessions/tokens with redacted identifiers and allow revocation by ID; hashes/secrets are never returned.
- **Audit retention best practice:** retain security audit events for a compliance window (e.g., 90 days) and delete or archive older rows; revoke expired/rotated families after a grace period (e.g., 7 days) so incident response still has time to inspect them.
- **Hono background tasks:** Bun/Node cron or `setInterval` can run cleanup; for tests, expose the cleanup function so it can be invoked deterministically.

## Three variants

| Variant | Name | Summary | Trade-off |
|---------|------|---------|-----------|
| A | In-memory admin stubs | Add list/revoke endpoints backed by the in-memory service state, with no cleanup and no persistence. | Fastest to implement, but admin state is lost on restart and audit tables still grow. |
| B | SQLite admin endpoints + retention cleanup | Add `/auth/admin/families` (list) and `/auth/admin/families/:id/revoke`, plus a store cleanup method that deletes old revoked families, expired rate-limit buckets, and audit rows past a retention window. **Implemented.** | Durable, operational, bounded growth; requires a periodic cleanup trigger. |
| C | External SIEM + real-time alerting | Stream audit events to an external log aggregator and emit alerts on reuse/rate-limit. Best for fleet-wide BrowserOS deployments. | Requires external service, network dependency, and alerting infrastructure. |

## Selected variant: B

### Implementation steps

1. **Extend `TokenFamilyStore` interface** (`token-family-store.ts`)
   - Add `listFamilies(options?: { status?: TokenFamilyStatus; limit?: number; offset?: number }): TokenFamily[]`.
   - Add `cleanup(options: { familyRetentionMs: number; auditRetentionMs: number; rateLimitRetentionMs: number }): CleanupResult`.
   - Add `recordRateLimited(event)` or extend `AuthAuditEvent` with `rate-limited` (already exists in Cycle 26, but verify it is recorded).

2. **Implement in `SqliteTokenFamilyStore`**
   - `listFamilies`: query `local_auth_families` with optional status filter and pagination, ordered by `created_at DESC`.
   - `cleanup`:
     - Delete families whose `status = 'revoked'` and `rotated_at/created_at` is older than `familyRetentionMs`.
     - Delete `local_auth_family_audit` rows older than `auditRetentionMs`.
     - Delete `local_auth_rate_limits` rows whose `window_start` is older than `rateLimitRetentionMs`.
     - Return counts of deleted rows.

3. **Update `LocalAuthService`** (`local-auth-service.ts`)
   - Add `cleanup(options?)` delegating to the store.
   - Add `listFamilies(options?)` delegating to the store.
   - Add default retention constants (e.g., family 7 days, audit 90 days, rate-limit 1 day).
   - Record the existing `rate-limited` audit event when a `RateLimitError` is thrown (currently not recorded by the service; the route catches it before audit).

4. **Add admin routes** (`local-auth.ts` or new `local-auth-admin.ts`)
   - `GET /auth/admin/families` — returns paginated families with redacted hashes (show first 8 chars + `...`). Gated by `requireLocalAuth`.
   - `POST /auth/admin/families/:familyId/revoke` — revokes a specific family. Returns `{ revoked: true/false }`. Gated by `requireLocalAuth`.
   - `POST /auth/admin/cleanup` — runs retention cleanup and returns deleted-row counts. Gated by `requireLocalAuth`.

5. **Wire into `server.ts`**
   - Mount admin routes under `/auth` using the same `LocalAuthService` instance.
   - Optionally start a periodic cleanup interval (e.g., every 24h) from the server bootstrap, with a flag to disable in tests.

6. **Tests** (`auth-routes.test.ts`)
   - List families after issuing tokens.
   - Revoke a family and verify it no longer appears as active.
   - Verify hashes are redacted in the list response.
   - Run cleanup with short retention and verify old revoked families and audit rows are removed.
   - Verify admin endpoints reject requests without `X-TriOS-Local-Auth`.

7. **Verification**
   - `bun run typecheck`
   - `bun test ./tests/api/routes/auth-routes.test.ts`
   - `cargo run --bin clade-build`
   - `cargo run --bin clade-audit`
   - `cargo run --bin clade-seal`
   - `cargo run --bin clade-e2e`
   - Relaunch `trios.app` and confirm `/health`.

## TDD criteria

- `GET /auth/admin/families` returns paginated families with redacted hashes and requires `X-TriOS-Local-Auth`.
- `POST /auth/admin/families/:id/revoke` revokes the family and returns `{ revoked: true }`.
- `POST /auth/admin/cleanup` removes revoked families, old audit rows, and stale rate-limit buckets according to configured retention.
- Cleanup is deterministic and testable with `:memory:` stores and short retention windows.
- No new clade-audit hard-gate findings; existing tests still pass.
