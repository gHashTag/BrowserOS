#!/usr/bin/env bash
#
# RING-00 — parity between the generated Rust and Swift.
# gHashTag/trios#1281
#
# The t27 source `rings/T27-00/queen_core.t27` is the law once; Rust, Verilog
# and Swift are readings of it. This script takes the Rust reading: it generates
# Rust from the source, builds it with bare `rustc` (no cargo, no dependencies -
# the contract the .t27 header states for this ring), and runs the input table
# through it, comparing every answer against the answer Swift gives.
#
# The Verilog sibling tests/t27/ring00_verilog.sh (#1282) runs THE SAME input
# table through the Verilog reading of the same source. If a row changes here,
# change it there.
#
# Input table. It is the rows the two Swift scenarios in
# tests/swift/ChatSSEEndToEndTest.swift already enumerate —
#   runABeeIsNotSentAtTheSameWallForever   (how endings count, and retry)
#   runAJudgedTaskDoesNotWaitForAHuman     (review)
# Each row below cites the Swift check it comes from, so a change on either
# side of the pair is visible in this file.
#
# Rows that live in those scenarios but carry strings (retryBriefing,
# sendBackNote, the briefing a worker receives) are not in the table: the ring
# is integers and booleans by law (see the .t27 header), and a string is not a
# thing this ring answers. Merge gate and capacity are other scenarios' rows
# (runNothingMergesPastTheGate, and QueenDelegation's own tests), not this
# table's, and are not smuggled in.
#
# Constants are pinned separately, one row each. Reason, measured against the
# table itself: the two scenarios' rows can see a change to MAX_REAL_ATTEMPTS
# (r06 flips) and MAX_SEND_BACKS (r12 flips), but NO row in this table can see
# a change to MAX_CONCURRENT_WORKERS or to the ROLLUP_*/MERGE_* codings - their
# functions are other scenarios' rows - and no function in the ring names
# FAILURE_INTERRUPTED at all (counts_against_issue only ever compares against
# the two kinds that count, so any non-counting value is indistinguishable from
# any other inside this ring). "Any constant changes and this script goes red"
# (#1281, criterion 3) is therefore not reachable through the function table
# alone; the constants are pinned directly, each row citing the Swift answer it
# stands against. A deliberate change to the law updates Swift, this table and
# the function rows together - the red you see until then is the parity check
# doing its job, not a nuisance.
#
# Empty is never green. A generation that writes nothing, a build that fails, a
# runner that answers nothing, or a run that answers fewer rows than the tables
# hold, is a named failure — never "zero disagreements".
#
# Usage: tests/t27/ring00_parity.sh             (from anywhere)
#        T27C=/path/to/t27c tests/t27/ring00_parity.sh
#        RUSTC=/path/to/rustc tests/t27/ring00_parity.sh

set -euo pipefail

# --- Locations --------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC="$REPO_ROOT/rings/T27-00/queen_core.t27"

KEEP_ARTIFACTS=0
fail() {
    KEEP_ARTIFACTS=1
    echo "FAIL [ring00_parity]: $*" >&2
    # Keep the working directory on a failure: it is the evidence.
    echo "      artifacts kept in $TMP" >&2
    exit 1
}

TMP="$(mktemp -d /tmp/ring00-parity.XXXXXX)"
trap '[ "$KEEP_ARTIFACTS" -eq 1 ] || rm -rf "$TMP"' EXIT

# --- Tools ------------------------------------------------------------------

# The seed compiler lives in another agent's repository; it is not always on
# PATH. Look in the usual places, loudest failure naming every place tried.
find_t27c() {
    local candidates=()
    [ -n "${T27C:-}" ] && candidates+=("$T27C")
    local p
    if p="$(command -v t27c 2>/dev/null)"; then candidates+=("$p"); fi
    candidates+=(
        /tmp/t27ci/target/release/t27c
        /Users/playra/t27/target/release/t27c
    )
    for c in "${candidates[@]}"; do
        if [ -n "$c" ] && [ -x "$c" ]; then
            echo "$c"
            return 0
        fi
    done
    echo "none of: ${candidates[*]}" >&2
    return 1
}

