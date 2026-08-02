# Parallel Two — Acceptance

## Overview

This document defines what "acceptance" means for parallel worker tasks
in the Trios project. Acceptance is the gate between a worker's output and
the merged result: it is the moment the Queen reviews the completed work
against the stated acceptance criteria and decides whether it lands.

## Acceptance Criteria

Every task dispatched to a worker carries explicit acceptance criteria.
These are the **only** things the Queen checks during review. If a
criterion is met, it is met; if it is not met, it is not met; if it could
not be checked, that is stated plainly. There is no partial credit and no
"close enough."

Workers are expected to self-verify against each criterion before stopping
and to report the result in their final turn. This self-report is not a
substitute for the Queen's review — it is a courtesy that saves time when
both sides agree.

## Boundary Enforcement

Acceptance is bounded by scope. A worker may only create or edit files
listed in the specification. Work outside those paths is dropped silently
rather than reviewed. Unstated work — no matter how obviously needed — is
explicitly out of scope and should be raised as a question, not done
quietly.

## Verification Format

At the end of a turn, the worker answers every acceptance criterion in
turn: **met**, **not met**, or **could not check**. This section is not
summarised or shortened. An unchecked criterion is treated as a failure.

## Parallel Workers

When multiple workers operate in parallel, each one owns its own file
scope. They do not interfere with each other's paths. The Queen
dispatches tasks, workers execute independently, and acceptance is
evaluated per-task, not per-batch. This isolation is what makes parallel
work safe: no worker can break another worker's acceptance by touching a
file outside its own boundary.

## Summary

Acceptance is the contract between worker and Queen. It is defined by
criteria, bounded by scope, verified by self-report, and enforced by the
Queen's review. Everything else — process, style, approach — is the
worker's to choose.
