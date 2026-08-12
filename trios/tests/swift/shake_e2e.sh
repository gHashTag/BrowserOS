#!/bin/bash
# Shake the chat SSE end-to-end suite: run it repeatedly under deliberate CPU
# and I/O load and report whether it always passes, always fails, or sometimes
# fails.
#
# Usage: bash tests/swift/shake_e2e.sh     (or: make shake)
#        make shake SHAKE_BOUND=20         a looser bound, for less money
#        make shake SHAKE_RUNS=3           spend exactly 3 runs, take the bound
#                                          those 3 runs happen to earn
#
# The default rules out any per-run failure rate above 10%, which costs 29
# loaded runs and about 20 minutes. See SHAKE_BOUND below for why 10 and not
# 45 (free, and useless) or 1 (honest, and overnight).
#
# WHY
# ---
# Silva, Teixeira and d'Amorim ("Shake It! Detecting Flaky Tests Caused by
# Concurrency with Shaker", ICSME 2020) report that 46.5% of flaky tests are
# resource-affected: their failure rate moves with machine load, so a suite
# that is green on an idle laptop turns red when the machine is busy. We hit
# exactly that here when nine agents happened to share this Mac, and spent
# hours deciding whether the failure was real. Shaker's method is to add noise
# deliberately instead of waiting for it: stress the machine, rerun, compare.
# This script is that method, sized for this repo.
#
# WHERE THE NUMBERS COME FROM
# ---------------------------
#   SHAKE_BOUND (default 10, percent)
#       Say what you want to RULE OUT, not how many runs to spend. n runs that
#       all pass reject "the per-run failure rate is >= p0" at level alpha when
#       (1-p0)^n <= alpha, so with alpha = 0.05 the runs needed for a bound are
#       n = ceil(log(0.05) / log(1 - p0)), and the bound n runs earn is
#       p0 = 1 - 0.05^(1/n). Equivalently the rule of three: no failure in n
#       trials puts the 95% upper bound near 3/n.
#
#           bound   runs   wall clock (baseline + loaded, this 8-core Mac)
#            45%      6      ~4m      what this target used to buy, for free
#            20%     14     ~10m
#            10%     29     ~20m      the default
#             5%     59     ~40m
#             1%    299    ~3h20m
#
#       The old default was 5 runs, and it announced that it had ruled out any
#       flake above 45%. Nothing anyone worries about lives up there: a suite
#       that fails 45% of the time is not flaky, it is broken, and you learn
#       that on the first run. The rates that cost real hours here are single
#       digit to low double digit - the incident that produced this script was
#       one red run in a working day. So the default now buys a bound in that
#       region: 10%, which is 29 loaded runs and about 20 minutes.
#
#       Not 5% (~40m) or 1% (~3h20m): those are overnight budgets, and a target
#       nobody has time to run measures nothing. 10% is the knee - the tightest
#       bound that still fits in a coffee break, and tight enough that "STABLE"
#       is now a claim about the suite rather than a claim about arithmetic.
#       Reach for SHAKE_BOUND=5 when a flake has already bitten twice and 10%
#       came back clean.
#
#   SHAKE_RUNS (no default; overrides SHAKE_BOUND when set)
#       Spend an exact number of runs instead. The report then states the bound
#       those runs actually earned. SHAKE_RUNS=10 is the budget Shaker itself
#       used per test (it earns 25.9%).
#
#   SHAKE_LOAD (default: number of logical cores)
#       Not from the paper - from our own incident. Nine agent processes on
#       this 8-core machine is what surfaced the flake, so the default is one
#       busy loop per logical core, which together with the suite itself leaves
#       the machine roughly 2x oversubscribed. SHAKE_LOAD=0 disables CPU load.
#
#   SHAKE_IO (default 1)
#       One writer looping over an 8 MB file. I/O noise is cheap here and the
#       suite touches SQLCipher databases and log files. SHAKE_IO=0 disables it.
#       Setting both SHAKE_LOAD=0 and SHAKE_IO=1 is a legal rerun-only mode:
#       no CPU floor is demanded, and the run says so in its own output.
#       Cost worth knowing before you put this in a loop: the writer runs for
#       the whole session, so the bill scales with the bound. At the old 5-run
#       default one run measured 17 GB written; at the 29-run default the run
#       that set these numbers measured 109 GB (the summary prints the figure
#       every time). The blobs are deleted as they go, so it costs SSD writes,
#       not disk space - but a nightly at SHAKE_BOUND=5 would write ~220 GB a
#       night, which is a real number for a laptop SSD. SHAKE_IO=0 if that
#       matters more to you than I/O noise does.
#
#   SHAKE_BASELINE (default 1)
#       One unloaded run first. This is what separates "resource-affected" from
#       "just broken": if the suite fails with no load at all, load is not the
#       story. Shaker draws the same with-noise / without-noise comparison.
#
# EXIT STATUS
#   0  every measured run passed
#   1  broken - the baseline (unloaded) run failed, so this is not a flake
#   2  flaky or resource-affected - failures appeared only under load
#   3  nothing trustworthy was measured: either a stressor that was asked for
#      never actually loaded the machine, or every run gave up waiting for the
#      shared e2e build lock. A shaker that cannot prove it shook anything must
#      not report a verdict.

