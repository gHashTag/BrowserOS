# Cycle 13 Report — Background Model Health Poller

## What was implemented

### Core service
- New `rings/SR-00/BackgroundHealthPoller.swift` (`@MainActor` class):
  - `start()` — begins a `Task.sleep`-driven loop (default 60 s).
  - `stop()` — cancels the loop.
  - `forceRefresh()` — runs one synchronous refresh and waits.
  - Publishes `isRunning` and `lastCheckAt`.

### Store integration
- `ModelConfigurationStore` now owns the poller:
  - Starts automatically in `init()` when `isBackgroundHealthPollingEnabled` is `true`.
  - `restartBackgroundHealthChecks()` is called after provider, base URL, API key changes.
  - `setBackgroundHealthPollingEnabled(_:)` persists to `UserDefaults` and starts/stops the loop.
  - `refreshHealth()` now removes models that report `.healthy` from `unhealthyModels`, enabling recovery detection.
  - New published `lastHealthCheckAt` and `isBackgroundHealthPollingEnabled`.

### UI
- `BR-OUTPUT/ModelsTabView.swift`:
  - Added an **Auto** toggle next to Refresh/Health.
  - Added a "Last check: …" relative timestamp line below the toolbar.

### Tests
- `tests/TriOSKitTests/ChatFailureTests.swift`:
  - `testBackgroundPollerUpdatesUnhealthyModels`
  - `testBackgroundPollerStopsAndResumes`
  - `testHealthyModelRecoversFromUnhealthy`

XCTest is not available in this toolchain (CommandLineTools only), so the new tests compile with the SPM target but were not executed locally.

## Verification results

| Gate | Result |
|---|---|
| `./build.sh` | ✅ Swift + Rust build, ChatSSEEndToEnd tests passed |
| `cargo test --workspace` | ✅ all crates passed |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | ✅ clean |
| `cargo run --bin clade-audit` | ✅ 0 findings across 8 checks |
| `cargo run --bin clade-seal` | ✅ `SEAL VALID` |
| App relaunch | ✅ `open trios.app` |

Commit: `3a069040a feat(trios): background model health poller` on `dev`.

## Weak spots addressed

| Before (Cycle 12) | After (Cycle 13) |
|---|---|
| Probe ran synchronously on send | Health state is refreshed in the background |
| Only the selected/fallback model was checked | All `availableModels` are probed periodically |
| Unhealthy models stayed marked until manual action | Healthy probes recover models automatically |
| Health button required user action | Fully autonomous with on/off toggle |
| No visibility into when health was last checked | Models tab shows relative last-check time |

## Three next-loop options

1. **Provider-native status integration** (recommended) — augment live probes with provider status endpoints (OpenRouter `/api/v1/models?enabled=true`, provider status pages). This avoids burning API calls on provider-wide outages and gives faster global-down detection.

2. **Persistent reliability scorecard** — store per-model success/failure counts in `agent-memory.sqlite3`, compute an uptime score, and surface a sorted "Most reliable" section in the Models tab. Builds a long-term quality signal beyond the current TTL cache.

3. **Predictive pre-selection** — use the health/unhealthy history to auto-select the cheapest healthy model when the app launches, the user switches provider, or the current selection becomes unavailable. Removes even the preflight switch step from the chat path.
