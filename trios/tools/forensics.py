#!/usr/bin/env python3
"""Report-only forensics commands for the trios Makefile.

Every line printed is an observation with its window; nothing here decides
whether the state is good, and every subcommand always exits 0 (the same
contract as `make doctor`). The recipes these commands replace lived as
copy-paste blocks in .claude/skills/trios-live-forensics/SKILL.md, where
picking the right log root was manual - and reading the wrong root is how
"the swarm is stopped" was said eleven times about the wrong variant.

Subcommands:
  forensics [--variant V]  binary-vs-commit drift, top-25 event histogram,
                           delegation state buckets - the skill's steps 1-3
  signals   [--variant V]  counts of the named signal events since the last
                           server.launch anchor in that variant's log
  board     [--variant V]  delegation registry bucketed by state, with ages
                           and boundaries of awaitingReview tasks
  drift                    one-line binary-vs-commit verdict per variant

Variants: release (default) -> .trinity, dev -> .trinity-dev,
test -> .trinity-test.
"""

import collections
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LOG_ROOTS = {
    "release": ".trinity",
    "dev": ".trinity-dev",
    "test": ".trinity-test",
}

BINARIES = {
    "release": "trios.app/Contents/MacOS/trios",
    "dev": "trios-dev.app/Contents/MacOS/trios",
    "test": "trios-test.app/Contents/MacOS/trios",
}

SIGNALS = [
    "queen.reconcile.disagrees",
    "conversation.persist.write_refused",
    "conversation.persist.encrypt_fallback",
    "conversation.persist.decrypt_failed",
    "conversation.persist.decrypt_deferred",
    "conversation.persist.read_plaintext",
    "conversation.persist.reencrypted",
    "conversation.persist.recovered",
    "conversation.persist.reclaimed",
    "conversation.persist.rejoined",
    "conversation.persist.preserved_then_written",
    "keychain.enumeration.stalled",
    "keychain.read.stalled",
    "keychain.read.settled",
    "keychain.read.served_late",
    "keychain.queue.starved",
]


def sh(args):
    try:
        return subprocess.run(
            args, cwd=ROOT, capture_output=True, text=True, timeout=15
        ).stdout.strip()
    except Exception:
        return ""


def variant_arg(argv):
    if "--variant" in argv:
        i = argv.index("--variant")
        if i + 1 < len(argv):
            return argv[i + 1]
    return os.environ.get("VARIANT") or "release"


def log_path(variant):
    root = LOG_ROOTS.get(variant)
    if root is None:
        return None
    return os.path.join(ROOT, root, "logs", "trios-app.jsonl")


def iter_log(variant):
    path = log_path(variant)
    if not path or not os.path.exists(path):
        return
    for line in open(path, errors="replace"):
        try:
            yield json.loads(line)
        except Exception:
            continue


def delegation(variant):
    root = LOG_ROOTS.get(variant, ".trinity")
    path = os.path.join(ROOT, root, "state", "queen_delegation.json")
    try:
        d = json.load(open(path))
    except Exception:
        return []
    t = d if isinstance(d, list) else d.get("tasks", d)
    return list(t.values()) if isinstance(t, dict) else t


def cmd_drift():
    head = sh(["git", "log", "-1", "--format=%h %ct %s"])
    parts = head.split(" ", 2)
    head_sha, head_ct = parts[0], int(parts[1]) if len(parts) > 2 else 0
    subject = parts[2] if len(parts) > 2 else ""
    print("HEAD        : %s - %s" % (head_sha, subject))
    for variant, rel in BINARIES.items():
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            print("%-12s: binary absent (%s)" % (variant, rel))
            continue
        mtime = os.stat(path).st_mtime
        stamp = time.strftime("%m-%d %H:%M", time.localtime(mtime))
        if mtime >= head_ct:
            print("%-12s: binary %s is newer than HEAD's commit time - it can "
                  "contain HEAD" % (variant, stamp))
        else:
            behind = sh(["git", "log", "--format=%h %s",
                         "--since=@%d" % int(mtime)]).splitlines()
            print("%-12s: binary %s PREDATES %d commit(s):" % (
                variant, stamp, len(behind)))
            for c in behind[:5]:
                print("              %s" % c)
    print("-- REPORT: mtime of the binary INSIDE the bundle vs commit times. A "
          "binary newer")
    print("   than HEAD proves nothing about WHICH commit it holds; only a "
          "rebuild does.")


def anchor_ts(variant):
    """Timestamp of the last server.launch line, or None."""
    last = None
    for d in iter_log(variant):
        if d.get("event") == "server.launch":
            last = d.get("ts")
    return last


def cmd_signals(variant):
    path = log_path(variant)
    if not path or not os.path.exists(path):
        print("no log at %s - nothing measured" % (path or variant))
        return
    anchor = anchor_ts(variant)
    if anchor:
        print("window      : since server.launch %s (%s log)" % (anchor, variant))
    else:
        print("window      : WHOLE FILE - no server.launch line in this log, "
              "so 'since launch' cannot be anchored")
    counts = collections.Counter()
    for d in iter_log(variant):
        ev = d.get("event", "")
        if ev in SIGNALS:
            ts = d.get("ts", "")
            if anchor and ts and ts < anchor:
                continue
            counts[ev] += 1
    for ev in SIGNALS:
        print("%6d  %s" % (counts.get(ev, 0), ev))
    print("-- REPORT: counts only; the diagnosis stays with the reader.")


