# Cycle 12 Plan: BrowserOS macOS Compiled Binary Signature Repair

## Issue
BrowserOS server production binary (`bun build --compile`) is killed by macOS with exit code 137 (SIGKILL) immediately on launch. `codesign --sign -` fails with "invalid or unsupported format for signature". This blocks the release/CI gate and any portable install path.

## Root cause
Bun v1.3.12 regression: compiled macOS arm64 binaries have a corrupt/truncated `LC_CODE_SIGNATURE`. macOS AMFI kills the process before `main()` prints anything. Verified independently with a minimal `console.log` compiled binary.

Upstream references:
- oven-sh/bun#29306
- oven-sh/bun#29361
- oven-sh/bun#29120
- Fixed by oven-sh/bun#29272

## Fix
Post-process each compiled Darwin binary in `scripts/build/server/compile.ts`:
1. `codesign --remove-signature <binary>` to strip the broken Bun signature stub.
2. `codesign --force --sign - <binary>` to apply a valid ad-hoc signature.
3. Make the step best-effort (log warning if `codesign` is unavailable) so cross-compilation CI does not hard-fail.

## Files
- `packages/browseros-agent/scripts/build/server/compile.ts`
- `packages/browseros-agent/apps/server/tests/build.test.ts` (no change needed; existing test becomes the verification)

## Tests
- `bun test apps/server/tests/build.test.ts` must pass: 2 pass, 0 fail.
- `./build.sh` PASS.
- `cargo run --bin clade-build` PASS.
- `cargo run --bin clade-e2e` PASS.
- `bash e2e/trios_e2e_flow.sh` PASS.
- `cargo test --workspace` PASS.
- `cargo clippy --workspace` PASS.
- `open trios.app` + `curl /health` ok.

## Road
Road B (balanced): one file change, one test gate, no new features.

## Waiver
AGENT-V-WAIVER: browseros-ai/BrowserOS#2025 for hand-edited build script.
