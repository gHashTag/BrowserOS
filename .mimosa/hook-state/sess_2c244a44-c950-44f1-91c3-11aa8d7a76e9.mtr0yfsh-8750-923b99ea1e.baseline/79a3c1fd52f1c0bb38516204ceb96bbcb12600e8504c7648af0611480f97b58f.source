#!/usr/bin/env bash
#
# RING-00 - the t27core CLI answers with the ring, and refuses bad input.
#
# rings/T27-00/shim/t27core.rs is the command-line face of the ring: it parses
# argv, calls a `pub fn` in the generated artifact, and prints `key=value`. It
# decides nothing itself. This script is what makes that claim checkable.
#
# It checks three separate things, and they are separate on purpose:
#
#   1. THE CONTRACT. Every subcommand, exact stdout, byte for byte. A verdict
#      is not "roughly right"; the production round parses these lines.
#
#   2. THE REFUSALS. A bad argument count, an unparsable integer, a boolean
#      that is neither 0 nor 1, an unknown subcommand, no subcommand at all:
#      each must exit 2, print `error=` on stderr, and print NOTHING on stdout.
#      A decision core that guesses at its input is the failure mode that
#      matters most here, so the refusals are checked as strictly as the
#      answers - including that a refusing binary does not also emit an answer
#      a caller could go on to parse.
#
#   3. THAT IT IS REALLY THE RING ANSWERING. Sections 1 and 2 would pass just
#      as well against a shim that restated the rules by hand, which is the one
#      thing this ring exists to prevent. So the last section rebuilds the same
#      shim source against a DELIBERATELY ALTERED copy of the generated
#      artifact and requires the answers to move with it. A hand-written rule
#      would not move.
#
# It reads the COMMITTED artifact rings/T27-00/generated/queen_core.rs and does
# not run t27c. That the artifact is what the source generates is a different
# claim, checked by tests/t27/ring00_generated_is_current.sh; that the artifact
# agrees with Swift is checked by tests/t27/ring00_parity.sh. This script is
# about the CLI wrapped around it, and stays runnable where the seed compiler
# is not installed.
#
# The build is bare `rustc`, twice, no cargo and no dependencies - the contract
# stated in the ring's header, and the same two-step tests/t27/ring00_parity.sh
# uses for its bench.
#
# If rustc is missing this script FAILS. It does not skip. This repository has
# already shipped a gate that reported success because the tool it drives was
# absent.
#
# Usage: tests/t27/ring00_shim.sh              (from anywhere)
#        RUSTC=/path/to/rustc tests/t27/ring00_shim.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ARTIFACT="$REPO_ROOT/rings/T27-00/generated/queen_core.rs"
SHIM="$REPO_ROOT/rings/T27-00/shim/t27core.rs"

TMP="$(mktemp -d /tmp/ring00-shim.XXXXXX)"
KEEP_ARTIFACTS=0
trap '[ "$KEEP_ARTIFACTS" -eq 1 ] || rm -rf "$TMP"' EXIT

fail() {
    KEEP_ARTIFACTS=1
    echo "[FAIL] ring00_shim: $*" >&2
    echo "       artifacts kept in $TMP" >&2
    exit 1
}

[ -f "$ARTIFACT" ] || fail "the generated artifact is missing: $ARTIFACT"
[ -f "$SHIM" ]     || fail "the shim source is missing: $SHIM"

# --- rustc ---------------------------------------------------------------------

find_rustc() {
    local candidates=()
    [ -n "${RUSTC:-}" ] && candidates+=("$RUSTC")
    local p
    if p="$(command -v rustc 2>/dev/null)"; then candidates+=("$p"); fi
    candidates+=( "$HOME/.cargo/bin/rustc" )
    local c
    for c in "${candidates[@]}"; do
        if [ -n "$c" ] && [ -x "$c" ]; then
            echo "$c"
            return 0
        fi
    done
    echo "none of: ${candidates[*]}" >&2
    return 1
}

RUSTC_BIN="$(find_rustc)" || fail "rustc was not found (set RUSTC=/path/to/rustc).
       This check cannot pass without it: a shim nobody compiled is exactly
       what it exists to catch."

