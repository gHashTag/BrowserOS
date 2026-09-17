# Cycle 44 — TriOS LOGS tab structured search and export

## Research summary

### Competitors
- **Datadog Log Explorer** — `status:error service:my-service @foo:bar` query syntax; export to CSV/JSON from the same query.
- **Grafana Loki** — LogQL `{app="foo",level="warn"} |= "search term"` with label filters and line filters.
- **Splunk** — `index=main source=*cron.log level=error search_term` and export to CSV.
- **Kibana** — KQL `level:warn AND message:timeout` with Discover export.
- **pino-ui / smart-log-viewer** — lightweight free-text + level filter and JSONL export.

### Common UX patterns
1. A single search box accepts both structured key:value tokens and free text.
2. Minimum-level filtering is the most used structured filter.
3. Source filtering is the second most used filter.
4. Export uses the same query result currently shown on screen.
5. Filename includes source and timestamp.

## Weak spots in current Cycle 43 implementation

1. **Search is substring-only over message/event/details.** There is no way to search by source, level, or metadata without scrolling through unrelated lines.
2. **No structured query.** The user cannot write `level:error source:cron connection` to narrow results; they must rely on the min-level chips and free text separately.
3. **No export.** Once the user has a useful filtered/deduplicated view, they cannot save it to a file for sharing or post-mortem analysis.
4. **No visual feedback for active structured tokens.** The search box shows raw text, but the user cannot see which parts were parsed as structured filters.
5. **Copy copies all filtered lines but not to disk.** A full-file Copy is fine for clipboard, but large filtered sets need a file export.

## Decomposed plan

### 1. Spec (done)
- `.trinity/specs/logs-tab-structured-search.md`

### 2. Query model
- Add `LogQueryToken` enum to `LogParser.swift`:
  - `.level(LogLevel)` — minimum level
  - `.source(String)` — substring of source id or display name
  - `.event(String)` — substring of event name
  - `.text(String)` — free text across message/event/details/metadata values
- Add `LogParser.parseQuery(_:) -> [LogQueryToken]`.
- Add `LogParser.matchesQuery(_ line: ParsedLogLine, tokens: [LogQueryToken], source: LogSource) -> Bool`.

### 3. Filtering integration
- Update `LogsTabView.filteredLines(for:)` to parse the query once and call `LogParser.matchesQuery` instead of the current ad-hoc filter.
- Keep min-level chips as a fast pre-filter; the `.level` token, if present, can override or combine.
- Keep deduplicate toggle behavior unchanged.

### 4. Export
- Add `LogParser.exportLines(_ lines: [ParsedLogLine], to path: String) -> Bool`.
- Add `LogsTabView.exportFilteredLines(_ source:)` that computes the export directory (`~/Downloads` preferred), builds a timestamped filename, and writes the filtered raw lines.
- Add an "Export" button in the selected-log detail header next to "Copy".
- Show a short status confirmation (still as a transient UI hint if possible; here we update a small `@State var lastExportPath` text below the header).

### 5. Active-filter hint
- Render a small chip row below the search box showing parsed structured tokens so the user sees the query interpretation.

### 6. Tests
- `LogsTabViewTests.swift`:
  - `testQueryParserExtractsLevelSourceAndEventTokens`
  - `testQueryParserFallsBackToFreeText`
  - `testLevelTokenMatchesMinimumLevel`
  - `testSourceTokenMatchesSourceIDAndDisplayName`
  - `testEventTokenMatchesEventSubstring`
  - `testFreeTextMatchesMessageDetailsAndMetadata`
  - `testCombinedTokensRequireAllToMatch`
  - `testExportWritesFilteredLines`

### 7. Verification gates
- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e`
- `open trios.app` to preserve the menu-bar logo.

### 8. Report + future options
- Report at `.claude/plans/trios-cycle44-logs-tab-structured-search-report.md`.
- Three future options at loop handoff.
- Experience episode at `.trinity/experience/2026-07-24_logs-tab-structured-search-loop-044.json`.
- Update `.trinity/experience.md` and user memory.
