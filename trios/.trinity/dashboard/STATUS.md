# Status board

Regenerate this from measurement at the start of every round. Every number
below carries the command that produced it, so the next reader can re-run it
rather than trust it. A number without a command is a rumour.

Last measured: 2026-08-23.

## MVP, against section 23 of Queen_T27_MVP_Architecture.md

**2 of 29 criteria done** (re-classified 2026-08-27, wave 107, by the
loop's live evidence; was 0/17/12 on 2026-08-23). The two proven done,
both Queen/Bees, by live measurement rather than claim:
- "Every Bee task is bound to an issue and owned paths" - live
  delegations with criterion+boundary, waves 081-103;
- "Queen cannot accept required work without evidence" - the
  acceptance gate proven live AND closed by three independent defense
  layers (contract cache, terminality, judgement notice), waves 092-093.
Method note: a desktop re-classification against wave evidence, not a
per-criterion rerun; the remaining 27 keep their 17-partial/10-not
standing. No adversarial challenge has yet run against a Playground
or Language "done" claim - none exists to challenge.

| Section | done | partial | not started | of |
|---|---:|---:|---:|---:|
| Queen and bees | 2 | 4 | 0 | 6 |
| Verification | 0 | 4 | 2 | 6 |
| Release and research | 0 | 4 | 1 | 5 |
| Language and compiler | 0 | 2 | 4 | 6 |
| Playground | 0 | 1 | 5 | 6 |

"Partial" here usually means the mechanism exists and the gate around it fails
open, which is not the same as half done.

## The three gates that fail open

1. `t27c typecheck` prints `Typecheck FAILED (N errors)` and exits 0. Its only
   consumer, `suite.rs cmd_typecheck`, tests `if !st.status.success()`, so it
   can never fire. [t27]
2. `icarus-lowerable` answers `"lowerable": true` for a spec containing
   `match`, because the parser deleted the construct before the classifier
   looked. A gate that reads the AST cannot see a defect that acts on the AST. [t27]
3. No semantic stage exists between parse and codegen: all four `gen_*` entry
   points take the raw `&Node`. Undefined functions and variables are never
   reported. [t27]

All three are in `gHashTag/t27`, which this repository may not edit. Reported
as gHashTag/t27#2508.

## Measured here

```
make check-bypass          -> EXIT=0 x2: waves 090/091 AND 103 (daytime,
                              neighbour-edited tree; the anomaly swallowed
                              the lock line ~35 min, then released - both
                              walks self-completed at 25 [OK]):
                              the FIRST full single-pass walk in the
                              loop's history - cassettes 4/4 replays,
                              mutants caught 2 of 2, dev 199/199
                              warnings-zero - under the diagnostic lock
                              bypass. Plain `make check` still stops at
                              the lock phase while the system-layer
                              anomaly lives (it swallowed the line 26
                              minutes this run, then released): the
                              owner's root fs_usage is the cure; the
                              bypass is diagnostic and never for CI.
make t27-lowering           -> counts declared vs emitted functions, per spec
make t27-rings              -> ring00_parity, ring01_rules, ring00_verilog
make chain                  -> 80 verdicts, spec and hand-written Swift agree
curl -s 127.0.0.1:9105/health
python3 -c "import json;from collections import Counter;print(Counter(t.get('state') for t in json.load(open('.trinity/state/queen_delegation.json')) if isinstance(t,dict)))"
```

The staleness guard, measured 2026-08-24: the release store still reads
`treeStateFingerprint` on 0 of its tasks (the user's app predates the fix;
rebuilding it needs the owner's word), and 12 tasks carry no acceptance
criteria at all. The write path is now proven LIVE, not only in tests: a
running test-variant app recorded verdict `make check passes: met` and
fingerprint `9d26541f…` in its own store via one atomic command chain
(approve -> delegate --criteria -> verify; wave 081). The e2e wire proof
stands at 971/971 twice. The release number moves the first time the
user's app is rebuilt and a verdict is sealed there.

Mesh ring, the seven specs repaired today: 91 functions declared, 91 emitted,
0 stubs, artifacts byte-identical to a fresh `gen-rust`.

Corpus-wide (re-measured live 2026-08-27, wave 106): 22 of 68 mesh
artifacts are byte-identical to a fresh `gen-rust` (was 12 of 68 at the
board's founding); 46 differ, so most committed artifacts are still stale
relative to their spec - the regeneration decision is owner-gated.

**59 of 70 generated Rust files compile; 11 do not** (re-measured live
2026-08-28 by two independent methods - `--emit=metadata` and a full
`--crate-type lib` build - which agreed; was 50/20 at the board's founding and
57/13 before this wave). The two that healed did so for different reasons: a
wrong-arity call and a call to a name that exists nowhere were genuine spec
faults, while eighteen artifacts were simply stale July output and needed only
regenerating - cache_management alone went 27 errors to 6 with no spec change.

The remaining eleven are mostly NOT ours. The largest single cause is one
backend defect: t27c's gen-rust never emits `mut` on a function parameter,
although `collect_mutable_names` already computes the exact set and the local
path already consults it. Eight errors are that omission. Renaming parameters
or adding shadow locals would silence it while hiding a one-line fix from its
author, so it was left and recorded. `T27_NOCOMPILE_CEILING` is lowered 20 ->
11 to hold the ground.

## How to update this

Run the commands above and rewrite the numbers. Do not carry a figure forward
because it was true last time — every restated list in this repository has
gone stale, and that is the defect this file exists to avoid.
