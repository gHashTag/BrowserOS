# Proposal: Specification as a Pinned Header

Issue: gHashTag/trios#1093 · Parent: #1090

## Problem

`QueenBriefing.text(for:)` sends the specification as the first message
in the worker's chat (`QueenTaskSpec.render`). After twenty turns of
conversation, that message has scrolled out of view. The Queen cannot
accept or reject work without seeing the criteria — and the criteria
table (`QueenAcceptancePolicy.table`) is only emitted as text inside
`postQueenNotice` messages at accept/reject time, never as a permanent
surface.

## What already exists

| What | Where | Why it matters |
|------|-------|----------------|
| `QueenTaskSpec.render(for:)` | `rings/SR-00/QueenTaskSpec.swift` | Produces the full spec text (intent, criteria, boundary, scope, verification). Already exists. |
| `QueenAcceptancePolicy.verdicts(criteria:recorded:)` | `rings/SR-00/QueenCriterionVerdict.swift` | Returns `[(criterion, verdict)]` — the exact rows a criteria table needs. |
| `QueenAcceptancePolicy.acceptanceBlockReason(...)` | same file | Returns the first unmet/unchecked criterion as a string, or nil. |
| `DelegatedTask.acceptanceCriteria` / `.criterionVerdicts` | `rings/SR-00/QueenDelegation.swift` | The data model holds both the criteria list and the per-criterion verdicts. No new storage needed. |
| `QueenTaskBanner` | `BR-OUTPUT/QueenTaskStatusView.swift` | A pinned banner above the worker's chat — shows status, branch, metrics, accept/reject buttons. Already in the right place on screen. Does **not** show criteria or verdicts today. |

## Proposal: extend the existing banner

**Who reads it:** the Queen — she evaluates each criterion to accept or
reject the worker's output.

`QueenTaskBanner` is already pinned above the chat transcript. It is the
natural home for the criteria table — no new layout slot, no new
positioning logic.

### What the banner shows after the change

```
┌──────────────────────────────────────────────────────────────┐
│ ● Needs review   gHashTag/trios#1098   bee-2                  │
│ branch: ring-1098   owns: rings/SR-02   3 files · 0.4k tok    │
│                                                              │
│ Criteria                                                     │
│ [x] 1. Transition fires objectWillChange on the view model  │
│ [ ] 2. Strip shows Working without reload                   │
│ [?] 3. Compact bar collapses at <760pt                      │
│                                                              │
│ ⚠ 1 criterion was not met: Strip shows Working without reload│
└──────────────────────────────────────────────────────────────┘
```

- **Criteria rows**: iterate `QueenAcceptancePolicy.verdicts(...)` — the
  same function the text table uses. Each row shows the verdict symbol
  (`QueenCriterionVerdict.symbol`: `[x]`, `[ ]`, `[?]`) and the
  criterion text.
- **Block reason**: if
  `QueenAcceptancePolicy.acceptanceBlockReason(...)` returns non-nil,
  show it as a warning line below the criteria. This is the "what
  blocks acceptance" line the issue asks for — visible at a glance,
  without running `/verify`.
- **No spec prose**: the full `QueenTaskSpec.render(...)` text (intent,
  boundary, scope, verification) is long. The banner shows only the
  criteria + verdicts — the contract the Queen reviews against. The
  full spec stays in the first chat message for anyone who scrolls up.

### Why not a separate panel

A second surface (sidebar tab, drawer, popover) adds a layout problem
and a second source of truth for what is shown where. The banner is
already there, already pinned, already observed for liveness. Adding
criteria rows to it is additive: one new `VStack` section, same
lifecycle.

### Collapse behaviour

**The header collapses below 760pt.** At widths under 760pt (or when there are many criteria) the banner shows only a summary — a tap expands it to the full criteria list.

The existing banner is compact (one row of metrics). Adding criteria
rows risks growing it beyond the chat's visible area on a narrow panel.
Two states, matching the `QueenCompactSupervisorBar` pattern:

- **Collapsed** (default, <760pt or many criteria): show only the block
  reason or a summary like "2/3 met, 1 not checked". A tap expands.
- **Expanded**: show the full criteria list with per-row verdicts.

At any width the header sits in the same slot: pinned to the top of
the chat column, directly above the transcript scroll view. Narrow
widths do not move it to a sidebar, dock, or floating overlay — the
collapse above shrinks the content, not the position. Keeping the
banner in its existing top-of-column slot means there is one layout
context to test at every size, and the worker's chat input (the
bottom anchor) is never displaced by header growth or collapse.

## What the pinned header must never show

The banner is a status strip, not a second chat panel. The following
must never appear in it, at any width or collapse state:

- **Specification prose** — intent, boundary, scope, and verification
  sections stay in the first chat message. The banner shows only the
  criteria list and verdicts. Full prose would push the transcript out
  of view, which is the exact problem the pinned header exists to solve.
- **Chat messages or transcript excerpts** — the transcript scroll view
  sits directly below the banner. Mirroring messages into the header
  creates a second source of truth and duplicates what the worker
  already sees.
- **Source code, file contents, or diffs** — too dense for a compact
  strip. Code review happens in the diff viewer or the files on disk,
  not in a status header.
- **Worker reasoning or chain-of-thought** — intermediate output is not
  part of the acceptance contract. The banner shows verdicts against
  criteria, not the worker's narrative.
- **Unrelated task data** — the banner is scoped to one
  `DelegatedTask`. Metrics, criteria, or verdicts from other workers
  must not bleed into it.

## What does NOT change

- The spec is still sent as the first chat message. Workers still
  receive it in-stream. The banner is a review surface, not a
  replacement for delivery.
- `messages: [ChatMessage]` is not modified. Criteria and verdicts are
  read from `DelegatedTask`, not from the transcript.
- `QueenAcceptancePolicy` is not modified. The banner calls the same
  static functions the accept/reject path already calls.

## Wiring

```swift
// In QueenTaskBanner, below the metrics HStack:
if !task.acceptanceCriteria.isEmpty {
    VStack(alignment: .leading, spacing: 2) {
        ForEach(
            QueenAcceptancePolicy.verdicts(
                criteria: task.acceptanceCriteria,
                recorded: task.criterionVerdicts
            ),
            id: \.criterion
        ) { row in
            HStack(spacing: 4) {
                Text(row.verdict.symbol)
                    .font(.system(size: 10, design: .monospaced))
                Text(row.criterion)
                    .font(.system(size: 10))
                    .foregroundColor(.grokText)
            }
        }
        if let reason = QueenAcceptancePolicy.acceptanceBlockReason(
            criteria: task.acceptanceCriteria,
            recorded: task.criterionVerdicts
        ) {
            Text("⚠ \(reason)")
                .font(.system(size: 9))
                .foregroundColor(.orange)
        }
    }
}
```

The banner already receives `task: DelegatedTask`. No new data plumbing.
The registry's `@Published tasks` already drives the banner's redraw, so
a verdict recorded via `/verify` appears immediately.

## Summary

The data exists (`DelegatedTask.criterionVerdicts`). The policy exists
(`QueenAcceptancePolicy`). The pinned surface exists (`QueenTaskBanner`).
The work is rendering the criteria rows inside the banner — one view
section, no new types, no new data path.

The header must stay readable at every panel width: criteria rows use a
compact monospaced font, the block reason is a single line, and the
collapse states ensure the banner never grows taller than the visible
chat area.
