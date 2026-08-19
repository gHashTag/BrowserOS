# Cycle 48 Report — LOGS tab noise suppression + reader-side log rotation

## Request
The user asked why the trios logs contained so much garbage, requested an immediate cleanup, and asked for a feasibility study on preventing future log bloat/noise.

## What was wrong
- `.trinity/logs/` had accumulated **643 files**, many of them stale build/rotation archives and service logs.
- `browseros-companion.log` was dominated by a tight loop of PostgreSQL auth failures + `Reclaiming stale task leases` (~96.7 % of recent lines).
- `.trinity/event_log.jsonl` was dominated by `watchdog_heartbeat` and `drift_detected` events (~87 % of lines).
- The LOGS tab UI had no way to hide these repetitive, low-signal lines, so the user perceived the whole view as noisy.
- There was no reader-side size cap or rotation, so watched log files could grow unbounded on disk.

## Immediate cleanup (done)
- Safely removed stale build/rotation logs in `.trinity/logs/` older than 24 h, keeping the 20 most recent files per prefix.
- Recovered ~4.94 MB of disk space; directory reduced from 643 files to 50 files.
- Rotated the actively-written `browseros-companion.log` in-place (copy-to-archive + truncate) so the Bun writer keeps its open fd.
- Verified active file descriptors with `lsof` before truncating.

## Code changes (done)
1. **Noise filter** — added `LogNoiseFilter` in `trios/rings/SR-02/LogParser.swift`:
   - Suppresses `watchdog_heartbeat`, `drift_detected`, `awareness_updated` event-log events.
   - Suppresses companion messages: `Reclaiming stale task leases`, `Registered 73 tools`, `list_pages request`, empty messages.
   - Suppresses raw-line noise: `ENOENT reading`, `Bun v` startup banners.
   - Added `LogParser.filterNoise(_:isOn:)` and wired it into `filteredLines(for:)` and `unifiedLines(...)`.

2. **UI toggle** — added `@State private var suppressNoise = true` and a **Quiet** toggle in `LogsTabView`:
   - Appears next to the existing **Dedup** toggle in the filter bar.
   - Default is **on**, so the LOGS tab opens in a low-noise state.
   - Turning it off reveals the suppressed lines for deep debugging.

3. **Reader-side rotation policy** — added `LogRotationPolicy` in `LogParser.swift`:
   - Default thresholds: 1 MB max file size, keep last 500 lines, retain 5 archives.
   - Archives are zlib-compressed and timestamped (`<file>.archive.<epoch>.zlib`).
   - `rotateIfNeeded(path:)` is called for `event_log.jsonl`, `cron.log`, `queen.log`, and every `.log` file under `.trinity/logs/` during `loadLogSources()`.
   - Uses `lsof` to detect external writers; if another process holds the file open, rotation is skipped to avoid copy-truncate holes.
   - Old archives beyond the retention count are deleted automatically.

4. **Tests** — extended `trios/tests/TriOSKitTests/LogsTabViewTests.swift`:
   - Noise filter unit tests (heartbeat, drift, companion leases, real events).
   - `filterNoise` on/off toggle test.
   - `unifiedLines` `suppressNoise` parameter test.
   - Rotation policy tests for oversized-file truncation and archive cleanup.

## Files touched
- `trios/rings/SR-02/LogParser.swift`
- `trios/BR-OUTPUT/LogsTabView.swift`
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift`
- `trios/.trinity/experience/2026-07-27_logs-tab-noise-suppression-rotation-loop-048.json`
- `trios/.claude/plans/trios-cycle48-logs-noise-rotation-report.md`

## Verification
| Gate | Result |
|---|---|
| `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` | PASS |
| `cargo test -p trios-mesh` | PASS (101 tests) |
| `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` | PASS |
| `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` | PASS (0 hard-gate findings) |
| `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` | SEAL VALID |
| `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e` | PASS |
| `open trios.app` | Relaunched; menu-bar logo preserved |

`swift test` is unavailable in the CommandLineTools-only environment, so the new Swift tests were compiled with the production build but not executed by `swift test`.

## Three future options
1. **Server-side log level filtering / sampling** — move the noise reduction upstream by teaching the BrowserOS companion and Queen cron to log high-frequency events at `debug` or sampled intervals, so less garbage reaches disk in the first place. This reduces I/O and archive churn, but requires coordinated server changes and a Bun logging configuration.

2. **Structured event store with retention policy** — replace the ad-hoc `.log` / `.jsonl` files with an indexed SQLite event table keyed by `(timestamp, source, level, event)`. Add per-source retention rules (e.g., keep info 7 days, debug 1 day) and fast historical queries/trend charts. Larger architectural change but solves bloat, search speed, and analytics in one surface.

3. **Per-source noise profile customization** — let users edit the `LogNoiseFilter` patterns in-app (e.g., a "Hide events like this" context menu item on any row) and persist personal profiles in `.trinity/state/logs_noise_profile.json`. Keeps the current file-based architecture, gives power users control, and provides signal for which events should be sampled or demoted server-side later.
