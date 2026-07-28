# Cycle 55 - Worktree log retention and strict artifact cleanup

Closes browseros-ai/BrowserOS#2047

## Problem

Cycle 54 solved the main `.trinity/logs/` artifact problem, but three gaps remain:

1. **Cap is loose.** 10 build/test logs per family is still enough to accumulate quickly on active dev machines; users want a smaller footprint.
2. **No age-based eviction.** Logs can sit for weeks or months because count-based caps only delete after enough newer files appear.
3. **Worktrees are ignored.** `.worktrees/*/trios/.trinity/logs` can hold stale build logs (e.g. `build_1784824254.log` in `chat-stream-smoothness`). The main repo scripts never look there, so cloning + building in worktrees leaves garbage behind when the worktree is removed or abandoned.

## Goal

1. Reduce artifact cap from 10 to 5 files per family.
2. Add 7-day age-based eviction for artifact logs.
3. Add a reusable cleanup routine that can run across git worktrees.
4. Wire the cleanup into existing build/test entry points without breaking worktree isolation.

## Scope

- `trios/build.sh` - lower cap to 5 and add age eviction.
- `trios/tests/swift/run_chat_sse_e2e.sh` - lower cap to 5 and add age eviction.
- `trios/tests/swift/run_queen_autonomous_test.sh` - lower cap to 5 and add age eviction.
- `trios/rings/RUST-01/clade-build/src/main.rs` - lower cap to 5 and add age eviction.
- New file `trios/scripts/cleanup_artifact_logs.sh` - standalone dry-run-by-default cleaner for main repo and worktrees.
- Optional: invoke from `build.sh` as a backstop after its inline rotation.

## Non-scope

- JSONL audit streams (event_log.jsonl, akashic-log.jsonl, episodes.jsonl).
- Runtime log rotation (`LogRotationPolicy` already handles those).
- Manual deletion of live worktree `.trinity` directories; the cleaner only removes gitignored artifact log files.

## Acceptance criteria

- Each artifact family has at most 5 files after any build/e2e/test run.
- Logs older than 7 days are removed regardless of count.
- `./build.sh` passes and clade-audit is clean.
- `scripts/cleanup_artifact_logs.sh --dry-run` shows what would be deleted in main repo and worktrees.
- `scripts/cleanup_artifact_logs.sh --apply` removes artifact logs older than 7 days and excess per-family logs, but leaves runtime/service logs alone.
- trios.app relaunches and menu-bar logo stays visible.

## TDD

- No new Swift code; verification is by running the scripts and checking file counts.
- Add a simple shell test in `tests/swift/run_chat_sse_e2e.sh` or a standalone check that creates dummy old logs and asserts cleanup.
