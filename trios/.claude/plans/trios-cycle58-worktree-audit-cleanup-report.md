# Cycle 58 Report — Worktree Audit Log Cleanup

## Weak spot addressed

Cycle 57 scheduled rotation for the main repo's JSONL audit streams, but git worktrees under `.worktrees/*/trios/.trinity` were ignored. Developers using worktrees for feature branches could accumulate unbounded `event_log.jsonl`, `akashic-log.jsonl`, `local-auth-audit.jsonl`, and `episodes.jsonl` files in every stale checkout.

## Competitor patterns

- **logrotate** — uses glob-based `include` directives to cover many directories; retention is not limited to a single fixed path.
- **systemd-journald** — per-machine journal namespaces collect logs from all instances regardless of checkout directory.
- **Datadog Agent** — log configuration supports wildcard directory patterns such as `/var/log/**/*.log`.
- **Fluent Bit / Fluentd** — recursive `path` globs tail and retain logs across nested directories centrally.
- **Splunk** — forwarders monitor all files matching a set of whitelisted paths, including nested directories.
- **macOS Unified Logging** — OS-level aggregation independent of the app's working directory.

The common pattern is directory discovery, not a single hardcoded path.

## Implementation

- Added `LogRotationPolicy.worktreeAuditLogPaths(repoRoot:)` in `rings/SR-02/LogParser.swift`.
  - Enumerates `\(repoRoot)/.worktrees`.
  - For each entry, checks for `\(repoRoot)/.worktrees/\(entry)/trios/.trinity`.
  - Returns the four standard JSONL streams with their policies: `event_log.jsonl` and `events/akashic-log.jsonl` (`.audit`), `state/local-auth-audit.jsonl` (`.security`), `experience/episodes.jsonl` (`.experience`).
- Extended `LogRotationPolicy.rotateAuditLogs()` to concatenate the main repo policies with `worktreeAuditLogPaths(repoRoot: ProjectPaths.root)` and rotate each.
- The existing `lsof` writer guard in `rotateIfNeeded(path:)` automatically skips any file another trios process is currently writing, so live worktrees are protected.
- Added XCTest cases in `tests/TriOSKitTests/LogsTabViewTests.swift` for worktree discovery, empty worktree roots, and worktrees without a `.trinity` directory.

## Verification

- `./build.sh` (with `TRIOS_SKIP_CHAT_E2E=1`) — PASS, app bundle signed.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` — PASS, 0 hard-gate findings across 8 checks.
- `cargo run --bin clade-e2e` — PASS, report `.trinity/e2e/report_prod_1785216625.md`.
- `open trios.app` relaunched; health returned `{"status":"ok","cdpConnected":true}`; menu-bar logo preserved.
- Note: `swift test` still skipped because XCTest is not available in the CommandLineTools-only install, but the new tests are part of the compiled Swift target checked by clade-audit.

## Three variants

1. **Variant A — In-process Swift discovery** (chosen and landed). `LogRotationPolicy` scans `.worktrees/*/trios/.trinity` directly, reuses existing policies and writer guard.
2. **Variant B — Shared bash + Swift**. Extend `scripts/cleanup_artifact_logs.sh` to list JSONL worktree paths and shell out from the scheduler. More moving parts and a new cross-language contract.
3. **Variant C — Rust clade-cleanup subcommand**. Add a Rust binary that scans worktrees and rotates JSONL externally. Covers headless/Windows devs but duplicates retention policy logic.

## Files

- `trios/rings/SR-02/LogParser.swift`
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift`
- `trios/.trinity/specs/worktree-audit-cleanup-cycle58.md`
- `trios/.claude/plans/trios-cycle58-worktree-audit-cleanup.md`
- `trios/.claude/plans/trios-cycle58-worktree-audit-cleanup-report.md`
- `trios/.trinity/experience/2026-07-28_worktree-audit-cleanup-cycle58-loop-058.json`

## Next options

1. **Retention configuration UI** — expose per-stream max size, archive count, and retention age in Settings/Logs.
2. **Wake-notification re-run** — subscribe to `NSWorkspace.didWakeNotification` and re-run rotation after long sleeps.
3. **Cross-format archive cleanup** — extend `cleanupOldArchives(path:)` to also remove legacy `.gz` and extensionless archives from before Cycle 56.
