# GOLDEN CHAIN Rebrand Skill
## Plan: Rebrand GOLDEN BRIDGE -> GOLDEN CHAIN + README Rewrite

## Core Insight
Mining $TRI tokens happens ONLY on TTSKY26b silicon chips (TinyTapeout).

"Chain" metaphor reflects:
1. **Blockchain** - hardware-verified chain of proof (Coq Qed. -> silicon anchor 0x47C0 -> GF16 Galois field)
2. **Lucas chain** - L_2=3 -> 0x47C0 anchor identity phi^2 + phi^-^2 = 3
3. **Honesty chain** - sharing what was tried and proven impossible (boundary theorems BT-1..BT-4) is itself proof

## Strong Side
"Ne dokazatelstvo - eto dokazatelstvo."
Boundary theorems formally prove which direct H4->SM paths do NOT work.
This is a permanent scientific asset, not a failure.

## Phase 1: Content Rewrite (no code changes)

### Files to Update
| File | Occurrences | Action |
|------|-------------|--------|
| README.md | ~15 | Full rewrite |
| docs/claims.yaml | ~3 | Rename entries |
| docs/TECH_TREE.md | ~4 | Update L6 layer |
| docs/CLAIM_STATUS.md | ~2 | Update framing |
| docs/REVIEW_GUIDE.md | ~2 | Update instructions |
| docs/REPOSITORY_MAP.md | ~1 | Update description |
| RESEARCH_STATUS.md | ~5 | Update references |
| SECURITY.md | ~1 | Update scope |
| CLAUDE.md | ~2 | Update skills |
| .claude/skills/golden-bridge/ | ~5 | Rename + update |
| games/trinity_fold/README.md | ~8 | Full rewrite |

## Phase 2: Game Code Rebrand
| File | Action |
|------|--------|
| games/trinity_fold/docs/GOLDEN_BRIDGE.md | Rename -> GOLDEN_CHAIN.md |
| games/trinity_fold/crates/ring4_canvas/src/bridge.rs | Rename module |
| games/trinity_fold/crates/ring4_canvas/src/lib.rs | Update docs |
| games/trinity_fold/crates/ring4_canvas/src/state.rs | Update naming |

## Phase 3: Validation
1. Run python3 scripts/anti_numerology_gate.py
2. Run python3 scripts/generate_claims.py --check
3. Build check: cd games/trinity_fold && cargo test --workspace
4. Search for remaining "GOLDEN BRIDGE" occurrences

## New README Positioning

Title: **Trinity S^3AI - Boundary-Mapping Research + Hardware-Verified Knowledge Chain**

Tagline: "We mine truth, not tokens. The $TRI chain is anchored in silicon."

### Key Narrative Shifts
1. OLD: "GOLDEN BRIDGE is a hypothesis-discovery puzzle, not evidence"
   NEW: "GOLDEN CHAIN is a hardware-verified proof chain. Every link is either a Coq Qed., a silicon anchor (0x47C0), or a documented boundary theorem."
2. OLD: "Boundary theorems are guideposts, not tombstones"
   NEW: "Boundary theorems are the strongest links - they prove what CANNOT be done, saving the field from wasted effort."
