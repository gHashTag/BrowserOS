:name: trios-wave-008-tablecloth-tmp-zero
:description: Complete tmp-zero by migrating clade-tablecloth tests from /tmp to tempfile, harden clade-improve test panic surface, and add a workspace /tmp-gate script.

# Wave 008 Plan - trios tmp-zero completion and test hardening

## Sources and research

- Weak-spot audit after Wave 007.
- Scientific literature:
  - [deflake.rs: Detect Flaky Tests in Rust Projects using Execution Data](https://philmcminn.com/publications/magill2025.pdf) (JOSS 2025) - per-test data and git diff to detect flaky Rust tests; underscores the value of isolated test state.
  - [RepoST: Scalable Repository-Level Coding Environment Construction with Sandbox Testing](https://arxiv.org/pdf/2503.07358) (2025) - sandbox testing for isolation and reproducibility.
  - [Docker Does Not Guarantee Reproducibility](https://arxiv.org/abs/2601.12811) (2025) - avoid shared temporary state for reproducible builds.
  - [chore(clippy): forbid .expect() in production code](https://github.com/DataDog/lading/pull/1882) (DataDog/lading, 2025) - lint-driven hardening: workspace `expect_used = deny` with test carve-outs.
  - [ADR-030: Code-Quality Gating - Enforced Lint Posture and Debt Ratchet](https://canopy-c1fab5.gitlab.io/canopy/adrs/adr-030-code-quality-gating.html) (Canopy, 2026) - comprehensive Clippy lint posture and monotonic debt ratchet.

## Research takeaways

1. Shared `/tmp` paths between tests are a known source of flakiness and cross-test collisions (deflake.rs, RepoST).
2. Lint-driven hardening with workspace `expect_used`/`unwrap_used` at `deny` plus test carve-outs is a proven pattern in production Rust codebases (DataDog/lading, Canopy).
3. A monotonic debt ratchet prevents regression once a policy is established.
4. Test-only panic markers (`panic!("expected X")`) should still be replaced with `matches!`/`assert!(matches!(...))` to keep tests panic-free in style.

## Current weak spots

- `clade-tablecloth/src/main.rs` has 6 tests using `/tmp`:
  - `write_atomic_roundtrips`
  - `independent_verify_accepts_clean_fix`
  - `independent_verify_rejects_residual_pattern`
  - `independent_verify_rejects_introduced_unsafe`
  - `independent_verify_rejects_missing_file`
  - `independent_verify_rejects_empty_file`
- `clade-improve/src/main.rs` tests use `_ => panic!("expected Improve")` for branch assertion; better to use `assert!(matches!(...))`.
- There is no automated CI-style gate that verifies `/tmp` does not re-enter workspace Rust source.

## Decomposed plan (P0 -> P5)

### P0 - Migrate clade-tablecloth tests from /tmp to tempfile
- Add `tempfile = "3"` to `[dev-dependencies]` in `clade-tablecloth/Cargo.toml`.
- Rewrite the 6 tests above to use `tempfile::tempdir()` for scratch files.
- Remove manual `fs::remove_file` cleanup.

### P1 - Harden clade-improve test branch assertions
- Replace `_ => panic!("expected Improve")` in tests with `assert!(matches!(parse_command(&args), CliCommand::Improve(_)))` and an explicit `desc` assertion where needed.
- No new dependencies.

### P2 - Add workspace /tmp gate script
- Create `trios/rings/RUST-99/tmp-zero-gate` ring that:
  - Walks `rings/RUST-*/src/**/*.rs` and `BR-OUTPUT/**/*.swift` under the trios root for `/tmp` literals.
  - Exempts known documentation/tooling/runtime paths: `docs/`, `smoke/`, `tools/`, `.trinity/`, `.claude/`.
  - Exits 0 if clean, 1 with `file:line:ext line` list if violations found.
- Register the binary in workspace `Cargo.toml` so `cargo run --bin tmp-zero-gate` works.
- Add the gate to `trios/.claude/skills/tmp-zero/SKILL.md` "CI Gate" section.

### P3 - Verify and ASCII clean
- Run `./build.sh`.
- Run `cargo test --workspace --all-features`.
- Run `cargo clippy --workspace --all-targets --all-features`.
- Run `cargo run --bin tmp-zero-gate` and confirm zero violations.
- ASCII-clean all changed files.

### P4 - Save skills and experience
- Update `trios/.claude/skills/tmp-zero/SKILL.md` with CI gate and clade-tablecloth examples.
- Update `trios/.claude/skills/panic-hardening/SKILL.md` if clade-improve changes introduce new patterns.
- Write `.trinity/specs/tablecloth-tmp-zero.md` and `.trinity/wave-loop-008.md`.
- Append `.trinity/experience.md` and write JSON episode.

### P5 - Backlog
- `seal-automation`: wire `tmp-zero-gate` into a `clade-seal` ring.
- `meshd-revival`: repair `trios_meshd.rs` API drift and register as `[[bin]]`.
- `cap-std-adoption`: migrate security-sensitive file I/O to capability-based `cap-std`.

## This iteration goal

Land P0-P4: eliminate all remaining `/tmp` usage in workspace Rust ring source files, replace test panic markers in `clade-improve` with `matches!`, add a reusable `/tmp`-zero gate binary, and document everything in skills.

## [FUTURE OPTIONS]

1. `seal-automation` - implement `clade-seal` ring that runs `./build.sh` + `cargo test --workspace` + `cargo clippy --workspace --all-targets --all-features` + `cargo run --bin tmp-zero-gate` + ASCII scan, writes a signed seal to `.trinity/state/seal.json`.
2. `meshd-revival` - repair `trios_meshd.rs` against current `trios-mesh` API, register as `[[bin]]`, add config/e2e tests.
3. `cap-std-adoption` - migrate `clade-monitor` and `clade-tablecloth` file I/O to `cap-std` for capability-based sandboxing.
