# Cycle 54 - Log retention and artifact cleanup

Closes browseros-ai/BrowserOS#2046

## Problem

The `.trinity/logs/` directory is treated as a single flat bag of `.log` files. The LOGS tab loads every `.log` it finds, including transient build/test artifacts (`build_*.log`, `chat_sse_e2e_build_*.log`, `clade-build_*.log`, `queen_autonomous_test_*.log`, `*.stdout.log`, `*.stderr.log`). Users see these as "online logs" even though they are offline build artifacts. After manual cleanup, 8 legacy cycle logs and a stale archive were also left behind.

## Goal

1. Separate runtime/service logs from build/test/artifact logs in the reader.
2. Exclude artifact logs from the default LOGS tab view.
3. Add automatic retention cleanup for artifact log families.
4. Keep existing `LogRotationPolicy` behavior for live runtime logs.

## Scope

- `rings/SR-02/LogParser.swift` - add source category and filtering.
- `BR-OUTPUT/LogsTabView.swift` - default view shows only runtime sources; add toggle to reveal artifacts.
- `build.sh` - cleanup artifact families after build.
- `tests/swift/run_chat_sse_e2e.sh` - cleanup chat SSE e2e logs after run.
- `tests/swift/run_queen_autonomous_test.sh` - cleanup queen autonomous test logs after run.
- `rings/RUST-01/clade-build/src/main.rs` - cleanup clade-build logs before write.
- `rings/RUST-09/clade-launchd/src/main.rs` - cleanup stdout/stderr logs on install (optional, out of scope if risky).

## Non-scope

- JSONL logs (`event_log.jsonl`, `akashic-log.jsonl`, etc.) are audit streams and are not rotated here.
- Worktree logs are per-worktree and not cleaned by the main repo scripts.

## Acceptance criteria

- LOGS tab no longer shows `build_*.log`, `chat_sse_e2e_build_*.log`, `clade-build_*.log`, `queen_autonomous_test_*.log`, or `*.stdout.log`/`*.stderr.log` by default.
- A toggle or menu in LOGS tab can reveal artifact logs when needed.
- Artifact log families are capped at 10 files each.
- `./build.sh` passes and no build logs accumulate beyond 10.
- `clade-audit` passes with no new hard-gate findings.
- trios.app relaunches and menu-bar logo stays visible.

## TDD

- Add unit tests for `LogSource.category` classification.
- Add test that `LogParser.loadLogSources()` excludes artifact logs by default.
- Add test that artifact toggle includes them.
