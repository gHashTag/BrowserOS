---
name: trios-live-forensics
description: Read what the running TriOS app is actually doing before changing any code. Use at the START of every autonomous round, when the Queen appears idle or stuck, when a fix "did not work", when credentials look missing, or before claiming a gate is green. Covers the log histogram, binary-versus-commit drift, the delegation registry, the three credential sources, and the gates that are red on the tree they guard.
---

# Live forensics

Observation before edit. Four of the last rounds began by fixing something the
running system was not doing.

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
