# Cycle 21 Implementation Plan — Keychain-Backed Local-Auth Persistence

## Weak Spot

`LocalAuthProvider` (Cycle 20) caches the BrowserOS `X-TriOS-Local-Auth` token only in process memory. Consequences:
- After trios restarts, the first chat/A2A request pays the latency of fetching a fresh token from `/auth/local-token`.
- If BrowserOS restarts and regenerates its in-memory token, the stale cached token causes every request to return 403 until the user manually triggers a refresh (no refresh path exists today).
- Concurrent callers that all see a 403 can stampede the server with refresh requests.

## Competitor Patterns

- **Apple Keychain**: canonical storage for local credentials; use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` for tokens that may be read after first unlock; use an actor to serialize access.
- **OAuth / A2A clients**: refresh access tokens reactively on 401/403; use a single-flight coordinator so concurrent 401s do not spawn multiple refresh requests; atomically update stored tokens.
- **A2A Agent Cards**: declare `securitySchemes`; common schemes include API key, JWT Bearer, OAuth2 Client Credentials, mTLS.

Sources:
- [Using the keychain to manage user secrets](https://developer.apple.com/documentation/security/using-the-keychain-to-manage-user-secrets)
- [swift-ios-skills credential storage patterns](https://github.com/dpearson2699/swift-ios-skills/blob/main/skills/swift-security/references/credential-storage-patterns.md)
- [A2A protocol authentication](https://adk-rs.vercel.app/docs/a2a)
- [Microsoft Foundry A2A authentication](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/agent-to-agent-authentication)

## Decomposed Tasks

1. **Add `LocalAuthTokenStore` abstraction**
   - Protocol `LocalAuthTokenStore: Sendable` with `read() -> String?` and `write(_ token: String) async throws`.
   - Implementation `KeychainLocalAuthTokenStore` backed by `KeychainSecrets` using service `com.browseros.trios.local-auth` and account `browseros-local-token`.
   - Add unit tests for read/write/delete and add-or-update semantics.

2. **Refactor `LocalAuthProvider`**
   - Inject `LocalAuthTokenStore` (default `KeychainLocalAuthTokenStore`).
   - `validToken(forcingRefresh:)`:
     - If not forcing refresh and a memory cache exists, return it.
     - Otherwise read from store; if found, cache and return.
     - If still missing, fetch from `GET /auth/local-token`.
     - Save fetched token to store and memory cache.
   - Add single-flight refresh: an actor-isolated `refreshTask` deduplicates concurrent forced refreshes.
   - Preserve the existing `LocalAuthProviding` protocol so callers need no changes.

3. **Wire 403 refresh into `SSETransport`**
   - In `sendMessage(body:)`, after receiving a non-2xx response, if status is 403 and a provider is present, call `validToken(forcingRefresh: true)`, rebuild the request with the new token, and retry once.
   - Only retry 403 once; if the second attempt also fails, throw `TransportError.serverError` as before.

4. **Wire 403 refresh into `A2ARegistryClient`**
   - In `performDataRequest` and the SSE stream request builder, detect 403 and refresh the token once before retry.
   - Keep the change inside the authorized helpers or a shared retry wrapper so all public methods benefit.

5. **Composition root**
   - Update `main.swift` to pass a `KeychainLocalAuthTokenStore` to the `LocalAuthProvider`.

6. **Tests**
   - `LocalAuthProviderTests.swift`: cache hit, Keychain hit, server fetch + Keychain save, forced refresh, concurrent refresh deduplication, Keychain failure fall-through.
   - `SSETransportTests.swift`: 403 triggers one refresh and retry, 403 after refresh still fails, 503 does not trigger refresh.
   - `A2ARegistryClient` test addition: mock provider returns refreshed token after first 403.

7. **Verification**
   - `./build.sh` PASS
   - `cargo run --bin clade-build` PASS
   - `cargo run --bin clade-e2e` PASS
   - `cargo run --bin clade-audit` 0 hard findings
   - `cargo run --bin clade-seal` SEAL VALID
   - Relaunch `trios.app` to preserve menu-bar logo invariant.

## Three Variants

### Variant A — Implemented (Keychain + reactive refresh)
Persist token in macOS Keychain; refresh reactively on 403; single-flight refresh. Minimal scope, closes the most pressing gap.

### Variant B — Proactive refresh + server-side stable token
Instead of reactive refresh, make BrowserOS derive a stable local-auth token from a persistent secret (e.g., a key stored in `~/.trios/config.json` or a server-side Keychain). Then the client rarely needs to refresh. Simpler client, but requires a trust-worthy server-side secret and rotation policy.

### Variant C — Short-lived capability tokens
Replace the single local-auth token with route-scoped capability tokens (`chat:post`, `a2a:register`, etc.). BrowserOS issues a capability JWT on demand; trios stores multiple tokens in Keychain; each expires after a short TTL. This is the most A2A-idiomatic path and limits blast radius, but adds JWT signing/validation infrastructure on the server.

## Recommended Next Step

Implement Variant A now because it closes the immediate operational gap (server restart invalidates token) with the smallest blast radius. Variant B is a good follow-up if the reactive refresh proves noisy; Variant C should be reserved for a later cycle focused on multi-tenant or third-party agent access.
