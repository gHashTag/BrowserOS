# Cycle 58 Plan — Worktree Audit Log Cleanup

## Weak spot

The background audit rotation scheduler only rotates JSONL audit streams in the main repo's `.trinity` directory. Git worktrees under `.worktrees/*/trios/.trinity` are ignored and can grow unbounded.

## Competitor insight

logrotate, Datadog Agent, Fluent Bit, and Splunk all support wildcard directory discovery (`/var/log/**/*.log`, recursive tail, or path whitelists) so retention agents cover all checkouts, not just the primary one.

## Decomposition

1. **Spec** — write `.trinity/specs/worktree-audit-cleanup-cycle58.md`.
2. **Canon code** — delegate `rings/SR-02/LogParser.swift` changes to t27-creator.
   - Add `worktreeAuditLogPaths(repoRoot:)` helper.
   - Extend `rotateAuditLogs()` to include worktree paths.
3. **Tests** — add XCTest cases in `LogsTabViewTests.swift` for worktree discovery.
4. **Verify** — `./build.sh`, `clade-audit`, `clade-e2e`, relaunch app, health check.
5. **Report + learn** — write report, update `experience.md`, create episode JSON.

## Three variants

- **A — In-process Swift discovery** (chosen): `LogRotationPolicy` scans `.worktrees/*/trios/.trinity` directly, reuses existing policies and `lsof` guard.
- **B — Bash + Swift integration**: extend `cleanup_artifact_logs.sh` to list JSONL paths; scheduler shells out. More moving parts.
- **C — Rust clade-cleanup subcommand**: external binary scans and rotates worktree JSONL. Covers headless but duplicates policy logic.
