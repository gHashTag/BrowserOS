# Cycle 45 — TriOS LOGS tab saved searches / quick filters

## Research summary

### Competitors
- **Datadog Log Explorer** — saved views with name, query, time range, and columns; one-click recall from a sidebar.
- **Grafana** — saved Explore queries and dashboard variables; "Run query" button plus a query history dropdown.
- **Splunk** — saved searches and dashboards; quick filters pinned above results.
- **Kibana** — saved searches in Discover; filter bar shows active pills.
- **pino-ui / smart-log-viewer** — simple preset filter buttons (errors, warnings, slow queries) hardcoded in the UI.

### Common UX patterns
1. Small named chips above the search input for the most common views.
2. One click applies the full query; another click on the same chip clears it.
3. Add current query as a new chip with an inline label prompt.
4. Persistence is local JSON, not a remote index.

## Weak spots in current Cycle 44 implementation

1. **No reuse of common queries.** The user must retype `level:error source:cron` every time they open the LOGS tab.
2. **No quick presets for incident triage.** There are no one-tap views for "errors only", "companion errors", or "drift events".
3. **No saved state across app restarts.** The search box resets on every tab appear.
4. **Source filter chips only hide/show sources.** They do not combine level + source in one action, which is a frequent need.
5. **No way to share a query within the app.** Saved searches would let the user describe a diagnostic view to another operator.

## Decomposed plan

### 1. Spec (done)
- `.trinity/specs/logs-tab-saved-searches.md`

### 2. Saved-search model
- Add `LogSavedSearch` struct to `LogParser.swift`:
  - `id: String`, `label: String`, `query: String`
- Add `LogSavedSearchStore` actor:
  - `load() -> [LogSavedSearch]` — returns defaults if file missing or malformed.
  - `save(_ searches: [LogSavedSearch])` — writes JSON to `.trinity/state/logs_saved_searches.json`.
  - Built-in defaults:
    - "Errors only" → `level:error`
    - "Cron warnings" → `source:cron level:warn`
    - "Companion errors" → `source:companion level:error`
    - "Drift events" → `event:drift`

### 3. UI additions
- Add `@State private var savedSearches: [LogSavedSearch] = []` and `@State private var activeSavedSearchID: String?` to `LogsTabView`.
- Load saved searches in `loadAll` (or `onAppear`) via `Task { let list = await LogSavedSearchStore().load() ... }`.
- Add a `quickFiltersBar` view above `filterBar` with horizontal scroll of chips.
- Chip styling: accent border when active, muted otherwise, delete button via context menu.
- "+" chip triggers an alert with a text field for the label; if accepted, appends `LogSavedSearch(id: UUID, label: label, query: searchText)` and saves.
- A small context menu on any chip (or a trailing "Defaults" button) resets to built-ins.

### 4. Interaction
- Clicking a chip sets `searchText = search.query` and `activeSavedSearchID = search.id`.
- If the user edits `searchText` and it no longer matches the active saved query, clear `activeSavedSearchID`.
- For simplicity in this cycle, do not auto-clear on manual editing; only update `activeSavedSearchID` when a chip is clicked.

### 5. Tests
- `LogsTabViewTests.swift`:
  - `testSavedSearchStoreProvidesDefaultsWhenFileMissing`
  - `testSavedSearchStorePersistsAndReloads`
  - `testSavedSearchAppliesQuery`

### 6. Verification gates
- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e`
- `open trios.app` to preserve the menu-bar logo.

### 7. Report + future options
- Report at `.claude/plans/trios-cycle45-logs-tab-saved-searches-report.md`.
- Three future options at loop handoff.
- Experience episode at `.trinity/experience/2026-07-24_logs-tab-saved-searches-loop-045.json`.
- Update `.trinity/experience.md` and user memory.
