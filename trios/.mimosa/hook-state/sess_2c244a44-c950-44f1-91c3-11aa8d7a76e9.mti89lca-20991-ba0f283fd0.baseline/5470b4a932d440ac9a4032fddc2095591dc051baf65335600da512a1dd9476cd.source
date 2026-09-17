#!/usr/bin/env bash
# RING-01 — the A2A protocol, checked as rules rather than as text.
#
# Ring 01 restates a contract that already runs: nine routes in the agent
# server, the `agents` table, and the Swift client. Restating it is only worth
# anything if the restatement is exercised, so this generates Rust from the
# `.t27`, builds it with bare `rustc --crate-type lib`, and runs a table of
# inputs through it.
#
# The table is written here rather than derived, and each row says what it is
# defending. A row that cannot be explained is a row nobody will maintain.
#
# Skipped, not failed, when t27c is absent: the compiler lives in a sibling
# repository and a machine without it should not be told the ring is broken.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/rings/T27-01/a2a.t27"
T27C="${T27C:-$HOME/t27/target/release/t27c}"

if [ ! -x "$T27C" ]; then
  echo "[SKIP] ring01_rules: no t27c at $T27C"
  exit 0
fi
if [ ! -f "$SRC" ]; then
  echo "FAIL [ring01_rules]: $SRC does not exist"
  exit 1
fi

TMP="$(mktemp -d /tmp/ring01-rules.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

echo "== generating Rust from $SRC"
"$T27C" gen-rust "$SRC" > "$TMP/a2a_raw.rs"

# An empty or error-shaped generation must fail loudly. A harness that
# silently reports zero disagreements over zero rows is worse than no harness.
if ! grep -q "pub fn can_transition" "$TMP/a2a_raw.rs"; then
  echo "FAIL [ring01_rules]: generation produced no rules"
  head -5 "$TMP/a2a_raw.rs" | sed 's/^/       /'
  exit 1
fi

# The derives ask for serde, which a bare rustc build has no crate for. The
# ring itself carries no serialisation; stripping the attribute keeps this
# checking the LANGUAGE rather than the dependency graph.
sed 's/, serde::Serialize, serde::Deserialize//' "$TMP/a2a_raw.rs" > "$TMP/a2a.rs"

echo "== compiling the generated Rust as a library"
rustc --crate-type lib --edition 2021 "$TMP/a2a.rs" -o "$TMP/liba2a.rlib" 2>"$TMP/rustc.err" || {
  echo "FAIL [ring01_rules]: the generated Rust does not compile"
  head -12 "$TMP/rustc.err" | sed 's/^/       /'
  exit 1
}

cat > "$TMP/bench.rs" <<'RUST'
mod a2a { include!("A2A_PATH"); }
use a2a::*;

fn check(ok: bool, what: &str, failures: &mut Vec<String>) {
    if !ok { failures.push(what.to_string()); }
}

