# Queen Spec Header — The Pinned Specification That Does Not Scroll Away

Issue: gHashTag/trios#1093 · Parent: #1090

## What this document is

A sketch of the specification header: the fixed surface above a
worker's chat that shows the task's acceptance criteria and their
verdicts at all times, so nobody has to scroll to the top of a
conversation — or run `/verify` — to see what done means and whether it
has been reached.

It mirrors the types already in the codebase:
`DelegatedTask.acceptanceCriteria` and `.criterionVerdicts`
(`rings/SR-00/QueenDelegation.swift`),
`QueenAcceptancePolicy.table` and `.acceptanceBlockReason`
(`rings/SR-00/QueenCriterionVerdict.swift`),
`QueenTaskSpec.render` (`rings/SR-00/QueenTaskSpec.swift`), and the
banner view that currently sits above the chat
(`BR-OUTPUT/QueenTaskStatusView.swift → QueenTaskBanner`).

The companion document
[`queen-verdicts.md`](queen-verdicts.md) describes the three verdict
states and how they gate acceptance. This document focuses on one
question: **how does the reviewer see the spec without scrolling?**

## The problem

When the Queen opens a worker's chat, the first message is the full
specification — intent, acceptance criteria, boundary, out of scope,
verification (`QueenTaskSpec.render`). It is a contract, not a greeting,
and it is written first so it appears first.

But a chat scrolls. By the time a worker has produced twenty messages of
output, the specification that defines done is above the fold only in
the first minute. After that, the reviewer reads the transcript and
judges against a contract they can no longer see. The worker's own
summary fills the gap, and a summary is the worker grading its own
homework — the exact thing `QueenAcceptancePolicy.mechanicalVerdicts`
was built to stop, but only at review time, not while the work is in
progress.

The existing `QueenTaskBanner` (pinned above the chat in
`FullscreenChatWorkspace`) shows the task's state, branch, owned paths,
committed file count, and spend. It does **not** show the acceptance
criteria or their verdicts. So the banner tells you *what this is and
whether it is running*; it does not tell you *what done means or whether
anything is blocking*.

## What already exists

| Piece | File | What it does |
|-------|------|--------------|
| `QueenTaskSpec.render(for:)` | `rings/SR-00/QueenTaskSpec.swift` | Produces the full specification text: intent, criteria, boundary, out-of-scope, verification. Posted as the first message in the worker's chat. |
| `DelegatedTask.acceptanceCriteria` | `rings/SR-00/QueenDelegation.swift` | The criteria list, written by the Queen when she opens the task. |
| `DelegatedTask.criterionVerdicts` | `rings/SR-00/QueenDelegation.swift` | Per-criterion verdict dictionary, keyed by criterion text. |
| `QueenAcceptancePolicy.verdicts(criteria:recorded:)` | `rings/SR-00/QueenCriterionVerdict.swift` | Merges recorded + mechanical verdicts, filling gaps with `.unchecked`. Returns ordered (criterion, verdict) pairs. |
| `QueenAcceptancePolicy.acceptanceBlockReason` | `rings/SR-00/QueenCriterionVerdict.swift` | Returns nil (nothing blocks) or a reason string listing every unmet or unchecked criterion. |
| `QueenAcceptancePolicy.table` | `rings/SR-00/QueenCriterionVerdict.swift` | Renders the verdict table as text: `[x] 1. docs/x.md exists` etc. |
| `QueenCriterionVerdict.symbol` | `rings/SR-00/QueenCriterionVerdict.swift` | `[x]` (met), `[ ]` (unmet), `[?]` (unchecked). |
| `QueenTaskBanner` | `BR-OUTPUT/QueenTaskStatusView.swift` | Pinned banner above the chat: state, branch, owned paths, committed files, spend. Does **not** show criteria or verdicts. |
| `FullscreenChatWorkspace` | `BR-OUTPUT/FullscreenChatWorkspace.swift` | Layout: sidebar + banner + chat panel. The banner sits between the conversation header and the chat, pinned, non-scrolling. |

All the data exists. All the rendering logic exists. The gap is a view
that puts them together in the pinned surface.

## The sketch

### Where it lives

The spec header is **not** a new location. It replaces or extends the
existing `QueenTaskBanner` — the pinned strip that already sits between
the conversation header and the chat in `ExpandedChatWorkspace`. Today
the banner has two rows: a status row and a metrics row. The sketch adds
a third element below them: the criteria-verdict strip.

```
┌──────────────────────────────────────────────────────────────────┐
│  ▶ Running   trios#1093   Doctor       Accept  Send back  Stop   │  ← status row (existing)
│  branch queen/1093-…   owns docs/   committed 2 files   ~$0.03   │  ← metrics row (existing)
│  ──────────────────────────────────────────────────────────────  │
│  [x] 1. docs/queen-spec-header.md exists                         │  ← criteria-verdict strip (NEW)
│  [?] 2. Each criterion has a verdict next to it                  │
│  [?] 3. Block reason visible without /verify                     │
│  ⚠ 2 criteria never checked — an unchecked criterion is not a   │  ← block-reason line (NEW)
│    pass                                                          │
└──────────────────────────────────────────────────────────────────┘
│                                                                  │
│  (chat transcript scrolls below this line)                       │
│                                                                  │
```

### What it shows

The criteria-verdict strip has three parts, each drawn from existing
logic:

