# Wave Loop 007 - clade-monitor signal safety and test isolation

## Sources

- Wave 7 weak-spot audit after Wave 006.
- Literature scan:
  - [SBD: Securing safe Rust automatically from unsafe Rust](https://dl.acm.org/doi/10.1016/j.scico.2025.103281) (Science of Computer Programming, 2025).
  - [Characterizing Unsafe Code Encapsulation In Real-world Rust Systems](https://arxiv.org/html/2406.07936) (2024).
  - [SandCell: Sandboxing Rust Beyond Unsafe Code](https://doi.org/10.48550/arxiv.2509.24032) (2025).
  - [Safe4U: Identifying Unsound Safe Encapsulations of Unsafe Calls in Rust using LLMs](https://xing-hu.github.io/assets/papers/issta25safe4U.pdf) (ISSTA 2025).
  - [Zero-Cost Capabilities: Retrofitting Effect Safety in Rust](https://par.nsf.gov/servlets/purl/10523652) (2024).
  - [Building a Daemon using Rust](https://tuttlem.github.io/2024/11/16/building-a-daemon-using-rust.html) (Cogs and Levers, 2024).
  - [Rust Signal Handling and Clean Shutdown for JavaScript Developers](https://www.rustfaq.org/en/how-to-write-signal-handlers-in-rust/) (2024).

## Key research takeaways

1. Raw `libc::signal` callbacks are async-signal-unsafe for application logic; best practice is to set a flag and let the main loop react.
2. `signal-hook` provides a safe, cross-platform Rust API for SIGTERM/SIGINT shutdown flags.
3. Unsound safe wrappers around unsafe calls are a real source of CVEs.
4. Capability-based filesystem access prevents path traversal and ambient-authority bugs.
5. Test scratch directories should use isolated per-test tempdirs, not shared `/tmp` paths.

## Decomposed plan (P0 -> P5)

### P0 - Replace raw signal handlers with signal-hook
- [x] Add `signal-hook = "0.3"` to `clade-monitor/Cargo.toml`.
- [x] Replace `unsafe { libc::signal(SIGTERM|SIGINT, ...) }` with `signal_hook::flag::register` on an `Arc<AtomicBool>`.
- [x] Keep the existing `RUNNING` static flag semantics so the main loop continues unchanged.

### P1 - Migrate clade-monitor atomic-write tests from /tmp to tempfile
- [x] Add `tempfile = "3"` to `[dev-dependencies]` in `clade-monitor/Cargo.toml`.
- [x] Rewrite `atomic_write_creates_file` and `atomic_write_no_tmp_left_behind` to use `tempfile::tempdir()`.
- [x] Remove manual `fs::remove_file` cleanup.

### P2 - Add test-only lint exemption to clade-monitor
- [x] Add `#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]` to the top of `clade-monitor/src/main.rs`.
- [x] Keep production code under `expect_used = deny`.

### P3 - Verify and ASCII clean
- [x] Run `./build.sh`.
- [x] Run `cargo test -p clade-monitor --all-features`.
- [x] Run `cargo clippy --workspace --all-targets --all-features`.
- [x] ASCII-clean all changed files.

### P4 - Save skills and experience
- [x] Update `trios/.claude/skills/panic-hardening/SKILL.md` with signal-safe shutdown pattern.
- [x] Update `trios/.claude/skills/tmp-zero/SKILL.md` with clade-monitor examples.
- [x] Write `.trinity/specs/monitor-signal-hardening.md` and `.trinity/wave-loop-007.md`.
- [x] Append `.trinity/experience.md` and write JSON episode.

### P5 - Backlog
- [ ] `seal-automation`: implement `clade-seal` ring for automated closeout gating.
- [ ] `meshd-revival`: repair `trios_meshd.rs` API drift and register as `[[bin]]`.
- [ ] `cap-std-adoption`: migrate file I/O in security-sensitive rings to capability-based `cap-std`.

## This iteration goal

Land P0-P4: replace raw `libc::signal` handlers in `clade-monitor` with safe `signal-hook` shutdown flags, migrate its `/tmp` test fixtures to `tempfile`, add test-only lint exemption, and document the patterns in reusable skills.

## Wave 007 Closeout Report

Status: LANDED in commit `HEAD` on branch `feat/zai-provider`.

### What shipped

- **P0 signal safety**: `clade-monitor` now uses `signal-hook::flag::register` on `SIGTERM`/`SIGINT`, with a watcher thread propagating the flag to the existing `RUNNING` static. Raw `unsafe { libc::signal(...) }` registration removed.
- **P1 tmp-zero in clade-monitor**: atomic-write tests and missing-binary test migrated to `tempfile::tempdir()`.
- **P2 lint exemption**: added `#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]` to `clade-monitor`.
- **P3 verification**: full workspace clippy clean; tests pass; build passes; ASCII clean.
- **P4 skills**: updated `panic-hardening/SKILL.md` (signal-safe shutdown section) and `tmp-zero/SKILL.md` (real examples).

### Verification

- `cargo test -p clade-monitor --all-features` -> 38 tests passed.
- `cargo test --workspace --all-features` -> all workspace tests passed.
- `cargo clippy --workspace --all-targets --all-features` -> clean.
- `./build.sh` -> OK.
- `grep -RIn '/tmp' rings/RUST-*/src/main.rs` -> zero matches.
- ASCII scan on changed files -> zero violations.

### Remaining backlog (not in scope)

- `seal-automation`: automated Wave closeout gating.
- `meshd-revival`: register `trios-meshd` binary once API drift is repaired.
- `cap-std-adoption`: capability-based I/O for security-sensitive rings.

## [FUTURE OPTIONS - next Wave loop]

1) **`seal-automation`** - implement a `clade-seal` Rust ring that runs `./build.sh` + `cargo test --workspace` + `cargo clippy --workspace --all-targets --all-features` + ASCII scan, writes a signed seal to `.trinity/state/seal.json`, and makes `clade-promote` require that seal before advancing any branch. Goal: reproducible automated Wave closeout gating.

2) **`meshd-revival`** - repair `src/bin/trios_meshd.rs` against the current `trios-mesh` API (`Delivery` enum, struct `MeshRouter`, exported `StaticKey::from_seed`), register it as `[[bin]]`, and add config parsing/host-sim e2e tests. Goal: make the mesh daemon a first-class workspace binary.

3) **`cap-std-adoption`** - migrate `clade-monitor` and other daemon rings to capability-based `cap-std` file/network access, starting with the pidfile/state directory I/O, to eliminate ambient-authority risks. Goal: apply capability-based sandboxing research to trios runtime.
