#!/usr/bin/env bash
#
# RING-00 — Verilog from the same source, checked by simulation.
# gHashTag/trios#1282
#
# The t27 source `rings/T27-00/queen_core.t27` is the law once; Rust, Verilog
# and Swift are readings of it. This script takes the Verilog reading: it
# generates Verilog from the same source the Rust parity script
# (tests/t27/ring00_parity.sh, #1281) uses, compiles it with iverilog, and runs
# THE SAME INPUT TABLE through it, comparing every answer against the answer
# Swift gives.
#
# Input table. Pinned by #1281: it is the rows the two Swift scenarios in
# tests/swift/ChatSSEEndToEndTest.swift already enumerate —
#   runABeeIsNotSentAtTheSameWallForever   (how endings count, and retry)
#   runAJudgedTaskDoesNotWaitForAHuman     (review)
# Each row below cites the Swift check it comes from, so a change on either
# side of the pair is visible in this file.
#
# Rows that live in those scenarios but carry strings (retryBriefing,
# sendBackNote, the briefing a worker receives) are not in the table: the ring
# is integers and booleans by law (see the .t27 header), and a string is not a
# thing silicon answers. Merge gate and capacity are other scenarios' rows,
# not this table's, and are not smuggled in.
#
# Answers are coded as integers in the .t27 (see its coding tables). The Swift
# case each expected value stands for is written beside it. If a constant in
# the .t27 changes — MAX_SEND_BACKS from 2 to 3, say — a row here goes red;
# that is inherited from #1281 and is the point, not a nuisance.
#
# Empty is never green. A generation that writes nothing, a simulation that
# answers nothing, or a run that answers fewer rows than the table holds, is a
# named failure — never "zero disagreements". (Measured on this machine:
# `t27c icarus-simulate` on a source with no test blocks prints nothing and
# exits 0. A script that scored silence would pass forever.)
#
# Usage: tests/t27/ring00_verilog.sh          (from anywhere)
#        T27C=/path/to/t27c tests/t27/ring00_verilog.sh

set -euo pipefail

# --- Locations --------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC="$REPO_ROOT/rings/T27-00/queen_core.t27"

KEEP_ARTIFACTS=0
fail() {
    KEEP_ARTIFACTS=1
    echo "FAIL [ring00_verilog]: $*" >&2
    # Keep the working directory on a failure: it is the evidence.
    echo "      artifacts kept in $TMP" >&2
    exit 1
}

TMP="$(mktemp -d /tmp/ring00-verilog.XXXXXX)"
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

T27C_BIN="$(find_t27c)" || fail "the t27 compiler was not found (set T27C=/path/to/t27c)"
IVERILOG="$(command -v iverilog 2>/dev/null)" || fail "iverilog is not on PATH"
VVP="$(command -v vvp 2>/dev/null)" || fail "vvp (Icarus Verilog runtime) is not on PATH"

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
# them; the testbench derives real_attempts by running every kind through the
# ring's own counts_against_issue — Swift's `filter(\.countsAgainstTheIssue)`,
# not a number precomputed by hand.
# Review rows carry the verdict pattern exactly as the scenario writes it
# (T=met, F=unmet); the testbench counts judged and unmet from it — Swift's
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

