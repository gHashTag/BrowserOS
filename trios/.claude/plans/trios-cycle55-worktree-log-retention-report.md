# Cycle 55 - Worktree log cleanup and strict artifact retention (report)

Closes browseros-ai/BrowserOS#2047

## Summary

Tightened artifact-log retention across the trios repo and its git worktrees.
- Lowered per-family artifact cap from 10 to 5 files.
- Added 7-day age-based eviction.
- Added a standalone dry-run-by-default cleaner that scans the main repo and every `.worktrees/*/trios/.trinity/logs` directory.
- Wired the cleaner into `build.sh`, `run_chat_sse_e2e.sh`, and `run_queen_autonomous_test.sh` as a backstop.
- Updated the Rust `clade-build` binary to keep 5 `clade-build*.log` files and delete logs older than 7 days.

## Verification

- `scripts/cleanup_artifact_logs.sh --apply --days 7 --cap 5` deleted 12 old artifact logs and freed 54.9 KB.
- After cleanup:
  - `.trinity/logs/*.log` = 12 files
  - `.trinity/logs/build_*.log` = 5 files
  - `.trinity/logs/chat_sse_e2e_build_*.log` = 5 files
  - `.worktrees/chat-stream-smoothness/trios/.trinity/logs/*.log` = 1 file
- `./build.sh` passed (Swift + cargo + chat SSE end-to-end).
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` passed all 8 gates with 0 findings.
- `cargo run --bin clade-e2e` produced a passing prod report.
- `open trios.app` relaunched successfully and `curl http://127.0.0.1:9105/health` returned `{"status":"ok","cdpConnected":true}`; menu-bar logo present.

## Changed files

- `trios/scripts/cleanup_artifact_logs.sh` (new)
- `trios/build.sh`
- `trios/tests/swift/run_chat_sse_e2e.sh`
- `trios/tests/swift/run_queen_autonomous_test.sh`
- `trios/rings/RUST-01/clade-build/src/main.rs`
- `trios/.trinity/specs/worktree-log-retention-cycle55.md` (new)
- `trios/.claude/plans/trios-cycle55-worktree-log-retention.md` (new)
- `trios/.claude/plans/trios-cycle55-worktree-log-retention-report.md` (new)

## Three variants considered

1. **Chosen - strict count + age + worktree scanner**
   - Pros: maximum footprint reduction, reusable script, no silent accumulation in worktrees.
   - Cons: adds a new shell script to maintain; worktree glob is macOS/git-specific.

2. **Lighter - count-only cap lowered to 5, no age eviction, no worktree scan**
   - Pros: smallest code change; no new script.
   - Cons: old logs still persist until enough new runs happen; worktree garbage remains.

3. **Heavier - central retention service in Swift/Rust with config UI**
   - Pros: user-visible retention settings, per-source policies, easy to extend to remote stores.
   - Cons: over-engineered for local artifact logs; UI and persistence work exceed the current scope.

## Next-cycle options

- Apply the same age/count policy to `.trinity/event_log.jsonl.archive.*` archives (currently managed by `LogRotationPolicy`).
- Add a cron `/doctor` skill that runs `cleanup_artifact_logs.sh --dry-run` and reports if a worktree is bloated.
- Promote `cleanup_artifact_logs.sh` to a Rust subcommand so Windows/WSL dev environments get the same behavior without bash.
