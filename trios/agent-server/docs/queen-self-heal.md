# Queen self-heal: resolve recoverable blockers instead of parking them

**Status:** design, not yet implemented. Written 2026-09-27 from live dispatch/review
logs on the production `trios-agent-server` and a read of the engine sources below.
Owner ask: *"королева сама чинит все блокеры — она должна понимать где проблемы и
сама решать их."*

## The gap

The Queen already *detects* the recoverable blockers and then **parks them for a
human** (an `escalate` verdict, or a task that loops without landing). Measured on
2026-09-27 over ~15 min the swarm dispatched ~18 issues on
`nvidia/nemotron-3-ultra-550b` with review verdicts `accept×5 / send×5 / wait / escalate×3
/ empty×2` — healthy, but the escalate/empty/loop cases each needed a person.

Four recoverable classes, each observed live:

| Class | Observed | Where it is decided today |
|---|---|---|
| **Work outside the boundary** | #4871, #4872 ("all 9 uncommitted paths fall outside the boundary"), #4874 — repeated `Queen found work outside the boundary she gave`; salvage discards it, task loops/escalates | `queen-core/Sources/QueenCore/QueenBoundaryPaths.swift`, salvage columns in `apps/server/src/api/services/queen-tick.ts` |
| **Empty diff** | #4869, #4870 → `empty` verdict → escalate ("a reviewer that passes an empty diff has judged the absence of work") | `queen-core/Sources/QueenCore/QueenReviewDecision.swift` |
| **Review call timed out** | #4871 — `Queen reviewer call failed; nothing was spent`, `The operation timed out`, `transient:true` | reviewer path in `queen-tick.ts` |
| **No acceptance criteria** | `escalate` reason "the task has no acceptance criteria, so there is nothing to judge it against" | `QueenReviewDecision.swift`, `QueenSpecQuality.swift` |
| **Retry ceiling holds the issue forever** | t27#4886 (re-filed from #2164 BY HAND): "a dispatch row that has spent its retry ceiling keeps its issue for good — so no bee could take it again, however much the brief improved" | dispatch-row lifecycle in `queen-tick.ts` |

The invariant to keep across all of them: **no gate that protects correctness is
weakened.** Work that ran and failed its criteria is still sent back or escalated;
an empty diff never becomes an accept. Self-heal only converts a *park* into a
*bounded, audited, reversible* re-attempt for the specific recoverable cause.

## The four (five) heals

### 1. Auto-correct the boundary
When a task's salvaged-outside path set is the **same across two consecutive
attempts** and **none of those paths is inside another running task's boundary**,
widen the issue boundary to include exactly those paths and re-dispatch — capped by
`QUEEN_BOUNDARY_AUTOWIDEN_MAX` (default 2), audited with a comment naming the added
paths, beyond the cap it escalates as today. Differing path sets, a colliding path,
or past-cap → unchanged behaviour.

### 2. Retry an empty diff on the next model
An empty-diff turn is usually the model, not the task. Re-dispatch once on the next
untried model in the ranked candidate list; bound the retries by the list length;
once exhausted and still empty → escalate as today. A non-empty diff that failed its
criteria is untouched.

### 3. Retry a transient reviewer failure
A reviewer timeout with `transient:true` and "nothing was spent" should re-run the
review once (idempotent — nothing was charged), before it becomes a `wait` that a
person has to clear.

### 4. Write the missing acceptance criteria
When an issue has a `## Boundary` and ≥1 Given/When/Then scenario but no
`## Success Criteria`, derive criteria FROM THE ISSUE'S OWN scenarios and boundary,
write them onto the issue (marked Queen-derived, dated, so a person can correct
them), and let the normal flow proceed. Never invents a new issue, never a boundary,
never rewrites existing criteria; an issue with a boundary but no scenarios still
escalates (nothing to derive from).

### 5. Free a retry-exhausted issue instead of holding it forever
A dispatch row at its retry ceiling currently holds its issue for good, so re-filing
under a new number by hand is the only way back (t27#4886 ← #2164). Instead: when the
issue body has changed since the last attempt (the brief improved), reset the row's
retry budget once and let it be re-chosen — bounded, audited, so a genuinely
impossible task still stops rather than looping forever.

## Success criteria for the implementation

Each heal ships with tests under `apps/server/tests/api/` that assert: (a) the heal
fires on its exact trigger and re-dispatches rather than escalating; (b) every
neighbouring case keeps today's behaviour; (c) a **gate-preservation control** — an
accept / send-back / empty-diff decision is byte-for-byte unchanged. `bun test` for
the changed package passes with raw output quoted. This is a `trios/agent-server`
change (roadmap stage 2, `gHashTag/BrowserOS`); it must be built and tested where the
engine's bun deps and Postgres are available — it cannot be validated from a
read-only session.
