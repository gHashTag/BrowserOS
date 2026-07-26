# Cycle 23 Implementation Plan — Server-Side Local-Auth TTL + Client Hardening

## Weak Spot

Cycle 22 added proactive refresh, but it relies on a client-side heuristic (5 minutes since `fetchedAt`). Problems:
- **Clock drift / process lifetime mismatch**: if BrowserOS restarts and regenerates the token, the client thinks its 5-minute cache is still valid even though the server has a brand-new secret.
- **No server-side TTL policy**: the server has no notion of token lifetime, rotation schedule, or expiry.
- **Client cannot show a real TTL countdown**: it only shows "time since fetch", not "time until expiry".
- **No rotation endpoint**: to refresh, the client re-fetches the *same* token from `/auth/local-token` instead of asking the server to rotate.
- **No server-side audit of token issuance**: security review cannot see when tokens were minted or rotated.

## Competitor Patterns

- **Capability tokens** (UAPK Gateway, Talos, Covenant, IntentGate): include `iat`/`issuedAt`, `exp`/`expires_at`, `jti`, scope, and constraints; validate signature + expiry + revocation on every request.
- **OAuth2 / OIDC token responses**: include `access_token`, `expires_in`, `token_type`, `issued_at`; refresh tokens are rotated on use.
- **Hono auth starter / seepine/hono-jwt**: access tokens 15 min, refresh tokens 7 days; `/auth/refresh` rotates refresh token.
- **ClaudeUsageBar / TokenEater**: proactive refresh before expiry + live reset countdown in menu-bar UI.
- **macOS Keychain**: `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` for background-accessible tokens.

Sources:
- [UAPK Gateway capability tokens](https://uapk.info/docs/guides/capability-tokens/)
- [Talos capability authorization](https://github.com/talosprotocol/talos-docs/blob/main/features/authorization/capability-authorization.md)
- [Covenant capabilities](https://docs.opencovenant.org/capabilities)
- [DEV Community Hono OIDC refresh tokens](https://dev.to/shygyver/add-refresh-tokens-to-your-hono-oidc-server-with-token-rotation-4nm9)
- [hono-jwt middleware](https://github.com/seepine/hono-jwt)
- [ClaudeUsageBar](https://github.com/sam-pop/ClaudeUsageBar)
- [TokenEater](https://github.com/AThevon/TokenEater/commit/c02810e25eb94de9a0ad21bcff75cd937501e218)

## Decomposed Tasks

### Server (BrowserOS)

1. **Extend `LocalAuthService`**
   - Add `issuedAt: Date`, `expiresInSeconds: number`, `ttlSeconds: number`.
   - Add `rotate()` to mint a new token and update metadata.
   - Add `isExpired()` and `timeToExpirySeconds()`.
   - Keep existing `validate()` timing-safe comparison.

2. **Extend `/auth/local-token` response**
   - Return `{ token, issuedAt, expiresIn, ttlSeconds }`.
   - Add server-side audit log entry on issuance: timestamp + jti-like id.

3. **Add server-side token TTL validation in `requireLocalAuth`**
   - If token is present but expired, return 401 with `error: 'Local authorization expired'` so the client can distinguish expired vs invalid vs missing.

4. **Update server tests**
   - Assert response shape includes TTL fields.
   - Test expired token returns 401.

### Client (TriOS)

5. **Extend `LocalAuthProvider` data model**
   - Parse `issuedAt`/`expiresIn`/`ttlSeconds`.
   - Store `issuedAt` and `expiresAt` in `LocalAuthMetadata`.

6. **Precise proactive refresh**
   - Refresh when `expiresAt - now < 60s` or at 75% of TTL instead of the 5-minute heuristic.
   - Fallback to the 5-minute heuristic if server does not return TTL.

7. **UI countdown**
   - `QueenStatusViewModel` Local Auth component detail can show seconds/minutes until expiry.

8. **Tests**
   - Server: TTL response, expired token 401.
   - Client: parsing TTL, proactive refresh at 75%, fallback heuristic.

9. **Verification**
   - `bun test` for BrowserOS server tests.
   - `cargo run --bin clade-build` PASS.
   - `cargo run --bin clade-e2e` PASS.
   - `cargo run --bin clade-audit` 0 findings.
   - `cargo run --bin clade-seal` SEAL VALID.
   - Relaunch `trios.app`.

## Three Variants

### Variant A — Implemented (server TTL + precise proactive refresh + countdown)
BrowserOS exposes TTL metadata; TriOS uses precise 75%-TTL/60-s proactive refresh and shows a real countdown. Server also validates expiry.

### Variant B — Refresh-token rotation with `/auth/rotate` (future)
Add a dedicated `POST /auth/rotate` endpoint that invalidates the current token and returns a fresh one. TriOS calls it explicitly on 401-expired. Simpler client logic but requires a new mutation endpoint.

### Variant C — Signed capability JWTs with scopes (future)
Replace the opaque token with a JWT signed by BrowserOS containing `exp`, `iat`, `jti`, and scopes (`chat`, `a2a`, `shutdown`). TriOS stores the JWT, server validates signature/expiry/scope on every request. Most A2A-idiomatic but adds key-management complexity.

## Recommended Next Step

Implement Variant A: it keeps the existing token shape backward-compatible, gives the client precise TTL, and closes the stale-after-server-restart gap.
