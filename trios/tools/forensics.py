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
    "encryption.key.answered_after_refusal",
    "keychain.read.not_restacked",
    "keychain.enumeration.not_restacked",
    "keychain.read.starved_out",
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


def cmd_refusals(variant):
    """Who refused the encryption key, per event, since the last launch.

    `signals` counts how often the key was unavailable. Until 2026-08-23 that
    was the end of it: every refusal carried the same sentence, so a count of
    ten told a reader nothing about whether to open Keychain Access or to look
    at our own cool-down. The `refusal` attribute now records which of five
    measured conditions it was, and `keychain_was_asked` says whether securityd
    was contacted at all - two of the five never reach it.

    A line with no `refusal` attribute was written by a binary older than that
    change; it is counted separately rather than folded in, because guessing
    which condition an old line meant is the defect this whole change is about.
    """
    path = log_path(variant)
    if not path or not os.path.exists(path):
        print("no log at %s - nothing measured" % (path or variant))
        return
    anchor = anchor_ts(variant)
    print("window      : %s (%s log)" % (
        ("since server.launch %s" % anchor) if anchor
        else "WHOLE FILE - no server.launch line to anchor on", variant))

    events = ["conversation.persist.encrypt_fallback",
              "conversation.persist.decrypt_deferred"]
    per_event = {ev: collections.Counter() for ev in events}
    unattributed = collections.Counter()
    asked = collections.Counter()

    for d in iter_log(variant):
        ev = d.get("event", "")
        if ev not in per_event:
            continue
        ts = d.get("ts", "")
        if anchor and ts and ts < anchor:
            continue
        attrs = d.get("attrs") or {}
        tag = attrs.get("refusal")
        if tag:
            per_event[ev][tag] += 1
            asked[attrs.get("keychain_was_asked", "unrecorded")] += 1
        else:
            unattributed[ev] += 1

    for ev in events:
        total = sum(per_event[ev].values()) + unattributed[ev]
        print("\n%s  (%d)" % (ev, total))
        if not total:
            print("       none")
            continue
        for tag, n in per_event[ev].most_common():
            print("%6d  %s" % (n, tag))
        if unattributed[ev]:
            print("%6d  (no refusal attribute - written by a binary predating "
                  "2026-08-23)" % unattributed[ev])

    if asked:
        print("\nkeychain actually asked:")
        for k, n in asked.most_common():
            print("%6d  %s" % (n, k))

    # The refusal window: how long callers were turned away before the key
    # answered. This is the number that decides whether a bounded retry could
    # replace the plaintext fallback, and until 2026-08-23 nobody had it.
    windows = []
    for d in iter_log(variant):
        if d.get("event") != "encryption.key.answered_after_refusal":
            continue
        ts = d.get("ts", "")
        if anchor and ts and ts < anchor:
            continue
        attrs = d.get("attrs") or {}
        try:
            windows.append((float(attrs.get("elapsed", 0)),
                            int(attrs.get("refusals", 0)),
                            attrs.get("key", "?"), ts))
        except (TypeError, ValueError):
            continue
    total_refusals = sum(sum(c.values()) for c in per_event.values())
    print("\nrefusal windows (first refusal -> key answered):")
    if not windows:
        # "none recorded" used to be printed for two opposite situations, and
        # the reassuring reading was the wrong one. A window is only logged
        # when it CLOSES, so a key that never answers at all - the worst case -
        # produced the same silence as a key that was never asked. Measured
        # 2026-08-23T07:06: 221 refusals in one window, 55 of them completed
        # reads answering "stored but unreadable", and zero closed windows.
        if total_refusals:
            print("       NONE CLOSED, but %d refusal(s) were recorded above." % total_refusals)
            print("       A window is logged only when the key finally answers, so this")
            print("       means no refused key has answered yet in this window - the")
            print("       window is still OPEN. That is the bad case, not the quiet one.")
            if per_event["conversation.persist.decrypt_deferred"].get("stored_but_unreadable"):
                n = per_event["conversation.persist.decrypt_deferred"]["stored_but_unreadable"]
                print("       %d of them are 'stored_but_unreadable': the Keychain was asked,"
                      % n)
                print("       the read COMPLETED, and it returned nothing. That is not slowness.")
        else:
            print("       none - no caller was refused in this window, or the running")
            print("       binary predates 2026-08-23.")
    else:
        for secs, n, key, ts in windows:
            print("%8.1fs  %-12s %d caller(s) refused   %s" % (secs, key, n, ts))
        longest = max(w[0] for w in windows)
        print("  longest: %.1fs - a bounded retry shorter than this cannot "
              "remove every plaintext write." % longest)

    print("\n-- REPORT: counts only. 'no' means TriOS refused the read itself and")
    print("   securityd was never contacted, so Keychain Access has nothing to show.")


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
    # Mirrors SwarmBudget.current (rings/SR-00/ModelPricing.swift): the
    # TRIOS_SWARM_DAILY_CAP_USD env var, then the per-variant knob file
    # state/swarm_budget.json ({"dailyCapUSD": 30}), then the $10 default.
    # Same strictness: non-positive or over $1M/day reads as no knob. The gate
    # sums estimatedCostUSD over tasks whose updatedAt falls in the same LOCAL
    # calendar day and refuses NEW dispatches past the cap - running bees are
    # not killed.
    DAILY_CAP_MICRO = 10_000_000
    def _knob_dollars(raw):
        try:
            d = float(raw)
        except (TypeError, ValueError):
            return None
        return d if 0 < d <= 1_000_000 else None
    _env_cap = _knob_dollars(os.environ.get("TRIOS_SWARM_DAILY_CAP_USD"))
    if _env_cap is not None:
        DAILY_CAP_MICRO = int(_env_cap * 1_000_000)
    else:
        _knob_path = os.path.join(
            LOG_ROOTS.get(variant, ".trinity"), "state", "swarm_budget.json"
        )
        try:
            with open(_knob_path) as kf:
                _file_cap = _knob_dollars(json.load(kf).get("dailyCapUSD"))
            if _file_cap is not None:
                DAILY_CAP_MICRO = int(_file_cap * 1_000_000)
        except FileNotFoundError:
            pass
        except Exception as knob_err:
            print("NOTE: budget knob %s unreadable (%s); using the $10 default"
                  % (_knob_path, knob_err))
    import datetime
    today_local = datetime.date.today().isoformat()
    today_micro = 0
    for t in tasks:
        upd = t.get("updatedAt") or ""
        try:
            dt = datetime.datetime.strptime(upd[:19], "%Y-%m-%dT%H:%M:%S")
            local_day = (dt.replace(tzinfo=datetime.timezone.utc)
                         .astimezone().date().isoformat())
        except Exception:
            continue
        if local_day != today_local:
            continue
        p = price_for(t.get("model"), t.get("provider"))
        if p is None:
            continue
        ti, to = t.get("inputTokens") or 0, t.get("outputTokens") or 0
        today_micro += (ti * p[0] + to * p[1]) // 1_000_000
    print("== spend, %s registry (pruned history: settled tasks past 50 are "
          "gone, so this is not all-time) ==" % variant)
    print("budget today (local day %s): $%.4f of $%.2f daily cap%s"
          % (today_local, today_micro / 1e6, DAILY_CAP_MICRO / 1e6,
             " - EXHAUSTED, new dispatches are refused"
             if today_micro >= DAILY_CAP_MICRO else ""))
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
        print("NOTE: %d of %d task(s) recorded zero tokens - turns finished "
              "before usage emission went live on 2026-08-21; new worker "
              "turns record real numbers (tool calls are real either way)." % (
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
    elif cmd == "refusals":
        cmd_refusals(variant)
    else:
        cmd_forensics(variant)


if __name__ == "__main__":
    os.chdir(ROOT)
    main()
    sys.exit(0)
