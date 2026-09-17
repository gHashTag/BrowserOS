# Cycle 59 Report — Cross-Format Archive Cleanup

**Issue:** browseros-ai/BrowserOS#2051
**Ring:** SR-02 / LogParser.swift
**Road:** B (fix + test + experience save)
**Agents:** claude, t27-creator

## 1. Weak spot

Cycles 54-56 standardized audit-log archives on `.archive.<timestamp>.zlib`, but pre-existing rotated files used other naming patterns:

- `.archive.<timestamp>.gz` — earlier gzip-based rotation.
- `.archive.<timestamp>` — extensionless raw archive from an earlier implementation.

`LogRotationPolicy.cleanupOldArchives(path:)` and `cleanupArchives(of:)` only parsed the `.zlib` suffix, so legacy archives were ignored by both age-based eviction and `maxArchiveCount`. On long-lived dev machines they continued to accumulate indefinitely.

## 2. Competitor insight

- **logrotate**, **Datadog Agent**, **Fluent Bit/Fluentd**, **Splunk**, and **Elasticsearch ILM** all apply retention policies to every rotated artifact matching a base pattern, not only the current suffix.
- The common principle is: changing the archive compression format must not break existing retention rules.

## 3. Decomposition and implementation

1. **Spec** — `.trinity/specs/cross-format-archive-cleanup-cycle59.md` defined suffix-aware retention without changing the current `.zlib` output format.
2. **Canon code** — `t27-creator` updated `rings/SR-02/LogParser.swift`:
   - Added `private static let archiveSuffixes: [String?] = [".zlib", ".gz", nil]` as a single source of truth.
   - Added `private static func archiveTimestamp(_ file: String, prefix: String) -> TimeInterval?` that tries `.zlib`, then `.gz`, then extensionless raw archives by parsing the segment after `prefix` and before the suffix.
   - Updated `cleanupArchives(of:)` to collect all files matching the prefix and any recognized suffix, sort by parsed timestamp, and drop the oldest beyond `maxArchiveCount`.
   - Updated `cleanupOldArchives(path:)` to delete any recognized archive older than `maxArchiveAgeSeconds`.
3. **Tests** — added XCTest cases in `tests/TriOSKitTests/LogsTabViewTests.swift`:
   - `testRotationPolicyRemovesLegacyGzArchiveByAge`
   - `testRotationPolicyRemovesExtensionlessArchiveByAge`
   - `testRotationPolicyCapsMixedFormatArchivesByCount`
4. **Verify** — ran `./build.sh`, `clade-audit`, `clade-e2e`, relaunched the app, and checked `/health`.

## 4. TDD results

- `./build.sh` — PASS.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` — PASS, 0 hard-gate findings across 8 checks.
- `cargo run --bin clade-e2e` — PASS (report `.trinity/e2e/report_prod_1785217521.md`).
- `open trios.app` relaunch — PASS; health returned `{"status":"ok","cdpConnected":true}`; menu-bar logo preserved.
- XCTest cases are compiled and syntactically validated by `./build.sh`. The host toolchain is CommandLineTools-only and cannot execute `swift test`, so runtime execution of the new unit tests was not performed in this cycle.

## 5. Three variants

- **Variant A — Unified suffix-aware cleanup** (implemented): one policy treats `.zlib`, `.gz`, and extensionless archives as a single logical family.
- **Variant B — Separate legacy cleanup pass**: a dedicated method for old formats; simpler to reason about but duplicates timestamp parsing logic.
- **Variant C — Shell script cleanup**: a one-time bash purge; fast but not integrated with the scheduler.

## 6. Files changed

- `trios/rings/SR-02/LogParser.swift` — suffix-aware archive timestamp parsing and cleanup.
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift` — tests for `.gz`/extensionless/mixed-format archives.
- `trios/.trinity/specs/cross-format-archive-cleanup-cycle59.md` — spec.
- `trios/.claude/plans/trios-cycle59-cross-format-archive-cleanup.md` — plan.
- `trios/.claude/plans/trios-cycle59-cross-format-archive-cleanup-report.md` — this report.

## 7. Next options

1. **Wake-notification re-run** — subscribe to `NSWorkspace.didWakeNotification` and re-run `rotateAuditLogs()` after long sleeps so rotation does not drift.
2. **Retention configuration UI** — expose per-stream max size, archive count, and retention age in Settings/Logs.
3. **Rust-side audit log cleanup** — add a `cargo run --bin clade-cleanup-audit` subcommand for non-macOS/WSL environments that cannot run the Swift scheduler.

---

Phase complete: SYNTHESIZE
→ Phase 9: LEARN