find_rustc() {
    local candidates=()
    [ -n "${RUSTC:-}" ] && candidates+=("$RUSTC")
    local p
    if p="$(command -v rustc 2>/dev/null)"; then candidates+=("$p"); fi
    candidates+=( "$HOME/.cargo/bin/rustc" )
    for c in "${candidates[@]}"; do
        if [ -n "$c" ] && [ -x "$c" ]; then
            echo "$c"
            return 0
        fi
    done
    echo "none of: ${candidates[*]}" >&2
    return 1
}

T27C_BIN="$(find_t27c)" || fail "the t27 compiler was not found (set T27C=/path/to/t27c)"
RUSTC_BIN="$(find_rustc)" || fail "rustc was not found (set RUSTC=/path/to/rustc)"

[ -f "$SRC" ] || fail "source not found: $SRC"

# --- The input table ---------------------------------------------------------
#
# Verdict codes, from the .t27 coding tables; the Swift case each one is:
RETRY_ATTEMPT=0     # QueenRetryPolicy.Decision.attempt(number:)
RETRY_ESCALATE=1    # QueenRetryPolicy.Decision.escalate(reason:)
REVIEW_WAIT=0       # QueenReviewDecision.Decision.wait(reason:)
REVIEW_ACCEPT=1     # QueenReviewDecision.Decision.accept
REVIEW_SEND_BACK=2  # QueenReviewDecision.Decision.sendBack(unmet:)
REVIEW_ESCALATE=3   # QueenReviewDecision.Decision.escalate(reason:)

# Failure kinds, from the .t27 coding table:
INTERRUPTED=0        # .interrupted
PRODUCED_NOTHING=1   # .producedNothing
WORKED_BUT_FAILED=2  # .workedButFailed

# Each row: id|kind|expected|swift check it transcribes. The expected value is
# the budget effect the Swift scenario asserts: an interruption must not
# consume the issue's budget, the two real endings must.
# Retry rows carry the prior-attempt kinds exactly as the Swift scenario lists
# them; the bench derives real_attempts by running every kind through the
# ring's own counts_against_issue — Swift's `filter(\.countsAgainstTheIssue)`,
# not a number precomputed by hand.
# Review rows carry the verdict pattern exactly as the scenario writes it
# (T=met, F=unmet); the bench counts judged and unmet from it — Swift's
# `verdicts.count` and `verdicts.filter { !$0.met }`.
COUNTS_ROWS=(
    "r01|INTERRUPTED|0|classify: open stream, no completed turn -> interrupted; four interruptions leave the issue untouched"
    "r02|PRODUCED_NOTHING|1|classify: 41 tool calls, nothing committed -> producedNothing; a real failure earns a second attempt"
    "r03|WORKED_BUT_FAILED|1|classify: work landed and still failed -> workedButFailed; two real failures must stop the loop"
)
RETRY_ROWS=(
    # id|expected|attempt kinds|swift check
    "r04|$RETRY_ATTEMPT|INTERRUPTED INTERRUPTED INTERRUPTED INTERRUPTED|four interruptions leave the issue untouched - it is still a first attempt"
    "r05|$RETRY_ATTEMPT|PRODUCED_NOTHING|one real failure earns a second attempt, and it is numbered as such"
    "r06|$RETRY_ESCALATE|PRODUCED_NOTHING WORKED_BUT_FAILED|two real failures must stop the loop rather than start a third bee"
    "r07|$RETRY_ATTEMPT|INTERRUPTED PRODUCED_NOTHING INTERRUPTED|interruptions interleaved with a real failure still do not count"
)
REVIEW_ROWS=(
    # id|expected|total|verdicts|committed|sendbacks|swift check
    "r08|$REVIEW_ACCEPT|2|TT|3|0|everything met with a diff behind it is an accept"
    "r09|$REVIEW_ESCALATE|1|T|0|0|every criterion met with nothing committed cannot be an accept (empty diff)"
    "r10|$REVIEW_SEND_BACK|2|TF|2|0|an unmet criterion returns the task, naming exactly which one"
    "r11|$REVIEW_SEND_BACK|1|F|1|1|a second return is still allowed - the first one is the one that teaches"
    "r12|$REVIEW_ESCALATE|1|F|1|2|two returns must be the end of the automatic loop"
    "r13|$REVIEW_WAIT|3|F|1|0|one unmet answer out of three questions is not a verdict on the task"
    "r14|$REVIEW_ESCALATE|0||5|0|a task with no criteria has no contract and cannot be judged"
)

