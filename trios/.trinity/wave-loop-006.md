# Wave Loop 006 - trios tmp-zero: remove /tmp from Rust ring source

## Sources

- Wave 6 weak-spot audit after Wave 005.
- Literature scan:
  - [Atomicity for Agents: Exposing, Exploiting, and Mitigating TOCTOU Vulnerabilities in Browser-Use Agents](https://arxiv.org/html/2603.00476) (2026) - TOCTOU attacks on shared files/temp paths.
  - [Mind the Gap: Time-of-Check to Time-of-Use Vulnerabilities in LLM-Enabled Agents](https://arxiv.org/pdf/2508.17155) (2025) - file-system TOCTOU in agent code.
  - [Docker Does Not Guarantee Reproducibility](https://arxiv.org/abs/2601.12811) (2025) - recommends avoiding temporary files for reproducible builds.
  - [RepoST: Scalable Repository-Level Coding Environment Construction with Sandbox Testing](https://arxiv.org/abs/2503.07358) (2025) - sandbox testing for isolation.
  - [Detecting Flakiness in Quantum Software: A Dynamic Testing Approach](https://arxiv.org/abs/2512.18088) (2025) - clean environments per test run.
  - [An Empirical Case Study on the Temporary File Smell in Dockerfiles](https://doi.org/10.1109/access.2019.2905424) (2019) - foundational temporary-file smell definition.

## Key research takeaways

1. World-writable `/tmp` paths enable TOCTOU races and cross-user/cross-process collisions.
2. Reproducible builds and CI require isolated, per-run temporary state.
3. Shared `/tmp` state between test runs causes flakiness; best practice is per-test scratch directories.
4. The Rust `tempfile` crate provides `tempdir()` with automatic cleanup, avoiding the temporary-file smell.

## Decomposed plan (P0 -> P5)

### P0 - Migrate clade-experience tests from /tmp to tempfile
- [x] Add `tempfile = "3"` as dev-dependency in `clade-experience/Cargo.toml`.
- [x] Rewrite `load_episodes_skips_oversized_files` to use two `tempfile::tempdir()` instances.
- [x] Remove manual `fs::remove_dir_all` cleanup.

### P1 - Migrate clade-audit tests from /tmp to tempfile
- [x] Add `tempfile = "3"` as dev-dependency in `clade-audit/Cargo.toml`.
- [x] Rewrite `read_file_bounded_returns_none_for_missing` to use a tempdir path.
- [x] Rewrite `read_file_bounded_reads_small_file` to write inside a tempdir.

### P2 - Clean clade-launchd test WorkingDirectory examples
- [x] Replace `/tmp` sample paths in tests with project-relative `.trinity/dev/launchd-wd`.
- [x] Keep XML-escape assertions unchanged.

### P3 - Add workspace policy and save skills
- [x] Update `trios/.claude/skills/portable-paths/SKILL.md` with completed `/tmp/mesh.drop` migration and `tempfile` recipe.
- [x] Create `trios/.claude/skills/tmp-zero/SKILL.md`.
- [x] ASCII-clean all changed source and Cargo.toml lines.

### P4 - Verify
- [x] Run `grep -RIn '/tmp' rings/RUST-*/src/` and confirm zero matches in workspace Rust source.
- [x] Run `cargo test -p clade-experience -p clade-launchd -p clade-audit --all-features`.
- [x] Run `cargo test --workspace --all-features`.
- [x] Run `cargo clippy --workspace --all-targets --all-features`.
- [x] Run `./build.sh`.
- [x] Run ASCII scan on changed files.

### P5 - Backlog
- [ ] `seal-automation`: implement `clade-seal` ring that runs build/test/clippy/ASCII gate.
- [ ] `meshd-revival`: repair `trios_meshd.rs` API drift and register it as `[[bin]]`.
- [ ] `diff-hardening`: ASCII-clean `clade-diff` console output and add HTTP probe timeout/retry policy.

## This iteration goal

Land P0-P4: eliminate all `/tmp` usage in trios workspace Rust ring source files (`clade-experience`, `clade-launchd`, `clade-audit`), introduce `tempfile` as the standard pattern for test scratch directories, and document the policy in reusable skills.

## Wave 006 Closeout Report

Status: LANDED in commit `HEAD` on branch `feat/zai-provider`.

### What shipped

- **P0 clade-experience**: added `tempfile` dev-dependency; rewrote oversized-file test to use isolated tempdirs for fixture dir and fake `TRIOS_ROOT`; removed manual cleanup.
- **P1 clade-audit**: added `tempfile` dev-dependency; rewrote missing-file and small-file tests to use `tempfile::tempdir()`.
- **P2 clade-launchd**: replaced all `/tmp` sample `WorkingDirectory` strings in tests with project-relative `.trinity/dev/launchd-wd`.
- **P3 skills**: updated `portable-paths/SKILL.md` (completed `/tmp/mesh.drop`, added `tempfile` recipe) and created `tmp-zero/SKILL.md`.
- **P4 verification**: workspace is `/tmp`-free in Rust source; all tests and clippy pass; build passes; ASCII clean.

### Verification

- `grep -RIn '/tmp' rings/RUST-*/src/` -> zero matches.
- `cargo test -p clade-experience -p clade-launchd -p clade-audit --all-features` -> 37 tests passed.
- `cargo test --workspace --all-features` -> all workspace tests passed.
- `cargo clippy --workspace --all-targets --all-features` -> clean.
- `./build.sh` -> OK.
- ASCII scan on changed files -> zero violations.

### Remaining backlog (not in scope)

- `seal-automation`: automated Wave closeout gating via `clade-seal` ring.
- `meshd-revival`: register `trios-meshd` binary once API drift is repaired.
- `diff-hardening`: clean `clade-diff` output and add HTTP timeout.

## [FUTURE OPTIONS - next Wave loop]

1) **`seal-automation`** - implement a `clade-seal` Rust ring that runs `./build.sh` + `cargo test --workspace` + `cargo clippy --workspace --all-targets --all-features` + ASCII scan, writes a signed seal to `.trinity/state/seal.json`, and makes `clade-promote` require that seal before advancing any branch. Goal: reproducible, automated Wave closeout gating.

2) **`meshd-revival`** - repair `src/bin/trios_meshd.rs` against the current `trios-mesh` API (`Delivery` enum, struct `MeshRouter`, exported `StaticKey::from_seed`), register it as `[[bin]]`, and add config parsing/host-sim e2e tests. Goal: make the mesh daemon a first-class workspace binary.

3) **`diff-hardening`** - ASCII-clean `clade-diff` console output (box-drawing and emoji) and add an HTTP probe timeout/retry policy to prevent hangs against sovereign/canary health endpoints. Goal: bring `clade-diff` into L3 PURITY compliance and production robustness.
