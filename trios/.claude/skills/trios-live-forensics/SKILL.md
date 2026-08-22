---
name: trios-live-forensics
description: Read what the running TriOS app is actually doing before changing any code. Use at the START of every autonomous round, when the Queen appears idle or stuck, when a fix "did not work", when credentials look missing, or before claiming a gate is green. Covers the log histogram, binary-versus-commit drift, the delegation registry, the three credential sources, and the gates that are red on the tree they guard.
---

# Live forensics

Observation before edit. Four of the last rounds began by fixing something the
running system was not doing.

## 0. The one-command versions (added 2026-08-21)

Steps 1-3 below are now runnable Makefile targets - use these first and fall
back to the raw recipes only when a target is unavailable:

```bash
make forensics            # binary drift + histogram + board, release log
make signals              # named signal counts since the last server.launch
make board                # delegation registry bucketed by state, with ages
make binary-drift         # one-line binary-vs-commit verdict per variant
make dashboard            # regenerate .trinity/dashboard/index.html
make forensics VARIANT=dev   # any of them against the dev or test roots
```

Trap these targets closed: `$(VARIANT)` defaults to `dev` further down the
Makefile (chat-probe), so the report targets use their own `LOG_VARIANT` that
defaults to RELEASE and honors only an explicit command-line `VARIANT=`. The
first run of `make board` printed dev's registry as if it were the release -
the exact wrong-root failure this skill exists to prevent.

## 1. Is the running app the code you are reading?

```bash
ps -eo pid,lstart,etime,comm | grep -E "trios(-dev)?\.app"
stat -f "%Sm %N" -t "%m-%d %H:%M" trios.app/Contents/MacOS/trios
git log -3 --format="%h %cd %s" --date=format:"%m-%d %H:%M"
```

If the newest commit is later than the binary's mtime, the running app does not
contain it. This has been true silently: the release binary was built at 09:11
and two commits landed at 09:23 and 09:26 - so the "refuses to orphan working
bees" fix existed in git and in nobody's process.

The bundle **directory** mtime is set at creation, not at rebuild. Always stat
the binary inside it.

Two variants run at once and both executables are named `trios`. `pgrep -x
trios` matches either; only the **path** distinguishes them.

## 2. What is the app doing? Histogram first, lines second.

```bash
python3 - <<'PY'
import json, collections
c = collections.Counter()
for line in open('.trinity/logs/trios-app.jsonl', errors='replace'):
    try: c[json.loads(line).get('event','')] += 1
    except: pass
for k, v in c.most_common(25): print(f'{v:6d}  {k}')
PY
```

Per-tick ratios are the diagnosis. 68 `queen.autonomy.tick` against 68
`queen.choose.exhausted` means the board did not move once in the whole window.
816 `boundary_taken` / 68 ticks = 12 candidates blocked every tick by the same
holders.

Variant log roots: release `.trinity/`, dev `.trinity-dev/`, harness
`.trinity-test/`. Reading the wrong one is how "the swarm is stopped" gets said
eleven times while dev dispatches workers all night.

## 3. Is a worker actually running?

```bash
python3 -c "
import json,collections
d=json.load(open('.trinity/state/queen_delegation.json'))
t=d if isinstance(d,list) else d.get('tasks',d)
t=list(t.values()) if isinstance(t,dict) else t
print(collections.Counter(x.get('state') for x in t))"
```

Only `running` has a worker. `queued` says so in its own doc comment;
`accepted` and `merged` are finished; `awaitingReview` is waiting on the
operator. A registry of 17 cancelled / 12 failed / 11 accepted / 5
awaitingReview / 3 merged has **zero** workers, however busy the journal reads.

`awaitingReview` tasks hold their file boundaries while they wait. Two of them,
37 and 39 hours old, blocked 12 of 23 candidates. That is a queue with no exit,
not a busy swarm.

## 4. Where credentials really are

Three sources, consulted in this order by `resolvedAPIKey`:

| Source | Release | Dev |
|---|---|---|
| Keychain `com.browseros.trios.model-keys` | the only working one | not used |
| `~/.trios/config.json` | **present with zero-length values** - looks configured, supplies nothing | not used |
| `TRIOS_<PROVIDER>_API_KEY` env | unset | unset |
| `~/.trios-dev/secrets/` files | not used | the working one |

