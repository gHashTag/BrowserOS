# playground

- **Label**: t27.ai Playground - eight screens, no owner and no code
- **Status**: planned
- **Layer**: interface
- **Generated from**: `.trinity/dashboard/tech-tree.json` by `tools/tree-to-briefs.mjs` — a skeleton the operator finishes and files; the generator itself files nothing.

> Evidence, verbatim from the tree (home directories redacted):
>
> Queen_T27_MVP_Architecture.md:1433-1610 (spec editor, source AST, semantic view, IR explorer, generated outputs, hardware view, verification, provenance timeline) and :2225-2299 (E7-I1..I7). No directory, route or spec for it exists anywhere in this repository. RELEASE-BLOCKER.md:44: 'the Playground has no owner and no code.' STATUS.md scores Playground 0 done / 1 partial / 5 not started.

> Note, verbatim from the tree (home directories redacted):
>
> Six of the 29 DoD criteria depend on it, and 11 of the 12 vertical-slice steps are not owned by this repo at all - RELEASE-BLOCKER.md:24 records the correction that only step 12, the Queen half, moves from here.

## User Scenarios & Testing

### User Story 1 - Filing this node is mechanical, not authoring (P1)

**Why this priority**: the technology tree holds `playground` as `planned`, and the Queen's candidate list reads open GitHub issues only — no code path turns a tree node into work until this brief is filed.

**Independent Test**: the filed issue body carries the four headings below, in order, and its Boundary names files or the single `UNKNOWN` line.

**Acceptance Scenarios**:
1. **Given** this brief as generated,
   **When** the operator pastes it into a new issue and trims the Boundary to the files the task may actually touch,
   **Then** the issue is delegatable — it carries `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` and `## Boundary`, in that order.

### User Story 2 - playground itself is settled (P1)

[NEEDS CLARIFICATION: the operator must write the Given/When/Then that settles `playground`; this skeleton carries the evidence, not the plan.]

## Requirements

- **FR-001**: The operator MUST trim the Boundary below to exactly the files this task may touch, and MUST replace an `UNKNOWN` Boundary with named files before the issue is filed.
- **FR-002**: The evidence quoted above MUST travel with the issue unedited, in its redacted form.
- **FR-003**: The filed issue MUST be in English.

## Success Criteria

- The four required headings appear in the filed issue in this order: User Scenarios & Testing, Requirements, Success Criteria, Boundary.
- The Boundary names files, one per line, or carries the single line `UNKNOWN - the operator must name the files`.
- [NEEDS CLARIFICATION: the operator must add the criterion that settles `playground` — a command and its exit code, a count, or a log line to grep for.]

## Boundary

`Queen_T27_MVP_Architecture.md`
`RELEASE-BLOCKER.md`
`STATUS.md`
