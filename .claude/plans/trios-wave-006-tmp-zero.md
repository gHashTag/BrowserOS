# Wave 006 Plan - trios tmp-zero: eliminate world-writable /tmp from Rust ring tests

## Sources and research

- Weak-spot audit after Wave 005.
- Scientific literature:
  - [Atomicity for Agents: Exposing, Exploiting, and Mitigating TOCTOU Vulnerabilities in Browser-Use Agents](https://arxiv.org/html/2603.00476) (2026) - TOCTOU attacks on shared files/temp paths.
  - [Mind the Gap: Time-of-Check to Time-of-Use Vulnerabilities in LLM-Enabled Agents](https://arxiv.org/pdf/2508.17155) (2025) - file-system TOCTOU in agent code.
  - [Docker Does Not Guarantee Reproducibility](https://arxiv.org/abs/2601.12811) (2025) - recommends avoiding temporary files for reproducible builds.
  - [RepoST: Scalable Repository-Level Coding Environment Construction with Sandbox Testing](https://arxiv.org/abs/2503.07358) (2025) - sandbox testing for isolation and reproducibility.
  - [Detecting Flakiness in Quantum Software: A Dynamic Testing Approach](https://arxiv.org/abs/2512.18088) (2025) - clean environments per test run to avoid flaky collisions.
  - [An Empirical Case Study on the Temporary File Smell in Dockerfiles](https://doi.org/10.1109/access.2019.2905424) (2019) - foundational "temporary file smell" definition and detection.

## Research takeaways

1. World-writable `/tmp` paths enable TOCTOU races and cross-user/cross-process collisions (Atomicity for Agents, Mind the Gap).
2. Reproducible builds and CI require isolated, per-run temporary state (Docker Does Not Guarantee Reproducibility, RepoST).
3. Shared `/tmp` state between test runs causes flakiness; best practice is per-test scratch directories (Detecting Flakiness in Quantum Software).
4. The Rust `tempfile` crate provides `tempdir()`/`NamedTempFile` with automatic cleanup, which avoids the temporary-file smell.

## Current weak spots

- `clade-experience/src/main.rs:259` - test writes to `/tmp/clade_experience_size_test`.
- `clade-experience/src/main.rs:268-278` - test sets `TRIOS_ROOT=/tmp/clade_experience_size_test_root`, creates `.trinity/experience` under it, writes files, then removes dir.
- `clade-launchd/src/main.rs:145-176` - tests use `/tmp` as sample WorkingDirectory values.
- `clade-audit/src/main.rs:1139` - test reads `/tmp/nonexistent_audit_test_file`.
- `clade-audit/src/main.rs:1145` - test writes `/tmp/clade_audit_bounded_test.txt`.
- No workspace crate uses the `tempfile` crate for isolated test scratch dirs.

## Decomposed plan (P0 -> P5)

### P0 - Migrate clade-experience tests from /tmp to tempfile
- Add `tempfile` as a dev-dependency in `clade-experience/Cargo.toml`.
- Replace `/tmp/clade_experience_size_test` with `tempfile::tempdir()`.
- Replace `/tmp/clade_experience_size_test_root/.trinity/experience` with a tempdir that is then pointed to via `TRIOS_ROOT`.
- Ensure automatic cleanup via `TempDir::drop()`.

### P1 - Migrate clade-audit tests from /tmp to tempfile
- Add `tempfile` as a dev-dependency in `clade-audit/Cargo.toml`.
- Replace `/tmp/nonexistent_audit_test_file` with a path inside `tempfile::tempdir()` (or use a guaranteed-nonexistent path under it).
- Replace `/tmp/clade_audit_bounded_test.txt` with `NamedTempFile` inside a tempdir.

### P2 - Clean clade-launchd test WorkingDirectory examples
- Change test sample paths from `/tmp` to project-relative `.trinity/dev/launchd-test/` or tempfile-generated paths.
- No external dependency needed; these are just string inputs to `plist_xml()`.

### P3 - Add workspace policy and ASCII cleanup
- Add a note to `trios/.claude/skills/portable-paths/SKILL.md` and/or create `tmp-zero/SKILL.md` documenting the no-/tmp policy.
- ASCII-clean all changed source and Cargo.toml lines.
- Optionally add a CI-style grep test that fails if `/tmp` appears in `rings/**/src/*.rs` test or production code (smoke docs/tools exempt).

### P4 - Verify
- Run `./build.sh`.
- Run `cargo test --workspace --all-features`.
- Run `cargo clippy --workspace --all-targets --all-features`.
- Run ASCII scan on all changed files.

### P5 - Backlog
- `seal-automation`: implement `clade-seal` ring that runs build/test/clippy/ASCII gate.
- `meshd-revival`: repair `trios_meshd.rs` API drift and register it as `[[bin]]`.
- `diff-hardening`: add timeout to `clade-diff` HTTP probe and ASCII-clean its console output.

## This iteration goal

Land P0-P4: eliminate all `/tmp` usage in trios workspace Rust ring source files (`clade-experience`, `clade-launchd`, `clade-audit`), introduce `tempfile` as the standard pattern for test scratch directories, and document the policy in a reusable skill.

## [FUTURE OPTIONS]

1. `seal-automation` - implement `clade-seal` ring that runs `./build.sh` + `cargo test --workspace` + `cargo clippy --workspace --all-targets --all-features` + ASCII scan and writes a signed seal file required by `clade-promote`.
2. `meshd-revival` - repair `src/bin/trios_meshd.rs` against current `trios-mesh` API, register as `[[bin]]`, add config parsing/host-sim e2e tests.
3. `diff-hardening` - ASCII-clean `clade-diff` console output and add HTTP probe timeout/retry policy to prevent hangs.
