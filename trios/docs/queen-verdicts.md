# Queen Verdicts — Which Judgements the Queen Reaches Alone

Issue: gHashTag/trios#1095 · Parent: #1090

## What this document is

A description of the three verdicts the Queen can record for each
acceptance criterion, and the line between a verdict she can reach on
evidence alone and one that requires human judgement.

It mirrors `QueenCriterionVerdict` and `QueenAcceptancePolicy`
(`rings/SR-00/QueenCriterionVerdict.swift`). The companion document
[`queen-review-gate.md`](queen-review-gate.md) describes how verdicts
gate acceptance; this document focuses on **which verdicts exist and
when the Queen may set them without asking**.

## The three verdict states

Every acceptance criterion carries exactly one verdict:

| Verdict | Symbol | Meaning |
|---------|--------|---------|
| `.met` | `[x]` | The criterion was satisfied. |
| `.unmet` | `[ ]` | The criterion was examined and is not satisfied. |
| `.unchecked` | `[?]` | Nobody recorded a verdict. The criterion was never answered. |

Three states, not two. "Not checked" is the one that matters: collapsing
it into "not met" makes an unexamined criterion look examined, and
collapsing it into "met" is how work gets accepted on a glance. The
whole reason the specification exists is to stop completion being
asserted in one sentence, and a two-state verdict quietly restores that.

A missing entry in `criterionVerdicts` reads as `.unchecked` rather than
being dropped — a criterion nobody answered still appears in the table,
or the table silently shrinks to the questions that were convenient.

## What the Queen can decide without asking

Some criteria are settled by fact rather than opinion.
`QueenAcceptancePolicy.mechanicalVerdicts` reads the criteria and the
list of changed paths on the branch and produces a verdict for any
criterion that names a file path.

### How it works

1. Each criterion is scanned for tokens that look like file paths — a
   string containing both `/` and `.` (e.g. `docs/queen-verdicts.md`).
2. The changed-paths list (what the worker's branch actually carries)
   is normalised: leading `./` and `/` stripped.
3. If any mentioned path matches a changed path, the criterion is `.met`.
4. If a criterion names a path but none of the mentioned paths appear in
   the changes, the criterion is `.unmet`.
5. A criterion that names **no** path gets no entry at all — it stays
   `.unchecked`, keeping acceptance blocked on exactly the questions a
   person still has to answer.

### Examples

| Criterion | Changed paths | Mechanical verdict |
|-----------|---------------|---------------------|
| `docs/queen-verdicts.md exists` | `["docs/queen-verdicts.md"]` | `.met` |
| `docs/queen-verdicts.md exists` | `["README.md"]` | `.unmet` |
| `The code compiles without warnings` | `["src/main.swift"]` | no entry (stays `.unchecked`) |
| `Tests cover the new function` | `["src/main.swift", "tests/MainTests.swift"]` | no entry (stays `.unchecked`) |

A worker stating that it met a criterion is not a check — it is the same
agent grading its own homework, and a gate that accepts that is
decoration. But "this file exists" is answered by what the branch
actually carries, and that is the verdict `mechanicalVerdicts` delivers.

The point is not to unblock the gate; it is to stop it blocking on
things nobody needed to be asked.

## What stays `.unchecked`

Any criterion that does not name a file path cannot be answered
mechanically. These remain `.unchecked` until the Queen (or a human)
records a verdict through `recordVerdict`. Examples:

- "The code compiles without warnings."
- "Tests cover the new function."
- "The UI renders correctly in dark mode."
- "No existing tests broke."

These require running a build, reading test output, or exercising the
application — none of which a path check can answer. The Queen is not
blocked from recording a verdict on them; she simply cannot do it from
file-list evidence alone. She must read the worker's output, run the
checks, or ask a human.

## How verdicts gate acceptance

`QueenAcceptancePolicy.acceptanceBlockReason` returns a reason string
(or nil) based on the verdict table:

- **Any criterion `.unmet`** → acceptance blocked. Lists every unmet
  criterion. Reported first.
- **Any criterion `.unchecked`** (and none `.unmet`) → acceptance
  blocked. Lists every unchecked criterion with the note "An unchecked
  criterion is not a pass."
- **All criteria `.met`** (or no criteria set) → `nil`. Nothing blocks
  acceptance. The Queen may mark the task `.accepted`.

Only when `acceptanceBlockReason` returns `nil` does the Queen transition
the task from `.awaitingReview` to `.accepted`.

## How verdicts are recorded

| Method | Who calls it | What it does |
|--------|-------------|--------------|
| `QueenAcceptancePolicy.mechanicalVerdicts(criteria:changedPaths:)` | The review pipeline, automatically | Returns a verdict for each path-naming criterion based on changed paths. |
| `QueenDelegationRegistry.recordVerdict(taskID:criterion:verdict:)` | The Queen (or a human via `/verify`) | Records a verdict for one criterion. Returns `false` if the criterion text does not match any criterion on the task — a typo is refused rather than quietly filed under a requirement that does not exist. |
| `QueenAcceptancePolicy.verdicts(criteria:recorded:)` | Any consumer | Merges recorded verdicts with mechanical verdicts, filling gaps with `.unchecked`. |

Mechanical verdicts and manually recorded verdicts share the same
dictionary (`criterionVerdicts`). A manual recording overrides a
mechanical one if the same criterion is set twice — the last write wins,
which is correct because the human always has the final word.

## Path-matching rules

`pathsMentioned(in:)` splits the criterion on spaces, commas, and
semicolons, strips surrounding punctuation (`\` ' " . : ( )`), and
keeps only tokens that contain both `/` and `.` and do not end with
`/`. This is deliberately narrow:

- `docs/queen-verdicts.md` → matched (has `/` and `.`)
- `docs/queen-verdicts` → not matched (no `.`)
- `README` → not matched (no `/`)
- `it is short` → not matched (names nothing checkable)

A wrong verdict is worse than an absent one, because the absent one still
stops the merge. The narrow filter ensures only things that genuinely
look like paths trigger a mechanical check.

## Code references

| Symbol | File | Role |
|--------|------|------|
| `QueenCriterionVerdict` | `rings/SR-00/QueenCriterionVerdict.swift` | The three-state enum. `met`, `unmet`, `unchecked`. |
| `QueenAcceptancePolicy.mechanicalVerdicts` | `rings/SR-00/QueenCriterionVerdict.swift` | Auto-verdict for criteria that name a file path. |
| `QueenAcceptancePolicy.pathsMentioned` | `rings/SR-00/QueenCriterionVerdict.swift` | Extracts path-like tokens from a criterion string. |
| `QueenAcceptancePolicy.verdicts` | `rings/SR-00/QueenCriterionVerdict.swift` | Merges recorded + mechanical verdicts, filling gaps with `.unchecked`. |
| `QueenAcceptancePolicy.acceptanceBlockReason` | `rings/SR-00/QueenCriterionVerdict.swift` | Returns the first reason acceptance is blocked, or nil. |
| `QueenAcceptancePolicy.table` | `rings/SR-00/QueenCriterionVerdict.swift` | Renders the verdict table for display. |
| `QueenDelegationRegistry.recordVerdict` | `rings/SR-02/QueenDelegationRegistry.swift` | Records a verdict for one criterion. Refuses unknown criterion text. |
| `DelegatedTask.criterionVerdicts` | `rings/SR-00/QueenDelegation.swift` | The persisted verdict dictionary, keyed by criterion text. |
| `QueenDelegationPolicy.normalizePath` | `rings/SR-00/QueenDelegation.swift` | Strips `./` and leading `/` from paths for comparison. |
