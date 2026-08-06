# Queen Proactive — How She Arrives with Three Options Unprompted

Issue: gHashTag/trios#1097 · Parent: #1090

## What this document is

A sketch of the path from "the periodic timer fires" to "the
Queen posts three options into her own chat, unprompted." It
describes the pieces that already exist, the gap between them,
and the wire that closes it — without opening a single chat
without the person's consent.

It mirrors the types already in the codebase:
`QueenSelfImprovementService` (`rings/SR-02/QueenSelfImprovementService.swift`),
`QueenSelfAudit` (`rings/SR-00/QueenSelfAudit.swift`),
`QueenEvolutionOptions` (`rings/SR-00/QueenEvolutionOptions.swift`),
`QueenBackgroundService` (`rings/SR-02/QueenBackgroundService.swift`),
and the consent gate `QueenDelegationPolicy.approvalBlockReason`
(`rings/SR-00/QueenDelegation.swift`).

## The two loops that exist today

There are two independent periodic loops. Neither alone is the
proactive Queen; the gap between them is the gap this document
describes.

### Loop 1: the review scheduler

`QueenReviewScheduler` (`rings/SR-02/QueenReviewScheduler.swift`)
fires every 30 minutes, reads the swarm, and posts a digest to
the Queen's own chat via `QueenReviewDigest.text(for:now:)`. It is
silent when nothing is waiting — silence when idle is the contract,
because a heartbeat that fires whether or not anything happened is
indistinguishable from noise.

This loop reports **what workers have done**. It says nothing
about **what the Queen herself would do next**.

### Loop 2: the self-improvement audit

`QueenBackgroundService.startAuditLoop()` runs a 60-minute timer
that calls `QueenSelfImprovementService.runAudit()`. That audit:

1. Loads the last 50 Queen-conversation turns.
2. Recalls relevant long-term memory.
3. Detects weak spots — recurring delegate failures, empty memory
   recalls, unknown commands, high error rates
   (`QueenWeakSpot.Kind`).
4. Generates `QueenProposal` objects for each weak spot. Proposals
   are persisted to `.trinity/state/queen-proposals.json` with
   status `.pending`. **No code is mutated without a human-approved
   proposal** (`/evolve-apply <id>`).
5. Saves a consolidated record into durable memory.
6. Updates `lastAudit` and `proposals` on `QueenBackgroundService`
   for the UI.

This loop finds problems and files proposals. It does not post the
**three-option evolution message** into the chat. The proposals sit
in a JSON file until someone reads them, which is the same shape of
defect `/self-audit` was built to catch: a capability with no path
to it.

### The command that bridges them (but only on demand)

When the user types `/self-audit`, `ChatViewModel.runSelfAudit()`
runs the repository scanner (`Self.auditRepository(root:)`), posts
`QueenSelfAudit.report(findings:now:)`, and then — critically —
calls `QueenEvolutionOptions.options(from: findings)` and posts
`QueenEvolutionOptions.message(for: options)`. That message is
exactly what the spec describes: three options, each with a
rationale and the command that authorises it, ending with "I will
not open a chat for any of these until you say so."

The problem: it only happens when the user asks.

## The gap: proactive posting of evolution options

The wire that does not exist yet is a call from the self-improvement
audit loop to the evolution-options pipeline. Concretely:

```
QueenBackgroundService.startAuditLoop()
  → QueenSelfImprovementService.runAudit()    ← already runs
  → auditRepository(root:)                    ← not called from here
  → QueenEvolutionOptions.options(from:)      ← not called from here
  → post QueenEvolutionOptions.message(for:)  ← not posted from here
```

Today `runAudit()` scans the conversation transcript for weak spots.
The repository audit (`auditRepository`) and the option-building
step (`QueenEvolutionOptions`) are wired only behind the manual
`/self-audit` command in `ChatViewModel`.

The sketch is: after `runAudit()` has detected weak spots and
generated proposals, also run the repository audit, build options
from the findings, and post the resulting message into the Queen's
own chat — the same message the manual command produces.

The message is already written and already ends with the consent
gate. The only change is **who calls it**: the timer, not the
person.

