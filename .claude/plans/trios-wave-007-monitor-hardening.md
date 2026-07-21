# Wave 007 Plan - clade-monitor signal safety and test isolation

## Sources and research

- Weak-spot audit after Wave 006.
- Scientific literature:
  - [SBD: Securing safe Rust automatically from unsafe Rust](https://dl.acm.org/doi/10.1016/j.scico.2025.103281) (Science of Computer Programming, 2025) - compiler-integrated isolation of safe Rust from unsafe Rust.
  - [Characterizing Unsafe Code Encapsulation In Real-world Rust Systems](https://arxiv.org/html/2406.07936) (2024) - unsafety propagation graph and encapsulation patterns.
  - [SandCell: Sandboxing Rust Beyond Unsafe Code](https://doi.org/10.48550/arxiv.2509.24032) (2025) - flexible sandboxing for safe and unsafe Rust components.
  - [Safe4U: Identifying Unsound Safe Encapsulations of Unsafe Calls in Rust using LLMs](https://xing-hu.github.io/assets/papers/issta25safe4U.pdf) (ISSTA 2025) - detects unsound safe wrappers around unsafe calls.
  - [Zero-Cost Capabilities: Retrofitting Effect Safety in Rust](https://par.nsf.gov/servlets/purl/10523652) (2024) - capability-based filesystem effect safety in Rust.
  - [Building a Daemon using Rust](https://tuttlem.github.io/2024/11/16/building-a-daemon-using-rust.html) (Cogs and Levers, 2024) - daemon signal handling with signal-hook.
  - [Rust Signal Handling and Clean Shutdown for JavaScript Developers](https://www.rustfaq.org/en/how-to-write-signal-handlers-in-rust/) (2024) - AtomicBool graceful shutdown pattern.

## Research takeaways

1. Raw `libc::signal` callbacks are async-signal-unsafe for application logic; best practice is to set a flag and let the main loop react.
2. `signal-hook` provides a safe, cross-platform Rust API for SIGTERM/SIGINT shutdown flags.
3. Unsound safe wrappers around unsafe calls are a real source of CVEs (Safe4U found 22 new cases).
4. Capability-based filesystem access prevents path traversal and ambient-authority bugs.
5. Test scratch directories should use isolated per-test tempdirs, not shared `/tmp` paths (TOCTOU/flakiness).

## Current weak spots

- `clade-monitor` still uses raw `unsafe { libc::signal(...) }` to register SIGTERM/SIGINT handlers.
- `clade-monitor` tests write atomic-write fixtures to `/tmp/clade_monitor_atomic_test.json` and `/tmp/clade_monitor_atomic_notmp.json`.
- `clade-monitor` tests are not covered by `#[cfg(test)]` exemption for `expect`/`unwrap`; the whole file has no `#![cfg_attr(test, ...)]`.
- `clade-monitor` contains multiple `unsafe` blocks (`libc::kill`, `flock`, `setpgid`, `getuid`, signal registration). While reviewed, they are concentrated in the daemon that runs under pm2.

## Decomposed plan (P0 -> P5)

### P0 - Replace raw signal handlers with signal-hook
- Add `signal-hook = "0.3"` to `clade-monitor/Cargo.toml`.
- Replace `unsafe { libc::signal(SIGTERM|SIGINT, ...) }` with `signal_hook::flag::register` on an `Arc<AtomicBool>`.
- Keep the existing `RUNNING` static flag semantics so the main loop continues unchanged.
- Add `#[cfg(unix)]` gating where needed to keep cross-platform compile plausible.

### P1 - Migrate clade-monitor atomic-write tests from /tmp to tempfile
- Add `tempfile = "3"` to `[dev-dependencies]` in `clade-monitor/Cargo.toml`.
- Rewrite `atomic_write_creates_file` and `atomic_write_no_tmp_left_behind` to use `tempfile::tempdir()`.
- Remove manual `fs::remove_file` cleanup.

### P2 - Add test-only lint exemption to clade-monitor
- Add `#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]` to `clade-monitor/src/lib.rs` or at the top of `main.rs` (if no lib.rs, use crate-level attribute).
- Keep production code under `expect_used = deny`.

### P3 - Verify and ASCII clean
- Run `./build.sh`.
- Run `cargo test -p clade-monitor --all-features`.
- Run `cargo clippy --workspace --all-targets --all-features`.
- Run ASCII scan on all changed files.

### P4 - Save skills and experience
- Update `trios/.claude/skills/panic-hardening/SKILL.md` with signal-safe shutdown pattern.
- Create/update `trios/.claude/skills/tmp-zero/SKILL.md` with clade-monitor examples.
- Write `.trinity/specs/monitor-signal-hardening.md` and `.trinity/wave-loop-007.md`.
- Append `.trinity/experience.md` and write JSON episode.

### P5 - Backlog
- `seal-automation`: implement `clade-seal` ring for automated closeout gating.
- `meshd-revival`: repair `trios_meshd.rs` API drift and register as `[[bin]]`.
- `cap-std-adoption`: migrate file I/O in security-sensitive rings to capability-based `cap-std`.

## This iteration goal

Land P0-P4: replace raw `libc::signal` handlers in `clade-monitor` with safe `signal-hook` shutdown flags, migrate its `/tmp` test fixtures to `tempfile`, add test-only lint exemption, and document the patterns in reusable skills.

## [FUTURE OPTIONS]

1. `seal-automation` - implement `clade-seal` ring that runs `./build.sh` + `cargo test --workspace` + `cargo clippy --workspace --all-targets --all-features` + ASCII scan and writes a signed seal required by `clade-promote`.
2. `meshd-revival` - repair `trios_meshd.rs` against current `trios-mesh` API, register as `[[bin]]`, add config/e2e tests.
3. `cap-std-adoption` - migrate `clade-monitor` and other daemon rings to capability-based `cap-std` file/network access to eliminate ambient-authority risks.