# --- Build ----------------------------------------------------------------------
#
# build_t27core <artifact.rs> <shim.rs> <output binary>
# Two bare rustc invocations. The first proves the ring's own bare-lib
# contract on the artifact as emitted; the second builds the hand-written shim
# as its own crate against that rlib, so a failure names which half is broken.
build_t27core() {
    local artifact="$1" shim="$2" out="$3"
    # rustc insists an --extern rlib is named lib<crate>.rlib, so each build
    # gets its own directory rather than its own file name.
    local libdir="${out}.lib"
    local rlib="$libdir/libqueen_core.rlib"
    rm -rf "$libdir"
    mkdir -p "$libdir"

    if ! "$RUSTC_BIN" --edition 2021 --crate-type lib "$artifact" -o "$rlib" \
            2>"${out}.lib.err"; then
        cat "${out}.lib.err" >&2
        fail "rustc could not compile $artifact as a library"
    fi
    [ -s "$rlib" ] || fail "rustc reported success but wrote no rlib for $artifact"

    if ! "$RUSTC_BIN" --edition 2021 "$shim" --extern queen_core="$rlib" -o "$out" \
            2>"${out}.bin.err"; then
        cat "${out}.bin.err" >&2
        fail "rustc could not compile the shim $shim against $artifact"
    fi
    [ -x "$out" ] || fail "rustc reported success but wrote no t27core binary"
}

echo "== building t27core from the committed artifact"
build_t27core "$ARTIFACT" "$SHIM" "$TMP/t27core"
BIN="$TMP/t27core"

# --- Case helpers ----------------------------------------------------------------

CASES=0
ANSWERS=0
REFUSALS=0
COVERED=""

cover() {
    case " $COVERED " in
        *" $1 "*) ;;
        *) COVERED="$COVERED $1" ;;
    esac
}

# answers <description> <expected stdout> <argv...>
answers() {
    local desc="$1" expected="$2"
    shift 2
    CASES=$((CASES + 1)); ANSWERS=$((ANSWERS + 1))
    cover "$1"

    local got rc
    set +e
    got="$("$BIN" "$@" 2>"$TMP/case.err")"
    rc=$?
    set -e

    if [ "$rc" -ne 0 ]; then
        cat "$TMP/case.err" >&2
        fail "t27core $* exited $rc, want 0 ($desc)"
    fi
    if [ -s "$TMP/case.err" ]; then
        cat "$TMP/case.err" >&2
        fail "t27core $* answered correctly but wrote to stderr ($desc)"
    fi
    if [ "$got" != "$expected" ]; then
        printf 'want:\n%s\ngot:\n%s\n' "$expected" "$got" >&2
        fail "t27core $* printed the wrong answer ($desc)"
    fi
}

# refuses <description> <argv...>
refuses() {
    local desc="$1"
    shift
    CASES=$((CASES + 1)); REFUSALS=$((REFUSALS + 1))

    local got rc
    set +e
    got="$("$BIN" "$@" 2>"$TMP/case.err")"
    rc=$?
    set -e

    [ "$rc" -eq 2 ] || fail "t27core $* exited $rc, want 2 ($desc)"
    # Refusing and answering at once is worse than either: a caller that reads
    # stdout and not the exit status would act on the answer.
    [ -z "$got" ] || fail "t27core $* refused (exit 2) but still printed '$got' on stdout ($desc)"
    [ -s "$TMP/case.err" ] || fail "t27core $* refused silently, with nothing on stderr ($desc)"
    local first
    first="$(head -1 "$TMP/case.err")"
    case "$first" in
        error=?*) ;;
        *) fail "t27core $* wrote '$first' as the first line of stderr, want error=<what> ($desc)" ;;
    esac
}

# --- 1. The contract: every subcommand, exact stdout -------------------------------

echo "== capacity"
# MAX_CONCURRENT_WORKERS = 4.
answers "an idle swarm can start a worker and has every slot free" \
"can_start_another=true
free_slots=4" capacity 0
answers "one slot left is still a yes" \
"can_start_another=true
free_slots=1" capacity 3
answers "at the ceiling the answer is no, and no slot is free" \
"can_start_another=false
free_slots=0" capacity 4
answers "over the ceiling does not go negative" \
"can_start_another=false
free_slots=0" capacity 5

echo "== review"
# The rows of tests/t27/ring00_parity.sh r08..r14, put through the CLI.
answers "everything met with a diff behind it is an accept" \
"verdict=1
name=accept" review 2 2 0 3 0
answers "every criterion met with nothing committed cannot be an accept" \
"verdict=3
name=escalate" review 1 1 0 0 0
answers "an unmet criterion returns the task" \
"verdict=2
name=send_back" review 2 2 1 2 0
answers "a second return is still allowed" \
"verdict=2
name=send_back" review 1 1 1 1 1
answers "two returns must be the end of the automatic loop" \
"verdict=3
name=escalate" review 1 1 1 1 2
answers "one answer out of three questions is not a verdict" \
"verdict=0
name=wait" review 3 1 1 1 0
answers "a task with no criteria has no contract and cannot be judged" \
"verdict=3
name=escalate" review 0 0 0 5 0

