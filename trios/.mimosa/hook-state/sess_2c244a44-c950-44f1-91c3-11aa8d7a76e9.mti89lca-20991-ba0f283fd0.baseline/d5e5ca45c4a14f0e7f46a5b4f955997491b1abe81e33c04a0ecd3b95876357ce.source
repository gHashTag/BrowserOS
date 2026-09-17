# Cycle 22 Implementation Plan — Local Auth Observability + Proactive Refresh + Recovery UI

## Weak Spot

Cycle 21 made the BrowserOS local-auth token durable and reactive to 403, but left several operational gaps:
- **No visibility**: users and the Queen dashboard cannot see whether local auth is healthy, when it last refreshed, or how many 403 retries occurred.
- **No proactive refresh**: the client waits for a 403 before refreshing. If the token is old (e.g., BrowserOS restarted hours ago), the first request after wake pays a failure-and-retry latency.
- **No recovery UI**: if the server is unreachable or `/auth/local-token` fails repeatedly, there is no manual "Refresh Local Auth" or "Reset Token" action.
- **No audit trail**: security review cannot reconstruct token fetch/refresh/403-retry history without logs.
- **Blunt error taxonomy**: `LocalAuthError` only has `invalidURL` and `fetchFailed`, making diagnostics hard.

## Competitor Patterns

- **Token-state observable stream**: SwiftAI Boilerplate exposes `authStates()` as `AsyncStream<AuthState>` (`.authenticated`, `.unauthenticated`, `.refreshing`) so UI can react without polling.
- **Proactive refresh before expiry**: store `fetchedAt`/`expiresAt` and refresh at 75–90% of lifetime or a fixed 60 s buffer.
- **Single-flight refresh mutex**: `omi` `AuthSessionCoordinator` and many OAuth clients wrap refresh in a `refreshSingleFlight()` task to deduplicate concurrent callers.
- **Rich error state + UI banner**: `TokenEater` uses `AppErrorState` enum (`.tokenExpired`, `.keychainLocked`, `.networkError`) and shows a menu-bar red "!" plus a recovery button.
- **Client audit telemetry**: never log the secret itself, but record lifecycle events (fetch.success, refresh.forced, 403.retry, failure) to a local JSONL for incident review.
- **Versioned Keychain keys**: `swift-ios-skills` recommends key versioning (`oauth_tokens_v2`) to support migrations safely.

Sources:
- [SwiftAI Boilerplate Auth Module](https://docs.swiftaiboilerplate.com/pages/modules/auth)
- [TokenEater silent keychain reads + recovery](https://github.com/AThevon/TokenEater/commit/c02810e25eb94de9a0ad21bcff75cd937501e218)
- [omi AuthSessionCoordinator](https://github.com/BasedHardware/omi/blob/e0dd387b/desktop/macos/Desktop/Sources/AuthSessionCoordinator.swift)
- [swift-ios-skills credential storage patterns](https://github.com/dpearson2699/swift-ios-skills/blob/main/skills/swift-security/references/credential-storage-patterns.md)
- [Ory OAuth token lifecycle](https://www.ory.com/blog/oauth-token-lifecycle-management)

## Decomposed Tasks

1. **Add `LocalAuthMonitor` actor**
   - `LocalAuthState` enum: `.unknown`, `.cached`, `.refreshing`, `.failed`, `.missing`.
   - `LocalAuthMetadata` struct: `fetchedAt`, `refreshCount`, `lastFailureAt`, `lastFailureReason`, `isHealthy`.
   - `LocalAuthMonitor` singleton actor: records fetch success, forced refresh success, 403 retry, failure, reset; returns current status; writes events to `.trinity/state/local-auth-audit.jsonl` (no token values).

2. **Extend `LocalAuthProvider`**
   - Inject `LocalAuthMonitor` (default `.shared`).
   - Report every lifecycle event to the monitor.
   - Add proactive refresh threshold: if cached token is older than 5 minutes, treat it as stale and refresh before use (configurable, default 300 s).
   - Add `resetLocalAuth()` method to clear cache + Keychain + record reset.
   - Expand `LocalAuthError` with `.keychainWriteFailed`, `.fetchFailed(statusCode:)`.
   - Preserve `LocalAuthProviding` protocol so `SSETransport`/`A2ARegistryClient` need no changes.

3. **Wire `SSETransport` and `A2ARegistryClient` telemetry**
   - On 403 retry, report `monitor.record403Retry()`.
   - On refresh success after 403, report `monitor.recordRefreshSuccess()`.

4. **Add Queen dashboard observability**
   - `QueenStatusViewModel`: add `checkLocalAuthAsync()` that queries `LocalAuthMonitor.shared.status()` and updates a "Local Auth" component.
   - Add `refreshLocalAuth()` and `resetLocalAuth()` actions.

5. **Add recovery UI**
   - `QueenQuickActionsSheet`: add action handling for the "Local Auth" component's action labels ("Refresh", "Reset").

6. **Tests**
   - `LocalAuthProviderTests.swift`: proactive refresh on stale token, no proactive refresh on fresh token, reset clears store and monitor, error taxonomy.
   - New `LocalAuthMonitorTests.swift`: metadata updates, audit JSONL append, no token leakage.

7. **Verification**
   - `./build.sh` PASS
   - `cargo run --bin clade-build` PASS
   - `cargo run --bin clade-e2e` PASS
   - `cargo run --bin clade-audit` 0 hard findings
   - `cargo run --bin clade-seal` SEAL VALID
   - Relaunch `trios.app` to preserve menu-bar logo invariant.

## Three Variants

### Variant A — Implemented (observability + proactive refresh + recovery UI)
Add a `LocalAuthMonitor`, age-based proactive refresh, audit log, and Queen UI actions. Closes visibility and recovery gaps with no server changes.

### Variant B — Server-side token metadata + TTL (future)
BrowserOS exposes `GET /auth/local-token` with `issuedAt` and `expiresIn` metadata. TriOS refreshes proactively at 75% of TTL and can show a countdown. Requires server changes but gives precise expiry instead of a heuristic.

### Variant C — Biometric-gated high-value actions (future)
Use `SecAccessControl` with `.biometryCurrentSet` + `.devicePasscode` to protect the Keychain item. Manual "Reset Token" requires biometric approval. Strongest anti-exfiltration, but prompts the user and complicates background refresh.

## Recommended Next Step

Implement Variant A now: it is server-agnostic, improves operability immediately, and provides the telemetry needed to decide later whether Variant B or C is warranted.
