# Cycle 44 Spec — TriOS LOGS tab structured search and export

## Goal

Add a small structured query language and export action to the LOGS tab so the user can filter by level, source, event, and free-text terms, then save the filtered results to a file.

## Invariants

- The existing search box stays as the primary input.
- Query tokens may be combined with free text; all tokens must match.
- Unknown keys fall back to free-text matching.
- Export only writes filtered rows, never hidden or filtered-out rows.
- Exported files land in a predictable directory (`ProjectPaths.triOSExportDirectory` or `~/Downloads`) with a timestamped name.

## Query DSL (simple key:value)

Supported keys:
- `level:` one of `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Accepts a minimum level prefix (e.g. `level:warn` matches warn/error/fatal).
- `source:` source id prefix or display-name substring (e.g. `source:cron`, `source:queen`).
- `event:` event name substring for event-log lines (e.g. `event:heartbeat`).
- Any other token is searched as free text across message, event, details, and metadata values.

Examples:
- `level:error connection timeout`
- `source:companion level:warn`
- `event:drift_detected`

## Export

- Button in the selected-log detail header, next to "Copy".
- Saves the same rows the user currently sees (respecting search, min level, and deduplicate toggle) as newline-delimited text.
- Filename: `trios-logs-{sourceID}-{yyyyMMdd-HHmmss}.log`.
- Writes to `~/Downloads` if writable, else to the trios working directory.

## Architecture

- Add `LogQueryToken` enum to `LogParser.swift`.
- Add `LogParser.parseQuery(_:) -> [LogQueryToken]`.
- Add `LogParser.matchesQuery(_ line: ParsedLogLine, tokens: [LogQueryToken], source: LogSource) -> Bool`.
- Add `LogParser.exportLines(_ lines: [ParsedLogLine], to path: String) -> Bool`.
- Update `LogsTabView.filteredLines(for:)` to use `LogParser.matchesQuery`.
- Add `exportFilteredLines(_ source:)` and an "Export" button in the detail header.

## Test criteria

- `LogsTabViewTests`:
  - `testQueryParserExtractsLevelSourceAndEventTokens`
  - `testQueryParserFallsBackToFreeText`
  - `testLevelTokenMatchesMinimumLevel`
  - `testSourceTokenMatchesSourceIDAndDisplayName`
  - `testEventTokenMatchesEventSubstring`
  - `testFreeTextMatchesMessageDetailsAndMetadata`
  - `testCombinedTokensRequireAllToMatch`
  - `testExportWritesFilteredLines`

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
