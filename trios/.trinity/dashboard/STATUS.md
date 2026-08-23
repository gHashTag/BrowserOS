# Status board

Regenerate this from measurement at the start of every round. Every number
below carries the command that produced it, so the next reader can re-run it
rather than trust it. A number without a command is a rumour.

Last measured: 2026-08-23.

## MVP, against section 23 of Queen_T27_MVP_Architecture.md

**0 of 29 criteria done. 17 partial, 12 not started.**

No adversarial challenge ran against any "done" claim, because no section
produced one.

| Section | done | partial | not started | of |
|---|---:|---:|---:|---:|
| Queen and bees | 0 | 6 | 0 | 6 |
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
make check                  -> REAL_EXIT=0
make t27-lowering           -> counts declared vs emitted functions, per spec
make t27-rings              -> ring00_parity, ring01_rules, ring00_verilog
make chain                  -> 80 verdicts, spec and hand-written Swift agree
curl -s 127.0.0.1:9105/health
python3 -c "import json;from collections import Counter;print(Counter(t.get('state') for t in json.load(open('.trinity/state/queen_delegation.json')) if isinstance(t,dict)))"
```

Mesh ring, the seven specs repaired today: 91 functions declared, 91 emitted,
0 stubs, artifacts byte-identical to a fresh `gen-rust`.

Corpus-wide, which is a different and worse number: 12 of 68 mesh artifacts
are byte-identical to a fresh `gen-rust`; 56 differ, so most committed
artifacts are stale relative to their spec.

**50 of 70 generated Rust files compile; 20 do not.** Counting functions is
necessary and not sufficient - four specs keep every function and lose whole
`return` statements inside them, so the count stays right while the code stops
meaning anything. `make t27-lowering` now compiles the output too, against a
ceiling of 20 that may fall and must not rise.

## How to update this

Run the commands above and rewrite the numbers. Do not carry a figure forward
because it was true last time — every restated list in this repository has
gone stale, and that is the defect this file exists to avoid.