## Criterion 1: three options, each justified, each actionable

### Where the three come from

`QueenEvolutionOptions.options(from:)` takes ranked `QueenSelfAudit.Finding`
objects and takes the top three. The ranking lives in
`QueenSelfAudit.roadmap(from:)`, which sorts by severity:
`.dead` first (shipped and unreachable), then `.unverified`
(reachable but unproven), then `.fragile` (works, but the shape
invites the next bug).

### Why each is justified

Each `Option` carries a `rationale` string — the finding's
`explanation`, written to be read aloud. The Queen does not say
"consider improving X." She says what is wrong in a way that names
the evidence: "It is declared once and referenced nowhere else, so
whatever it does, nothing asks it to."

### The command that launches it

Each option ends with the authorisation instruction. Today this is
rendered by `QueenEvolutionOptions.message(for:)`, which appends:

> I will not open a chat for any of these until you say so. Approve
> one with `/approve owner/repo#N` once there is an issue for it.

So each option is actionable: the user picks one, files an issue,
and types one line. The Queen does not start work; she offers to.

### What happens when there are fewer than three

`QueenEvolutionOptions.desiredCount` is 3, but `options(from:)`
returns `ranked.prefix(desiredCount)` — fewer findings means fewer
options. Padding with filler would be the same failure as reporting
a metric nobody measured: it makes an empty repository look like it
offered a choice. When there are zero findings, the message says
so plainly: "I read my own code and have nothing to propose."

## Criterion 2: no chat opens without consent

### The rule that already exists

`QueenDelegationPolicy.approvalBlockReason(issue:approved:)`
returns a non-nil string unless the issue's slug is in the
`approved` set. The Queen may not open a worker chat for any task
the person has not approved. This is the existing, tested gate.

The evolution message reinforces it by ending with the instruction
above. Proposing is the other half of the consent gate: she reads
the repository, says what she would do, and waits. Without the
option to propose, the consent gate makes her passive rather than
careful — and a passive supervisor is one nobody consults.

The self-improvement proposals (`QueenProposal`) have their own
parallel gate: status `.pending` until a human approves with
`/evolve-apply <id>`. No code is mutated automatically. This is
the same principle applied to a different surface.

### What the proactive loop does not change

Posting a message into the Queen's own chat is not opening a worker
chat. The Queen's chat is where she already talks — the digest, the
audit findings, the budget warnings all land there. The proactive
evolution message is the same kind of entry: it reports what she
found and what she would do, and it stops there.

The boundary between **reporting** (autonomous, always allowed) and
**acting** (gated by consent) is the boundary this design keeps.

## Criterion 3: she does not come with the same thing twice in a row

### The deduplication rule

The Queen must not post the same three options on consecutive
cycles — a proposal nobody acted on yesterday should not be
re-pitched today as if it were new.

The mechanism is straightforward: compare the set of option subjects
(in practice, the `Finding.subject` strings) against those posted in
the previous cycle. If they are identical, the Queen posts a shorter
message instead — one that acknowledges the options are still open
without repeating them verbatim:

> The three options from my last audit are still open. Nothing has
> changed in the repository since I posted them. Say `/approve
> owner/repo#N` when you are ready, or ignore them and I will look
> again next cycle.

This keeps the chat from becoming a loop of identical walls of text.
The options themselves are still available (persisted in
`.trinity/state/queen-proposals.json` and shown in the proposals
view), so the user does not lose them — they just stop being
re-announced.

### What "the same" means

Comparison is on the `subject` set, not the full message text.
If the repository changed and one finding dropped off (a dead symbol
was wired up), the set differs and the Queen posts fresh options.
If nothing changed, the short reminder fires instead.

### The silence floor

When the options are unchanged **and** the user has not interacted
with the Queen chat since the last post, the Queen should go silent
rather than post even the reminder. A reminder of a reminder is
noise. The rule:

| Repository changed since last cycle? | Options match last cycle? | Queen posts |
|---------------------------------------|--------------------------|-------------|
| Yes                                   | —                        | Fresh options |
| No                                    | No (set differs)         | Fresh options |
| No                                    | Yes                      | Short reminder |
| No                                    | Yes, and no user activity since last | Silence |