set -uo pipefail   # deliberately not -e: a failing run is the data we came for

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# SHAKE_SUITE points the shaker at a different runner. Any script that exits
# non-zero on failure works, which is also how the classifier itself is proved:
# point it at a stub that always fails and it must say BROKEN (exit 1); point it
# at one that fails every other run and it must say FLAKY (exit 2). Verbatim:
#
#   printf '%s\n' '#!/bin/bash' 'echo "FAIL - broken assertion A"' 'exit 1' > /tmp/af.sh
#   SHAKE_SUITE=/tmp/af.sh SHAKE_RUNS=4 SHAKE_LOAD=2 bash tests/swift/shake_e2e.sh
#
# Both arms were driven on this machine; the always-fail stub returned exit 1
# with "BROKEN, not flaky" and the every-other stub returned exit 2 with
# "FLAKY: 2 of 4". Re-drive them after touching the classifier - a shaker that
# calls everything flaky is worse than no shaker.
E2E="${SHAKE_SUITE:-$SCRIPT_DIR/run_chat_sse_e2e.sh}"

CORES="$(sysctl -n hw.logicalcpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
BOUND="${SHAKE_BOUND:-10}"
LOAD="${SHAKE_LOAD:-$CORES}"
IO="${SHAKE_IO:-1}"
BASELINE="${SHAKE_BASELINE:-1}"

# Measured on this 8-core Mac and used only to predict the bill before it is
# run; the summary reports the real wall clock at the end.
#
# 40s is the shake load on an otherwise quiet machine, and the first runs of a
# session do hit it. It is a floor, not a promise: the 29-run run that set the
# default here was estimated at 19m45s and took 24m30s, because the per-run
# cost drifted 38s -> 64s as other agents piled onto the box. Read the printed
# estimate as "at least this long", and trust only the wall clock in the
# summary.
SECONDS_PER_LOADED_RUN=40
SECONDS_PER_BASELINE_RUN=25

# n = ceil(log(alpha) / log(1 - p0)) with alpha = 0.05: the runs needed before
# an all-pass result rejects "failure rate >= p0%" at 95% confidence. Rounded
# up, so the bound earned is always at least as tight as the one requested.
runs_for_bound() {
    awk -v p="$1" 'BEGIN{n=log(0.05)/log(1-p/100); c=int(n); if(c<n-1e-9)c++; if(c<1)c=1; print c}'
}

# The inverse: p0 = 1 - alpha^(1/n), the bound n all-passing runs actually earn.
bound_for_runs() {
    awk -v n="$1" 'BEGIN{printf "%.1f", (1-exp(log(0.05)/n))*100}'
}

