# Cycle 24 Plan: Local-Auth Refresh-Token Rotation + Family Invalidation

## 1. Weak spots after Cycle 23

1. **Single access token is replayable until TTL expiry.** A leaked token can be used by any loopback process for the full 15-minute window with no way to revoke or detect replay.
2. **No rotation or family invalidation.** The current `LocalAuthService` stores one in-memory token. There is no refresh token, no family ID, and no theft-detection mechanism.
3. **No per-route capability scoping.** The same token unlocks every high-impact route (agents, skills, chat, A2A, soul, shutdown), violating least-privilege.
4. **No server-side audit of token usage.** `requireLocalAuth` validates the token but does not log which route, when, or from which socket — hampering incident response.
5. **Cycle 23 tests are incomplete.** `auth-routes.test.ts` still expects `{ token }` and does not assert the new TTL fields or the 401 expired path.

## 2. Competitor research

- **OAuth2 / OWASP ASVS 5.0 / RFC 9700:** Refresh-token rotation is the accepted fallback when sender-constraining (DPoP / mTLS) is unavailable. On every refresh the AS issues a new access token + new refresh token, invalidates the old refresh token, and revokes the entire authorization/family if a used refresh token is replayed.
- **macOS `SecAccessControl`:** Binding a Keychain item to `biometryCurrentSet` or `devicePasscode` prevents a stolen token from being read without user authentication, even if the Keychain file is exfiltrated.
- **Capability / UAPK / Talos / Covenant patterns:** Issue short-lived, route-scoped tokens with `iat/exp/jti/scope/constraints`. Each capability grants only one action class (e.g., `agent:create`), reducing blast radius.
- **Hono auth patterns:** Access tokens ~15 min, refresh tokens ~7 days, `/auth/refresh` rotation endpoint.

## 3. Decomposed implementation plan

### Selected variant: B — Refresh-token rotation + family invalidation

Reason: directly closes the replay-window weak spot, matches OWASP/RFC 9700 best practice, and is implementable within one cycle without introducing UI-modal friction.

### Server-side (BrowserOS)

1. **Extend `LocalAuthService` to manage token families.**
   - Add `TokenFamily` state: `familyId`, `accessTokenHash`, `refreshTokenHash`, `status` (`active` | `rotated` | `revoked`), `createdAt`, `rotatedAt`.
   - `getTokenInfo()` returns the current access token + metadata (no refresh token leakage).
   - `issueInitialTokens()` creates a new family and returns `{ access, refresh, info }`.
   - `rotateRefreshToken(refreshToken)` validates the refresh token hash, checks status, issues a new access+refresh pair in the same family, marks the old refresh as `rotated`, and returns the new pair.
   - `detectRefreshReuse(refreshToken)` marks the family `revoked` if a rotated/revoked refresh token is presented again.
   - `revokeFamily(familyId)` and `revokeAllFamilies()` for explicit revocation (e.g., server admin, shutdown).

2. **Update `/auth/local-token` route.**
   - Continue to return full `LocalAuthTokenInfo` for the access token.
   - Also return the initial refresh token in a separate field: `refreshToken`.

3. **Add `/auth/refresh` route.**
   - POST with `refreshToken` in JSON body.
   - Returns new `{ accessToken, refreshToken, info }` on success.
   - Returns 401 with `error: "refresh token revoked/reused"` on family invalidation.
   - Returns 403 on missing/invalid refresh token.

4. **Update `require-local-auth` middleware.**
   - Continue validating only the access token.
   - Add optional `isExpired()` check (already present).
   - Add token-free audit logging: route path, timestamp, socket address, result (ok/expired/invalid) — never log the token value.

5. **Update server tests (`auth-routes.test.ts`).**
   - Assert `/auth/local-token` returns `token`, `refreshToken`, `issuedAt`, `expiresAt`, `expiresInSeconds`, `ttlSeconds`.
   - Assert expired access token returns 401.
   - Assert `/auth/refresh` returns new access+refresh pair.
   - Assert reuse of old refresh token revokes family and returns 401.

### Client-side (TriOS)

1. **Extend `LocalAuthTokenInfo` and add refresh types.**
   - Server response now includes `refreshToken`; decode it.
   - Add `LocalAuthRefreshResult` struct if needed.

2. **Extend `LocalAuthTokenStore` protocol.**
   - Add `readRefreshToken()` and `writeRefreshToken(_:)` / `deleteRefreshToken()`.
   - Use separate Keychain account `browseros-local-refresh-token`.

3. **Update `LocalAuthProvider`.**
   - On first fetch, store both access and refresh tokens.
   - When the access token is near expiry or 401/403 is received, call `/auth/refresh` with the stored refresh token.
   - If refresh returns 401 (family revoked/reused), fall back to full bootstrap via `/auth/local-token`.
   - Keep single-flight deduplication for both refresh and bootstrap paths.
   - Expose `currentRefreshInfo()` for UI countdown if desired.

4. **Extend `LocalAuthMonitor`.**
   - Add `recordRefreshSuccess()`, `recordRefreshReuse()`, `recordFamilyRevoked()` events.
   - Keep metadata token-free.

5. **Update Swift tests.**
   - Test refresh-token storage and retrieval.
   - Test access-token refresh path.
   - Test family-invalidated fallback to bootstrap.

### Verification

- `bun test apps/server/tests/api/routes/auth-routes.test.ts` — all pass.
- `cargo run --bin clade-build` — PASS.
- `cargo run --bin clade-audit` — 0 findings.
- `cargo run --bin clade-seal` — VALID.
- `cargo run --bin clade-e2e` — PASS.
- `open trios.app` relaunch + `/health` returns ok.

## 4. Three variants

| Variant | Name | Summary | Trade-off |
|---------|------|---------|-----------|
| A | Server-side audit + rate limiting | Add token-free audit logging and per-IP rate limiting on auth failures. Lightweight, improves operability, but does not shrink replay window. |
| B | Refresh-token rotation + family invalidation | Issue access+refresh pairs, rotate on refresh, revoke family on reuse. Closes replay window and matches OAuth2 BCP. **Selected.** |
| C | Biometric Keychain + capability tokens | Bind Keychain item to `SecAccessControl` biometry and issue per-route capability tokens. Strongest blast-radius control but requires UI prompts and larger server refactor. |

## 5. Risks and mitigations

- **Server restart loses in-memory families.** Mitigation: this is existing behavior for the single token; acceptable for local-auth bootstrap. Future cycle can persist families to DB if needed.
- **Refresh token also replayable until used.** Mitigation: rotation invalidates the old refresh immediately on first use; reuse triggers family revocation.
- **Client test complexity.** Mitigation: inject mock `URLSession` and `LocalAuthTokenStore`, as established in Cycle 21-23 tests.
- **Middleware audit logging performance.** Mitigation: async append-only write to `.trinity/state/local-auth-audit.jsonl`, same pattern as client-side monitor.

## 6. PHI LOOP mapping

- Issue: continue closing local-auth replay window after Cycle 23 TTL hardening.
- Spec: this plan.
- TDD: server + Swift tests listed above.
- Code/Impl: server and client changes.
- Seal: clade-build / clade-audit / clade-seal / clade-e2e.
- Verify: app relaunch + health.
- Land: commit on `feat/zai-provider`.
- Learn: save episode after verification.
