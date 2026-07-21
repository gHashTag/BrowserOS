:name: tmp-zero
:description: Eliminate world-writable /tmp usage from trios workspace Rust ring source files by migrating tests to tempfile and production paths to .trinity/ subdirs.
:owner: claude
:status: sealed
:wave: 006

# Spec - trios tmp-zero: remove /tmp from Rust ring source

## Goal

Eliminate all `/tmp` path literals from trios workspace Rust ring source files, replacing test scratch directories with the `tempfile` crate and production paths with project-relative `.trinity/` subdirs.

## Background

Wave 005 left three rings using `/tmp` in unit tests and sample strings:
- `clade-experience` wrote size-test fixtures to `/tmp/clade_experience_size_test` and a fake `TRIOS_ROOT` under `/tmp`.
- `clade-audit` read and wrote test files under `/tmp`.
- `clade-launchd` tests used `/tmp` as sample `WorkingDirectory` values.

Research on TOCTOU vulnerabilities (Atomicity for Agents, Mind the Gap) and CI reproducibility (Docker Does Not Guarantee Reproducibility, RepoST) shows that shared `/tmp` paths cause collisions, races, and flaky tests. The `tempfile` crate provides isolated per-test directories with automatic cleanup.

## Changes

### clade-experience

- Added `tempfile = "3"` to `[dev-dependencies]` in `Cargo.toml`.
- Rewrote `load_episodes_skips_oversized_files` to use two `tempfile::tempdir()` instances:
  - One for the direct fixture directory.
  - One as `TRIOS_ROOT` pointing to `.trinity/experience` inside the temp dir.
- Removed manual `fs::remove_dir_all` cleanup; `TempDir::drop()` handles it.

### clade-audit

- Added `tempfile = "3"` to `[dev-dependencies]` in `Cargo.toml`.
- Rewrote `read_file_bounded_returns_none_for_missing` to use a guaranteed-nonexistent file under a `tempfile::tempdir()`.
- Rewrote `read_file_bounded_reads_small_file` to write the test file inside a `tempfile::tempdir()` and let the directory auto-clean.

### clade-launchd

- No dependency needed (tests only pass strings to `plist_xml`).
- Replaced all `/tmp` sample `WorkingDirectory` strings in tests with project-relative `.trinity/dev/launchd-wd`.
- Kept the program-path test that contains `&` unchanged except for moving from `/tmp/test&prog` to `.trinity/dev/test&prog`.

### Skills

- Updated `trios/.claude/skills/portable-paths/SKILL.md`:
  - Marked `/tmp/mesh.drop` migration as completed.
  - Added a "Test Scratch Directories" section with `tempfile` recipe.
- Created `trios/.claude/skills/tmp-zero/SKILL.md` documenting the anti-pattern, `tempfile` pattern, project-relative runtime state pattern, migration recipe, and future CI gate.

## Verification

- `grep -RIn '/tmp' rings/RUST-*/src/` returns zero matches in workspace Rust source.
- `cargo test -p clade-experience -p clade-launchd -p clade-audit --all-features` passes (37 tests).
- `cargo test --workspace --all-features` passes (full workspace).
- `cargo clippy --workspace --all-targets --all-features` is clean.
- `./build.sh` passes.
- ASCII scan of changed files is clean.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| `tempfile` dir leaked on panic abort | `TempDir` auto-cleans via `Drop`, even on panic unwind; aborts are rare in tests. |
| Project-relative paths differ between macOS/Linux | `trios_config::project_dir()` centralizes resolution; tests use tempdirs. |
| CI without writable OS temp | `tempfile` respects `TMPDIR`; this is a standard CI assumption. |

## Backlog

- `seal-automation`: add `clade-seal` ring that runs build/test/clippy/ASCII gate.
- `meshd-revival`: repair `trios_meshd.rs` API drift and register it as `[[bin]]`.
- `diff-hardening`: ASCII-clean `clade-diff` console output and add HTTP probe timeout.

## Related

- `.claude/plans/trios-wave-006-tmp-zero.md`
- `.trinity/wave-loop-006.md`
- `trios/.claude/skills/tmp-zero/SKILL.md`
- `trios/.claude/skills/portable-paths/SKILL.md`
