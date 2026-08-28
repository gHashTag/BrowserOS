# The release blocker is one rename, not 763 commits

Measured 2026-08-28. Re-run every command here before acting on it.

## What "release" means, and which one is blocked

Two different things are called release in this project, and they block on
different work:

**A. A trios release** — this branch merged to `dev`, tagged, built. Blocked by
exactly one structural problem, described below. Achievable.

**B. The MVP in `Queen_T27_MVP_Architecture.md`** — twelve vertical-slice items
in section 16.1, thirty criteria in section 23.

CORRECTION, 2026-08-28. An earlier version of this file said the MVP was "not
achievable from here, and no amount of trios work moves it". That is wrong,
and the owner was right to reject it. **The Queen IS trios.** Section 11 of the
document — mission contract, task graph, Bee result contract, acceptance
policy, competing proposals — is entirely work in this repository, and the
whole Queen/Bees section of the Definition of Done, 6 of its 29 criteria, is
implemented here and nowhere else. The gap table's P0 row "Queen/T27 bridge —
[not demonstrated]" names a trios deliverable.

Measured against the live registry the same day, that row is also out of date:
the Queen has delegated 10 tasks carrying a `.t27` owned path, and #1280 on
`rings/T27-00/queen_core.t27` reached `accepted`. The bridge is partly
demonstrated. What is missing is narrower and nameable:

| section 11 | state |
|---|---|
| 11.1 machine-readable mission contract | absent — nothing in `rings/`, no `.trinity/missions` |
| 11.3 structured Bee result | none of its eight fields exist; the registry has `committedFiles` and `committedSHA` |
| 11.4 T27-aware acceptance | a `.t27` spec is accepted exactly like a Swift file — nothing checks it still lowers |

That third row is the bridge, and `make t27-lowering` already performs the
checks it needs. It is simply never consulted when the Queen accepts.

What genuinely is not ours is narrower than I claimed: the semantic stage, the
versioned IR and the compiler's diagnostics live in `gHashTag/t27`; the
Playground has no owner and no code. Those do not move from here. The Queen
half does, and it is the half this document's section 11 is about.

Everything below is about A.

## The measurement

```
git rev-list --count origin/dev..HEAD   ->  763   (ahead)
git rev-list --count HEAD..origin/dev   ->   17   (behind)
git merge-tree --write-tree origin/dev HEAD | grep -c '^CONFLICT\|<<<<<<<'  ->  570
```

1096 distinct conflicted files. But they are not spread through the code:

| area | conflicted files |
|---|---:|
| `packages/browseros-agent` | 546 |
| `trios/agent-server` | 436 |
| `trios/BR-OUTPUT` | 43 |
| `trios/rings` | 27 |
| everything else | 44 |

The top two are the same directory in two places.

## It is a rename

```
packages/browseros-agent   on dev: 1354 files    on this branch: 0
trios/agent-server         on dev:    0 files    on this branch: 1537
```

This branch moved the bun runtime from `packages/browseros-agent` to
`trios/agent-server`. Confirmed as a move rather than a rewrite: 1065 filenames
are common to both trees, and 38 of 40 sampled shared files are **byte-identical**
between `origin/dev:packages/browseros-agent/<f>` and
`HEAD:trios/agent-server/<f>`.

Git sees a delete-on-one-side, modify-on-the-other for every file `dev` touched
at the old path. That is where 546 of the conflicts come from, and they are
mechanical, not semantic.

## What actually has to be decided

`dev` changed 485 files at the old path while this branch was away:

- **203** of them exist in the new location, so the change has somewhere to go;
- **282** do not, so each is either new on `dev` or deliberately dropped here.

That is the real work: carry 203 changes across the rename, and rule on 282.
Bounded and countable, which 763 commits of conflict output is not.

## The decision belongs to the owner

Two coherent answers, and this document does not pick one:

1. **Keep the rename.** The runtime lives under `trios/` because trios owns it.
   Then `dev`'s 485 changes must be replayed into `trios/agent-server`, and
   `packages/browseros-agent` is deleted on merge.
2. **Undo the rename.** The runtime stays where BrowserOS expects it and trios
   references it. Then this branch's move is reverted before merging.

The choice is about which repository owns the runtime, which is an ownership
question, not a merge question. Answering it by whichever side wins a conflict
resolution would be deciding it by accident.

## The second blocker: the gate does not finish

`make check` did not complete on 2026-08-28 either. It ran 1h08m and was
stopped by hand.

Localised precisely. The whole run reduces to one `/bin/bash` child of `make`,
alive 57m42s in state `S`, whose argv is the `cassettes` lock-acquisition
prologue. It has **no children at all** - no `sleep`, no `cat`, no `mkdir` -
so it is not executing the loop body; it is blocked in a syscall. Meanwhile:

```
ls -ld /tmp/trios_harness.lock   ->  No such file or directory   (lock is FREE)
time mkdir /tmp/trios_harness_probe.lock  ->  0.004s             (mkdir works)
time touch /tmp/probe_$$                  ->  0.003s             (/tmp is fine)
```

So the loop should have acquired on its first iteration, and the 1800s timeout
should have fired 30 minutes before it did not.

This is the same "system-layer anomaly" earlier waves recorded on the status
board. They could not clear it either and reached for `make check-bypass`
(`TRIOS_SKIP_LOCK=1`), whose own banner says *"owner root-heals; never for
CI"*. A release cannot be cut on a bypass its author marked as diagnostic.

Aggravating factor, and it is ours: three targets - `cassettes`, `mutants`,
`mutants-logic` - now WAIT on this lock, and none fails fast any more. The
fail-fast path was what previously turned a stuck lock into a fast red instead
of an hour of silence. Converting the last of them to waiting removed the only
signal that distinguished "contended" from "hung".

Root-level tracing is the next step and it needs the owner:

```
sudo fs_usage -w -f filesys <pid>
sudo lsof -p <pid>
```

## What is NOT blocking

- trios' cheap gates. `t27-lowering`, `t27-rings` and `chain` all pass on
  demand, in seconds to minutes, outside the full walk.
- trios' own code. Only 27 conflicted files in `rings/` and 43 in `BR-OUTPUT/`,
  against 982 in the two runtime copies.
- The 85 unpushed commits. They push cleanly to the feature branch; they simply
  do not reach `dev`.

## How to re-measure

```bash
cd /Users/playra/BrowserOS
git fetch origin dev
git merge-tree --write-tree origin/dev HEAD > /tmp/mt.out
grep -c '^CONFLICT\|<<<<<<<' /tmp/mt.out
git ls-tree -r --name-only origin/dev -- packages/browseros-agent | wc -l
git ls-tree -r --name-only HEAD -- trios/agent-server | wc -l
```

A long-lived branch's conflict count grows on its own. This number will be
worse next week than it is today, and that is the argument for deciding soon
rather than deciding well later.