# --- The constants table ------------------------------------------------------
#
# Every `pub const` in the .t27, one row each: id|name|expected|the Swift
# answer it stands against. The bench reads the constant out of the GENERATED
# Rust, so a change to the .t27, a change to what t27c emits, or a constant
# deleted outright (the bench then does not compile) all go red here.
CONST_ROWS=(
    # id|name|expected|swift answer
    "k01|MAX_CONCURRENT_WORKERS|4|QueenDelegation.maximumConcurrentWorkers = 4 (rings/SR-00/QueenDelegation.swift)"
    "k02|MAX_REAL_ATTEMPTS|2|QueenRetryPolicy.maximumRealAttempts = 2 (rings/SR-00/QueenRetryPolicy.swift)"
    "k03|MAX_SEND_BACKS|2|QueenReviewDecision.maximumSendBacks = 2 (rings/SR-00/QueenReviewDecision.swift)"
    "k04|FAILURE_INTERRUPTED|0|QueenFailureKind.interrupted - caller-side coding; no function in the ring names it, only this row can see it change"
    "k05|FAILURE_PRODUCED_NOTHING|1|QueenFailureKind.producedNothing (r01/r02/r05/r06/r07 also see it through counts_against_issue)"
    "k06|FAILURE_WORKED_BUT_FAILED|2|QueenFailureKind.workedButFailed (r03/r06 also see it through counts_against_issue)"
    "k07|RETRY_ATTEMPT|0|QueenRetryPolicy.Decision.attempt(number:)"
    "k08|RETRY_ESCALATE|1|QueenRetryPolicy.Decision.escalate(reason:)"
    "k09|REVIEW_WAIT|0|QueenReviewDecision.Decision.wait(reason:)"
    "k10|REVIEW_ACCEPT|1|QueenReviewDecision.Decision.accept"
    "k11|REVIEW_SEND_BACK|2|QueenReviewDecision.Decision.sendBack(unmet:)"
    "k12|REVIEW_ESCALATE|3|QueenReviewDecision.Decision.escalate(reason:)"
    "k13|ROLLUP_NONE|0|QueenMergeGate.Rollup.none"
    "k14|ROLLUP_PENDING|1|QueenMergeGate.Rollup.pending"
    "k15|ROLLUP_SUCCESS|2|QueenMergeGate.Rollup.success"
    "k16|ROLLUP_FAILURE|3|QueenMergeGate.Rollup.failure"
    "k17|ROLLUP_ERROR|4|QueenMergeGate.Rollup.error"
    "k18|MERGE_APPROVE|0|QueenMergeGate.Decision.merge"
    "k19|MERGE_WAIT|1|QueenMergeGate.Decision.wait(reason:)"
    "k20|MERGE_WAKE_WORKER|2|QueenMergeGate.Decision.wakeWorker(reason:)"
    "k21|MERGE_REFUSE|3|QueenMergeGate.Decision.refuse(reason:)"
)

