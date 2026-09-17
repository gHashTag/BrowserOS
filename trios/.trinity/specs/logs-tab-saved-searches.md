# Cycle 45 Spec — TriOS LOGS tab saved searches / quick filters

## Goal

Let the user save, recall, and one-tap-apply frequently-used LOGS tab queries. A small library of named filters appears above the search box so common triage views ("errors only", "cron warnings", "browseros companion errors") are one click away.

## Invariants

- Saved searches are stored per-user in a lightweight JSON file under `.trinity/state/logs_saved_searches.json`.
- A saved search stores only the raw query string and a label; it is applied exactly as if the user typed the query.
- Default built-in searches are provided when the file is missing.
- Users can add the current query, delete a saved search, and reset to defaults.
- No new external dependencies.

## UX

- Horizontal scrollable chip row above the search box titled "Quick filters".
- Each chip shows the label and, on hover/long-press, a delete button.
- Clicking a chip applies the saved query string to `searchText`.
- A "+" chip saves the current `searchText` (prompts for a label inline).
- A "Reset" menu action restores built-in defaults.

## Data model

```json
[
  { "id": "errors-only", "label": "Errors only", "query": "level:error" },
  { "id": "cron-warn", "label": "Cron warnings", "query": "source:cron level:warn" },
  { "id": "companion-errors", "label": "Companion errors", "query": "source:companion level:error" },
  { "id": "drift-events", "label": "Drift events", "query": "event:drift" }
]
```

## Architecture

- Add `LogSavedSearch` struct and `LogSavedSearchStore` actor to `LogParser.swift`.
- `LogSavedSearchStore.load()` reads from `.trinity/state/logs_saved_searches.json`; if missing, returns defaults.
- `LogSavedSearchStore.save(_ searches:)` writes the file.
- `LogsTabView` loads the store on appear, renders the chip row, handles apply/add/delete/reset.
- Inline label prompt uses a simple `Alert` with a `TextField` via `@State private var newSearchLabel` and `showingSaveSearchAlert`.

## Test criteria

- `LogsTabViewTests`:
  - `testSavedSearchStoreProvidesDefaultsWhenFileMissing`
  - `testSavedSearchStorePersistsAndReloads`
  - `testSavedSearchAppliesAsQuery`

## Canon files

- `trios/rings/SR-02/LogParser.swift`
- `trios/BR-OUTPUT/LogsTabView.swift`
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift`

## Verification gates

- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e`
- `open trios.app` to preserve the menu-bar logo.
