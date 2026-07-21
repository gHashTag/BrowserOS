:name: monitor-signal-hardening
:description: Replace raw libc::signal handlers in clade-monitor with signal-hook atomic flags and migrate its /tmp test fixtures to tempfile.
:owner: claude
:status: sealed
:wave: 007

# Spec - clade-monitor signal safety and test isolation

## Goal

Replace the raw `libc::signal` SIGTERM/SIGINT registration in `clade-monitor` with a safe `signal-hook` atomic-flag watcher, migrate all remaining `/tmp` test fixtures to `tempfile`, and add a test-only clippy exemption.

## Background

Wave 006 eliminated `/tmp` from most Rust rings, but `clade-monitor` still used raw OS signal callbacks and wrote atomic-write test fixtures to `/tmp`. Research on Rust signal handling (Cogs and Levers 2024, rustfaq.org 2024) shows that real work inside `libc::signal` callbacks is async-signal-unsafe; the idiomatic Rust pattern is to set an atomic flag and let the main loop react. Additionally, shared `/tmp` paths between tests cause collisions and flakiness (RepoST 2025, Detecting Flakiness in Quantum Software 2025).

## Changes

### rings/RUST-05/clade-monitor/Cargo.toml

- Added `signal-hook = "0.3"` to `[dependencies]`.
- Added `tempfile = "3"` to `[dev-dependencies]`.

### rings/RUST-05/clade-monitor/src/main.rs

- Added crate-level test exemption: `#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]`.
- Added imports for `signal_hook::consts::signal::{SIGINT, SIGTERM}` and `signal_hook::flag`.
- Added `Arc` import.
- Removed the `extern "C" fn handle_signal` raw callback.
- Added `register_shutdown_signals()`:
  - Registers `SIGTERM` and `SIGINT` via `signal_hook::flag::register` on an `Arc<AtomicBool>`.
  - Spawns a thin watcher thread that propagates the flag into the existing `RUNNING` static.
- Replaced the `unsafe { libc::signal(...) }` block in `main` with a call to `register_shutdown_signals()`.
- Rewrote `atomic_write_creates_file` and `atomic_write_no_tmp_left_behind` to use `tempfile::tempdir()`.
- Rewrote `track_build_hash_returns_none_for_missing_binary` to use a `tempfile::tempdir()` as `TRIOS_ROOT`.
- ASCII-cleaned all changed lines and pre-existing non-ASCII characters in the file.

## Verification

- `cargo test -p clade-monitor --all-features` passes: 38 tests.
- `cargo test --workspace --all-features` passes: full workspace.
- `cargo clippy --workspace --all-targets --all-features` is clean.
- `./build.sh` passes.
- `grep -RIn '/tmp' rings/RUST-*/src/main.rs` returns zero matches across workspace Rust source.
- ASCII scan of changed files is clean.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| `signal-hook` watcher thread never exits | Thread terminates when daemon process exits; no resources leaked. |
| Signal handling latency increases by ~100ms | Watcher polls every 100ms; acceptable for graceful shutdown of a cron monitor. |
| `RUNNING` static still used by helpers | Watcher only toggles the flag; all existing call sites remain unchanged. |

## Backlog

- `seal-automation`: implement `clade-seal` ring for automated closeout gating.
- `meshd-revival`: repair `trios_meshd.rs` API drift and register as `[[bin]]`.
- `cap-std-adoption`: migrate security-sensitive file/network access to capability-based I/O.

## Related

- `.claude/plans/trios-wave-007-monitor-hardening.md`
- `.trinity/wave-loop-007.md`
- `trios/.claude/skills/panic-hardening/SKILL.md`
- `trios/.claude/skills/tmp-zero/SKILL.md`
