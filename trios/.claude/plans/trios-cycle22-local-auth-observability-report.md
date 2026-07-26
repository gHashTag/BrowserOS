# Cycle 22 Report — Local Auth Observability + Proactive Refresh + Recovery UI

## Executive Summary

Implemented **Variant A**: added a `LocalAuthMonitor` telemetry actor, age-based proactive refresh, token-free audit log, and Queen status UI integration for the BrowserOS local-auth token. Users can now see local-auth health, manually refresh, or reset the token from the Queen quick-actions sheet.

Verification: clade-build PASS, clade-audit 0 findings, clade-seal VALID, clade-e2e PASS, app relaunched and `/health` returns `{"status":"ok","cdpConnected":true}`.

---

## 1. Weak spots addressed

| Weak spot | Risk | Mitigation in this cycle |
|-----------|------|--------------------------|
| No visibility into token health | Hard to diagnose 403 storms or stale tokens | `LocalAuthMonitor.status()` exposes `LocalAuthState` + metadata; wired into `QueenStatusViewModel` |
| Reactive-only refresh | First request after a long sleep may hit 403 | Proactive refresh when cached token is older than 5 minutes (configurable) |
| No audit trail | Cannot reconstruct token lifecycle for incident review | `.trinity/state/local-auth-audit.jsonl` records fetch/refresh/403-retry/failure/reset events (no token values) |
| No recovery UI | If refresh fails repeatedly, user is stuck | Queen status sheet shows "Refresh" / "Reset" actions; `LocalAuthUIManager` performs them safely |
| Blunt error taxonomy | `fetchFailed` gave no status code | `LocalAuthError.fetchFailed(statusCode:)` includes HTTP status; monitor stores failure reason |

---

## 2. Competitor / prior-art research

- **SwiftAI Boilerplate Auth Module**: exposes `authStates()` as `AsyncStream<AuthState>` with `.authenticated`/`.refreshing` states and schedules proactive refresh 60 s before expiry.
- **TokenEater**: introduced `AppErrorState` enum (`.tokenExpired`, `.keychainLocked`, `.networkError`) and a menu-bar red "!" plus recovery banner; uses silent Keychain reads with `kSecUseAuthenticationUISkip`.
- **omi `AuthSessionCoordinator`**: wraps refresh in a single-flight task and classifies definitive Firebase errors to avoid unnecessary sign-outs.
- **Ory / swift-ios-skills**: recommend Keychain-only storage, actor-serialized atomic access, refresh-token rotation, token family invalidation, and server-side audit logging.
- **onelake-explorer-macos**: adds a "Sign In Again…" action directly in the account submenu for menu-bar apps.