TOTAL_ROWS=$(( ${#COUNTS_ROWS[@]} + ${#RETRY_ROWS[@]} + ${#REVIEW_ROWS[@]} ))
TOTAL_CONSTS=${#CONST_ROWS[@]}
[ "$TOTAL_ROWS" -gt 0 ] || fail "the input table is empty - nothing to check is nothing passed"
[ "$TOTAL_CONSTS" -gt 0 ] || fail "the constants table is empty - criterion 3 has nothing to stand on"

# A table row with a wrong shape cannot be transcribed honestly; refuse it
# rather than letting the bench generate a call that says something else.
# (A `read` with too few variables folds the tail silently — so the shape is
# counted from the row itself, not from what read produced.)
row_fields() {
    awk -F'|' '{print NF}' <<<"$1"
}

# --- Generate Rust from the source -------------------------------------------

echo "== generating Rust from $SRC"
if ! "$T27C_BIN" gen-rust "$SRC" >"$TMP/queen_core.rs" 2>"$TMP/gen.err"; then
    cat "$TMP/gen.err" >&2
    fail "t27c gen-rust exited nonzero"
fi
# Empty is never green: a generation that wrote nothing is not zero disagreements.
[ -s "$TMP/queen_core.rs" ] || fail "no Rust was generated (empty output)"
for decision in counts_against_issue retry_verdict review_verdict merge_verdict can_start_another free_slots; do
    grep -q "pub fn $decision" "$TMP/queen_core.rs" \
        || fail "generated Rust does not declare pub fn $decision"
done
for law in MAX_CONCURRENT_WORKERS MAX_REAL_ATTEMPTS MAX_SEND_BACKS; do
    grep -q "pub const $law" "$TMP/queen_core.rs" \
        || fail "generated Rust does not declare pub const $law"
done

# --- Build ---------------------------------------------------------------------
#
# Two rustc invocations, no cargo, no dependencies — the ring's stated contract
# is "compiles under bare `rustc --crate-type lib`". First prove that contract
# on the generated file exactly as emitted; then build the bench as its own
# crate against that rlib, so a failure names which half is broken.

echo "== compiling the generated Rust as a library"
if ! "$RUSTC_BIN" --edition 2021 --crate-type lib "$TMP/queen_core.rs" \
        -o "$TMP/libqueen_core.rlib" 2>"$TMP/rustc-lib.err"; then
    cat "$TMP/rustc-lib.err" >&2
    fail "rustc could not compile the generated Rust on its own (the ring's bare-lib contract)"
fi
[ -s "$TMP/libqueen_core.rlib" ] || fail "rustc reported success but wrote no rlib"

# --- Build the bench from the tables -------------------------------------------

BENCH="$TMP/ring00_bench.rs"
EXPECTED="$TMP/expected.txt"
: >"$EXPECTED"
{
    cat <<'HDR'
// Generated by tests/t27/ring00_parity.sh — do not edit by hand.
fn main() {
HDR

    kind_expr() {
        # INTERRUPTED -> the .t27 constant value; the bench spells kinds as
        # numbers so the row cites the same coding table the source uses.
        case "$1" in
            INTERRUPTED)       echo "$INTERRUPTED" ;;
            PRODUCED_NOTHING)  echo "$PRODUCED_NOTHING" ;;
            WORKED_BUT_FAILED) echo "$WORKED_BUT_FAILED" ;;
            *) return 1 ;;
        esac
    }

    # --- constants: read straight out of the generated crate
    for row in "${CONST_ROWS[@]}"; do
        IFS='|' read -r id name expected note <<<"$row"
        [ "$(row_fields "$row")" -eq 4 ] || fail "constants row '$id' has a malformed shape (want id|name|expected|swift answer)"
        [ -n "$expected" ] || fail "constants row $id pins $name to an empty value"
        echo "    // $id: $name — $note"
        echo "    println!(\"RESULT $id {}\", queen_core::$name);"
        echo "RESULT $id $expected" >>"$EXPECTED"
    done

    # --- counts_against_issue rows
    for row in "${COUNTS_ROWS[@]}"; do
        IFS='|' read -r id kind expected note <<<"$row"
        [ "$(row_fields "$row")" -eq 4 ] || fail "counts row '$id' has a malformed shape (want id|kind|expected|note)"
        k="$(kind_expr "$kind")" || fail "counts row $id names unknown kind '$kind'"
        echo "    // $id: counts_against_issue($kind) — $note"
        echo "    println!(\"RESULT $id {}\", if queen_core::counts_against_issue($k) { 1 } else { 0 });"
        echo "RESULT $id $expected" >>"$EXPECTED"
    done

    # --- retry rows: real_attempts derived through the ring's own filter
    for row in "${RETRY_ROWS[@]}"; do
        IFS='|' read -r id expected kinds note <<<"$row"
        [ "$(row_fields "$row")" -eq 4 ] || fail "retry row '$id' has a malformed shape (want id|expected|kinds|note)"
        echo "    // $id: [$kinds] — $note"
        echo "    let mut real_attempts: i32 = 0;"
        for kind in $kinds; do
            k="$(kind_expr "$kind")" || fail "row $id names unknown kind '$kind'"
            echo "    real_attempts += if queen_core::counts_against_issue($k) { 1 } else { 0 };"
        done
        echo "    println!(\"RESULT $id {}\", queen_core::retry_verdict(real_attempts));"
        echo "RESULT $id $expected" >>"$EXPECTED"
    done

    # --- review rows: judged/unmet counted from the verdict pattern
    for row in "${REVIEW_ROWS[@]}"; do
        IFS='|' read -r id expected total verdicts committed sendbacks note <<<"$row"
        [ "$(row_fields "$row")" -eq 7 ] || fail "review row '$id' has a malformed shape (want id|expected|total|verdicts|committed|sendbacks|note)"
        n="${#verdicts}"
        [ "$n" -le "$total" ] || fail "row $id judges $n criteria of a $total-criterion task"
        unmet=0
        for (( j=0; j<n; j++ )); do
            v="${verdicts:$j:1}"
            case "$v" in
                T) ;;
                F) unmet=$((unmet + 1)) ;;
                *) fail "row $id verdict pattern has '$v' (want T or F)" ;;
            esac
        done
        echo "    // $id: total=$total verdicts=[$verdicts] committed=$committed send_backs=$sendbacks — $note"
        echo "    let judged: i32 = $n;"
        echo "    let unmet: i32 = $unmet;"
        echo "    println!(\"RESULT $id {}\", queen_core::review_verdict($total, judged, unmet, $committed, $sendbacks));"
        echo "RESULT $id $expected" >>"$EXPECTED"
    done

    cat <<'FTR'
}
FTR
} > "$BENCH"

