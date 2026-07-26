# Cycle 13: Background Model Health Poller

## 1. Weak spots of Cycle 12 (preflight health check)

| Weak spot | Impact | How the poller fixes it |
|---|---|---|
| On-send latency | Every first request waits for a probe | Probes run in the background; send path reads cached state |
| Only selected model is checked | User discovers other models are broken only after switching | All `availableModels` are probged periodically |
| No recovery signal | A model that comes back online stays marked unavailable until user clicks Health or sends a message | Periodic refresh clears `unhealthyModels` when probes return `.healthy` |
| Manual trigger | Health button requires user action | Fully autonomous with visible last-check timestamp |
| No observability | Health state is hidden unless the Models tab is open | LogsTab gets a health event row; Models tab shows last check time |

## 2. Competitor / reference research

- **Cursor / VS Code extensions** — show a static model picker with no live probe; rely on the user retrying after an error.
- **Continue.dev** — probes connectivity lazily when the user sends a message; no background polling, similar to our Cycle 12.
- **OpenRouter status page** — human-readable page, not API-integrated.
- **Anthropic / OpenAI status APIs** — provider-level, not model-level; do not expose per-model health.
- **Ollama `/api/tags`** — free model inventory check, already used in Cycle 12.
- **Kubernetes readiness probes** — periodic probes with success/failure threshold and backoff; our two-failure threshold mirrors this.
- **Prometheus blackbox exporter** — periodic HTTP/S probe with scrape interval; we adapt the same interval-driven model.

**Differentiation:** trios combines provider-level `max_tokens:1` ping and Ollama `/api/tags` into a single model-level poller with SwiftUI badges and automatic chat failover.

## 3. Decomposed plan

### Phase 1 — Issue / spec
- Define the poller as an autonomous background service owned by `ModelConfigurationStore`, not by `ChatViewModel`.
- Decide interval: default 60 s, pause when app is backgrounded, resume on foreground.

### Phase 2 — TDD
- Add `BackgroundHealthPoller` actor with `start(interval:)`, `stop()`, and `forceRefresh()`.
- Add `ModelConfigurationStore` hooks: `startBackgroundHealthChecks()`, `stopBackgroundHealthChecks()`, `lastHealthCheck: Date?`.
- Add UI bindings in `ModelsTabView`: last-check label, enable/disable toggle, manual Refresh + Health buttons remain.
- Add tests: mock health service confirms polling updates `unhealthyModels` and stops/resumes correctly.

### Phase 3 — Code
1. Create `rings/SR-00/BackgroundHealthPoller.swift`.
2. Extend `ModelConfigurationStore` with poller ownership, start/stop, and last-check publishing.
3. Wire `startBackgroundHealthChecks()` from `main.swift` after `ModelConfigurationStore.shared` is used.
4. Update `ModelsTabView` to show last-check time and a toggle.
5. Add log lines to `LogsTabView` health events (optional, if time allows).

### Phase 4 — Seal
- `./build.sh` must pass.
- `cargo test --workspace` must pass.
- `cargo clippy --workspace --all-targets --all-features -- -D warnings` must pass.
- `clade-audit` and `clade-seal` must pass.
- Relaunch `trios.app`.

### Phase 5 — Learn
- Capture that background tasks must be owned by a singleton/store, not a ViewModel, to survive UI lifecycle.

## 4. Verification gates

- [ ] Build gate: `./build.sh` 0 errors.
- [ ] Rust gate: `cargo test --workspace` all pass.
- [ ] Clippy gate: 0 warnings.
- [ ] Audit gate: `clade-audit` 0 hard findings.
- [ ] Seal gate: `clade-seal` reports `SEAL VALID`.
- [ ] UI gate: Models tab shows last check time and toggle.
- [ ] Manual gate: Health button still works and overrides poller.

## 5. Three next-loop options

1. **Provider-native status integration** (recommended) — read provider status pages (OpenRouter `/api/v1/models?enabled=true`, Anthropic status RSS) and blend with live probes.
2. **Persistent reliability scorecard** — store per-model success/failure history in `agent-memory.sqlite3` and rank models by uptime score.
3. **Predictive pre-selection** — use health history to auto-select the cheapest healthy model at app launch / provider switch.
