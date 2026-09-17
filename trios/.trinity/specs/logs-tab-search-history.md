# Spec — TriOS LOGS tab search history / recent queries

**Cycle:** 46  
**Ring:** SR-02 / BR-OUTPUT  
**Road:** B  
**Closes:** #46

## Goal

Persist the last N structured queries the user actually ran in the LOGS tab and surface them as a one-tap "recent searches" chip row, separate from curated saved searches. Reduce retyping of common ad-hoc investigations.

## Invariants

- Recent searches are **ephemeral history**, not curated favorites; they coexist with `LogSavedSearch` quick filters.
- History is local-only in this cycle (cross-machine sync is a future option).
- Empty queries are never recorded.
- Duplicate queries are deduplicated by moving the existing entry to the front (LRU order).
- A query that exactly matches a saved search may still appear in history; do not merge the lists.
- Recording must not block the main thread or flood disk on every keystroke.

## Data model

```swift
struct LogRecentSearch: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let query: String
    let timestamp: Date
}
```

```swift
actor LogRecentSearchStore {
    private let path: String
    private let maxCount: Int
    init(path: String = "\(ProjectPaths.trinity)/state/logs_search_history.json", maxCount: Int = 20)
    func load() -> [LogRecentSearch]
    func record(query: String)             // dedupe, move-to-front, trim, persist
    func remove(id: String)
    func clear()
}
```

## UX

- A "Recent" chip row appears between the saved-search quick filters and the search field, only when history is non-empty.
- Each chip shows the query string truncated to ~30 characters and a clock icon.
- Tapping a chip applies the query to the current source (same as quick filters).
- Right-click / context menu offers: **Apply**, **Remove from history**, **Save to quick filters**.
- A "Clear" button at the end of the row clears all history after confirmation.
- History is recorded:
  - When the user presses Enter in the search field (`TextField.onSubmit`).
  - When the user taps a saved-search quick-filter chip (the resolved query becomes recent).
  - When the search text has been stable for 3 seconds (debounce) and is non-empty.

## Test criteria

- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` passes.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` passes.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` reports 0 hard-gate findings.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` is SEAL VALID.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e` passes.
- Unit tests cover default empty load, record/dedupe/move-to-front, cap enforcement, remove, clear, and UI application.
- `open trios.app` relaunched to fresh binary; menu-bar logo preserved.