3. NEW: "Why $TRI is mined only on TTSKY26b"
   - GF16 is the 16-bit rung of the GoldenFloat ladder, implemented in RTL and validated on
     TTSKY26b
     - [Retracted 2026-08-02] this line previously read "GF16 (4-bit Galois field) is optimal
       numeric format per BPB benchmarks". Wrong three ways, and it is a directive for PUBLIC
       README text, so it must never be restored. (1) GF16 is NOT a "4-bit Galois field" -- it
       is the 16-bit rung of the GoldenFloat ladder. (2) The optimality claim contradicts the
       canon's own non-promotion invariant and its governing sentence, "The goldenfloat ladder
       earns its place through breadth and toolchain coherence, NOT through per-rung
       superiority." (3) The "BPB benchmarks" appealed to are the IGLA RACE v2 frozen table,
       retracted 2026-08-02: no row can be re-derived, because checkpoint::save was a stub
       returning Ok(()), the eval returned 0.0 and f32::MAX sentinels in the same channel as
       real readings and laundered NaN into a finite value, and the train/val disjointness
       check scanned step_by(256). Claim no per-rung optimality here or anywhere.
   - 0x47C0 silicon anchor validates Lucas chain L_2=3 at reset
   - Euler crown (#4915) carries GF(16) arithmetic
   - No generic CPU can reproduce phi-structured arithmetic efficiently `[Open conjecture]`
     - tagged 2026-08-03: this is an UNMEASURED performance assertion sitting in PUBLIC-facing
       copy. No benchmark in this stack compares a generic CPU against TTSKY26b on
       phi-structured arithmetic. Do not emit it as a statement of fact; either measure it, or
       carry the `[Open conjecture]` tag into the README text itself.

   **HARD RULE (2026-08-03) - scope every claim of this kind that this skill emits.**
   This skill emits PUBLIC README copy, so a false claim here is falsifiable by anyone who
   clones the repo. The cross-architecture workflow has now measured the boundary TWICE
   `[n = 2 as of 2026-08-05 - this block previously treated it as a single run]`, on two
   different source states, with the same verdict, both public and both RED BY DESIGN (the job
   asserts a cross-architecture byte-identity the method does not claim):
   - run 31004703001, head `ba272b9`, 2026-08-05, conclusion `failure`
   - run 30767491098, head `3c1f751c`, 2026-08-02, conclusion `failure`

   Quote it as an upgrade: measured twice, two source states, publicly, same verdict.
   Run 30767491098 (gHashTag/trios-trainer-igla) trained the documented seed
   on x86_64 linux and compared the 852272-byte checkpoint against the aarch64 macos reference:
   - x86_64 linux : `bb14ab18f2c8e7a9a4c19f452471018f3a72cc18765175db44858c2c4e5c03f3`
   - aarch64 macos: `8a86fe691aef64fcb637b90d4cf62650c217c3b000b6252846a8ab70c186012c`

   Same pinned compiler (`rust-toolchain.toml` 1.96.0), same `--locked` dependency graph, same
   hash-verified corpora.

   Do NOT write "the only variables left were CPU architecture and OS" - that is superseded and
   weaker than what is now measured `[2026-08-05, docs/DIVERGENCE-LOCALIZATION.md]`. The step-0
   checkpoint is BYTE-IDENTICAL across instruction sets
   (`4f854c82177fadc41de92f754884dd290f0bbc426916dc840f499bafa66d5457`, 852272 bytes, both
   ISAs), so init and RNG are EXONERATED and the divergence is introduced by training-loop
   ARITHMETIC within ten gradient steps. The step-10 pair `efef1cba...` (aarch64) against
   `5913542e...` is a ROSETTA x86_64 comparison with the OS held fixed; the x86_64 LINUX step-10
   hash is `a32e9b2a...`, and the repository's own docs decline to attribute the difference
   between it and `5913542e...`, that pair being uncontrolled. Carry the scope word. Therefore:
   1. NEVER emit the word "reproducible" or "bit-reproducible" about the trainer, the
      checkpoint, or the GOLDEN CHAIN without a scope attached. Unqualified, it is a known-false
      statement about this artifact.
   2. The only permitted form is "bit-reproducible on a fixed architecture and OS" (or the
      equivalent naming `macos/aarch64` plus runs 30767491098 and 31004703001 as the measured
      boundary, n = 2).
   3. The repo description string "Reproducible on any machine + Railway" is known-false as
      measured. It is to be CORRECTED, never copied forward into new brand copy.
      `[UNACTIONED as of 2026-08-05 - re-verified live.]` `gh repo view --json description` on
      gHashTag/trios-trainer-igla still returns
      "Single source of truth for IGLA RACE training pipeline. Reproducible on any machine +
      Railway. Anchor: phi^2 + phi^-2 = 3". The string is unchanged since this rule was written,
      and it is now contradicted by TWO failing runs in the same repository's own Actions tab
      (30767491098 and 31004703001). A counterparty who reads the description and then opens
      Actions finds the contradiction in two clicks. This is a one-line fix the user must make
      himself - do not edit the repo description from an agent.
4. NEW: "Our Honest Model - Impossibility as Proof"
   - 5 real Admitted. - all honestly tagged
   - 14 refutation theorems (*_refuted)
   - 4 boundary theorems (BT-1..BT-4)
   - 0 fake proofs, 0 cosmetic edits

### Tech Tree Update
L6 becomes "GOLDEN CHAIN Game" - "hardware-verified hypothesis chain"