# Parallel One — Delegation

## Overview

Delegation is the act by which the Queen assigns a unit of work to a
worker. It is the starting point of every parallel task: the Queen writes
a specification, the worker reads it, executes within the stated
boundary, and reports back. Everything that follows — acceptance,
review, merge — depends on this initial hand-off being precise.

## What a Delegation Contains

A delegation is not a vague request. It carries:

- **Intent** — one or two sentences describing what the worker should
  produce or change.
- **Acceptance criteria** — a numbered list of checkable conditions. Each
  criterion is binary: met, not met, or could not check. There is no
  partial credit.
- **Boundary** — an explicit list of file paths the worker may create or
  edit. Work outside these paths is dropped, not reviewed.
- **Out of scope** — anything that seems obviously needed but is not
  listed in the criteria. The worker raises questions about such things
  rather than doing them quietly.
- **Verification instructions** — how the worker should self-report at
  the end of its turn.

If any of these are missing, the delegation is incomplete and the worker
should ask for clarification before starting.

## How Delegation Works

The Queen dispatches a specification to a worker. The worker operates
on a shared checkout — it does not create branches, switch to them, or
commit anything. The Queen manages the branch; the worker manages the
files within its boundary.

Multiple workers may run in parallel. Each owns a disjoint set of file
paths. Because paths never overlap, no worker can break another's
acceptance. This isolation is what makes parallel delegation safe.

## Worker Autonomy

Within its boundary the worker has full freedom. It may read any file in
the repository for context, but it may only write to the paths listed in
the specification. Process, style, and approach are the worker's to
choose. The only thing that matters is whether the acceptance criteria
are met when the worker stops.

## Self-Verification

Before stopping, the worker answers every acceptance criterion in turn.
An unchecked criterion is not a pass. The self-report is a courtesy that
saves the Queen time when both sides agree — it is not a substitute for
the Queen's own review.

## Summary

Delegation is the contract between Queen and worker. It defines what to
do, where to do it, and how success is measured. Everything else is
implementation detail left to the worker's judgement.
