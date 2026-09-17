# Cycle 59 Plan — Cross-Format Archive Cleanup

## Weak spot

`LogRotationPolicy` only recognizes `.archive.<timestamp>.zlib` archives. Pre-existing `.gz` and extensionless `.archive.<timestamp>` legacy archives are ignored by both age-based and count-based cleanup.

## Competitor insight

logrotate, Datadog Agent, Fluent Bit, Splunk, and Elasticsearch ILM apply retention to all files matching a base pattern, regardless of suffix. Retention should not break just because the archive compression format changed.

## Decomposition

1. **Spec** — write `.trinity/specs/cross-format-archive-cleanup-cycle59.md`.
2. **Canon code** — delegate `rings/SR-02/LogParser.swift` changes to t27-creator.
   - Add `.zlib`, `.gz`, and extensionless suffix support to archive timestamp parsing.
   - Update `cleanupArchives(of:)` to sort and cap all recognized archive suffixes together.
   - Update `cleanupOldArchives(path:)` to delete all recognized archive suffixes by age.
3. **Tests** — add XCTest cases in `LogsTabViewTests.swift` for `.gz` and extensionless archive cleanup by age/count.
4. **Verify** — `./build.sh`, `clade-audit`, `clade-e2e`, relaunch app, health check.
5. **Report + learn** — write report, update `experience.md`, create episode JSON.

## Three variants

- **A — Unified suffix-aware cleanup** (chosen): one policy treats `.zlib`, `.gz`, and extensionless archives as a single logical family.
- **B — Separate legacy cleanup pass**: a dedicated method for old formats; simpler but duplicates logic.
- **C — Shell script cleanup**: one-time bash purge; fast but not scheduler-integrated.
