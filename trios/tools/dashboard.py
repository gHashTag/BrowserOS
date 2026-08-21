#!/usr/bin/env python3
"""Generate .trinity/dashboard/index.html from measured state only.

Every tile on the dashboard is an observation with a timestamp, never a
verdict the generator invented. Sources:
  - git (branch, HEAD, ahead/behind, dirty count)
  - .trinity/logs/trios-app.jsonl (event histogram, signal counts)
  - .trinity/state/queen_delegation.json (board state)
  - .trinity/dashboard/iterations.jsonl (one line per Queen iteration,
    appended by the loop that did the work; this script only renders it)

Run from the trios directory: python3 tools/dashboard.py
Or via make: make dashboard
"""

import collections
import html
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRINITY = os.path.join(ROOT, ".trinity")
OUT_DIR = os.path.join(TRINITY, "dashboard")
OUT = os.path.join(OUT_DIR, "index.html")
ITERATIONS = os.path.join(OUT_DIR, "iterations.jsonl")
APP_LOG = os.path.join(TRINITY, "logs", "trios-app.jsonl")
DELEGATION = os.path.join(TRINITY, "state", "queen_delegation.json")

SIGNALS = [
    ("conversation.persist.write_refused", "write refused", 0),
    ("conversation.persist.encrypt_fallback", "encrypt fallback", 0),
    ("conversation.persist.decrypt_failed", "decrypt failed", 0),
    ("keychain.read.stalled", "keychain read stalled", 0),
    ("keychain.enumeration.stalled", "keychain enum stalled", 0),
    ("queen.reconcile.disagrees", "reconcile disagrees", 0),
]


def sh(args, cwd=ROOT):
    try:
        return subprocess.run(
            args, cwd=cwd, capture_output=True, text=True, timeout=15
        ).stdout.strip()
    except Exception:
        return ""


def git_state():
    branch = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    head = sh(["git", "rev-parse", "--short", "HEAD"])
    subject = sh(["git", "log", "-1", "--format=%s"])
    ahead = sh(["git", "rev-list", "--count", "@{upstream}..HEAD"]) or "?"
    dirty = sh(["git", "status", "--porcelain"])
    dirty_n = len([l for l in dirty.splitlines() if l.strip()])
    return {
        "branch": branch,
        "head": head,
        "subject": subject,
        "ahead": ahead,
        "dirty": dirty_n,
    }


def app_process():
    out = sh(["pgrep", "-fl", "trios.app/Contents/MacOS/trios"])
    lines = [l for l in out.splitlines() if "trios.app" in l and "-dev" not in l]
    if not lines:
        return {"running": False, "pid": None, "started": None}
    pid = lines[0].split()[0]
    lstart = sh(["ps", "-o", "lstart=", "-p", pid])
    return {"running": True, "pid": pid, "started": lstart}


def read_log(since_iso=None):
    hist = collections.Counter()
    sig = collections.Counter()
    first = last = None
    if not os.path.exists(APP_LOG):
        return hist, sig, first, last
    names = {s[0] for s in SIGNALS}
    for line in open(APP_LOG, errors="replace"):
        try:
            d = json.loads(line)
        except Exception:
            continue
        ts = d.get("ts", "")
        if since_iso and ts and ts < since_iso:
            continue
        ev = d.get("event", "")
        hist[ev] += 1
        if ev in names:
            sig[ev] += 1
        if ts:
            if first is None:
                first = ts
            last = ts
    return hist, sig, first, last


def board():
    try:
        d = json.load(open(DELEGATION))
    except Exception:
        return collections.Counter(), []
    t = d if isinstance(d, list) else d.get("tasks", d)
    t = list(t.values()) if isinstance(t, dict) else t
    counts = collections.Counter(x.get("state") for x in t)
    waiting = [
        {
            "title": x.get("title", "")[:70],
            "updated": x.get("updatedAt", ""),
        }
        for x in t
        if x.get("state") == "awaitingReview"
    ]
    return counts, waiting


def iterations():
    rows = []
    if os.path.exists(ITERATIONS):
        for line in open(ITERATIONS, errors="replace"):
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows


def esc(s):
    return html.escape(str(s), quote=True)


