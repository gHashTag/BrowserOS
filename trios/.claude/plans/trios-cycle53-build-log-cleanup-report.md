# Cycle 53 Report — Build Log Rotation / Online Log Cleanup

**Issue:** gHashTag/trios#1087  
**Date:** 2026-07-28  
**Ring:** build tooling / e2e scripts  
**Road:** A (fast direct fix)  
**Agent:** claude

## 1. Summary

User reported that `.trinity/logs/` contained dozens of stale `chat_sse_e2e_build_*.log` entries, which the LOGS tab surfaced as visual noise. These files are created by `tests/swift/run_chat_sse_e2e.sh` on every run and were never cleaned up. A similar pattern existed for `build.sh`, which produced 120 `build_*.log` files.

This cycle adds rotation directly into the two scripts: each run keeps only the 10 newest per-script logs and deletes older ones.

## 2. Weak spot addressed

- **Accumulating per-run build artifacts.** Every `./build.sh` and every `bash tests/swift/run_chat_sse_e2e.sh` created a new log with a `date +%s` suffix. Over days this produced 60+ chat-SSE e2e build logs and 120+ build logs, cluttering the live log directory and the LOGS tab UI.
- **No distinction in cleanup.** The existing `LogRotationPolicy` rotates large active logs (`browseros-companion.log`, `queen.log`, `cron.log`, etc.) but does not address transient per-build artifacts.

## 3. Implementation

### 3.1 `trios/build.sh`

After setting `LOG_FILE`, added:

```bash
if command -v find > /dev/null 2>&1; then
    find "$LOG_DIR" -maxdepth 1 -type f -name 'build_*.log' -print0 \
        | xargs -0 ls -t 2>/dev/null \
        | tail -n +11 \
        | xargs -I {} rm -f {}
fi
```

### 3.2 `trios/tests/swift/run_chat_sse_e2e.sh`

Added the same rotation for `chat_sse_e2e_build_*.log`.

### 3.3 Manual cleanup

- Deleted all but the 10 newest `chat_sse_e2e_build_*.log` files (was 61, now 10).
- Deleted all but the 10 newest `build_*.log` files (was 120, now 10).
- Left live service logs (`browseros-companion.log`, `cron.log`, `queen-zig.log`, `event_log.jsonl`) untouched.

## 4. Files changed

- `trios/build.sh`
- `trios/tests/swift/run_chat_sse_e2e.sh`
- `trios/.claude/plans/trios-cycle53-build-log-cleanup-report.md`

## 5. Verification gates

| Gate | Result |
|------|--------|
| `bash -n trios/build.sh` | ✅ PASS |
| `bash -n trios/tests/swift/run_chat_sse_e2e.sh` | ✅ PASS |
| `cargo run --bin clade-build` | ✅ PASS |
| `cargo run --bin clade-audit` | ✅ 0 hard-gate findings across 8 checks |
| `open trios.app` + `/health` | ✅ `{"status":"ok","cdpConnected":true}` |
| Build log count after clade-build | ✅ 11 (10 old + 1 new) |

## 6. Law compliance

| Law | Verdict |
|-----|---------|
| L1 TRACEABILITY | PASS — GitHub issue #1087 referenced |
| L2 GENERATION | PASS — tooling scripts, no canon Swift touched |
| L3 PURITY | PASS — ASCII-only |
| L4 TESTABILITY | PASS — syntax checks + clade-build + clade-audit pass |
| L5 IDENTITY | PASS — no constants touched |
| L6 CEILING | PASS — no UI changes |
| L7 UNITY | PASS — existing shell scripts modified, no new scripts on critical path |

## 7. Three options for Cycle 54

1. **Centralized per-build artifact cleanup policy** — instead of rotation in each script, add a small `LogArtifactJanitor` helper or cron rule that scans `.trinity/logs/` for known transient patterns (`build_*.log`, `chat_sse_e2e_build_*.log`, test outputs) and applies uniform retention by age/count, so future scripts do not each reimplement the logic.
2. **Exclude transient build logs from LOGS tab** — teach `LogParser.loadLogSources()` to skip `build_*.log` and `chat_sse_e2e_build_*.log` by default (or show them under a collapsed "Build artifacts" source), reducing noise even if files accumulate briefly.
3. **Noise rule impact dashboard** — return to the original Cycle 53 plan: show per-rule suppression statistics in the noise-profile sheet so users can audit and delete stale rules.