**1. The verdict table.** Each criterion on its own line, prefixed with
its verdict symbol. The data comes from
`QueenAcceptancePolicy.verdicts(criteria:recorded:)` — the same function
`/verify` uses — so the header and the command can never disagree. If
no criteria were set, the strip shows the same "No acceptance criteria
were set" message that `QueenAcceptancePolicy.table` returns, rather
than hiding the absence.

**2. The block reason.** A single line below the table, drawn from
`QueenAcceptancePolicy.acceptanceBlockReason`. If it returns `nil`,
nothing appears — the absence of a warning is the signal that nothing
is blocking. If it returns a reason, the line shows the count and lists
the criteria, the same way `/verify` would.

The block reason is the thing that makes `/verify` redundant for the
common question "is this ready?" The reviewer reads the line; if it is
absent, the work is judged ready; if it is present, the reason is right
there. Running the command is still needed to *record* a verdict, but
seeing the state no longer requires it.

**3. The verdict colour.** Each criterion's symbol carries its
`QueenTaskStyle` colour: green for met, red for unmet, grey for
unchecked. This is the same palette the status pill and the sidebar
use, so a green checkmark means the same thing everywhere.

### How it stays current

The strip reads from the live `DelegatedTask` object, the same one
`QueenTaskBanner` already receives as a property. When the Queen records
a verdict via `/verify`, `QueenDelegationRegistry.recordVerdict` mutates
`task.criterionVerdicts`, and the view updates on the next observation
cycle. No new data pipeline is needed — the registry already publishes
changes that the banner observes.

Mechanical verdicts (from `QueenAcceptancePolicy.mechanicalVerdicts`)
are computed at review time from the branch's changed paths. While the
worker is still running, criteria that name file paths will read
`.unchecked` because the review pipeline has not yet run. This is
correct: the strip shows what is *known*, not what is *guessed*, and a
running worker's files are not yet committed for comparison.

### Compact mode

In compact mode (narrow panel), the criteria-verdict strip collapses to
a single summary line:

```
⚠ 1 unmet, 2 unchecked — tap to expand
```

or, when nothing blocks:

```
✓ 3 criteria, all met
```

This mirrors the pattern of `QueenCompactSupervisorBar` — the narrow
view says the minimum, the expanded view says everything.

## What does not change

- **`QueenTaskSpec.render`** still produces the full specification text
  for the first chat message. The header is a live view of the criteria
  and verdicts, not a replacement for the written contract. The worker
  still reads the full spec on arrival; the header is for the reviewer
  who arrives later.

- **`/verify`** still works exactly as before. It records verdicts and
  computes mechanical ones. The header reads the result; it does not
  produce it. Removing the command is out of scope — the header makes
  it *unnecessary for reading*, not *unnecessary for writing*.

- **`QueenAcceptancePolicy`** is unchanged. All the logic — verdict
  merging, block-reason computation, table rendering — is reused
  verbatim. The header is a SwiftUI view that calls existing functions
  and displays their output.

## The gap this closes

Without the spec header, the only ways to see acceptance criteria are:

1. Scroll to the top of the chat (lost after a few messages).
2. Run `/verify` (which computes and displays verdicts but is a command,
   not a persistent view).

With the header, the criteria and their verdicts are visible at all
times, in the same pinned surface that already shows the task's state
and metrics. The reviewer sees what done means without scrolling, sees
each criterion's verdict next to it, and sees the block reason without
running anything.

## Code references

| Symbol / View | File | Role |
|---------------|------|------|
| `QueenTaskBanner` | `BR-OUTPUT/QueenTaskStatusView.swift` | The pinned banner to extend. Currently shows state + metrics; criteria strip is added below. |
| `QueenTaskSpec.render` | `rings/SR-00/QueenTaskSpec.swift` | Renders the full spec as the first chat message. Unchanged. |
| `DelegatedTask.acceptanceCriteria` | `rings/SR-00/QueenDelegation.swift` | The criteria list. Source of truth for the strip. |
| `DelegatedTask.criterionVerdicts` | `rings/SR-00/QueenDelegation.swift` | Per-criterion verdicts. Live-mutated by `recordVerdict`. |
| `QueenAcceptancePolicy.verdicts` | `rings/SR-00/QueenCriterionVerdict.swift` | Ordered (criterion, verdict) pairs for display. |
| `QueenAcceptancePolicy.acceptanceBlockReason` | `rings/SR-00/QueenCriterionVerdict.swift` | The block-reason string (or nil). Powers the warning line. |
| `QueenAcceptancePolicy.table` | `rings/SR-00/QueenCriterionVerdict.swift` | Text rendering of the verdict table. Reused for the strip. |
| `QueenCriterionVerdict.symbol` | `rings/SR-00/QueenCriterionVerdict.swift` | `[x]`, `[ ]`, `[?]` prefix for each criterion line. |
| `QueenTaskStyle.color` | `BR-OUTPUT/QueenTaskStatusView.swift` | State → colour mapping. Extended for verdict colours. |
| `ExpandedChatWorkspace` | `BR-OUTPUT/FullscreenChatWorkspace.swift` | Layout host. The banner lives here, between the header and the chat. |
| `QueenCompactSupervisorBar` | `BR-OUTPUT/FullscreenChatWorkspace.swift` | Compact-mode pattern to follow for the collapsed summary. |