echo "== compiling the bench"
if ! "$RUSTC_BIN" --edition 2021 "$BENCH" \
        --extern queen_core="$TMP/libqueen_core.rlib" \
        -o "$TMP/ring00_runner" 2>"$TMP/rustc-bench.err"; then
    cat "$TMP/rustc-bench.err" >&2
    fail "rustc could not compile the bench against the generated library"
fi
[ -x "$TMP/ring00_runner" ] || fail "rustc reported success but wrote no runner"

# --- Run the table through it ---------------------------------------------------

echo "== running the input table through the generated Rust"
if ! "$TMP/ring00_runner" >"$TMP/runner.out" 2>"$TMP/runner.err"; then
    cat "$TMP/runner.err" >&2
    fail "the runner exited nonzero"
fi

grep '^RESULT ' "$TMP/runner.out" >"$TMP/results.txt" || true
GOT_ROWS="$(wc -l <"$TMP/results.txt" | tr -d ' ')"
# Empty is never green, one level deeper: a runner that answers nothing — or
# fewer rows than the tables hold — is silence, and silence is not agreement.
WANT_ROWS=$(( TOTAL_ROWS + TOTAL_CONSTS ))
if [ "$GOT_ROWS" -ne "$WANT_ROWS" ]; then
    fail "the runner answered $GOT_ROWS of $WANT_ROWS rows (empty output is a failure, not zero disagreements)"
fi

# --- Compare against the Swift answers -------------------------------------------
#
# The bench prints rows in table order, so results and expectations pair by
# line: a diff shows every disagreement with both sides, and the count check
# above has already guaranteed the sequences are the same length.

if ! diff -u "$EXPECTED" "$TMP/results.txt" >"$TMP/diff.txt"; then
    cat "$TMP/diff.txt" >&2
    mismatches="$(grep -c '^+RESULT ' "$TMP/diff.txt")"
    fail "$mismatches of $WANT_ROWS rows disagree between the generated Rust and Swift (swift=-, rust=+)"
fi

echo "[OK] ring00_parity: $TOTAL_ROWS rows checked and $TOTAL_CONSTS constants pinned, the generated Rust answers the Swift table"
echo "     generated from rings/T27-00/queen_core.t27, built with bare rustc --crate-type lib, run as a bench against the rlib"
