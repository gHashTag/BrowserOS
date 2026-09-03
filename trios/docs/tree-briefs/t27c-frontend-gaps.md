# t27c-frontend-gaps

- **Label**: t27c front-end: statements dropped, no semantic stage, typecheck exits 0
- **Status**: blocked
- **Layer**: seed
- **Blocked by**: gHashTag/t27#2508 - upstream repo trios may not edit
- **Generated from**: `.trinity/dashboard/tech-tree.json` by `tools/tree-to-briefs.mjs` — a skeleton the operator finishes and files; the generator itself files nothing.

> Evidence, verbatim from the tree (home directories redacted):
>
> Verified verbatim today at /Users/.../t27/bootstrap/src/compiler.rs:1887-1893 - Parser::parse_fn_body does `Err(_) => { self.recover_to_stmt_boundary(); }`, dropping the error and skipping to the next `;`. STATUS.md:35-48 adds two more: `t27c typecheck` prints FAILED and exits 0 so its only consumer (`suite.rs cmd_typecheck`, which tests `!st.status.success()`) can never fire; and all four gen_* entry points take the raw &Node, so no semantic stage exists between parse and codegen.

> Note, verbatim from the tree (home directories redacted):
>
> Measured cost inside this repo: rings/SR-00/QueenMissionContract.swift:18-24 - trust_manager.t27 declared 21 functions and emitted 12; nine had been silently gone for as long as the spec existed. It is also why both trios rings are written with parenthesised conditions and integer constants (queen_core.t27:15-21). This gap is exactly MVP epic E2.

## User Scenarios & Testing

### User Story 1 - Filing this node is mechanical, not authoring (P1)

**Why this priority**: the technology tree holds `t27c-frontend-gaps` as `blocked`, and the Queen's candidate list reads open GitHub issues only — no code path turns a tree node into work until this brief is filed.

**Independent Test**: the filed issue body carries the four headings below, in order, and its Boundary names files or the single `UNKNOWN` line.

**Acceptance Scenarios**:
1. **Given** this brief as generated,
   **When** the operator pastes it into a new issue and trims the Boundary to the files the task may actually touch,
   **Then** the issue is delegatable — it carries `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` and `## Boundary`, in that order.

### User Story 2 - t27c-frontend-gaps itself is settled (P1)

[NEEDS CLARIFICATION: the operator must write the Given/When/Then that settles `t27c-frontend-gaps`; this skeleton carries the evidence, not the plan.]

## Requirements

- **FR-001**: The blocker recorded above MUST be resolved, or explicitly waived by the operator, before this task is worked.
- **FR-002**: The operator MUST trim the Boundary below to exactly the files this task may touch, and MUST replace an `UNKNOWN` Boundary with named files before the issue is filed.
- **FR-003**: The evidence quoted above MUST travel with the issue unedited, in its redacted form.
- **FR-004**: The filed issue MUST be in English.

## Success Criteria

- The four required headings appear in the filed issue in this order: User Scenarios & Testing, Requirements, Success Criteria, Boundary.
- The Boundary names files, one per line, or carries the single line `UNKNOWN - the operator must name the files`.
- [NEEDS CLARIFICATION: the operator must add the criterion that settles `t27c-frontend-gaps` — a command and its exit code, a count, or a log line to grep for.]

## Boundary

`/Users/.../t27/bootstrap/src/compiler.rs`
`STATUS.md`
`suite.rs`
`rings/SR-00/QueenMissionContract.swift`
`trust_manager.t27`
`queen_core.t27`