TOTAL_ROWS=$(( ${#COUNTS_ROWS[@]} + ${#RETRY_ROWS[@]} + ${#REVIEW_ROWS[@]} ))
[ "$TOTAL_ROWS" -gt 0 ] || fail "the input table is empty - nothing to check is nothing passed"

# A table row with a wrong shape cannot be transcribed honestly; refuse it
# rather than letting the testbench generate a call that says something else.
# (A `read` with too few variables folds the tail silently — so the shape is
# counted from the row itself, not from what read produced.)
row_fields() {
    awk -F'|' '{print NF}' <<<"$1"
}

# --- Generate Verilog from the same source -----------------------------------

echo "== generating Verilog from $SRC"
if ! "$T27C_BIN" gen-verilog "$SRC" >"$TMP/queen_core.v" 2>"$TMP/gen.err"; then
    cat "$TMP/gen.err" >&2
    fail "t27c gen-verilog exited nonzero"
fi
# Criterion 3: empty output is a failure, not zero disagreements.
[ -s "$TMP/queen_core.v" ] || fail "no Verilog was generated (empty output)"
grep -q "module queen_core" "$TMP/queen_core.v" \
    || fail "generated Verilog does not declare module queen_core"

# --- Build the testbench from the table --------------------------------------
#
# gen-verilog emits the four decisions as functions inside module queen_core
# (the module has no data ports — see T81 note in the generated file), so the
# bench reaches them through the instance, hierarchically, which iverilog
# supports for simulation.

TB="$TMP/ring00_tb.v"
EXPECTED="$TMP/expected.txt"
: >"$EXPECTED"
{
    cat <<'HDR'
// Generated by tests/t27/ring00_verilog.sh — do not edit by hand.
`timescale 1ns/1ps
`default_nettype none
module ring00_tb;
    reg clk = 1'b0;
    queen_core dut(.clk(clk), .rst_n(1'b1), .en(1'b1), .ready());
    integer real_attempts;
    integer judged;
    integer unmet;
    initial begin
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

    # --- counts_against_issue rows
    for row in "${COUNTS_ROWS[@]}"; do
        IFS='|' read -r id kind expected note <<<"$row"
        [ "$(row_fields "$row")" -eq 4 ] || fail "counts row '$id' has a malformed shape (want id|kind|expected|note)"
        k="$(kind_expr "$kind")" || fail "counts row $id names unknown kind '$kind'"
        echo "        // $id: counts_against_issue($kind) - $note"
        echo "        \$display(\"RESULT $id %0d\", dut.counts_against_issue($k));"
        echo "RESULT $id $expected" >>"$EXPECTED"
    done

    # --- retry rows: real_attempts derived through the ring's own filter
    for row in "${RETRY_ROWS[@]}"; do
        IFS='|' read -r id expected kinds note <<<"$row"
        [ "$(row_fields "$row")" -eq 4 ] || fail "retry row '$id' has a malformed shape (want id|expected|kinds|note)"
        expr=""
        for kind in $kinds; do
            k="$(kind_expr "$kind")" || fail "row $id names unknown kind '$kind'"
            expr="${expr:+$expr + }dut.counts_against_issue($k)"
        done
        [ -n "$expr" ] || fail "row $id has an empty attempt list"
        echo "        // $id: [$kinds] $note"
        echo "        real_attempts = $expr;"
        echo "        \$display(\"RESULT $id %0d\", dut.retry_verdict(real_attempts));"
        echo "RESULT $id $expected" >>"$EXPECTED"
    done

    # --- review rows: judged/unmet counted from the verdict pattern
    for row in "${REVIEW_ROWS[@]}"; do
        IFS='|' read -r id expected total verdicts committed sendbacks note <<<"$row"
        [ "$(row_fields "$row")" -eq 7 ] || fail "review row '$id' has a malformed shape (want id|expected|total|verdicts|committed|sendbacks|note)"
        n="${#verdicts}"
        [ "$n" -le "$total" ] || fail "row $id judges $n criteria of a $total-criterion task"
        expr=""
        for (( j=0; j<n; j++ )); do
            v="${verdicts:$j:1}"
            case "$v" in
                T) term="0" ;;
                F) term="1" ;;
                *) fail "row $id verdict pattern has '$v' (want T or F)" ;;
            esac
            expr="${expr:+$expr + }$term"
        done
        [ -n "$expr" ] || expr="0"
        echo "        // $id: total=$total verdicts=[$verdicts] committed=$committed send_backs=$sendbacks - $note"
        echo "        judged = $n;"
        echo "        unmet = $expr;"
        echo "        \$display(\"RESULT $id %0d\", dut.review_verdict($total, judged, unmet, $committed, $sendbacks));"
        echo "RESULT $id $expected" >>"$EXPECTED"
    done

    cat <<'FTR'
        $finish;
    end
endmodule
`default_nettype wire
FTR
} > "$TB"

# --- Compile and simulate -----------------------------------------------------

echo "== compiling with iverilog"
if ! "$IVERILOG" -g2005 -o "$TMP/sim" "$TB" "$TMP/queen_core.v" 2>"$TMP/iverilog.err"; then
    cat "$TMP/iverilog.err" >&2
    fail "iverilog could not compile the generated Verilog with the bench"
fi

echo "== simulating"
if ! "$VVP" "$TMP/sim" >"$TMP/vvp.out" 2>"$TMP/vvp.err"; then
    cat "$TMP/vvp.err" >&2
    fail "vvp exited nonzero"
fi

grep '^RESULT ' "$TMP/vvp.out" >"$TMP/results.txt" || true
GOT_ROWS="$(wc -l <"$TMP/results.txt" | tr -d ' ')"
# Criterion 3, again, one level deeper: a simulation that answers nothing — or
# fewer rows than the table holds — is silence, and silence is not agreement.
if [ "$GOT_ROWS" -ne "$TOTAL_ROWS" ]; then
    fail "the simulation answered $GOT_ROWS of $TOTAL_ROWS rows (empty output is a failure, not zero disagreements)"
fi

# --- Compare against the Swift answers ----------------------------------------
#
# The bench prints rows in table order, so results and expectations pair by
# line: a diff shows every disagreement with both sides, and the count check
# above has already guaranteed the sequences are the same length.

if ! diff -u "$EXPECTED" "$TMP/results.txt" >"$TMP/diff.txt"; then
    cat "$TMP/diff.txt" >&2
    mismatches="$(grep -c '^+RESULT ' "$TMP/diff.txt")"
    fail "$mismatches of $TOTAL_ROWS rows disagree between simulation and Swift (swift=-, simulation=+)"
fi

echo "[OK] ring00_verilog: $TOTAL_ROWS rows checked, simulation answers the Swift table"
echo "     generated from rings/T27-00/queen_core.t27, compiled with iverilog, run under vvp"