human_seconds() {
    awk -v s="$1" 'BEGIN{h=int(s/3600); m=int((s%3600)/60); r=s%60;
        if(h>0) printf "%dh%02dm", h, m; else printf "%dm%02ds", m, r}'
}

case "$BOUND" in ''|*[!0-9]*) echo "[FAIL] SHAKE_BOUND is a whole percent between 1 and 99, got '$BOUND'"; exit 1 ;; esac
if [ "$BOUND" -lt 1 ] || [ "$BOUND" -gt 99 ]; then
    echo "[FAIL] SHAKE_BOUND is a whole percent between 1 and 99, got '$BOUND'"
    echo "       It names the per-run failure rate to rule out at 95% confidence."
    exit 1
fi

if [ -n "${SHAKE_RUNS:-}" ]; then
    RUNS="$SHAKE_RUNS"
    RUNS_FROM="SHAKE_RUNS"
    BOUND_REQUESTED=0
else
    RUNS="$(runs_for_bound "$BOUND")"
    RUNS_FROM="SHAKE_BOUND"
    BOUND_REQUESTED=1
fi

case "$RUNS" in ''|*[!0-9]*) echo "[FAIL] SHAKE_RUNS must be a non-negative integer, got '$RUNS'"; exit 1 ;; esac
case "$LOAD" in ''|*[!0-9]*) echo "[FAIL] SHAKE_LOAD must be a non-negative integer, got '$LOAD'"; exit 1 ;; esac
case "$IO"   in ''|*[!0-9]*) echo "[FAIL] SHAKE_IO must be a non-negative integer, got '$IO'"; exit 1 ;; esac
if [ "$RUNS" -lt 1 ]; then echo "[FAIL] SHAKE_RUNS must be at least 1"; exit 1; fi
if [ ! -f "$E2E" ]; then echo "[FAIL] e2e runner not found at $E2E"; exit 1; fi

SESSION="$(date +%s)"
SHAKE_DIR="$PROJECT_DIR/.trinity-test/shake/$SESSION"
IO_DIR="$SHAKE_DIR/io"
IO_TALLY="$SHAKE_DIR/io_cycles"
mkdir -p "$IO_DIR"
: > "$IO_TALLY"