Silence is always acceptable. The Queen's chat already follows this
principle: `QueenReviewDigest.text` returns `nil` when there is
nothing to report, and the scheduler does not post.

## How the pieces connect

```
                    ┌──────────────────────────────────────┐
                    │  QueenBackgroundService              │
                    │  startAuditLoop()                    │
                    │  60-minute timer                     │
                    └──────────────┬───────────────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────────────┐
                    │  QueenSelfImprovementService         │
                    │  runAudit()                          │
                    │                                      │
                    │  1. Load recent Queen turns          │
                    │  2. Recall memory                    │
                    │  3. Detect weak spots                │
                    │  4. Generate QueenProposal[]         │
                    │  5. Run auditRepository(root:)       │
                    │  6. QueenEvolutionOptions.options()  │
                    │  7. Dedup vs. previous cycle         │
                    │  8. Post message to Queen chat       │
                    └──────────────────────────────────────┘
                                   │
                    ┌──────────────┴───────────────────────┐
                    │                                      │
                    ▼                                      ▼
    ┌────────────────────────────┐       ┌────────────────────────────┐
    │  Fresh options             │       │  Short reminder or silence │
    │  (repository changed)      │       │  (unchanged)               │
    │  Ends with consent gate    │       │  Points to previous post   │
    └────────────────────────────┘       └────────────────────────────┘
```

Steps 5–8 are the sketch. Steps 1–4 already exist.

## Code references

| Symbol | File | Role |
|--------|------|------|
| `QueenSelfImprovementService.runAudit()` | `rings/SR-02/QueenSelfImprovementService.swift` | The 60-minute audit cycle. Today it detects weak spots and generates proposals but does not run the repository audit or post evolution options. |
| `QueenSelfImprovementService.defaultInterval` | `rings/SR-02/QueenSelfImprovementService.swift` | 60 minutes. The cadence at which the proactive cycle would fire. |
| `QueenBackgroundService.startAuditLoop()` | `rings/SR-02/QueenBackgroundService.swift` | The timer that calls `runAudit()`. Where the proactive call would be wired. |
| `QueenBackgroundService.postToChat(id:role:content:)` | `rings/SR-02/QueenBackgroundService.swift` | How a message lands in the Queen's own chat from the background service. |
| `ChatViewModel.auditRepository(root:)` | `rings/SR-02/ChatViewModel.swift` | The repository scanner. Finds dead symbols by counting call sites. Today called only by `/self-audit`. |
| `QueenSelfAudit.Finding` | `rings/SR-00/QueenSelfAudit.swift` | One finding: severity, subject, explanation, proposal. The unit the options are built from. |
| `QueenSelfAudit.roadmap(from:)` | `rings/SR-00/QueenSelfAudit.swift` | Ranks findings: dead first, then unverified, then fragile. |
| `QueenEvolutionOptions.options(from:)` | `rings/SR-00/QueenEvolutionOptions.swift` | Takes up to 3 ranked findings, returns labelled options (A, B, C). |
| `QueenEvolutionOptions.message(for:)` | `rings/SR-00/QueenEvolutionOptions.swift` | Composes the chat message. Ends with the consent gate: "I will not open a chat until you say so." |
| `QueenEvolutionOptions.desiredCount` | `rings/SR-00/QueenEvolutionOptions.swift` | 3. Fewer findings means fewer options; never padded. |
| `QueenDelegationPolicy.approvalBlockReason(issue:approved:)` | `rings/SR-00/QueenDelegation.swift` | The consent gate. Returns a refusal string unless the issue was approved. |
| `QueenProposal` | `rings/SR-02/QueenSelfImprovementService.swift` | Parallel consent surface for self-improvement patches. `.pending` until `/evolve-apply`. |
| `QueenReviewScheduler` | `rings/SR-02/QueenReviewScheduler.swift` | The 30-minute swarm digest loop. Silent when idle. Separate from the evolution pipeline. |
| `QueenReviewDigest.text(for:now:)` | `rings/SR-00/QueenReviewDigest.swift` | Returns `nil` when nothing is worth reporting. The model for the proactive loop's silence floor. |
