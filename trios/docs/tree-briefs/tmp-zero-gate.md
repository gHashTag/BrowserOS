# tmp-zero-gate

- **Label**: tmp-zero: a gate that would fail, invoked by nothing
- **Status**: blocked
- **Layer**: runtime
- **Blocked by**: the checker is wired to no target and no workflow, so the violation it exists to find is invisible
- **Generated from**: `.trinity/dashboard/tech-tree.json` by `tools/tree-to-briefs.mjs` — a skeleton the operator finishes and files; the generator itself files nothing.

> Evidence, verbatim from the tree (home directories redacted):
>
> `grep -rn '/tmp' rings/*/*/src/*.rs | wc -l` = 90 today, almost all production consts rather than tests, e.g. rings/RUST-02/clade-e2e/src/main.rs:193-196 `SwiftLogicSuite { bin: "/tmp/trios_chat_logic_test", ... }`. The checker exists at rings/RUST-99/tmp-zero-gate/src/main.rs and its EXEMPT_DIRS (:12-18) do not include clade-e2e, so it would fail. `grep -c tmp-zero Makefile` = 0.

> Note, verbatim from the tree (home directories redacted):
>
> The clearest case in the repo of a rule whose contradiction is invisible precisely because nobody invokes the checker written to find it.

## User Scenarios & Testing

### User Story 1 - Filing this node is mechanical, not authoring (P1)

**Why this priority**: the technology tree holds `tmp-zero-gate` as `blocked`, and the Queen's candidate list reads open GitHub issues only — no code path turns a tree node into work until this brief is filed.

**Independent Test**: the filed issue body carries the four headings below, in order, and its Boundary names files or the single `UNKNOWN` line.

**Acceptance Scenarios**:
1. **Given** this brief as generated,
   **When** the operator pastes it into a new issue and trims the Boundary to the files the task may actually touch,
   **Then** the issue is delegatable — it carries `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` and `## Boundary`, in that order.

### User Story 2 - tmp-zero-gate itself is settled (P1)

[NEEDS CLARIFICATION: the operator must write the Given/When/Then that settles `tmp-zero-gate`; this skeleton carries the evidence, not the plan.]

## Requirements

- **FR-001**: The blocker recorded above MUST be resolved, or explicitly waived by the operator, before this task is worked.
- **FR-002**: The operator MUST trim the Boundary below to exactly the files this task may touch, and MUST replace an `UNKNOWN` Boundary with named files before the issue is filed.
- **FR-003**: The evidence quoted above MUST travel with the issue unedited, in its redacted form.
- **FR-004**: The filed issue MUST be in English.

## Success Criteria

- The four required headings appear in the filed issue in this order: User Scenarios & Testing, Requirements, Success Criteria, Boundary.
- The Boundary names files, one per line, or carries the single line `UNKNOWN - the operator must name the files`.
- [NEEDS CLARIFICATION: the operator must add the criterion that settles `tmp-zero-gate` — a command and its exit code, a count, or a log line to grep for.]

## Boundary

`rings/RUST-02/clade-e2e/src/main.rs`
`rings/RUST-99/tmp-zero-gate/src/main.rs`
`Makefile`
