# Queen Review Lifecycle

## Observed failure

The public board can report cards as waiting for Queen review while the durable
dispatch ledger reports zero unreviewed work. The current board maps every
non-accept verdict to the same review column, and a `sendBack` verdict records
the unmet criteria without scheduling another Bee. The result is a terminal
parking state presented as actionable Queen work.

## Observable contract

1. A finished dispatch with no verdict is `queenReviewPending` and is reviewed
   before Queen chooses unrelated backlog work.
2. `accept` is terminal, releases the owned boundary, and appears as done.
3. `sendBack` records the verdict and creates exactly one bounded retry dispatch
   carrying the unmet criteria. The retry must preserve the original issue,
   branch boundary, criteria, provider policy, and send-back count.
4. `escalate` is a distinct human-action state and must never be labelled as
   waiting for Queen.
5. A registry task in `awaitingReview` without a matching unreviewed durable
   dispatch is classified as a reconciliation anomaly, not silently counted as
   Queen review debt.
6. The public board exposes separate counts for Queen review pending, changes
   requested, human escalation, and reconciliation anomalies.
7. When the last running Bee finishes, the durable close signal wakes Queen.
   A retry or newly freed slot is refilled in the same bounded round when safe.

## Safety limits

- At most one retry dispatch may be created for one `sendBack` verdict.
- Existing provider capacity, file-boundary, criteria, and maximum-send-back
  gates remain authoritative.
- No credential values or private transcript text may enter public ledgers.
- The scheduler must remain idempotent across concurrent ticks and restarts.
- Accepted work is never reopened; escalated work is never auto-dispatched.

## Acceptance criteria

- A deterministic regression test first reproduces the parked `sendBack` state.
- The test proves one retry is scheduled, a second tick creates no duplicate,
  and the retry carries the unmet criteria and incremented send-back count.
- Board tests prove the four review-related states and counters are distinct.
- Existing Queen round, Kanban, public-status, provider-capacity, and immediate
  wake tests remain green.
- Type checking and the production server build pass for the exact branch.

## Boundary

- `trios/agent-server/apps/server/src/api/services/queen-tick.ts`
- `trios/agent-server/apps/server/src/api/services/queen-dispatch.ts`
- `trios/agent-server/apps/server/src/api/routes/queen-kanban.ts`
- `trios/agent-server/apps/server/src/lib/db/pg-migrate.ts`
- `trios/agent-server/apps/server/tests/api/queen-round.test.ts`
- `trios/agent-server/apps/server/tests/api/queen-board.test.ts`
- Public DTO types touched by those two modules only when required.
## Production boot ownership contract (#1319)

OBSERVED: deployment `6498451d-6fb2-4826-9f8e-9a77b59df25a` reached Railway
`SUCCESS` while `/queen/status` returned 502. The live process table showed PID
1 blocked in `chown -R bee /workspace`; the mounted workspace was 38 GiB used.

Given a durable completion marker records the configured unprivileged tool
user's current numeric UID, the entrypoint MUST skip recursive ownership repair
and continue to git preflight/server startup. A missing or stale marker MUST
retain the exact recursive repair before any git command runs, then replace the
marker only after that repair succeeds. It MUST NOT delete or rewrite repository
content to achieve the fast path.

## Finished wait recovery contract (#1320)

OBSERVED: six production dispatches were finished with `review_state = 'wait'`.
The review sweep selected only rows whose review state was null, so those rows
could never receive another verdict and continued to hold their file boundaries
while the public dashboard truthfully reported zero running Bees.

For a finished dispatch, incomplete verdict evidence is not a streaming state:
the Bee can no longer append evidence. The runtime MUST therefore convert a
Queen `wait` answer into bounded rework while fewer than two send-backs have
occurred, with an actionable request for a complete parseable `## VERDICT`
block. After two prior send-backs it MUST escalate for human action. The review
sweep MUST include existing durable `wait` rows so production can self-recover,
while preserving accepted, explicit send-back, explicit escalation, exact
provider attribution, retry-claim, file-boundary, and single-flight behavior.