def chip(label, tone):
    return '<span class="chip %s">%s</span>' % (tone, esc(label))


def render():
    g = git_state()
    proc = app_process()
    # Signals since the running app started, when we know its start; the
    # ISO conversion is approximate (local ps time vs UTC log ts), so when
    # the process start is unknown we show whole-file counts and say so.
    since = None
    window_note = "whole log file"
    if proc["running"] and proc["started"]:
        try:
            t = time.strptime(proc["started"].strip(), "%a %b %d %H:%M:%S %Y")
            since = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.mktime(t)))
            window_note = "since app launch %s (local)" % proc["started"].strip()
        except Exception:
            pass
    hist, sig, first, last = read_log(since)
    counts, waiting = board()
    iters = iterations()

    tiles = []
    for event, label, ceiling in SIGNALS:
        n = sig.get(event, 0)
        tone = "ok" if n <= ceiling else "bad"
        tiles.append(
            '<div class="tile"><div class="num %s">%d</div>'
            '<div class="lbl">%s</div><div class="sub">%s</div></div>'
            % (tone, n, esc(label), esc(event))
        )

    hist_rows = []
    top = hist.most_common(14)
    peak = top[0][1] if top else 1
    for ev, n in top:
        width = max(2, int(100.0 * n / peak))
        hist_rows.append(
            '<div class="hrow"><span class="hname">%s</span>'
            '<span class="hbar"><i style="width:%d%%"></i></span>'
            '<span class="hn">%d</span></div>' % (esc(ev), width, n)
        )

    board_chips = " ".join(
        chip("%s %d" % (state, n), "warn" if state == "awaitingReview" else "dim")
        for state, n in counts.most_common()
    )
    waiting_rows = "".join(
        '<div class="wrow">%s <span class="dim">%s</span></div>'
        % (esc(w["title"]), esc(w["updated"]))
        for w in waiting
    )

    iter_rows = []
    for it in reversed(iters[-12:]):
        verdict = it.get("verdict", "?")
        tone = {"green": "ok", "red": "bad"}.get(verdict, "warn")
        iter_rows.append(
            '<div class="irow">%s<div><b>#%s %s</b> <span class="dim">%s</span>'
            "<br><span>%s</span></div></div>"
            % (
                chip(verdict, tone),
                esc(it.get("n", "?")),
                esc(it.get("title", "")),
                esc(it.get("ts", "")),
                esc(it.get("summary", "")),
            )
        )

    generated = time.strftime("%Y-%m-%d %H:%M:%S %z")
    page = HTML_TEMPLATE
    page = page.replace("@@GENERATED@@", esc(generated))
    page = page.replace("@@BRANCH@@", esc(g["branch"]))
    page = page.replace("@@HEAD@@", esc(g["head"]))
    page = page.replace("@@SUBJECT@@", esc(g["subject"]))
    page = page.replace("@@AHEAD@@", esc(g["ahead"]))
    page = page.replace("@@DIRTY@@", esc(g["dirty"]))
    page = page.replace(
        "@@APP@@",
        chip("release app pid %s" % proc["pid"], "ok")
        if proc["running"]
        else chip("release app NOT RUNNING", "bad"),
    )
    page = page.replace("@@APPSTART@@", esc(proc["started"] or "not running"))
    page = page.replace("@@WINDOW@@", esc(window_note))
    page = page.replace("@@LOGSPAN@@", esc("%s -> %s" % (first, last)))
    page = page.replace("@@SIGNALS@@", "\n".join(tiles))
    page = page.replace("@@HIST@@", "\n".join(hist_rows))
    page = page.replace("@@BOARD@@", board_chips or '<span class="dim">empty</span>')
    page = page.replace("@@WAITING@@", waiting_rows or '<span class="dim">none</span>')
    page = page.replace("@@ITER@@", "\n".join(iter_rows) or '<span class="dim">no iterations recorded yet</span>')

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT, "w") as f:
        f.write(page)
    print("dashboard: wrote %s (%d bytes)" % (OUT, len(page)))


HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="120">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TriOS Queen &mdash; Release Dashboard</title>
<style>
:root {
  --bg: #262624; --panel: #1e1e1c; --border: #3a3a36;
  --text: #e8e6dc; --dim: #9c9a90; --accent: #d97757;
  --ok: #82b58c; --warn: #d9a757; --bad: #d97763;
}
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: var(--bg); color: var(--text);
  font: 13px/1.5 ui-monospace, "SF Mono", Menlo, monospace; }
h1 { font-size: 16px; margin: 0 0 2px; color: var(--accent); font-weight: 600; }
h2 { font-size: 12px; margin: 0 0 10px; color: var(--dim);
  text-transform: uppercase; letter-spacing: .08em; font-weight: 600; }
.meta { color: var(--dim); margin-bottom: 20px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
  gap: 14px; }
.panel { background: var(--panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 16px; }
.panel.wide { grid-column: 1 / -1; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
.tile { background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; }
.num { font-size: 22px; font-weight: 700; }
.num.ok { color: var(--ok); } .num.bad { color: var(--bad); }
.lbl { margin-top: 2px; } .sub { color: var(--dim); font-size: 10px; }
.chip { display: inline-block; padding: 1px 9px; border-radius: 99px;
  border: 1px solid var(--border); margin: 1px 2px 1px 0; font-size: 11px; }
.chip.ok { color: var(--ok); border-color: var(--ok); }
.chip.warn { color: var(--warn); border-color: var(--warn); }
.chip.bad { color: var(--bad); border-color: var(--bad); }
.chip.dim { color: var(--dim); }
.dim { color: var(--dim); }
.hrow { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
.hname { flex: 0 0 320px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; color: var(--dim); }
.hbar { flex: 1; background: var(--bg); border-radius: 4px; height: 10px; overflow: hidden; }
.hbar i { display: block; height: 100%; background: var(--accent); opacity: .75; }
.hn { flex: 0 0 52px; text-align: right; }
.wrow { padding: 6px 0; border-bottom: 1px dashed var(--border); }
.wrow:last-child { border-bottom: 0; }
.irow { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px dashed var(--border); }
.irow:last-child { border-bottom: 0; }
.kv { margin: 2px 0; } .kv b { color: var(--text); font-weight: 600; }
footer { margin-top: 22px; color: var(--dim); text-align: center; }
</style></head><body>
<h1>TriOS Queen &mdash; Release Dashboard</h1>
<div class="meta">generated @@GENERATED@@ &middot; every number below is a
measurement with a window, not a verdict &middot; auto-refreshes each 2 min</div>
<div class="grid">
  <div class="panel">
    <h2>Tree</h2>
    <div class="kv"><b>branch</b> @@BRANCH@@</div>
    <div class="kv"><b>HEAD</b> @@HEAD@@ &mdash; @@SUBJECT@@</div>
    <div class="kv"><b>unpushed</b> @@AHEAD@@ commits (push is operator-gated)</div>
    <div class="kv"><b>dirty files</b> @@DIRTY@@ (shared tree; some are other agents')</div>
  </div>
  <div class="panel">
    <h2>Running app</h2>
    <div class="kv">@@APP@@</div>
    <div class="kv"><b>started</b> @@APPSTART@@</div>
    <div class="kv"><b>signal window</b> @@WINDOW@@</div>
    <div class="kv"><b>log span</b> @@LOGSPAN@@</div>
  </div>
  <div class="panel wide">
    <h2>Signals (ceiling 0 for each)</h2>
    <div class="tiles">@@SIGNALS@@</div>
  </div>
  <div class="panel">
    <h2>Delegation board</h2>
    <div>@@BOARD@@</div>
    <h2 style="margin-top:14px">Awaiting operator review</h2>
    @@WAITING@@
  </div>
  <div class="panel">
    <h2>Event histogram (window above)</h2>
    @@HIST@@
  </div>
  <div class="panel wide">
    <h2>Queen iterations</h2>
    @@ITER@@
  </div>
</div>
<footer>&phi;&sup2; + 1/&phi;&sup2; = 3 &middot; TRINITY &middot; regenerate: make dashboard</footer>
</body></html>
"""

if __name__ == "__main__":
    os.chdir(ROOT)
    render()
    sys.exit(0)
