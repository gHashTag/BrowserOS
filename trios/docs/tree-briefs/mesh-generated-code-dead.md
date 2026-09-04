# mesh-generated-code-dead

- **Label**: RUST-13: the generated code is excluded, the forbidden hand-written code ships
- **Status**: blocked
- **Layer**: ring
- **Blocked by**: t27c-mut-emit upstream, a build.rs hook that cannot find its compiler, and an owner-gated regeneration decision
- **Generated from**: `.trinity/dashboard/tech-tree.json` by `tools/tree-to-briefs.mjs` — a skeleton the operator finishes and files; the generator itself files nothing.

> Evidence, verbatim from the tree (home directories redacted):
>
> rings/RUST-13/trios-mesh/src/lib.rs:3-5 - 'The hand-written modules below are the current runtime surface. The generated gen/rust/ stubs are excluded from compilation.' The four shipping modules - crypto.rs (948 lines), router.rs (927), routing.rs (480), wire.rs (155) - are exactly the four categories that submodule's own CLAUDE.md lists as FORBIDDEN to write by hand. build.rs:15-18 looks for t27c at ../t27/target/release/t27c, which does not exist, and returns early in silence. STATUS.md:97-101: 46 of 68 committed artifacts differ from a fresh gen-rust.

> Note, verbatim from the tree (home directories redacted):
>
> Same failure shape as the t27-rings gate that slept for months: a hook that cannot find its tool and reports nothing.

## User Scenarios & Testing

### User Story 1 - Filing this node is mechanical, not authoring (P1)

**Why this priority**: the technology tree holds `mesh-generated-code-dead` as `blocked`, and the Queen's candidate list reads open GitHub issues only — no code path turns a tree node into work until this brief is filed.

**Independent Test**: the filed issue body carries the four headings below, in order, and its Boundary names files or the single `UNKNOWN` line.

**Acceptance Scenarios**:
1. **Given** this brief as generated,
   **When** the operator pastes it into a new issue and trims the Boundary to the files the task may actually touch,
   **Then** the issue is delegatable — it carries `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` and `## Boundary`, in that order.

### User Story 2 - mesh-generated-code-dead itself is settled (P1)

[NEEDS CLARIFICATION: the operator must write the Given/When/Then that settles `mesh-generated-code-dead`; this skeleton carries the evidence, not the plan.]

## Requirements

- **FR-001**: The blocker recorded above MUST be resolved, or explicitly waived by the operator, before this task is worked.
- **FR-002**: The operator MUST trim the Boundary below to exactly the files this task may touch, and MUST replace an `UNKNOWN` Boundary with named files before the issue is filed.
- **FR-003**: The evidence quoted above MUST travel with the issue unedited, in its redacted form.
- **FR-004**: The filed issue MUST be in English.

## Success Criteria

- The four required headings appear in the filed issue in this order: User Scenarios & Testing, Requirements, Success Criteria, Boundary.
- The Boundary names files, one per line, or carries the single line `UNKNOWN - the operator must name the files`.
- [NEEDS CLARIFICATION: the operator must add the criterion that settles `mesh-generated-code-dead` — a command and its exit code, a count, or a log line to grep for.]

## Boundary

`rings/RUST-13/trios-mesh/src/lib.rs`
`crypto.rs`
`router.rs`
`routing.rs`
`wire.rs`
`CLAUDE.md`
`build.rs`
`STATUS.md`
