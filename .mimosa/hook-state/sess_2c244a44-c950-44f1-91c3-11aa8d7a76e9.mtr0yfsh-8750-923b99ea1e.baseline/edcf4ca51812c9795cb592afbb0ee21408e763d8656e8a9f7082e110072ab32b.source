# Cycle 54 Report - Log retention and artifact cleanup

Closes browseros-ai/BrowserOS#2046

## Summary

The `.trinity/logs/` directory was a flat bag of `.log` files. The LOGS tab loaded every `.log` it found, including transient build/test artifacts (`build_*.log`, `chat_sse_e2e_build_*.log`, `clade-build_*.log`, `queen_autonomous_test_*.log`, `*.stdout.log`, `*.stderr.log`). Users saw these as "online logs" even though they are offline build artifacts.

This cycle introduces source categorization, hides artifact logs by default, and caps each artifact family at 10 files.

## Changes

1. `rings/SR-02/LogParser.swift`
   - Added `LogSourceCategory` enum: `.runtime`, `.service`, `.build`, `.test`, `.artifact`.
   - Added `category` field to `LogSource`.
   - Added `LogParser.category(for:)` classifier by filename patterns.
   - `loadLogSources(includeArtifacts:)` defaults to `false`, showing only `.runtime` and `.service` sources.

2. `BR-OUTPUT/LogsTabView.swift`
   - Added "Show build/test logs" toggle bound to `UserDefaults` key `trios_logs_show_artifact_logs`.
   - `loadAll()` honors `includeArtifacts`.

3. `tests/TriOSKitTests/LogsTabViewTests.swift`
   - Added classification tests for runtime/service/build/test/artifact filenames.
   - Added default filtering and artifact-inclusive `loadLogSources` tests.

4. `build.sh`
   - Added `rotate_family()` helper.
   - Caps `build_*.log`, `clade-build*.log`, `queen_autonomous_test_*.log`, `*.stdout.log`, `*.stderr.log` to 10 files each.

5. `tests/swift/run_queen_autonomous_test.sh`
   - Caps `queen_autonomous_test_*.log` to 10 files.

6. `rings/RUST-01/clade-build/src/main.rs`
   - Added `rotate_clade_build_logs()` keeping 10 most recent `clade-build*.log` files before writing a new one.

7. `.trinity/specs/log-retention-cycle54.md`
   - Cycle 54 spec.

8. `.claude/plans/trios-cycle54-log-retention.md`
   - Cycle 54 plan with three variants.

## Verification

- `./build.sh`: PASS
- `cargo run --bin clade-build`: PASS
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`: PASS (0 findings, 8 checks)
- `cargo run --bin clade-e2e`: PASS
- `open trios.app` + health check: `{"status":"ok","cdpConnected":true}`
- Menu-bar logo: preserved (app relaunched successfully)

## Before / after

- `.trinity/logs` went from 33 files (~3.2 MB) with legacy cycle logs to 24 files after cleanup.
- Artifact logs are no longer shown in LOGS tab unless the user toggles "Show build/test logs".
- Each artifact family is capped at 10 files.

## Three follow-up variants

1. **Variant A - Strict artifact retention**
   - Lower cap to 5 files per family and add age-based eviction (delete logs older than 7 days).
   - Pros: smaller disk footprint. Cons: less history for debugging build failures.

2. **Variant B - JSONL audit rotation**
   - Apply `LogRotationPolicy` to `.trinity/event_log.jsonl`, `.trinity/events/akashic-log.jsonl`, and `.trinity/experience/episodes.jsonl`.
   - Pros: prevents long-term growth of audit streams. Cons: audit/compliance implications need review.

3. **Variant C - Worktree log cleanup**
   - Extend artifact rotation to `.worktrees/*/trios/.trinity/logs` so stale worktrees do not keep copies.
   - Pros: cleaner git worktree state. Cons: worktrees may be in use by parallel agents; needs safe-guards.