def cmd_board(variant):
    tasks = delegation(variant)
    if not tasks:
        print("no delegation registry for variant %s (or it is empty)" % variant)
        return
    counts = collections.Counter(x.get("state") for x in tasks)
    for state, n in counts.most_common():
        print("%6d  %s" % (n, state))
    print("-- legend: only 'running' has a worker; queued is waiting, accepted/")
    print("   merged are finished, awaitingReview is waiting on the operator and")
    print("   HOLDS its file boundaries while it waits.")
    now = time.time()
    waiting = [t for t in tasks if t.get("state") == "awaitingReview"]
    for t in waiting:
        upd = t.get("updatedAt", "")
        age = ""
        for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%fZ"):
            try:
                dt = time.mktime(time.strptime(upd, fmt)) - time.timezone
                age = " (%.0fh old)" % ((now - dt) / 3600)
                break
            except Exception:
                continue
        paths = ", ".join(t.get("ownedPaths", [])[:4]) or "-"
        print("  awaitingReview: %s%s holds: %s" % (
            (t.get("title", "") or "")[:56], age, paths))


# Prices in micro-USD per million tokens, longest-prefix matched.
# DUPLICATED from rings/SR-00/ModelPricing.swift, which is the SSOT - update
# both together. Deliberately NOT ModelCostService.swift: the two tables
# disagree (glm-5 $0.60/$2.20 here vs $1.00/$2.00 there) and ModelPricing is
# the one DelegatedTask.estimatedCostUSD bills with. An unknown model prints
# "no price", never a guessed number.
MODEL_PRICES = {
    "glm-5": (600000, 2200000),
    "glm-4": (600000, 2200000),
    "claude-opus": (15000000, 75000000),
    "claude-sonnet": (3000000, 15000000),
    "claude-haiku": (800000, 4000000),
    "gpt-5": (1250000, 10000000),
    "gpt-4": (2500000, 10000000),
    "deepseek": (280000, 420000),
}
FREE_PROVIDERS = {"ollama", "lmstudio", "llamacpp"}


def price_for(model, provider):
    if provider in FREE_PROVIDERS:
        return (0, 0)
    if not model:
        return None
    best = None
    for prefix, p in MODEL_PRICES.items():
        if model.startswith(prefix) and (best is None or len(prefix) > best[0]):
            best = (len(prefix), p)
    return best[1] if best else None


def cmd_spend(variant):
    tasks = delegation(variant)
    if not tasks:
        print("no delegation registry for variant %s" % variant)
        return
    days = {}
    total_in = total_out = total_calls = total_turns = 0
    cost_micro = 0
    costed = uncosted = zero_usage = 0
    for t in tasks:
        day = (t.get("updatedAt") or "")[:10] or "undated"
        d = days.setdefault(day, {"tasks": 0, "calls": 0, "in": 0, "out": 0})
        d["tasks"] += 1
        d["calls"] += t.get("toolCalls") or 0
        ti, to = t.get("inputTokens") or 0, t.get("outputTokens") or 0
        d["in"] += ti
        d["out"] += to
        total_in += ti
        total_out += to
        total_calls += t.get("toolCalls") or 0
        total_turns += t.get("completedTurns") or 0
        if ti == 0 and to == 0:
            zero_usage += 1
            continue
        p = price_for(t.get("model"), t.get("provider"))
        if p is None:
            uncosted += 1
        else:
            costed += 1
            cost_micro += (ti * p[0] + to * p[1]) // 1_000_000
    print("== spend, %s registry (pruned history: settled tasks past 50 are "
          "gone, so this is not all-time) ==" % variant)
    for day in sorted(days):
        d = days[day]
        print("%s  %3d task(s)  %5d tool call(s)  %8d in / %8d out tokens"
              % (day, d["tasks"], d["calls"], d["in"], d["out"]))
    print("totals: %d task(s), %d tool call(s), %d turn(s), %d in / %d out tokens"
          % (len(tasks), total_calls, total_turns, total_in, total_out))
    if costed:
        print("estimated: $%.4f across %d priced task(s); %d task(s) had usage "
              "but no known price" % (cost_micro / 1e6, costed, uncosted))
    if zero_usage:
        print("NOTE: %d of %d task(s) recorded ZERO tokens - the agent-server "
              "does not emit a usage SSE event yet, so token spend is "
              "structurally unmeasured (tool calls above are real)." % (
                  zero_usage, len(tasks)))


def cmd_forensics(variant):
    print("== binary vs commits ==")
    cmd_drift()
    print()
    print("== event histogram (%s log, whole file) ==" % variant)
    hist = collections.Counter()
    first = last = None
    for d in iter_log(variant):
        hist[d.get("event", "")] += 1
        ts = d.get("ts")
        if ts:
            if first is None:
                first = ts
            last = ts
    if first:
        print("window: %s -> %s" % (first, last))
    for ev, n in hist.most_common(25):
        print("%6d  %s" % (n, ev))
    if not hist:
        print("no parseable lines - is this the right variant?")
    print()
    print("== delegation board ==")
    cmd_board(variant)


def main():
    argv = sys.argv[1:]
    cmd = argv[0] if argv else "forensics"
    variant = variant_arg(argv)
    if variant not in LOG_ROOTS:
        print("unknown variant %r; use release, dev or test" % variant)
        return
    if cmd == "drift":
        cmd_drift()
    elif cmd == "signals":
        cmd_signals(variant)
    elif cmd == "board":
        cmd_board(variant)
    elif cmd == "spend":
        cmd_spend(variant)
    else:
        cmd_forensics(variant)


if __name__ == "__main__":
    os.chdir(ROOT)
    main()
    sys.exit(0)
