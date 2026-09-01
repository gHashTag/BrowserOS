# Status board

Regenerate this from measurement at the start of every round. Every number
below carries the command that produced it, so the next reader can re-run it
rather than trust it. A number without a command is a rumour.

Last measured: each figure carries its own date inline (2026-08-27 through
2026-09-01).

## MVP, against section 23 of Queen_T27_MVP_Architecture.md
(now in-repo at `docs/architecture/Queen_T27_MVP_Architecture.md`,
3261 lines, since commit 6d1d50656; the 2026-08-27 re-classification
below read the ~/Downloads original - same document, moved not rewritten)

**3 of 29 criteria done** (re-classified 2026-09-01, wave 118, against
the in-repo arch doc's section 23; the 2026-08-27 pass (wave 107) read
the ~/Downloads original; was 0/17/12 on 2026-08-23). The three proven
done, all Queen/Bees:
- "Every Bee task is bound to an issue and owned paths" - live
  delegations with criterion+boundary, waves 081-103;
- "Queen cannot accept required work without evidence" - the
  acceptance gate proven live AND closed by three independent defense
  layers (contract cache, terminality, judgement notice), waves 092-093;
- "Worker result is structured" (closed 2026-09-01, wave 118) - the
  bee's turn ends in a "## VERDICT" block the round parses
  (queen-tick.ts:1329-1333), pinned by 11 parser tests
  (tests/api/verdict-block.test.ts) incl. last-block-wins and
  colon-bearing criteria; the long-line loss class was found and fixed
  in the wild (a8df984af); the Swift side carries QueenBeeResult as a
  Codable struct (rings/SR-00/QueenBeeResult.swift:40). Verified by
  direct file read this wave; the test suite was not rerun by this loop
  (method note below).
Method note: a desktop re-classification against wave evidence, not a
per-criterion rerun; the remaining 26 keep their 16-partial/10-not
standing. No adversarial challenge has yet run against a Playground
or Language "done" claim - none exists to challenge.

| Section | done | partial | not started | of |
|---|---:|---:|---:|---:|
| Queen and bees | 3 | 3 | 0 | 6 |
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
make cassettes            -> fast honest verdict since the ROOT-CAUSE FIX
                              (commit 4d56070ef, 2026-08-29): the
                              14-wave "system-layer exec anomaly" was a
                              BACKTICK in a `: "..."` comment - `make
                              check` inside backticks ran as command
                              substitution from the lock recipe line, the
                              exact phantom subshell our waves 069-076
                              measured. Evidence right, layer wrong. The
                              wedge is dead (verdict in ~2 min, was
                              26+ min); 4 of 5 replays fail on one real
                              cause (diagnosed in commit aa3b6fc14, fix
                              in flight). The old EXIT=0 x2 walks (090/
                              091, 103) stand as history - they ran under
                              the diagnostic bypass, now obsolete:
                              the FIRST full single-pass walk in the
                              loop's history - cassettes 4/4 replays,
                              mutants caught 2 of 2, dev 199/199
                              warnings-zero - under the diagnostic lock
                              bypass (its names and targets are dead
                              history now; deleting them is the owner's
                              call). Plain `make check` no longer wedges
                              either: the cassettes step returns the same
                              ~2-min verdict, and what is red there is
                              the SAME four real failures - not the lock
                              (corrected 2026-09-01: an earlier edit
                              left this tail saying fs_usage was still
                              the cure after the root cause above it).
