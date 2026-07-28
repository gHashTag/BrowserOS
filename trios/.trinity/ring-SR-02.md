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

### 4. Optional metadata scoping with global fallback

A rule that matches content should be able to apply globally or only to selected sources. Use an optional collection where `nil` / empty means "all sources"; this preserves existing behavior without migration.

Example from `LogNoiseRule`:

```swift
struct LogNoiseRule: Codable, Equatable, Identifiable, Sendable {
    var sourceIDs: [String]?   // nil / empty = global

    func applies(toSourceID sourceID: String) -> Bool {
        guard let ids = sourceIDs, !ids.isEmpty else { return true }
        return ids.contains(sourceID)
    }
}
```

The filter checks scope before content so a source-scoped rule never matches a different source. The UI passes `availableSources` to the rule editor and pre-fills the source from the row that invoked **Hide events like this**.

**When to reuse:** any rule/filter/alert that could have different signal/noise semantics depending on origin — log suppression, notification muting, error grouping, or allow/block lists by source/host/service.

### 5. Portable export/import with schema versioning

Small preference models should be back-uppable and shareable. Wrap the persisted array in a versioned envelope so future fields can be migrated safely, and keep the local store format unchanged.

Example from `LogNoiseProfileStore`:

```swift
struct LogNoiseProfileEnvelope: Codable, Equatable, Sendable {
    var schemaVersion: Int   // current = 1
    var exportedAt: Date?
    var rules: [LogNoiseRule]
}

func exportRules(_ rules: [LogNoiseRule], to directory: String) -> URL? { ... }
func importRules(from url: URL) -> LogNoiseImportResult { ... }
```

Rules:
- Local store format stays unchanged; only portable files use the envelope.
- Reject schema versions newer than the app understands.
- Validate each imported item and report skipped count.
- Merge imported items by identity, replacing duplicates and prepending new ones.

**When to reuse:** any user-tuned configuration that should survive reinstalls, be shared with teammates, or be loaded from runbooks — filters, saved searches, view layouts, allowed/block lists.

- Keep the store path overridable for tests.

**When to reuse:** saved searches, recent queries, noise profiles, view toggles, last-used export paths, and other per-user UI state that is safe at rest in plain JSON.

### 6. Frequency-based auto-suggest for filters and rules

A filter UI should proactively propose new rules by analyzing the data it already shows, not wait for the user to manually construct every rule. Keep the proposer deterministic, local, and source-scoped so suggestions are testable and safe to surface.

Example from `LogNoiseSuggester` in `LogParser.swift`:

```swift
enum LogNoiseSuggester {
    static func suggest(
        from sources: [LogSource],
        profile: LogNoiseProfile,
        minOccurrences: Int = 5,
        topN: Int = 10
    ) -> [LogNoiseSuggestion]
}
```

Rules:
- Prefer structured matchers (`event`) over raw text phrases.
- Skip candidates already suppressed by the active profile to avoid duplicates.
- Count real matched lines and rank suggestions by impact (`matchedCount`).
- Reject overly broad fallback phrases (short tokens, pure numbers, common words like `info`, `debug`, `ok`).
- Scope each suggestion to the source it came from so a noisy companion pattern does not hide signal in queen logs.

**When to reuse:** any rule/filter UI where users build up a personal or runbook profile from observed data — log noise, inbox filters, notification muting, error suppression, allow/block lists.

### 7. Separate live runtime sources from transient build/test artifacts

A log reader that treats every `.log` file as a live source will drown users in build artifacts, test harness output, and launchd stdout/stderr. Tag each source with a category and default the UI to only runtime/service logs, with an opt-in toggle for artifacts.

Example from `LogParser.swift`:

```swift
enum LogSourceCategory: String, CaseIterable, Equatable, Sendable {
    case runtime
    case service
    case build
    case test
    case artifact
}

static func loadLogSources(includeArtifacts: Bool = false, maxLinesPerSource: Int = 500) -> [LogSource] {
    let loaded: [LogSource] = ...
    guard includeArtifacts else {
        return loaded.filter { $0.category == .runtime || $0.category == .service }
    }
    return loaded
}
```

Rules:
- Classify by filename pattern, not by folder, so the policy is self-describing and easy to test.
- Default to hiding build/test artifacts from the main view.
- Pair the UI toggle with a `UserDefaults` key so the choice persists.
- Cap each artifact family at a small number (e.g. 10) in the scripts/binaries that produce them, so the log directory cannot grow without bound even if the app is never opened.

**When to reuse:** any log/event reader, file browser, or status dashboard that ingests both live operational data and transient build/test output.

---

## Recent changes

- **Cycle 52 (2026-07-27):** Noise rule auto-suggest based on loaded-log frequency. Added `LogNoiseSuggestion`, `LogNoiseSuggester`, and a "Suggested rules" section in `BR-OUTPUT/LogsTabView.swift`. See `.trinity/experience/2026-07-27_logs-tab-noise-rule-auto-suggest-loop-052.json`.
- **Cycle 51 (2026-07-27):** Noise profile import/export with schema versioning. Added `LogNoiseProfileEnvelope`, `LogNoiseImportResult`, `exportRules`/`importRules` on `LogNoiseProfileStore`, and Import/Export buttons in `BR-OUTPUT/LogsTabView.swift`. See `.trinity/experience/2026-07-27_logs-tab-noise-profile-import-export-loop-051.json`.
- **Cycle 50 (2026-07-27):** Per-source noise rules (`sourceIDs` scope) in `LogParser.swift` and source-scope editor in `BR-OUTPUT/LogsTabView.swift`. See `.trinity/experience/2026-07-27_logs-tab-per-source-noise-profiles-loop-050.json`.
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
