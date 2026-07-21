:name: wave-loop-008
:description: Wave 008 of T27 autonomous hardening: complete tmp-zero in clade-tablecloth, harden clade-improve test assertions, and add tmp-zero-gate.
:status: sealed

# Wave 008 - trios tmp-zero completion and test hardening

## Trigger

Recurring T27 Wave-loop macro invocation (8th wave in this session).

## Research

- Weak-spot audit after Wave 007 found six remaining `/tmp` tests in `clade-tablecloth` and test-only `panic!` markers in `clade-improve`.
- Literature reviewed: deflake.rs, RepoST, Docker reproducibility, DataDog/lading clippy expect ban, Canopy ADR-030 debt ratchet.

## Decisions

- Use `tempfile::tempdir()` for all remaining test scratch directories instead of `/tmp`.
- Replace test `panic!` markers with `assert!(matches!(...))` to keep the panic-free style consistent with workspace `unwrap_used`/`expect_used` at `deny`.
- Add a dedicated `tmp-zero-gate` ring rather than a one-off shell script, honoring L7 UNITY (no new `.sh` on the critical path).

## Implementation

| Change | Files |
| --- | --- |
| tablecloth /tmp migration | `trios/rings/RUST-14/clade-tablecloth/{Cargo.toml,src/main.rs}` |
| improve panic markers | `trios/rings/RUST-04/clade-improve/src/main.rs` |
| tmp-zero-gate binary | `trios/rings/RUST-99/tmp-zero-gate/{Cargo.toml,src/main.rs}` |
| workspace registration | `trios/Cargo.toml` |
| skill updates | `trios/.claude/skills/tmp-zero/SKILL.md`, `trios/.claude/skills/panic-hardening/SKILL.md` |
| spec / plan | `trios/.trinity/specs/tmp-zero.md`, `trios/.trinity/specs/tablecloth-tmp-zero.md`, `.claude/plans/trios-wave-008-tablecloth-tmp-zero.md` |

## Verification

- BUILD_PASS: `./build.sh`
- TEST_PASS: `cargo test --workspace --all-features`
- CLIPPY_PASS: `cargo clippy --workspace --all-targets --all-features`
- TMP_ZERO_PASS: `cargo run --bin tmp-zero-gate -- /Users/playra/BrowserOS-full/trios`
- ASCII_PASS: manual scan of changed files

## Seal status

BUILD_PASS, TEST_PASS, CLIPPY_PASS, TMP_ZERO_PASS, ASCII_PASS, E2E_NOT_RUN_DUE_SERVER_DOWN

## Next wave options

1. `seal-automation` - implement `clade-seal` ring that runs build/test/clippy/ASCII/tmp-zero-gate and writes a signed seal to `.trinity/state/seal.json`.
2. `meshd-revival` - repair `trios_meshd.rs` against current `trios-mesh` API, register as `[[bin]]`, add config/e2e tests.
3. `cap-std-adoption` - migrate `clade-monitor` and `clade-tablecloth` file I/O to `cap-std` for capability-based sandboxing.