Sources:
- [SwiftAI Boilerplate Auth Module](https://docs.swiftaiboilerplate.com/pages/modules/auth)
- [TokenEater silent keychain reads + recovery](https://github.com/AThevon/TokenEater/commit/c02810e25eb94de9a0ad21bcff75cd937501e218)
- [omi AuthSessionCoordinator](https://github.com/BasedHardware/omi/blob/e0dd387b/desktop/macos/Desktop/Sources/AuthSessionCoordinator.swift)
- [swift-ios-skills credential storage patterns](https://github.com/dpearson2699/swift-ios-skills/blob/main/skills/swift-security/references/credential-storage-patterns.md)
- [Ory OAuth token lifecycle](https://www.ory.com/blog/oauth-token-lifecycle-management)
- [onelake-explorer-macos Sign In Again](https://github.com/sdebruyn/onelake-explorer-macos/pull/267)

---

## 3. Decomposed plan (executed)

1. Add `LocalAuthMonitor` actor with `LocalAuthState` and `LocalAuthMetadata`; write token-free audit events.
2. Extend `LocalAuthProvider` with monitor integration, proactive refresh threshold, `resetLocalAuth()`, and richer `LocalAuthError`.
3. Wire `SSETransport` and `A2ARegistryClient` to record 403-retry telemetry.
4. Add `LocalAuthUIManager` MainActor singleton configured from `main.swift` for UI recovery actions.
5. Add `QueenStatusViewModel.checkLocalAuthAsync()` component and `refreshLocalAuth()` / `resetLocalAuth()` actions.
6. Update `QueenQuickActionsSheet` to dispatch Local Auth actions.
7. Add/update tests: proactive refresh, reset, monitor metadata, audit log hygiene.
8. Run `clade-build`, `clade-audit`, `clade-seal`, `clade-e2e`; relaunch `trios.app`.

---

## 4. Implemented Variant A — Observability + proactive refresh + recovery UI

### 4.1 `LocalAuthMonitor` (`rings/SR-01/LocalAuthMonitor.swift`)

Singleton actor tracking:
- `LocalAuthState`: `.unknown`, `.cached`, `.refreshing`, `.failed`, `.missing`
- `LocalAuthMetadata`: `fetchedAt`, `refreshCount`, `retry403Count`, `lastFailureAt`, `lastFailureReason`, `isHealthy`
- Audit log: `.trinity/state/local-auth-audit.jsonl` with events `fetch.success`, `refresh.success`, `403.retry`, `failure`, `missing`, `reset`. No token values are ever written.
- `shouldProactivelyRefresh(maxAge:)` default 300 s.

### 4.2 `LocalAuthProvider` extensions (`rings/SR-01/LocalAuthProvider.swift`)

- Injects `LocalAuthMonitor` (default `.shared`) and `proactiveRefreshMaxAge`.
- On `validToken(forcingRefresh: false)` with a cached token, checks proactive refresh threshold and fetches fresh token when stale.
- Records `fetch.success` / `failure` with HTTP status reason.
- `resetLocalAuth()` clears cache + Keychain + monitor metadata.
- `LocalAuthError` now has `.fetchFailed(statusCode: Int?)` and `.keychainWriteFailed`.

### 4.3 Telemetry wiring

- `SSETransport.sendMessage(body:)` calls `LocalAuthMonitor.shared.record403Retry()` before forcing refresh.
- `A2ARegistryClient.performAuthorizedDataRequest` / `performAuthorizedGetRequest` record 403 retries.

### 4.4 Recovery UI

- `LocalAuthUIManager` (`rings/SR-01/LocalAuthUIManager.swift`) is configured from `main.swift` with the shared `LocalAuthProvider`.
- `QueenStatusViewModel` shows a "Local Auth" component with status, last-fetch age, 403-retry count, and action labels "Refresh" / "Reset".
- `QueenQuickActionsSheet.runAction(for:)` dispatches "Local Auth" to `viewModel.refreshLocalAuth()`.

### 4.5 Tests

- `LocalAuthProviderTests.swift`: cache, store fallback, fetch+save, forced refresh, concurrent dedup, store failures, new proactive refresh (stale/fresh), reset, status-code error.
- `LocalAuthMonitorTests.swift`: metadata updates, failure tracking, 403 counter, reset, proactive refresh heuristics, audit log contains no token value.

---

## 5. Three variants

### Variant A — Observability + proactive refresh + recovery UI (IMPLEMENTED)

- Client-side age-based proactive refresh (heuristic, no server changes).
- Token-free audit log and Queen UI status/actions.
- Lowest blast radius; closes visibility and recovery gaps immediately.

**Verdict:** chosen because it needs no BrowserOS changes and provides the telemetry required to decide between Variant B and C later.

### Variant B — Server-side token metadata + TTL (future)

- BrowserOS augments `GET /auth/local-token` with `issuedAt`/`expiresIn`.
- TriOS refreshes proactively at 75% of TTL and can display a countdown in the UI.
- Audit log gains precise expiry events.
- Pros: accurate, no heuristic guessing; cons: requires server changes and clock-skew handling.

**When to consider:** if the 5-minute heuristic in Variant A proves too aggressive or too lax, or if BrowserOS moves to JWT-style local tokens.

### Variant C — Biometric-gated high-value actions (future)

- Store the local-auth Keychain item with `SecAccessControl` `.biometryCurrentSet` + `.devicePasscode`.
- Manual "Reset Token" action triggers biometric approval before deletion.
- Background refresh uses `kSecUseAuthenticationUISkip` so it remains silent.
- Pros: strongest anti-exfiltration; cons: user prompts for recovery, complicates headless refresh.

**When to consider:** when the local-auth token protects higher-value operations (e.g., Keychain-secret proxying, privileged A2A skills) and physical-user presence is required for token reset.

---

## 6. Verification results

| Gate | Result |
|------|--------|
| `cargo run --bin clade-build` | PASS |
| `cargo run --bin clade-audit` | 0 findings |
| `cargo run --bin clade-seal` | SEAL VALID |
| `cargo run --bin clade-e2e` | PASS |
| `open trios.app` + `curl /health` | `{"status":"ok","cdpConnected":true}` |

Known environment note: `swift test` is unavailable in this CommandLineTools-only environment; verification uses the clade pipeline per `CLAUDE.md`.

---

## 7. Files changed

- `rings/SR-01/LocalAuthMonitor.swift` — new telemetry + audit actor.
- `rings/SR-01/LocalAuthProvider.swift` — monitor integration, proactive refresh, reset, richer errors.
- `rings/SR-01/LocalAuthUIManager.swift` — new MainActor recovery-action manager.
- `rings/SR-01/SSETransport.swift` — 403-retry telemetry.
- `rings/SR-02/A2ARegistryClient.swift` — 403-retry telemetry.
- `BR-OUTPUT/QueenStatusViewModel.swift` — Local Auth component + actions.
- `BR-OUTPUT/QueenQuickActionsSheet.swift` — Local Auth action dispatch.
- `main.swift` — configure `LocalAuthUIManager` with provider.
- `tests/TriOSKitTests/LocalAuthProviderTests.swift` — updated for new behavior.
- `tests/TriOSKitTests/LocalAuthMonitorTests.swift` — new test suite.

---

## 8. Menu-bar logo invariant

`trios.app` was relaunched after the final build. The status-bar logo is present and the app health endpoint is healthy.

---

*Cycle 22 complete — L1-L7 compliance maintained; no new shell scripts on critical path.*
