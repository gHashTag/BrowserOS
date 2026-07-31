# Queen Review Gate

Issue: gHashTag/trios#1095 · Parent: #1090

Two gates stand between a worker's output and a merged commit:
**acceptance** (the Queen's judgement) and **merge** (the forge).

## Gate 1 — Acceptance: what stops the Queen accepting work

The Queen reviews output against each acceptance criterion
(`QueenAcceptancePolicy`). She cannot accept while:

- **Any criterion marked `.unmet`** (reported first).
  `acceptanceBlockReason(...)` lists every unmet criterion and
  refuses acceptance. The task stays `.awaitingReview`.
- **Any criterion still `.unchecked`** (reported only if none are
  `.unmet`). An unchecked criterion is not a pass — the Queen
  must record a verdict for every criterion before acceptance
  proceeds. The task stays `.awaitingReview` until every
  criterion is `[x]`.

Only when all criteria pass does the Queen mark the task `.accepted`.

## Gate 2 — Merge: what blocks a merge

After acceptance, the forge decides. A merge is blocked when:

- **Branch protection or required CI fails (HTTP 405).** Returns
  `false`; retried next poll.
- **Base branch moved (HTTP 409).** The PR is stale. Same retry.
- **Forge unreachable.** Network, auth, or rate-limit failure.
  Logs `queen.pr.poll_failed`; no state change.
- **PR closed without merging.** Outcome `.abandoned`; returns
  to `.awaitingReview` for a new decision.
- **PR already merged.** Nothing to merge; settles as `.merged`.

## Authority

The Queen judges acceptance; the forge confirms the merge. Accepted
work with an open PR is **not settled** until the merge lands.
The Queen records each criterion's verdict (`recordVerdict`); no
other role writes verdicts.
