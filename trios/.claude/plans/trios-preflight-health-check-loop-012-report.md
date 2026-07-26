# TriOS Preflight Model Health Check — Cycle 12 Report

**Date:** 2026-07-26  
**Branch:** `dev`  
**Previous cycle:** Cycle 11 auto-failover + LOGS tab at Cmd+3.

---

## 1. What was implemented

| Area | Change | File |
|---|---|---|
| Health probe service | New `ModelHealthService` actor with cached, TTL-based probes. Cloud providers get a `max_tokens:1` ping; Ollama gets free `/api/tags` existence check. Two-failure threshold before marking `.unavailable`. | `rings/SR-00/ModelHealthService.swift` |
| Store health state | `ModelConfigurationStore` now tracks `unhealthyModels`, exposes `healthStatus(for:)`, `refreshHealth()`, `selectFirstHealthyModel()`, and invalidates health on provider/baseURL/key changes. | `rings/SR-00/ModelConfigurationStore.swift` |
| Preflight in chat | `ChatViewModel.sendMessage` probes the selected model before `executeStream`. If unavailable, it switches to the first healthy fallback and posts a system banner so the user sees the switch. | `rings/SR-02/ChatViewModel.swift` |
| Post-error marking | Any transport error now marks the failing model as unhealthy so the next preflight avoids it. | `rings/SR-02/ChatViewModel.swift` |
| Models tab UI | Added "Health" button, red unavailable badges, disabled selection for unhealthy models, and an unavailable badge on the active model. | `BR-OUTPUT/ModelsTabView.swift` |

---

## 2. Verification

- `bash trios/build.sh` — pass (115 Swift files, QueenUILib rebuilt, ChatSSEEndToEnd passed).
- `cargo test --workspace` — all pass.
- `cargo clippy --workspace --all-targets --all-features -- -D warnings` — clean.
- `trinity_999_tab_map_test.swift` standalone — pass.
- `curl http://127.0.0.1:9105/health` — `{"status":"ok"}`.
- `trios.app` relaunched; menu-bar logo process alive.

> Swift `XCTest` was skipped in this environment (CommandLineTools only, no full Xcode), so the new `ChatFailureTests` preflight cases were added but not executed here. They will run on CI or a machine with Xcode.

---

## 3. Three cooperation options for next loop

### Option 1 — Background health poller
Run a periodic background task (every 60s) that probes all known models and updates the picker proactively. Removes on-send latency entirely but adds steady background load.

### Option 2 — Persistent reliability scorecard
Store per-model success/failure counts in `agent-memory.sqlite3`/UserDefaults, compute a rolling reliability score, and use it to auto-rank `fallbackModels`. Learns from real usage but needs convergence time and telemetry consent.

### Option 3 — Provider-native status integration
For OpenRouter, consume `/models/{id}/endpoints` latency/uptime feed; for Anthropic/OpenAI/Z.AI, use their status pages or model list endpoints. Avoids paid pings but is provider-specific and fragile when providers change shape.

**Recommendation:** Option 1 next, because it removes the need for on-send latency entirely and builds directly on the preflight health cache landed in this cycle.

---

## 4. Competitor references

- OpenRouter Models API: https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
- OpenRouter availability skill: https://github.com/jeremylongshore/claude-code-plugins-plus-skills/blob/main/plugins/saas-packs/openrouter-pack/skills/openrouter-model-availability/SKILL.md
- LiteLLM Health Check Driven Routing: https://docs.litellm.ai/docs/proxy/health_check_routing
- LiteLLM Fallbacks: https://docs.litellm.ai/docs/proxy/reliability
- LiteLLM Pre-Call Checks: https://docs.litellm.ai/docs/routing#pre-call-checks-context-window-eu-regions
- Cursor Router blog: https://cursor.com/blog/router
- Cursor auto switch bug: https://forum.cursor.com/t/bug-when-switching-to-auto-if-other-models-are-not-avilable/155161
- Claude Code fallback docs issue: https://github.com/anthropics/claude-code/issues/65782
- Claude Code fallback bug: https://github.com/anthropics/claude-code/issues/8413