# Keep the artifact family small, like every other log family in this tree:
# three shake sessions, newest kept.
ls -dt "$PROJECT_DIR/.trinity-test/shake"/*/ 2>/dev/null | tail -n +4 | while IFS= read -r d; do rm -rf "$d"; done

STRESS_PIDS=()
CPU_PIDS=()
IO_PIDS=()
stop_load() {
    if [ "${#STRESS_PIDS[@]}" -gt 0 ]; then
        kill "${STRESS_PIDS[@]}" 2>/dev/null
        wait "${STRESS_PIDS[@]}" 2>/dev/null
        STRESS_PIDS=()
        CPU_PIDS=()
        IO_PIDS=()
    fi
    rm -rf "$IO_DIR"
}
trap 'stop_load' EXIT
trap 'echo; echo "[shake] interrupted; stopping load."; stop_load; exit 130' INT
trap 'stop_load; exit 143' TERM

start_load() {
    local i
    i=0
    while [ "$i" -lt "$LOAD" ]; do
        awk 'BEGIN{x=0;while(1){x=x+1}}' >/dev/null 2>&1 &
        STRESS_PIDS+=("$!")
        CPU_PIDS+=("$!")
        i=$((i + 1))
    done
    i=0
    while [ "$i" -lt "$IO" ]; do
        (
            n=0
            while :; do
                dd if=/dev/zero of="$IO_DIR/blob.$n" bs=1m count=8 conv=notrunc 2>/dev/null
                sync 2>/dev/null
                rm -f "$IO_DIR/blob.$n"
                # One byte per completed 8 MB cycle. This is how the I/O load
                # proves it exists: a writer that never got off the ground
                # leaves the tally empty, and the check below refuses to call
                # that a shaken run.
                printf '.' >> "$IO_TALLY"
                n=$(((n + 1) % 4))
            done
        ) >/dev/null 2>&1 &
        STRESS_PIDS+=("$!")
        IO_PIDS+=("$!")
        i=$((i + 1))
    done
}

# 8 MB per completed cycle, summed over every writer.
io_megabytes() {
    local bytes
    bytes="$(wc -c < "$IO_TALLY" 2>/dev/null | tr -d ' ')"
    [ -n "$bytes" ] || bytes=0
    echo $((bytes * 8))
}

loadavg_1m() { sysctl -n vm.loadavg 2>/dev/null | awk '{gsub(/[{}]/,"");print $1}'; }

# Total CPU seconds burned so far by the stressors. `ps` reports cputime as
# [[HH:]MM:]SS.ss, so fold the colon-separated fields base 60.
stressor_cpu_seconds() {
    local pid list=""
    for pid in "${STRESS_PIDS[@]}"; do
        list="$list $(ps -o cputime= -p "$pid" 2>/dev/null | tr -d ' ')"
    done
    printf '%s\n' "$list" | awk '{t=0;for(i=1;i<=NF;i++){n=split($i,p,":");s=0;for(j=1;j<=n;j++)s=s*60+p[j];t+=s}printf "%.2f\n",t}'
}

# --- one measured run ---------------------------------------------------
# Sets RUN_STATUS, RUN_SECONDS, RUN_LOG, RUN_SUMMARY.
run_suite() {
    local label="$1"
    local start end
    RUN_LOG="$SHAKE_DIR/$label.log"
    start="$(date +%s)"
    bash "$E2E" >"$RUN_LOG" 2>&1
    RUN_STATUS=$?
    end="$(date +%s)"
    RUN_SECONDS=$((end - start))
    RUN_SUMMARY="$(/usr/bin/grep -E 'ChatSSEEndToEnd tests passed|test\(s\) failed|only [0-9]+ checks ran|\[FAIL\] Build failed' "$RUN_LOG" | tail -1)"
    [ -n "$RUN_SUMMARY" ] || RUN_SUMMARY="no summary line (see $RUN_LOG)"
}

# The named checks that failed in a run, one per line, sorted. A run that dies
# before any check (build failure, crash) reports a synthetic name so it is
# still counted and still visible in the per-check table.
failed_checks() {
    local log="$1"
    local names
    names="$(/usr/bin/grep '^FAIL - ' "$log" | sed 's/^FAIL - //' | sort -u)"
    if [ -z "$names" ]; then
        if /usr/bin/grep -q '\[FAIL\] Build failed' "$log"; then
            names="<build failed>"
        else
            names="<no named check failed; suite exited non-zero>"
        fi
    fi
    printf '%s\n' "$names"
}

EST_SECONDS=$((RUNS * SECONDS_PER_LOADED_RUN))
[ "$BASELINE" != "0" ] && EST_SECONDS=$((EST_SECONDS + SECONDS_PER_BASELINE_RUN))

echo "[shake] resource-affected flakiness probe for the chat SSE e2e suite"
echo "[shake] configuration"
if [ "$BOUND_REQUESTED" -eq 1 ]; then
    printf '        target bound    : %-6s (SHAKE_BOUND: rule out any per-run failure rate above\n' "${BOUND}%"
    printf '                          this, at 95%% confidence, which takes %s all-passing runs)\n' "$RUNS"
else
    printf '        target bound    : %-6s (what %s all-passing runs earn at 95%% confidence;\n' \
        "$(bound_for_runs "$RUNS")%" "$RUNS"
    printf '                          SHAKE_RUNS was set, so it wins over SHAKE_BOUND)\n'
fi
printf '        runs under load : %-6s (from %s)\n' "$RUNS" "$RUNS_FROM"
printf '        estimated cost  : ~%s at ~%ss per loaded run%s\n' \
    "$(human_seconds "$EST_SECONDS")" "$SECONDS_PER_LOADED_RUN" \
    "$([ "$BASELINE" != "0" ] && echo " plus a ~${SECONDS_PER_BASELINE_RUN}s baseline")"
printf '        cpu stressors   : %-6s (SHAKE_LOAD; machine has %s logical cores)\n' "$LOAD" "$CORES"
printf '        io writers      : %-6s (SHAKE_IO; 8 MB file, rewritten in a loop)\n' "$IO"
printf '        baseline run    : %-6s (SHAKE_BASELINE; unloaded, tells broken from load-induced)\n' "$BASELINE"
printf '        suite           : %s\n' "$E2E"
printf '        logs            : %s\n' "$SHAKE_DIR"
printf '        load average now: %s\n' "$(loadavg_1m)"
echo

TOTAL_START="$(date +%s)"

# --- baseline: no added load -------------------------------------------
BASELINE_STATUS=0
BASELINE_SECONDS=0
BASELINE_RAN=0
if [ "$BASELINE" != "0" ]; then
    echo "[shake] baseline (no added load) ..."
    run_suite "baseline"
    BASELINE_STATUS=$RUN_STATUS
    BASELINE_SECONDS=$RUN_SECONDS
    BASELINE_RAN=1
    if [ "$BASELINE_STATUS" -eq 0 ]; then
        echo "[shake] baseline: PASS  ${BASELINE_SECONDS}s  ${RUN_SUMMARY# }"
    else
        echo "[shake] baseline: FAIL  ${BASELINE_SECONDS}s  ${RUN_SUMMARY# }"
        failed_checks "$RUN_LOG" | sed 's/^/          /'
    fi
    echo
fi

# --- load on -----------------------------------------------------------
LOAD_BEFORE="$(loadavg_1m)"
STRESS_UTIL="n/a"
IO_MB_WINDOW=0
if [ "$((LOAD + IO))" -gt 0 ]; then
    start_load
    cpu0="$(stressor_cpu_seconds)"
    sleep 3
    cpu1="$(stressor_cpu_seconds)"
    STRESS_UTIL="$(awk -v a="$cpu0" -v b="$cpu1" 'BEGIN{printf "%.0f", (b-a)/3*100}')"
    IO_MB_WINDOW="$(io_megabytes)"
    LOAD_DURING="$(loadavg_1m)"
    echo "[shake] load on: ${LOAD} cpu + ${IO} io stressors"
    echo "        stressor cpu    : ${STRESS_UTIL}% of ${CORES}00% (measured over a 3s window)"
    [ "$IO" -gt 0 ] && echo "        io written      : ${IO_MB_WINDOW} MB in the same 3s window"
    echo "        load average    : $LOAD_BEFORE before -> $LOAD_DURING after 3s (a 1-minute"
    echo "                          average barely moves in 3s; the summary reports it again"
    echo "                          at the end, when it has caught up)"
    # A load generator that silently fails to spin is the whole target lying:
    # every run would then be an ordinary rerun wearing a "shaken" label. Each
    # stressor kind is verified on its own terms - the CPU loops by the CPU
    # seconds they burned, the writers by the bytes they actually wrote - and
    # only the kinds that were actually ASKED for are demanded. Requiring CPU
    # when SHAKE_LOAD=0 is what the first cut of this script did, and it made
    # the documented `SHAKE_LOAD=0` rerun-only mode exit 3 without measuring
    # anything.
    if [ "$LOAD" -gt 0 ] && [ "$STRESS_UTIL" -lt 100 ]; then
        echo "[FAIL] $LOAD cpu stressors were asked for and they are together consuming"
        echo "       less than one core (${STRESS_UTIL}%); the load is not real."
        echo "       Result would be meaningless, so nothing was measured."
        exit 3
    fi
    if [ "$IO" -gt 0 ] && [ "$IO_MB_WINDOW" -eq 0 ]; then
        echo "[FAIL] $IO io writer(s) were asked for and not one 8 MB cycle completed;"
        echo "       the I/O load is not real. Nothing was measured."
        exit 3
    fi
    if [ "$LOAD" -eq 0 ]; then
        echo "        NOTE: SHAKE_LOAD=0, so no CPU floor is enforced - these are plain"
        echo "              reruns with I/O noise, not a CPU-shaken run."
    fi
    echo
fi

# --- the shaken runs ----------------------------------------------------
FAILED_RUNS=0
MIN_S=999999
MAX_S=0
TOTAL_RUN_S=0
LOCK_WAITS=0
# Runs that never reached a single assertion because the shared e2e build lock
# never came free. On a machine busy enough to be worth shaking, that is a
# likely outcome, and calling it a flaky test would be exactly the wrong
# diagnosis - it is the harness losing a race with another agent, not the suite
# moving. Counted separately and excluded from the flakiness verdict.
HARNESS_FAILS=0
ALL_FAILS="$SHAKE_DIR/failed_checks.txt"
: > "$ALL_FAILS"
SETS=()

i=1
while [ "$i" -le "$RUNS" ]; do
    run_suite "run_$i"
    [ "$RUN_SECONDS" -lt "$MIN_S" ] && MIN_S=$RUN_SECONDS
    [ "$RUN_SECONDS" -gt "$MAX_S" ] && MAX_S=$RUN_SECONDS
    TOTAL_RUN_S=$((TOTAL_RUN_S + RUN_SECONDS))
    if /usr/bin/grep -q 'Waiting for the e2e build lock' "$RUN_LOG"; then
        LOCK_WAITS=$((LOCK_WAITS + 1))
    fi
    if [ "$RUN_STATUS" -eq 0 ]; then
        echo "[shake] run $i/$RUNS: PASS  ${RUN_SECONDS}s  ${RUN_SUMMARY# }"
        SETS+=("")
    elif /usr/bin/grep -q 'another e2e build holds' "$RUN_LOG"; then
        HARNESS_FAILS=$((HARNESS_FAILS + 1))
        echo "[shake] run $i/$RUNS: SKIP  ${RUN_SECONDS}s  never got the shared build lock (not a flake)"
        SETS+=("")
    else
        FAILED_RUNS=$((FAILED_RUNS + 1))
        echo "[shake] run $i/$RUNS: FAIL  ${RUN_SECONDS}s  ${RUN_SUMMARY# }"
        checks="$(failed_checks "$RUN_LOG")"
        printf '%s\n' "$checks" | sed 's/^/          /'
        printf '%s\n' "$checks" >> "$ALL_FAILS"
        SETS+=("$(printf '%s\n' "$checks" | shasum | cut -d' ' -f1)")
    fi
    i=$((i + 1))
done

LOAD_AT_END="$(loadavg_1m)"
stop_load
TOTAL_SECONDS=$(($(date +%s) - TOTAL_START))

# --- report -------------------------------------------------------------
# Runs that produced a verdict. A run that never got the shared build lock is
# not one of them, and dividing by RUNS instead of MEASURED would quietly
# understate every failure rate below.
MEASURED=$((RUNS - HARNESS_FAILS))

echo
echo "[shake] summary"
echo "        runs under load : $RUNS requested, $MEASURED measured"
echo "        failed runs     : $FAILED_RUNS / $MEASURED"
[ "$BASELINE_RAN" = "1" ] && echo "        baseline (idle) : $([ "$BASELINE_STATUS" -eq 0 ] && echo PASS || echo FAIL)  ${BASELINE_SECONDS}s"
echo "        wall clock      : $((TOTAL_SECONDS / 60))m$((TOTAL_SECONDS % 60))s total, per loaded run min ${MIN_S}s / max ${MAX_S}s"
echo "        load average    : $LOAD_BEFORE before the load, $LOAD_AT_END at the end of the last run"
[ "$IO" -gt 0 ] && echo "        io written      : $(io_megabytes) MB over the whole session"
[ "$LOCK_WAITS" -gt 0 ] && echo "        NOTE: $LOCK_WAITS run(s) waited on the shared e2e build lock, so those timings include another process's build."
[ "$HARNESS_FAILS" -gt 0 ] && echo "        NOTE: $HARNESS_FAILS run(s) never got that lock at all and were excluded - harness contention, not flakiness."

if [ -s "$ALL_FAILS" ]; then
    echo "        per-check failure counts (out of $MEASURED measured runs):"
    sort "$ALL_FAILS" | uniq -c | sort -rn | sed 's/^ *\([0-9]*\) /          \1\/'"$MEASURED"'  /'
fi

# Same failing checks every time, or a different set each time?
SAME_SET=1
if [ "$FAILED_RUNS" -gt 1 ]; then
    first=""
    for s in "${SETS[@]}"; do
        [ -z "$s" ] && continue
        if [ -z "$first" ]; then first="$s"; elif [ "$s" != "$first" ]; then SAME_SET=0; fi
    done
fi

echo
if [ "$BASELINE_RAN" = "1" ] && [ "$BASELINE_STATUS" -ne 0 ]; then
    echo "[FAIL] BROKEN, not flaky: the suite failed with no added load at all."
    echo "       Fix the failure before reading anything into the loaded runs"
    echo "       ($FAILED_RUNS of $MEASURED measured loaded runs also failed)."
    exit 1
fi

if [ "$MEASURED" -eq 0 ]; then
    echo "[FAIL] NOTHING MEASURED: all $RUNS runs gave up waiting for the shared e2e"
    echo "       build lock. Another process is building; retry later or point this"
    echo "       run at a private build dir with TRIOS_E2E_BUILD_DIR."
    exit 3
fi

if [ "$FAILED_RUNS" -eq 0 ]; then
    # The bound is earned by the runs that produced a verdict, not by the runs
    # that were asked for. Harness contention can eat some, and a target that
    # printed the requested bound after measuring fewer runs than it needs
    # would be overstating exactly the number it exists to state.
    earned="$(bound_for_runs "$MEASURED")"
    echo "[OK] STABLE under load: $MEASURED/$MEASURED measured runs passed."
    echo "     That rules out any flake with a per-run failure rate above ${earned}% at 95%"
    echo "     confidence: (1 - p)^$MEASURED <= 0.05 for every p above it."
    if [ "$BOUND_REQUESTED" -eq 1 ] && [ "$MEASURED" -lt "$RUNS" ]; then
        echo "     SHORT: SHAKE_BOUND=${BOUND}% needed $RUNS measured runs and got $MEASURED, so the"
        echo "     bound above is what was earned, not the one requested. Re-run to close it."
    else
        # Half of what this run earned, whether that came from SHAKE_BOUND or
        # from a hand-picked SHAKE_RUNS.
        tighter="$(awk -v b="$earned" 'BEGIN{t=int(b/2); if(t<b/2)t++; if(t<1)t=1; print t}')"
        n_t="$(runs_for_bound "$tighter")"
        est_t=$((n_t * SECONDS_PER_LOADED_RUN))
        [ "$BASELINE" != "0" ] && est_t=$((est_t + SECONDS_PER_BASELINE_RUN))
        echo "     A rarer flake would survive this many runs. Halving the bound roughly"
        echo "     doubles the bill: SHAKE_BOUND=$tighter is $n_t runs, ~$(human_seconds "$est_t")."
    fi
    exit 0
fi

if [ "$FAILED_RUNS" -eq "$MEASURED" ]; then
    if [ "$SAME_SET" -eq 1 ]; then
        echo "[FAIL] DETERMINISTIC UNDER LOAD, not flaky: every loaded run failed, and every"
        echo "       run failed the same checks. The suite passes idle and fails whenever the"
        echo "       machine is busy - a resource-affected failure, reproducible on demand."
    else
        echo "[FAIL] FAILS EVERY LOADED RUN, but on different checks each time. Something"
        echo "       load-sensitive is broadly wrong rather than one flaky assertion."
    fi
    exit 2
fi

echo "[FAIL] FLAKY: $FAILED_RUNS of $MEASURED measured runs failed and the rest passed, with no"
echo "       change to the tree between runs. The per-check table above names the"
echo "       assertions that moved; each is resource-affected in the sense of"
echo "       Silva et al. Re-run with SHAKE_RUNS higher to sharpen the rate."
exit 2
