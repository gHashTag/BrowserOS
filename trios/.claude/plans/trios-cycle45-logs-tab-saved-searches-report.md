# Cycle 45 Report — TriOS LOGS tab saved searches and quick filters

**Date:** 2026-07-24  
**Issue:** Closes #45  
**Ring:** SR-02 / BR-OUTPUT  
**Road:** B  
**Agent:** claude

## Summary

Cycle 44 gave the LOGS tab a structured query DSL and export. The remaining weak spot was that useful queries had to be retyped every session — there was no way to persist common filters or expose them as one-tap chips. Cycle 45 added saved searches / quick filters.

`LogParser` now exposes `LogSavedSearch` (`id`, `label`, `query`) and a `LogSavedSearchStore` actor that persists to `.trinity/state/logs_saved_searches.json` and provides sensible defaults (`Errors only`, `Cron warnings`, `Companion errors`). `LogsTabView` gained a quick-filters bar above the search field: tapping a chip instantly applies the saved query to the current source; an inline "+" button opens an alert to save the current query under a custom label; right-clicking/long-pressing a chip (or a small trash icon) deletes it; a reset action restores the defaults. The filter text field and token chips update immediately when a quick filter is selected.

## Files changed

- `trios/rings/SR-02/LogParser.swift`
- `trios/BR-OUTPUT/LogsTabView.swift`
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift`
- `trios/.trinity/specs/logs-tab-saved-searches.md`
- `trios/.claude/plans/trios-cycle45-logs-tab-saved-searches.md`
- `trios/.claude/plans/trios-cycle45-logs-tab-saved-searches-report.md`
- `trios/.trinity/experience/2026-07-24_logs-tab-saved-searches-loop-045.json`

## Verification

- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` — PASS
- `cargo test -p trios-mesh` — PASS (101 tests)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` — PASS
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` — PASS (0 hard-gate findings)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` — SEAL VALID
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e` — PASS
- `open trios.app` — relaunched to fresh binary, menu-bar logo preserved (PID 8586)

`swift test` remains unavailable in this CommandLineTools-only environment.

## Research sources

- [Datadog Log Search Syntax](https://docs.datadoghq.com/logs/explorer/search_syntax/)
- [Grafana Loki LogQL](https://grafana.com/docs/loki/latest/query/)
- [Splunk Search Reference](https://docs.splunk.com/Documentation/Splunk/latest/SearchReference/Whatsinthismanual)
- [Kibana Query Language](https://www.elastic.co/guide/en/kibana/current/kuery-query.html)
- [pino-ui](https://github.com/sergiofilhowz/pino-ui)
- [smart-log-viewer](https://github.com/timabell/smart-log-viewer)

## Three future options

1. **Search history and recent queries** — keep a rolling list of the last N executed queries (separate from saved favorites) and surface them as a dropdown or "recent" chip group under the search field.
2. **Cross-machine / shared saved searches** — sync named searches via the encrypted recovery package or a lightweight BrowserOS preference endpoint so the same quick filters appear on every TriOS instance tied to the user.
3. **Advanced query operators** — extend the structured DSL with negation (`-level:info`), wildcards (`source:*cron*`), numeric comparisons (`level>=warn`), and quoted phrases to rival Datadog / Splunk log search ergonomics.
