---
:name: tablecloth-tmp-zero
:description: Finalize tmp-zero in clade-tablecloth and clade-improve, add tmp-zero-gate, and document the patterns in skills.
:owner: claude
:status: sealed
:wave: 008

# Spec - tablecloth tmp-zero completion (Wave 008)

## Goal

Eliminate the last `/tmp` usage in workspace Rust ring source, replace remaining test-only `panic!` markers with `matches!` assertions, and add a reusable `tmp-zero-gate` binary so the policy stays enforced.

## Changes

### clade-tablecloth

- Added `tempfile = "3"` to `[dev-dependencies]` in `Cargo.toml`.
- Migrated six tests from `/tmp` to `tempfile::tempdir()`:
  - `write_atomic_roundtrips`
  - `independent_verify_accepts_clean_fix`
  - `independent_verify_rejects_residual_pattern`
  - `independent_verify_rejects_introduced_unsafe`
  - `independent_verify_rejects_missing_file`
  - `independent_verify_rejects_empty_file`
- Removed manual `fs::remove_file` cleanup.
- Fixed `PathBuf` -> `&str` type mismatch for `independent_verify(file_path: &str, ...)` by passing `&path.to_string_lossy()`.
- ASCII-cleaned pre-existing `[U+23ED]` / `[U+2190]` placeholders in log/PR strings.

### clade-improve

- Replaced test `_ => panic!("expected Improve")` with `assert!(matches!(...))`:
  - `parse_improve_without_description`
  - `parse_improve_with_description`
- No new dependencies.

### tmp-zero-gate

- New ring `rings/RUST-99/tmp-zero-gate` with `walkdir = "2"` dependency.
- Walks the trios workspace for `.rs` and `.swift` source files.
- Exempts `docs/`, `smoke/`, `tools/`, `.trinity/`, `.claude/`.
- Exits `0` if clean, `1` with `file:line:ext line` violations.
- Registered as a workspace member in `trios/Cargo.toml`.
- Gracefully handles missing `current_dir()` and missing `Cargo.toml` root without `expect`.

### Skills

- Updated `trios/.claude/skills/tmp-zero/SKILL.md`:
  - Added "CI Gate: tmp-zero-gate" section with registration instructions.
  - Added clade-tablecloth `independent_verify` migration example.
- Updated `trios/.claude/skills/panic-hardening/SKILL.md`:
  - Added section "Replace test-only `panic!` markers with `matches!`".
  - Added checklist items for test panic markers and tmp-zero-gate.

## Verification

- `cargo test --workspace --all-features` passes (all rings).
- `cargo clippy --workspace --all-targets --all-features` is clean.
- `cargo run --bin tmp-zero-gate -- /Users/playra/BrowserOS/trios` reports OK.
- `./build.sh` passes.
- ASCII scan of changed files is clean.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| `tempfile` dir leaked on panic abort | `TempDir::drop()` auto-cleans on unwind; aborts are rare in tests. |
| Gate false-positives on doc-only `/tmp` | Exemption list covers docs, smoke, tools, runtime, and agent instructions. |
| `expect_used` clippy in gate startup | Uses `match env::current_dir()` and exits `MISCONFIG` on error. |

## Related

- `.claude/plans/trios-wave-008-tablecloth-tmp-zero.md`
- `.trinity/specs/tmp-zero.md`
- `.trinity/wave-loop-008.md`
- `trios/.claude/skills/tmp-zero/SKILL.md`
- `trios/.claude/skills/panic-hardening/SKILL.md`