make t27-lowering           -> counts declared vs emitted functions, per spec
make t27-rings              -> ring00_parity, ring01_rules, ring00_verilog
make chain                  -> 80 verdicts, spec and hand-written Swift agree
make test / make mutants    -> RESURRECTED 2026-09-01, waves 126-129
                              (was dead since the QueenCore module split
                              12b97dedc, found wave 120). Four causes,
                              each measured: (1) the script built rings
                              as one module - fixed by the build.sh
                              pattern (fresh module emit + QUEEN_CORE
                              filter + -I, wave 126); (2) the #1172
                              drill pinned a record the policy move
                              retired - aligned, wave 127; (3) the global
                              git executor silently re-rooted scratch
                              projectRoots - fixed at repositoryRoot,
                              12 reds healed, wave 128; (4) two checks
                              pinned the zod-stripped `messages` key -
                              aligned to userSystemPrompt, wave 129.
                              Final state MEASURED: 972 of 972 checks
                              green (floor 962), and registry row 22
                              (QueenReviewDecision.decide) driven and
                              CAUGHT (failed twice). Latent notes: the
                              11-vs-15 module list disagreement
                              (build.sh vs Makefile) and the toolchain
                              flag mandate stand (see below).
                              mutants-logic measured GREEN wave 122
                              (2 of 2 caught) after refreshing the stale
                              .trinity/build/QueenCore module - it was
                              built by Swift 6.0.3 (build.sh run, Aug 31)
                              while the logic suites compile with the
                              default 6.3.3; a toolchain disagreement
                              between build.sh and the suite compiler
                              will re-break this gate on the next app
                              build. Cause sharpened wave 124: nothing
                              pins a toolchain - the SYSTEM updated
                              6.0.3 -> 6.3.3 mid-day (documented at
                              build.sh:397) and the old toolchain is
                              gone; only a future system update re-arms
                              the mine. Consumers audited: exactly two
                              (build.sh:606 producer+app,
                              clade-e2e:1140 suites). Structural cure,
                              VALIDATED in a temp dir wave 124: add
                              `-enable-library-evolution
                              -emit-module-interface-path
                              $QUEEN_CORE_DIR/QueenCore.swiftinterface`
                              to the emit at build.sh:607 - the
                              .swiftinterface pair emits clean (0
                              errors) and a consumer typecheck passes;
                              per Swift module stability a newer
                              compiler imports the older-built
                              interface, exactly the failing direction.
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

LIVE-VERIFY CHAIN DOWN (measured wave 125, 2026-09-01): the ninth
reproduction attempt did NOT run - the prebuilt test bundle (Aug 31
19:17) crashes at launch in the #1172 boundary-parse drill
(trios_test_app/ChatViewModel.swift:13114, fatal by design: "the
prose-after-path replay did not come out as the record says") because
the tree MOVED after that build (the neighbour's evening series). The
eight prior reproductions stand (fp 9d26541f each). Rebuilding the
bundle rides tests/swift/run_chat_sse_e2e.sh - the same script dead
since the QueenCore module split (see the oracle note above): one fix
unblocks the mutants gate, make test, AND the live regression ritual.

Mesh ring, the seven specs repaired today: 91 functions declared, 91 emitted,
0 stubs, artifacts byte-identical to a fresh `gen-rust`.

Corpus-wide (re-measured live 2026-09-01, wave 117): 29 of 68 mesh
artifacts are byte-identical to a fresh `gen-rust` (was 22 of 68 on
2026-08-27, 12 of 68 at the board's founding - the neighbour's weekend
submodule repairs moved it +7); 39 differ, so most committed artifacts are
still stale relative to their spec - the regeneration decision is
owner-gated.

**59 of 70 generated Rust files compile; 11 do not** (re-measured live
2026-09-01, wave 117 - count and spec list identical to the 2026-08-28
measure, EXIT=0; full `--crate-type lib` build. `--emit=metadata`, which the
gate used until today, does not run the MIR const-prop lint and hides every
`arithmetic_overflow`: olsr_routing reports 13 errors under metadata and 26
under a full build. It happens not to change WHICH specs fail today, because
no spec fails on overflow alone - but the gate now uses the full build, since
a number that agrees only by luck is not a measurement; was 50/20 at the board's founding and
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

TWO t27 populations, never merged (split recorded 2026-09-01 from the
neighbour's measurement, commit 5d837a855): every number above is the
trios-mesh SUBMODULE corpus. The rings specs are a population of three:
`rings/T27-00/queen_core.t27` (209 lines, 7 rules) and `rings/T27-01/a2a.t27`
(223 lines) exist; T27-02 (the Queen tick) does not; zero generated .rs
under T27-* and no Rust crate hosts any of it - the supervisor instead lives
in `queen-tick.ts` (1551 lines) plus the Swift `queend`, with
`can_start_another` present in BOTH `queen_core.t27:198` and
`QueenDelegation.swift:472` (agreeing today; the two-languages state the
generation law exists to prevent). t27c is NOT the blocker for this
population - run on the RING-00 decision core it exits 0 and emits 121 lines
of Rust. Ring work also cannot be delegated to a cloud bee: the bee image is
oven/bun with git and queend - no Swift, no Rust, no t27c.

## How to update this

Run the commands above and rewrite the numbers. Do not carry a figure forward
because it was true last time — every restated list in this repository has
gone stale, and that is the defect this file exists to avoid.
