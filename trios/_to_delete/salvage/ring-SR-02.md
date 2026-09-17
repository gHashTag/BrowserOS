# Ring SR-02 — Application-layer business logic (trios)

**Scope:** ViewModels, parsers, and business logic that sit between raw system state (SR-00/SR-01) and the BR-OUTPUT UI layer. Files in `rings/SR-02/*.swift` are canon/generated artifacts per `.trinity/SOUL.md` Article IX.

---

## Responsibility summary

- Transform raw logs, events, chat streams, and agent state into models the UI can render.
- Own lightweight persistence for UI preferences that do not require encryption or SQLite (`*.json` under `.trinity/state/`).
- Provide testable, pure helper types (filters, parsers, sizers, proposers) that can be unit-tested without launching the app.

---

## Known pitfalls

- **Hard-coded rule arrays become opaque.** A static tuple of filter patterns cannot be inspected, disabled, or extended by users. Move rules into `Codable` structs and expose a profile model.
- **Defaults must not leak into persisted JSON.** Store only user-created overrides; ship built-in defaults as code. Re-merging at runtime keeps defaults upgradable and avoids stale copies in user data.
- **Best-effort file I/O needs round-trip tests.** `try?` persistence can fail silently; verify with temp paths in unit tests.
- **Contextual rule derivation must guard against broad patterns.** A "hide like this" action based on a single token (number, common word, severity label) will over-filter. Reject short/common tokens and prefer structured fields before falling back to raw substrings.
- **Actors serialize, not optimize.** For lightweight JSON preferences an actor is fine; for high-frequency or large-data access, prefer a database or buffered writer.

---

## Verified patterns

### 1. Immutable defaults merged with mutable user overrides

Use a profile model that keeps built-in rules as `static let` code and user rules as a persisted array.

Example from `rings/SR-02/LogParser.swift`:

```swift
struct LogNoiseProfile: Codable, Equatable, Sendable {
    var customRules: [LogNoiseRule]
    static let defaultRules: [LogNoiseRule] = [...]
    var allRules: [LogNoiseRule] { LogNoiseProfile.defaultRules + customRules }
}
```

The store (`LogNoiseProfileStore`) persists only `customRules`. The filter evaluates `profile.allRules`, so product defaults can be improved in future releases without migrating stored user data.

**When to reuse:** any feature that ships sensible defaults plus user overrides — filters, allowed/block lists, sampling rules, default searches, theme tokens.

### 2. Derive a contextual rule from a parsed row with preview impact

A "Hide events like this" action needs to:
1. Extract the most specific structured matcher first (`event`, then `message` phrase, then raw substring).
2. Reject overly broad candidates (short tokens, pure numbers, common words).
3. Show how many existing rows would match before the user commits.

Example from `LogNoisePatternProposer.propose(from:)` + `LogsTabView.countLinesMatching(_:)`:

```swift
let rule = LogNoisePatternProposer.propose(from: line)
let previewCount = countLinesMatching(rule)   // runs filter over loaded sources
```

The sheet renders `"matches \(previewCount) lines"` and disables the action when the rule is invalid or empty.

**When to reuse:** any UI affordance that creates a filter/alert/ignore rule from a concrete item — log noise, inbox filters, error suppression, notification muting.

### 3. Lightweight preference persistence via a JSON actor store

For small UI state that does not need encryption or relational queries, use an `actor` that reads/writes a single JSON file under `.trinity/state/`.

Example from `LogNoiseProfileStore`:

```swift
actor LogNoiseProfileStore {
    private let path: String
    init(path: String = "\(ProjectPaths.trinity)/state/logs_noise_profile.json") { ... }
    func load() -> LogNoiseProfile { ... }
    func save(_ profile: LogNoiseProfile) { ... }
}
```

Rules:
- Create the parent directory on every save.
- Return a sensible default when the file is missing or corrupt.
- Keep the store path overridable for tests.

**When to reuse:** saved searches, recent queries, noise profiles, view toggles, last-used export paths, and other per-user UI state that is safe at rest in plain JSON.

---

## Recent changes

- **Cycle 49 (2026-07-27):** User-configurable log noise profiles in `LogParser.swift`. Added `LogNoiseRule`, `LogNoiseProfile`, `LogNoiseProfileStore`, `LogNoisePatternProposer`, and wired them into `BR-OUTPUT/LogsTabView.swift`. See `.trinity/experience/2026-07-27_logs-tab-user-noise-profiles-loop-049.json`.
- **Cycle 48 (2026-07-27):** Hard-coded noise filter and reader-side log rotation policy in `LogParser.swift`.
- **Cycles 41-47 (2026-07-24/27):** Structured log parser, live tail, scroll-aware follow, structured search, saved searches, recent searches, and cross-source correlated timeline.

---

## Tests to run after changes here

- `./build.sh`
- `cargo run --bin clade-build`
- `cargo run --bin clade-e2e`
- `cargo run --bin clade-audit` (0 hard-gate findings)
- `cargo run --bin clade-seal` (SEAL VALID)
- `cargo test -p trios-mesh`
- Relaunch `open trios.app` and confirm the menu-bar logo is present (`.claude/rules/cron-life.md`).
