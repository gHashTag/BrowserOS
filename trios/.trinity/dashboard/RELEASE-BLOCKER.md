# The release blocker is one rename, not 978 commits

Measured 2026-09-03. Re-run every command here before acting on it.

CORRECTION, 2026-09-03. The page as last written (2026-08-28) was wrong in
two ways, and both are corrected here. First, the second blocker it named -
the `make check` wedge - had already been root-caused and fixed on
2026-08-29, one day after that page was written; the second-blocker section
below is rewritten to say so. Second, three of the five headline numbers had
drifted; all five were re-measured today, and the tool named at the end of
this page re-runs them in one command. The area table below, the 1096
distinct-conflicted-files figure, and the 2026-08-28 narrative numbers
(filename overlap, the 485/203/282 split, the 85 unpushed commits) were NOT
re-measured today; they keep their 2026-08-28 provenance.

## What "release" means, and which one is blocked

Two different things are called release in this project, and they block on
different work:

**A. A trios release** - this branch merged to `dev`, tagged, built. Blocked by
exactly one structural problem, described below. Achievable.

**B. The MVP in `Queen_T27_MVP_Architecture.md`** - twelve vertical-slice items
in section 16.1, thirty criteria in section 23.

CORRECTION, 2026-08-28. An earlier version of this file said the MVP was "not
achievable from here, and no amount of trios work moves it". That is wrong,
and the owner was right to reject it. **The Queen IS trios.** Section 11 of the
document - mission contract, task graph, Bee result contract, acceptance
policy, competing proposals - is entirely work in this repository, and the
whole Queen/Bees section of the Definition of Done, 6 of its 29 criteria, is
implemented here and nowhere else. The gap table's P0 row "Queen/T27 bridge -
[not demonstrated]" names a trios deliverable.

Measured against the live registry the same day, that row is also out of date:
the Queen has delegated 10 tasks carrying a `.t27` owned path, and #1280 on
`rings/T27-00/queen_core.t27` reached `accepted`. The bridge is partly
demonstrated. What is missing is narrower and nameable:

| section 11 | state |
|---|---|
| 11.1 machine-readable mission contract | absent - nothing in `rings/`, no `.trinity/missions` |
| 11.3 structured Bee result | none of its eight fields exist; the registry has `committedFiles` and `committedSHA` |
| 11.4 T27-aware acceptance | a `.t27` spec is accepted exactly like a Swift file - nothing checks it still lowers |

That third row is the bridge, and `make t27-lowering` already performs the
checks it needs. It is simply never consulted when the Queen accepts.

What genuinely is not ours is narrower than I claimed: the semantic stage, the
versioned IR and the compiler's diagnostics live in `gHashTag/t27`; the
Playground has no owner and no code. Those do not move from here. The Queen
half does, and it is the half this document's section 11 is about.

Everything below is about A.

## The measurement