fn main() {
    let mut f: Vec<String> = Vec::new();

    // Message kinds: a broadcast addressed to one agent is an accident, and a
    // direct message with nobody named is dropped by the router in silence -
    // the failure that is hardest to notice because nothing errors.
    check(!requires_recipient(MSG_BROADCAST), "broadcast needs no recipient", &mut f);
    check(!requires_recipient(MSG_HEARTBEAT), "heartbeat needs no recipient", &mut f);
    check(requires_recipient(MSG_DIRECT), "a direct message must name one", &mut f);
    check(requires_recipient(MSG_TASK_ASSIGN), "so must a task assignment", &mut f);

    // Exactly three kinds belong to the task lifecycle. Getting this wrong
    // either loses task history or fills the store with chatter.
    let task_kinds = [MSG_TASK_ASSIGN, MSG_TASK_UPDATE, MSG_TASK_RESULT];
    let other_kinds = [MSG_DIRECT, MSG_BROADCAST, MSG_ADD_TOOL_CALL, MSG_HEARTBEAT, MSG_ERROR];
    for k in task_kinds { check(is_task_message(k), "task kind recognised", &mut f); }
    for k in other_kinds { check(!is_task_message(k), "transport kind is not a task", &mut f); }

    // Terminal states go nowhere. A completed task that can be reassigned is
    // how one piece of work gets done twice.
    for s in [TASK_COMPLETED, TASK_FAILED, TASK_CANCELLED] {
        check(is_terminal(s), "terminal state recognised", &mut f);
        // TASK_CANCELLED belongs in this list, and leaving it out was a hole
        // my own break-test found: removing the terminal guard from the ring
        // left "anything unfinished may be cancelled" firing for finished work,
        // and every row here still passed. A terminal state must refuse EVERY
        // destination, including the one that is otherwise always allowed.
        for to in [TASK_PENDING, TASK_ASSIGNED, TASK_IN_PROGRESS, TASK_COMPLETED,
                   TASK_FAILED, TASK_CANCELLED] {
            check(!can_transition(s, to), "nothing leaves a terminal state", &mut f);
        }
    }
    for s in [TASK_PENDING, TASK_ASSIGNED, TASK_IN_PROGRESS] {
        check(!is_terminal(s), "unfinished state is not terminal", &mut f);
        // Cancelling is the operator's escape hatch and must never be refused.
        check(can_transition(s, TASK_CANCELLED), "anything unfinished may be cancelled", &mut f);
        check(!can_transition(s, s), "a state does not transition to itself", &mut f);
    }
    check(can_transition(TASK_PENDING, TASK_ASSIGNED), "pending -> assigned", &mut f);
    check(!can_transition(TASK_PENDING, TASK_IN_PROGRESS), "pending does not skip assignment", &mut f);
    check(!can_transition(TASK_PENDING, TASK_COMPLETED), "and cannot complete unassigned", &mut f);
    check(can_transition(TASK_ASSIGNED, TASK_IN_PROGRESS), "assigned -> in progress", &mut f);
    check(can_transition(TASK_ASSIGNED, TASK_FAILED), "an assigned task can fail before starting", &mut f);
    check(!can_transition(TASK_ASSIGNED, TASK_COMPLETED), "but cannot complete without starting", &mut f);
    check(can_transition(TASK_IN_PROGRESS, TASK_COMPLETED), "in progress -> completed", &mut f);
    check(can_transition(TASK_IN_PROGRESS, TASK_FAILED), "in progress -> failed", &mut f);

    // Liveness. Three missed beats, not one: marking an agent offline for a
    // single hiccup makes the registry flap, and a status field that flaps is
    // one every consumer learns to ignore.
    check(offline_after_seconds() == 90, "90s = three 30s beats", &mut f);
    check(is_alive(0), "a beat just now is alive", &mut f);
    check(is_alive(89), "one second inside the window is alive", &mut f);
    check(is_alive(90), "the boundary itself is alive", &mut f);
    check(!is_alive(91), "one second past it is not", &mut f);
    check(is_alive(-5), "a beat in the future is a clock disagreement, not death", &mut f);
    check(status_from_heartbeat(10) == AGENT_ONLINE, "fresh beat records online", &mut f);
    check(status_from_heartbeat(600) == AGENT_OFFLINE, "a stale one records offline", &mut f);

    // Priority. An out-of-range value must not be clamped into a real one: a
    // task that says 99 and is read as critical jumps every queue on a typo.
    check(outranks(PRIORITY_CRITICAL, PRIORITY_LOW), "critical outranks low", &mut f);
    check(!outranks(PRIORITY_LOW, PRIORITY_CRITICAL), "and not the other way", &mut f);
    check(!outranks(PRIORITY_HIGH, PRIORITY_HIGH), "equal does not outrank", &mut f);
    for p in [PRIORITY_LOW, PRIORITY_MEDIUM, PRIORITY_HIGH, PRIORITY_CRITICAL] {
        check(is_valid_priority(p), "a defined priority is valid", &mut f);
    }
    check(!is_valid_priority(-1), "below the range is refused", &mut f);
    check(!is_valid_priority(99), "and so is above it", &mut f);

    if f.is_empty() {
        println!("OK");
    } else {
        for line in &f { println!("MISMATCH: {}", line); }
        std::process::exit(1);
    }
}
RUST
sed -i '' "s|A2A_PATH|$TMP/a2a.rs|" "$TMP/bench.rs"

echo "== running the rule table through the generated Rust"
rustc --edition 2021 "$TMP/bench.rs" -o "$TMP/bench" 2>"$TMP/bench.err" || {
  echo "FAIL [ring01_rules]: the bench does not compile against the generated ring"
  head -12 "$TMP/bench.err" | sed 's/^/       /'
  exit 1
}

if OUT="$("$TMP/bench")" && [ "$OUT" = "OK" ]; then
  echo "[OK] ring01_rules: the A2A rules hold in the generated Rust"
  echo "     message kinds, task transitions, liveness and priority, from rings/T27-01/a2a.t27"
else
  echo "FAIL [ring01_rules]: the generated ring disagrees with its own rules"
  echo "$OUT" | sed 's/^/       /'
  exit 1
fi
