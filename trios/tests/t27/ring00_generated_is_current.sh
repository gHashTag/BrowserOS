#!/usr/bin/env bash
#
# RING-00 - the committed artifact matches the .t27 it claims to come from.
#
# L0 in CLAUDE.md: "Generated files are artifacts. They are not edited. A diff
# that changes a generated file without changing its `.t27` is a defect."
# Until 2026-09-03 there was no artifact at all: `t27c gen-rust` produced valid
# Rust on demand and nothing in the tree held the result, so the ring could be
# said to "generate" while nothing was ever built from it and no reviewer had
# seen a line of its output.
#
# This checks the two ways the pair can come apart:
#
#   the .t27 changed and nobody regenerated  -> the artifact is stale
#   the .rs  was edited by hand              -> the artifact is a lie
#
# Both show up as the same diff, which is the point: the artifact is not a file
# anyone may have an opinion about, it is a function of the source.
#
# It also compiles the artifact with bare `rustc`, no cargo and no dependencies,
# because that is the contract this ring's header states. A ring that generates
# code nothing can build has not been demonstrated to work.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="$ROOT/rings/T27-00/queen_core.t27"
ARTIFACT="$ROOT/rings/T27-00/generated/queen_core.rs"
T27C="${T27C:-/Users/playra/t27/target/release/t27c}"

fail() { echo "[FAIL] ring00_generated_is_current: $*" >&2; exit 1; }

[ -f "$SOURCE" ]   || fail "the source is missing: $SOURCE"
[ -f "$ARTIFACT" ] || fail "the artifact is missing: $ARTIFACT
       generate it with: $T27C gen-rust $SOURCE > $ARTIFACT"

if [ ! -x "$T27C" ]; then
  # A gate that cannot find its compiler must say so and fail, not pass. This
  # repository has already shipped a gate that reported success because the
  # tool it drives was absent.
  fail "t27c not found at $T27C - set T27C=<path>.
       This check cannot pass without it: an unverified artifact is exactly
       what it exists to catch."
fi

FRESH="$(mktemp -t ring00_generated)"
trap 'rm -f "$FRESH" "$FRESH.rlib"' EXIT
"$T27C" gen-rust "$SOURCE" > "$FRESH" || fail "t27c gen-rust exited non-zero"

if ! diff -u "$ARTIFACT" "$FRESH" > "$FRESH.diff" 2>&1; then
  echo "[FAIL] ring00_generated_is_current: the committed artifact is not what the source generates" >&2
  head -40 "$FRESH.diff" >&2
  echo "       regenerate with: $T27C gen-rust $SOURCE > $ARTIFACT" >&2
  exit 1
fi

# Bare rustc, no cargo, no dependencies - the contract this ring states.
if ! rustc --crate-type lib --edition 2021 -o "$FRESH.rlib" "$ARTIFACT" 2> "$FRESH.err"; then
  echo "[FAIL] ring00_generated_is_current: the artifact does not compile" >&2
  head -20 "$FRESH.err" >&2
  exit 1
fi

LINES="$(wc -l < "$ARTIFACT" | tr -d ' ')"
RULES="$(grep -c '^pub fn ' "$ARTIFACT" || true)"
CONSTS="$(grep -c '^pub const ' "$ARTIFACT" || true)"
echo "[OK] ring00_generated_is_current: the artifact is what the source generates and it compiles"
echo "     $LINES lines, $RULES rules, $CONSTS constants, from rings/T27-00/queen_core.t27"