echo "== retry"
# MAX_REAL_ATTEMPTS = 2.
answers "no real failure yet - attempt" \
"verdict=0
name=attempt" retry 0
answers "one real failure earns a second attempt" \
"verdict=0
name=attempt" retry 1
answers "two real failures must stop the loop" \
"verdict=1
name=escalate" retry 2
answers "past the ceiling is still an escalation" \
"verdict=1
name=escalate" retry 3

echo "== merge"
answers "green checks on a ready PR merge" \
"verdict=0
name=approve" merge 2 1 0 1
answers "pending checks wait" \
"verdict=1
name=wait" merge 1 1 0 1
answers "failing checks wake the worker" \
"verdict=2
name=wake_worker" merge 3 1 0 1
answers "erroring checks wake the worker" \
"verdict=2
name=wake_worker" merge 4 1 0 1
answers "a draft is refused whatever the checks say" \
"verdict=3
name=refuse" merge 2 1 1 1
answers "an unmergeable PR is refused whatever the checks say" \
"verdict=3
name=refuse" merge 2 0 0 1
answers "no rollup yet but checks are configured - wait for them" \
"verdict=1
name=wait" merge 0 1 0 1
answers "no rollup and no checks configured - nothing to wait for" \
"verdict=0
name=approve" merge 0 1 0 0

echo "== counts"
answers "an interruption does not spend the issue's budget" \
"counts_against_issue=false" counts 0
answers "producing nothing is a real failure" \
"counts_against_issue=true" counts 1
answers "working and still failing is a real failure" \
"counts_against_issue=true" counts 2
answers "a kind the ring does not know does not spend the budget" \
"counts_against_issue=false" counts 7

echo "== constants"
# Pinned exactly, in the order the generated artifact declares them. A change
# to the .t27 goes red here, which is the point: the production round reads
# these names, and a renumbered verdict must not pass silently.
CONSTANTS_EXPECTED="MAX_CONCURRENT_WORKERS=4
MAX_REAL_ATTEMPTS=2
MAX_SEND_BACKS=2
FAILURE_INTERRUPTED=0
FAILURE_PRODUCED_NOTHING=1
FAILURE_WORKED_BUT_FAILED=2
RETRY_ATTEMPT=0
RETRY_ESCALATE=1
REVIEW_WAIT=0
REVIEW_ACCEPT=1
REVIEW_SEND_BACK=2
REVIEW_ESCALATE=3
ROLLUP_NONE=0
ROLLUP_PENDING=1
ROLLUP_SUCCESS=2
ROLLUP_FAILURE=3
ROLLUP_ERROR=4
MERGE_APPROVE=0
MERGE_WAIT=1
MERGE_WAKE_WORKER=2
MERGE_REFUSE=3"
answers "every pub const in the generated artifact, in source order" \
"$CONSTANTS_EXPECTED" constants

# ...and the list is complete: one line per `pub const`, counted from the
# artifact itself, so a constant added to the .t27 and dropped by the shim's
# parser cannot hide behind an expectation that was written by hand.
WANT_CONSTS="$( { grep -c '^pub const ' "$ARTIFACT" || true; } | tr -d ' ')"
GOT_CONSTS="$( { printf '%s\n' "$CONSTANTS_EXPECTED" | grep -c '^[A-Z]' || true; } | tr -d ' ')"
[ "$WANT_CONSTS" -gt 0 ] || fail "the artifact declares no pub const - there is nothing to check"
[ "$GOT_CONSTS" -eq "$WANT_CONSTS" ] \
    || fail "t27core constants printed $GOT_CONSTS lines but the artifact declares $WANT_CONSTS pub const"

# --- 2. The refusals ----------------------------------------------------------------

echo "== refusals: a bad argument count"
refuses "capacity with no argument"        capacity
refuses "capacity with two arguments"      capacity 1 2
refuses "review with four arguments"       review 1 1 0 0
refuses "review with six arguments"        review 1 1 0 0 0 0
refuses "retry with no argument"           retry
refuses "merge with three arguments"       merge 2 1 0
refuses "counts with no argument"          counts
refuses "constants with an argument"       constants 3

echo "== refusals: an unparsable integer"
refuses "capacity with a word"             capacity abc
refuses "capacity with an empty argument"  capacity ""
refuses "retry with a decimal"             retry 1.5
refuses "counts with a word"               counts two
refuses "review with a word in the middle" review 2 x 0 3 0
refuses "merge with a word for the rollup" merge green 1 0 1