Check without printing values:

```bash
python3 -c "
import json,os
d=json.load(open(os.path.expanduser('~/.trios/config.json')))
print([(k, len(v) if isinstance(v,str) else type(v).__name__) for k,v in d.items()])"
```

A length of 0 is the finding. I wrote in a commit message that dev reads
`config.json` and it does not - it reads `~/.trios-dev/secrets/`. Verify the
source before naming it.

## 5. Run the gate FIRST, not only at the end

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools make check
```

`make check` has twice been red on arrival for reasons that were nobody's
current change:

- `make-dollars` flagged `$(HOME)` and `$(FORCE)` - both correct Make
  variables missing from `MAKE_DOLLAR_VARS`. That failed `check-selftest`'s
  clean-fixture half, which failed `make check` outright.
- the warning gate stood at 6 against a ceiling of 0, from commits already
  landed.

Running it first tells you which red is yours. Running it only at the end
means inheriting someone's red and debugging your own change for it.

`DEVELOPER_DIR=/Library/Developer/CommandLineTools` is required on this
machine; without it the Xcode licence prompt blocks the build.

## 6. Prove it on the wire

A fix is proven by the running system emitting the new line, not by the test
passing. Rebuild, relaunch, then wait for the event:

```bash
python3 - <<'PY'
import json
for line in open('.trinity/logs/trios-app.jsonl', errors='replace'):
    try: d = json.loads(line)
    except: continue
    if d.get('event') in ('conversation.persist.reclaimed', 'queen.choose'):
        print(d['ts'], '|', d.get('message','')[:200])
PY
```

If the old string is still appearing, the binary is old - go back to step 1.
`make relaunch` refuses while any worker is `running`; `FORCE=1` overrides.
Killing the app mid-worker is the largest single cause of `interrupted` in the
registry: 22 of 40 failures in one night were the rebuild loop, not the code.

## Added 2026-08-22, after the first real-money day

- **Measure the clock before declaring silence.** "30 minutes without a
  heartbeat" was twice a misread wall clock: `date -u` against the log's
  tail timestamp costs one second and both false alarms would have
  triggered a relaunch over a healthy bee.
- `make spend` now carries the day's burn against the SwarmBudget cap and
  an EXHAUSTED marker. A resting swarm with money spent is by design, not
  a stall - check spend before diagnosing idleness.
- `keychain.read.settled` / `keychain.read.served_late` are the stall
  family's resolution: settled says what a stalled call ultimately
  returned (measured tails 9.8s-215.6s, always OSStatus 0 so far);
  served_late says the value reached the next caller. Stalls WITHOUT
  later settles are the only remaining mystery worth digging at.
- Board lifecycle commands and their real shapes: awaitingReview resolves
  via `/review <slug> reject <why>` then `/cancel <slug> <why>` (bare
  /cancel is an illegal transition); FAILED records are invisible to every
  command except `/dismiss <issue> <why>`, which exists precisely for
  looked-at failures and refuses an empty reason.

## Added 2026-08-22, second consolidation (the board-lifecycle night)

- **Verify verdicts by record id, not by state counters.** A two-step
  reject-then-cancel on an issue with sibling records can cancel the wrong
  one while the restarted bee flies; the counter still matches the
  expectation. Measured: dev #1132-r3 finished twenty minutes after a
  mistargeted cancel and reappeared in awaitingReview.
- **A record-level dismissal teaches choose nothing.** Candidates come
  from OPEN forge issues, so any lane with budget re-grinds a dismissed
  issue (dev dispatched #1131 attempts 12 and 13 within the hour). The
  durable stop for a measured dead end is closing the issue on the forge
  with a verdict comment; verify the candidate count drops on the next
  choose pass.
- **The macosx26.5 stamps were our own bees.** The agent server launches
  without DEVELOPER_DIR, worker shells resolve swiftc to full Xcode, and
  bee builds stamp shared artifacts with Xcode's SDK. The scrubbed worker
  env now defaults DEVELOPER_DIR to CLT; build.sh's typecheck probe
  auto-repairs artifacts stamped before that landed.
- Dev-lane token counts stay zero until the 9205 server process restarts
  into the emission-default code - a zero there is a stale server, not a
  broken pipeline.
