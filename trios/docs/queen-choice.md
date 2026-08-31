# Queen Choice — How the Next Subtask Is Picked

Issue: gHashTag/trios#1216

## Why this file exists

The selection rule lives only in code (`chooseNextOpenIssue` in
`rings/SR-02/ChatViewModel.swift`). A person reading a delegation proposal
saw "chosen: #NNNN" with no way to check whether that was the right pick.
This page is the rule written down, so the choice can be verified by hand
against the same evidence the Queen used.

## Where the list of subtasks comes from

The candidates are the **open sub-issues of the Queen's epics**, read from
the GitHub REST API (public, no token): epic #1090 (the supervisor epic)
and #1279 (the T27 backend), in that order. The epic list is a default,
not a constant — the operator can change it under the `queen.epics` key
(`QueenEpics` in `queen-core/Sources/QueenCore/QueenEpics.swift`), and
adding an epic requires no build. Sub-issues are read through the epic
timeline, paginated, with PRs not treated as work to delegate.

If the network read fails, the last successfully read list is loaded from
the store at `.trinity/state/queen_subissues.json`, and the choice is
labelled as made on that stored list. No stored list and no network means
no choice: the tick refuses rather than guessing.

## The order: smaller boundary first

The Queen hands out the work that fits, not the work that waited longest
(the measurements behind this are in `docs/choosing-what-fits.md`). Every
candidate is scored by the size of its declared boundary — the paths
listed under `## Границы` / `## Boundary` in the issue body:

1. **A task with a smaller boundary goes earlier.** The score is the
   number of files named in the boundary section; fewer files sorts
   first (`countBoundaryFiles`).
2. **A path ending in `/` is not a boundary — it is a region.** A
   directory path adds 9999 to the score instead of 1, so "a whole
   directory" ranks as huge, not as one line.
3. **No boundary section at all scores `Int.max`** and sorts last; such
   an issue is skipped anyway (see below).
4. **Ties break by the lower issue number** — the older issue wins, and
   only among equals.

## What is skipped before the first survivor is chosen

The list is walked in score order, and a candidate is passed over when:

- an issue body is missing and cannot be fetched, so its boundary is
  unknown;
- it declares no boundary section — nothing can be reserved for it;
- its paths are held by a live task (a boundary conflict — the skip
  names the holder and its state);
- a task already exists for it in any spoken-for state (queued, running,
  awaitingReview, rejected, accepted, merged);
- its prior attempts say escalate (`QueenRetryPolicy`);
- it looks already done against the current tree (#1180).

The first candidate none of these touch is the chosen one, and the
proposal names its reason — "smallest boundary: N files under Границы;
ties break by lowest number" — which a reader can now check against this
page and the issue list on the forge.