echo "== refusals: a boolean that is neither 0 nor 1"
refuses "merge with mergeable=2"           merge 2 2 0 1
refuses "merge with is_draft=true"         merge 2 1 true 1
refuses "merge with checks_configured=-1"  merge 2 1 0 -1

echo "== refusals: no subcommand, or one the ring does not have"
refuses "an unknown subcommand"            deploy
refuses "a subcommand that is nearly right" capacities 0
set +e
NO_ARGV_OUT="$("$BIN" 2>"$TMP/case.err")"
NO_ARGV_RC=$?
set -e
CASES=$((CASES + 1)); REFUSALS=$((REFUSALS + 1))
[ "$NO_ARGV_RC" -eq 2 ] || fail "t27core with no arguments exited $NO_ARGV_RC, want 2"
[ -z "$NO_ARGV_OUT" ] || fail "t27core with no arguments printed '$NO_ARGV_OUT' on stdout"
case "$(head -1 "$TMP/case.err")" in
    error=?*) ;;
    *) fail "t27core with no arguments did not write error=<what> as the first line of stderr" ;;
esac

# --- 3. That it is really the ring answering ------------------------------------------
#
# Rebuild the SAME shim source against an altered copy of the generated
# artifact. The shim links that copy and embeds it with include_str!, so every
# answer below must move with it. A shim that had restated the ring's rules by
# hand - the duplication this ring exists to end - would keep answering 4.

echo "== the answers come from the artifact, not from the shim"
MUTANT="$TMP/mutant"
mkdir -p "$MUTANT/generated" "$MUTANT/shim"
sed 's/^pub const MAX_CONCURRENT_WORKERS: i32 = 4;$/pub const MAX_CONCURRENT_WORKERS: i32 = 7;/' \
    "$ARTIFACT" > "$MUTANT/generated/queen_core.rs"
grep -q '^pub const MAX_CONCURRENT_WORKERS: i32 = 7;$' "$MUTANT/generated/queen_core.rs" \
    || fail "could not alter MAX_CONCURRENT_WORKERS in the copied artifact - this section would
       have proved nothing, so it is a failure rather than a skip"
cp "$SHIM" "$MUTANT/shim/t27core.rs"
build_t27core "$MUTANT/generated/queen_core.rs" "$MUTANT/shim/t27core.rs" "$MUTANT/t27core"

MUT_CAPACITY="$("$MUTANT/t27core" capacity 4)"
[ "$MUT_CAPACITY" = "can_start_another=true
free_slots=3" ] || fail "the shim did not follow MAX_CONCURRENT_WORKERS=7 through capacity:
       got: $MUT_CAPACITY
       the shim is answering from a rule of its own, not from the ring"

MUT_CONST="$("$MUTANT/t27core" constants | head -1)"
[ "$MUT_CONST" = "MAX_CONCURRENT_WORKERS=7" ] \
    || fail "t27core constants printed '$MUT_CONST' against an artifact that says 7 - the list is
       not derived from the generated file"

# The same guard from the other side: a binary built from two different rings
# (an artifact embedded at compile time, a different one linked) must refuse
# rather than answer with half of each.
build_t27core "$ARTIFACT" "$MUTANT/shim/t27core.rs" "$TMP/t27core-mixed"
CASES=$((CASES + 1)); REFUSALS=$((REFUSALS + 1))
set +e
MIXED_OUT="$("$TMP/t27core-mixed" constants 2>"$TMP/case.err")"
MIXED_RC=$?
set -e
[ "$MIXED_RC" -eq 2 ] || fail "a t27core built from a shim embedding one artifact and linked
       against another exited $MIXED_RC and printed:
$MIXED_OUT
       it must refuse (exit 2) rather than report constants it does not decide with"
[ -z "$MIXED_OUT" ] || fail "the mixed-ring binary refused but still printed '$MIXED_OUT'"

# --- Empty is never green ---------------------------------------------------------------

[ "$ANSWERS" -ge 20 ] || fail "only $ANSWERS answers were checked - a contract this size cannot
       be covered by that few, and a helper that silently stopped running would look like this"
[ "$REFUSALS" -ge 15 ] || fail "only $REFUSALS refusals were checked"
for subcommand in capacity review retry merge counts constants; do
    case " $COVERED " in
        *" $subcommand "*) ;;
        *) fail "no answer was checked for the '$subcommand' subcommand" ;;
    esac
done

echo "[OK] ring00_shim: $CASES cases - $ANSWERS answers pinned exactly, $REFUSALS refusals"
echo "     all six subcommands covered; built with bare rustc from"
echo "     rings/T27-00/generated/queen_core.rs, and proved to follow it by rebuilding"
echo "     against an altered copy"
