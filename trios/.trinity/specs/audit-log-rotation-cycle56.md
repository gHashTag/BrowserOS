# Cycle 56 - JSONL audit stream rotation spec

Closes browseros-ai/BrowserOS#2048

## Background

Cycles 54-55 solved artifact `.log` retention. JSONL audit streams (`event_log.jsonl`, `akashic-log.jsonl`, `local-auth-audit.jsonl`, `episodes.jsonl`) are not covered by the artifact cleaner and are not always loaded by the LOGS tab, so they can grow without bound.

## Requirements

1. `LogRotationPolicy` must support age-based retention for archives.
2. Active audit JSONL files must rotate at least daily even if under the size limit.
3. The following streams must be rotated on app launch and when the LOGS tab loads:
   - `.trinity/event_log.jsonl`
   - `.trinity/events/akashic-log.jsonl`
   - `.trinity/state/local-auth-audit.jsonl`
   - `.trinity/experience/episodes.jsonl`
4. Security audit (`local-auth-audit.jsonl`) must have a longer archive retention than general event logs.
5. Existing `lsof` external-writer guard must be preserved.

## Implementation notes

- Add `maxArchiveAgeSeconds` and `maxAgeBeforeRotationSeconds` to `LogRotationPolicy`.
- Add `cleanupOldArchives(path:)` that deletes `.archive.<ts>.zlib` files older than `maxArchiveAgeSeconds`.
- Modify `rotateIfNeeded(path:)` to also check file mtime against `maxAgeBeforeRotationSeconds`.
- Add `static func rotateAuditLogs()` with per-stream policies.
- Call `rotateAuditLogs()` from `AppDelegate.applicationDidFinishLaunching()` and `LogParser.loadLogSources()`.
- Keep all source ASCII-only.

## Verification

- `./build.sh` PASS
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` PASS (0 findings)
- `cargo run --bin clade-e2e` PASS
- Unit tests in `LogsTabViewTests.swift` for age eviction and audit rotation.
- App relaunches and health returns `{"status":"ok"}`.
