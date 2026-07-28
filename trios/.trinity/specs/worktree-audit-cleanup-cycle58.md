# Worktree Audit Log Cleanup — Cycle 58

**Issue:** browseros-ai/BrowserOS#2050
**Ring:** SR-02 / LogParser.swift
**Road:** B (fix + test + experience save)

## Problem

Cycle 57 added a background scheduler that rotates JSONL audit streams in the main repo's `.trinity` directory (`event_log.jsonl`, `akashic-log.jsonl`, `local-auth-audit.jsonl`, `episodes.jsonl`). However, trios uses git worktrees under `.worktrees/*/trios` for feature branches and experiments. Those worktrees have their own `.trinity` audit streams, and they are never rotated. Over time a developer can accumulate many stale worktrees with unbounded JSONL files.

## Goal

Extend `LogRotationPolicy.rotateAuditLogs()` to discover and rotate JSONL audit streams inside every git worktree under `.worktrees/*/trios/.trinity`, using the same policies as the main repo.

## Non-goals

- Do not rotate worktree `.log` artifact files; `scripts/cleanup_artifact_logs.sh` already covers those.
- Do not add a UI for worktree retention in this cycle.
- Do not change archive compression format or naming.

## Competitor patterns

- **logrotate** — `include /var/log/**/*.log` and per-directory `rotate` directives; tools that manage many log directories use glob-based discovery rather than a single fixed path.
- **systemd-journald** — per-machine journal namespace; all instances of a service write into a managed namespace regardless of their checkout directory.
- **Datadog Agent** — `logs:` configuration supports wildcard directory patterns (`/var/log/**/*.log`), so one agent covers all checkouts.
- **Fluent Bit / Fluentd** — recursive `path` globs (`/var/log/**/*.json`) tail logs across many directories and apply retention centrally.
- **Splunk** — forwarders monitor all files matching a set of whitelisted paths, including nested directories.
- **macOS Unified Logging** — OS-level aggregation that is independent of the app's working directory.

The common pattern is: the retention agent discovers logs across directories, not only the primary one.

## Design

Add a helper to `LogRotationPolicy`:

```swift
static func worktreeAuditLogPaths(repoRoot: String) -> [(path: String, policy: LogRotationPolicy)]
```

- Enumerate `\(repoRoot)/.worktrees`.
- For each subdirectory `worktreeName`, look for `\(repoRoot)/.worktrees/\(worktreeName)/trios/.trinity`.
- If that directory exists, return the four standard JSONL paths with their policies:
  - `event_log.jsonl` — `.audit`
  - `events/akashic-log.jsonl` — `.audit`
  - `state/local-auth-audit.jsonl` — `.security`
  - `experience/episodes.jsonl` — `.experience`
- The existing `rotateIfNeeded(path:)` already uses `lsof` to skip files another process is writing, so it is safe to run against a worktree whose trios instance is currently alive.

Update `rotateAuditLogs()` to concatenate the main repo paths with `worktreeAuditLogPaths(repoRoot: ProjectPaths.root)` and rotate each.

## Files

- `trios/rings/SR-02/LogParser.swift` — add worktree discovery helper and extend `rotateAuditLogs()`.
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift` — add tests for worktree path discovery.

## TDD

- `./build.sh` passes.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` passes with 0 hard-gate findings.
- `cargo run --bin clade-e2e` passes.
- New XCTest passes: worktree directories are discovered when present, ignored when absent, and yield the correct four streams per worktree.
- `open trios.app` relaunches and health returns ok; menu-bar logo preserved.

## Three variants

1. **Variant A (in-process Swift discovery)** — implemented. `LogRotationPolicy` scans worktrees directly. Low risk, same policies, no shelling out.
2. **Variant B (shared bash + Swift)** — extend `scripts/cleanup_artifact_logs.sh` to also list JSONL worktree paths and have `AuditRotationScheduler` shell to it. More moving parts, not worth it.
3. **Variant C (Rust clade-cleanup subcommand)** — add a Rust binary that scans worktrees and rotates JSONL, callable from the scheduler or cron. Covers headless machines but duplicates policy logic.
