# Cycle 24 Report: Local-Auth Refresh-Token Rotation + Family Invalidation

## Summary

Cycle 24 closed the replay-window weak spot left after Cycle 23's TTL hardening by introducing refresh-token rotation with family invalidation on the BrowserOS server and a matching refresh flow in the TriOS Swift client. The access token remains short-lived (15 minutes), but the refresh token rotates on every use; reuse of an old refresh token now revokes the entire family and forces the client back through a full `/auth/local-token` bootstrap.

## Weak spots researched

1. **Single access token replayable until TTL expiry.** A leaked loopback token could be replayed for up to 15 minutes with no revocation path.
2. **No rotation or family invalidation.** `LocalAuthService` kept one in-memory token; there was no refresh token or theft-detection mechanism.
3. **No per-route capability scoping.** The same token unlocked every high-impact route (agents, skills, chat, A2A, soul, shutdown).
4. **No server-side audit of token usage.** `requireLocalAuth` validated the token but did not log route, timestamp, or socket.
5. **Cycle 23 tests were incomplete.** `auth-routes.test.ts` asserted only `body.token` and ignored the new TTL fields and 401 expired path.

## Competitor research

- **OAuth2 / OWASP ASVS 5.0 / RFC 9700:** Refresh-token rotation is the accepted fallback when DPoP/mTLS sender-constraining is unavailable. The authorization server must invalidate the old refresh token on use and revoke the entire family if a used refresh token is replayed.
- **macOS `SecAccessControl`:** Binding a Keychain item to `biometryCurrentSet` prevents a stolen token from being read without user authentication.
- **Capability / UAPK / Talos / Covenant patterns:** Short-lived, route-scoped tokens with `iat/exp/jti/scope/constraints` reduce blast radius.
- **Hono auth patterns:** Access tokens ~15 min, refresh tokens long-lived, `/auth/refresh` rotation endpoint.

## Implemented variant: B — Refresh-token rotation + family invalidation

### Server-side changes

- **`packages/browseros-agent/apps/server/src/api/services/local-auth-service.ts`**
  - Replaced single token with in-memory token families (`TokenFamily`, `TokenFamilyStatus`).
  - Stores SHA-256 hashes only; validates with `crypto.timingSafeEqual`.
  - Added `issueInitialTokens()`, `rotateRefreshToken()`, `detectRefreshReuse()`, `revokeFamily()`, `revokeAllFamilies()`.
  - `getTokenInfo()` returns access-token metadata only.
  - `validate()` checks active family + access-token hash + expiry.

- **`packages/browseros-agent/apps/server/src/api/routes/local-auth.ts`**
  - `GET /auth/local-token` returns `{ token, refreshToken, issuedAt, expiresAt, expiresInSeconds, ttlSeconds }`.
  - Added `POST /auth/refresh` accepting `{ refreshToken }`.
    - 200 → `{ accessToken, refreshToken, info }`
    - 401 → `{ error: 'refresh token revoked/reused' }` (family invalidation)
    - 403 → `{ error: 'Local authorization required' }`

- **`packages/browseros-agent/apps/server/src/api/utils/require-local-auth.ts`**
  - Continues to validate only the access token.
  - Added token-free async audit logging to `.trinity/state/local-auth-audit.jsonl` (path configurable via `auditPath` arg or `LOCAL_AUTH_AUDIT_PATH` env).
  - Logs route path, timestamp, socket address, and result (`ok`/`expired`/`invalid`/`unconfigured`). Never logs the token value.

- **`packages/browseros-agent/apps/server/tests/api/routes/auth-routes.test.ts`**
  - Asserted `/auth/local-token` returns `refreshToken` and all TTL metadata.
  - Added expired-access-token 401 test.
  - Added `/auth/refresh` rotation test.
  - Added refresh-token reuse / family-revocation 401 test.
  - Added audit-log test using a temp file.

### Client-side changes

- **`trios/rings/SR-01/LocalAuthProvider.swift`**
  - Added `refreshToken` field to `LocalAuthTokenInfo` and new `LocalAuthRefreshResponse` for `/auth/refresh`.
  - Extended `LocalAuthTokenStore` protocol and `KeychainLocalAuthTokenStore` to persist refresh tokens under a separate Keychain account (`browseros-local-refresh-token`).
  - Refactored token lifecycle: access token served from cache; near-expiry triggers `/auth/refresh` when a refresh token is stored; 401 from refresh triggers family-revocation monitoring and a full bootstrap fallback.
  - Added `LocalAuthError.refreshFailed(statusCode:)`.
  - Fixed ISO8601 date decoding by setting `decoder.dateDecodingStrategy = .iso8601`.
  - `resetLocalAuth()` now deletes the refresh token as well.

- **`trios/rings/SR-01/LocalAuthMonitor.swift`**
  - Added `recordFamilyRevoked()` event with token-free audit log entry.

- **`trios/tests/TriOSKitTests/LocalAuthProviderTests.swift`**
  - Extended mock store to track refresh-token reads/writes.
  - Updated token responses to include TTL metadata and refresh token.
  - Added tests for refresh-token storage, proactive refresh via `/auth/refresh`, family-revocation fallback, and reset clearing refresh token.

- **`trios/tests/TriOSKitTests/LocalAuthMonitorTests.swift`**
  - Added test for `recordFamilyRevoked()` audit event.

## Verification

| Check | Result |
|-------|--------|
| `bun test apps/server/tests/api/routes/auth-routes.test.ts` | 33 pass, 0 fail |
| `bunx tsc -p apps/server/tsconfig.json --noEmit` | clean |
| `cargo run --bin clade-build` | PASS |
| `cargo run --bin clade-audit` | 0 findings |
| `cargo run --bin clade-seal` | VALID |
| `cargo run --bin clade-e2e` | PASS (server ok, app PID 74992) |
| `open trios.app` + `curl /health` | `{"status":"ok","cdpConnected":true}` |

(`swift test` remains unavailable in this CommandLineTools-only environment; verification uses the clade pipeline per `CLAUDE.md`.)

## Three variants

| Variant | Name | Summary | Trade-off |
|---------|------|---------|-----------|
| A | Server-side audit + rate limiting | Add token-free audit logging and per-IP rate limiting on auth failures. Lightweight and improves operability, but does not shrink the replay window. |
| B | Refresh-token rotation + family invalidation | Issue access+refresh pairs, rotate on refresh, revoke family on reuse. Closes the replay window and matches OAuth2 BCP. **Implemented.** |
| C | Biometric Keychain + capability tokens | Bind Keychain item to `SecAccessControl` biometry and issue per-route capability tokens. Strongest blast-radius control, but requires UI prompts and a larger server refactor. |

## Lessons

- Token-family state should store hashes, not raw tokens, and use `timingSafeEqual` for comparisons even after hashing.
- A refresh endpoint must return a distinct 401 for family revocation so the client can fall back to bootstrap instead of retrying the dead refresh token.
- Client-side date decoding must explicitly use `.iso8601` when the server returns ISO-8601 strings; the default `JSONDecoder` strategy expects timestamps.
- Audit logs on both server and client must be token-free by design — log event names, paths, and results, never the secret value.
- Single-flight deduplication in `LocalAuthProvider` naturally extends to both bootstrap and refresh operations by wrapping the entire token acquisition in one task.

## Artifacts

- Plan: `.claude/plans/trios-cycle24-refresh-rotation-plan.md`
- Report: `.claude/plans/trios-cycle24-refresh-rotation-report.md`
- Episode: `.trinity/experience/2026-07-25_19-45-23_CYCLE24-REFRESH-ROTATION.json`
