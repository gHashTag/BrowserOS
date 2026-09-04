# t27c-mut-emit

- **Label**: gen-rust never emits `mut` on a function parameter
- **Status**: blocked
- **Layer**: seed
- **Blocked by**: gHashTag/t27 - collect_mutable_names (compiler.rs:11267) computes the set, gen_fn (compiler.rs:12668) never asks
- **Generated from**: `.trinity/dashboard/tech-tree.json` by `tools/tree-to-briefs.mjs` — a skeleton the operator finishes and files; the generator itself files nothing.

> Evidence, verbatim from the tree (home directories redacted):
>
> Makefile:940-945 names it the chief remaining cause of the 11 non-compiling generated files; STATUS.md:102-121 measures 'Eight errors are that omission'. wave-loop-114.md W2 lists it as one of exactly two ownership boundaries still open.

> Note, verbatim from the tree (home directories redacted):
>
> Deliberately not worked around: 'Renaming parameters or adding shadow locals would silence it while hiding a one-line fix from its author.'

## User Scenarios & Testing

### User Story 1 - Filing this node is mechanical, not authoring (P1)

**Why this priority**: the technology tree holds `t27c-mut-emit` as `blocked`, and the Queen's candidate list reads open GitHub issues only — no code path turns a tree node into work until this brief is filed.

**Independent Test**: the filed issue body carries the four headings below, in order, and its Boundary names files or the single `UNKNOWN` line.

**Acceptance Scenarios**:
1. **Given** this brief as generated,
   **When** the operator pastes it into a new issue and trims the Boundary to the files the task may actually touch,
   **Then** the issue is delegatable — it carries `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` and `## Boundary`, in that order.

### User Story 2 - t27c-mut-emit itself is settled (P1)

[NEEDS CLARIFICATION: the operator must write the Given/When/Then that settles `t27c-mut-emit`; this skeleton carries the evidence, not the plan.]

## Requirements

- **FR-001**: The blocker recorded above MUST be resolved, or explicitly waived by the operator, before this task is worked.
- **FR-002**: The operator MUST trim the Boundary below to exactly the files this task may touch, and MUST replace an `UNKNOWN` Boundary with named files before the issue is filed.
- **FR-003**: The evidence quoted above MUST travel with the issue unedited, in its redacted form.
- **FR-004**: The filed issue MUST be in English.

## Success Criteria

- The four required headings appear in the filed issue in this order: User Scenarios & Testing, Requirements, Success Criteria, Boundary.
- The Boundary names files, one per line, or carries the single line `UNKNOWN - the operator must name the files`.
- [NEEDS CLARIFICATION: the operator must add the criterion that settles `t27c-mut-emit` — a command and its exit code, a count, or a log line to grep for.]

## Boundary

`Makefile`
`STATUS.md`
`wave-loop-114.md`