```
git rev-list --count origin/dev..HEAD   ->  978   (ahead)
git rev-list --count HEAD..origin/dev   ->   17   (behind)
git merge-tree --write-tree origin/dev HEAD | grep -c '^CONFLICT\|<<<<<<<'  ->  569   (conflicts)
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
trios/agent-server         on dev:    0 files    on this branch: 1593
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
Bounded and countable, which 978 commits of conflict output is not.

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

## The second blocker, closed 2026-08-29: the wedge was a backtick

The version of this page dated 2026-08-28 reported `make check` as an open
blocker. Its evidence, all of it real: a run stopped by hand after one hour
eight minutes; the whole run reducible to one `/bin/bash` child of `make`,
57m42s old, in state `S`, whose argv was the `cassettes` lock-acquisition
prologue; that child having no children at all - no `sleep`, no `cat`, no
`mkdir` - while the lock file did not exist, a probe `mkdir` on `/tmp`
answered in milliseconds, and `/tmp` itself was fine. The page read all that
as "blocked in a syscall", called it the same system-layer anomaly the status
board had recorded, and prescribed root-level tracing as the next step.

The layer was wrong. Root-caused one day later, in commit 4d56070ef
(2026-08-29, "fix: the 'system-layer exec anomaly' was a backtick in a
comment"), which is an ancestor of this branch:

The lock-acquisition prologue opens with a `: "..."` line that reads exactly
like a shell comment. It is not one. The quoted prose mentioned `make check`
inside backticks, and backticks inside a double-quoted shell word are command
substitution: that line re-entered `make check`, a target that depends on
`cassettes`, which runs the same line again. A recursion, terminated only by
whatever the harness lock did that day; when the lock was changed from
fail-fast to WAIT, the terminator went with it and the recursion became a
permanent hang. Every symptom the old page measured follows from that line
and from nothing else: the recipe's first echo never printed because the
shell never left the `:` line; it "wedged with the lock free" because it was
never waiting on the lock; `TRIOS_SKIP_LOCK` did nothing because its branch
sits downstream of the line that never returns; and the wedged shell "had no
sleep child" because the child was a nested make. Fourteen waves chased it as
a system-layer defect; the evidence was right, the layer was wrong.

The defect now has a standing gate. `recipe-backticks` (declared `.PHONY` at
trios/Makefile line 1448, defined at line 1449) fails on any backtick
surviving a recipe line once shell comments and single-quoted spans are
removed, and `check:` carries it among its prerequisites at trios/Makefile
line 2024. Prose in a recipe is code, and the gate says so permanently.

Nothing on the gate's present state is asserted first-hand here: the author
of this correction had no `make` to run. The record that the wedge is dead is
trios/.trinity/dashboard/STATUS.md, lines 67 through 75 - "make cassettes ->
fast honest verdict since the ROOT-CAUSE FIX (commit 4d56070ef, 2026-08-29)",
"the wedge is dead (verdict in ~2 min, was 26+ min)" - which also records
four real cassette-suite failures newly VISIBLE now that the target's output
can be seen at all. Those are suite findings for their own issue, not lock
findings and not a wedge.

The root-level tracing step the old page prescribed is retired with the
defect it was meant to diagnose. Do not reach for system tools on a closed
defect; re-run the measurement instead.

## What is NOT blocking

- trios' cheap gates (measured 2026-08-28; not re-run for the 2026-09-03
  correction, which had no `make` available). `t27-lowering`, `t27-rings` and
  `chain` all pass on demand, in seconds to minutes, outside the full walk.
- trios' own code. Only 27 conflicted files in `rings/` and 43 in `BR-OUTPUT/`,
  against 982 in the two runtime copies.
- The 85 unpushed commits. They push cleanly to the feature branch; they simply
  do not reach `dev`.

## How to re-measure

```bash
cd "$(git rev-parse --show-toplevel)"
git fetch origin dev
git merge-tree --write-tree origin/dev HEAD > /tmp/mt.out
grep -c '^CONFLICT\|<<<<<<<' /tmp/mt.out
git ls-tree -r --name-only origin/dev -- packages/browseros-agent | wc -l
git ls-tree -r --name-only HEAD -- trios/agent-server | wc -l
```

The five numbered claims above - ahead, behind, conflicts, dev-agent-files,
branch-agent-files - are re-measured against this working tree in one command:

```bash
node trios/tools/release-blocker-recheck.mjs
```

It exits zero and prints `[recheck] OK` when the page still agrees with the
repository; it exits non-zero with one line per drifting claim when it does
not; and a deleted claim line is reported as `MISSING`, so removing a
sentence is not a route to green. When it cannot measure - a ref that does
not resolve, a git too old for `merge-tree --write-tree` - it prints
`cannot measure` and no verdict at all. It is deliberately not wired into
`make` or any CI workflow: this page's counts decay by design, and a decaying
number must not be able to turn a release gate red. It is a reader's tool,
run on demand.

A long-lived branch's conflict count grows on its own. This number will be
worse next week than it is today, and that is the argument for deciding soon
rather than deciding well later.
