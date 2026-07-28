# Cross-Format Archive Cleanup — Cycle 59

**Issue:** browseros-ai/BrowserOS#2051
**Ring:** SR-02 / LogParser.swift
**Road:** B (fix + test + experience save)

## Problem

Cycles 54-56 standardized archive format to `.archive.<timestamp>.zlib` for LOGS-tab logs and JSONL audit streams. However, pre-existing archives use other naming patterns:

- `.archive.<timestamp>.gz` — produced by an earlier gzip-based rotation.
- `.archive.<timestamp>` — extensionless raw archive from an earlier implementation.

These legacy archives are not recognized by `cleanupOldArchives(path:)` or `archiveTimestamp(_:prefix:)`, so they are never cleaned up by age and are not counted toward `maxArchiveCount`. On long-lived dev machines they continue to accumulate even though the active log is now using zlib.

## Goal

Extend `LogRotationPolicy` archive cleanup to recognize and remove legacy `.gz` and extensionless `.archive.<timestamp>` archives using the same age/count limits as current zlib archives.

## Non-goals

- Do not change the current archive format (remains `.zlib`).
- Do not add a UI for archive management in this cycle.
- Do not re-compress or migrate legacy archives to zlib.

## Competitor patterns

- **logrotate** — supports `olddir` and wildcard cleanup of rotated files regardless of suffix; retention policies apply to all files matching the rotation pattern.
- **systemd-journald** — only keeps its native `.journal` files; legacy formats are ignored but systemd does not leave old `.gz` journals on disk because it owns the whole rotation pipeline.
- **Datadog Agent** — archive retention is format-aware and cleans `.gz`/`.bz2`/`.zip` archives produced by different rotations.
- **Fluent Bit / Fluentd** — file tailers treat all matched files uniformly by modification time, so old archives of any suffix are evicted.
- **Splunk** — bucket rolling applies to all files under an index path regardless of extension; frozen buckets are removed by age.
- **Elasticsearch ILM** — index lifecycle actions target all segments/shards under an index, not only one filename pattern.

The common pattern is: retention policy applies to all rotated artifacts matching a base pattern, not only the current suffix.

## Design

Update `LogRotationPolicy` to recognize three archive suffixes in order of preference:

1. `.zlib` — current format.
2. `.gz` — legacy gzip archive.
3. No suffix (extensionless raw archive) — legacy raw archive.

Changes:

- Add a private static helper `archiveTimestamp(_:prefix:)` overload or variant that accepts an optional explicit suffix, falling back through the three suffixes.
- In `cleanupArchives(of:)`, collect all files with `\(base).archive.` prefix and any recognized suffix, sort by timestamp, and apply `maxArchiveCount` to the combined list.
- In `cleanupOldArchives(path:)`, iterate over all files with `\(base).archive.` prefix and any recognized suffix, parse the timestamp segment before the suffix, and delete those older than `maxArchiveAgeSeconds`.
- Add `archiveSuffixes` private constant to keep the list in one place.

## Files

- `trios/rings/SR-02/LogParser.swift` — extend archive recognition in `cleanupArchives(of:)`, `cleanupOldArchives(path:)`, and `archiveTimestamp(_:prefix:)`.
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift` — add tests for `.gz` and extensionless archive cleanup by age and count.

## TDD

- `./build.sh` passes.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` passes with 0 hard-gate findings.
- `cargo run --bin clade-e2e` passes.
- New XCTest passes: legacy `.gz` archive is removed by age, extensionless archive is removed by age, mixed-format archives respect `maxArchiveCount` across all suffixes.
- `open trios.app` relaunches and health returns ok; menu-bar logo preserved.

## Three variants

1. **Variant A (unified suffix-aware cleanup)** — implemented. Single policy treats `.zlib`, `.gz`, and extensionless archives as one logical archive family.
2. **Variant B (separate legacy cleanup pass)** — add a new `cleanupLegacyArchives(path:)` method that only handles old formats. Simpler to reason about but duplicates timestamp parsing logic.
3. **Variant C (shell script cleanup)** — add a one-time bash script that deletes old `.gz`/extensionless archives. Fast but not integrated with the scheduler and requires manual/ cron invocation.
