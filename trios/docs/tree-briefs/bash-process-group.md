# bash-process-group

- **Label**: Shell timeout kills the parent only, not the process group
- **Status**: blocked
- **Layer**: runtime
- **Blocked by**: unfixed: proc.kill() signals the parent and the read then waits on a pipe every surviving child still holds
- **Generated from**: `.trinity/dashboard/tech-tree.json` by `tools/tree-to-briefs.mjs` — a skeleton the operator finishes and files; the generator itself files nothing.

> Evidence, verbatim from the tree (home directories redacted):
>
> Confirmed unchanged today: agent-server/apps/server/src/tools/filesystem/bash.ts:208 `proc.kill()` inside the setTimeout, with no setsid or detached handling in the Bun.spawn options at :198-205. PARALLEL-BEES.md:141 marks it verbatim 'Not fixed.' - a 3 s timeout still pending at 25 s; one `bun run dev &` costs a worker slot until the process restarts.

> Note, verbatim from the tree (home directories redacted):
>
> The sibling fixes in the same file DID land - readBoundedTail at :212-213 (the 890 MB RSS bug) and the 900 s timeout cap. This one did not, and it is a prerequisite for raising the bee cap.

## User Scenarios & Testing

### User Story 1 - Filing this node is mechanical, not authoring (P1)

**Why this priority**: the technology tree holds `bash-process-group` as `blocked`, and the Queen's candidate list reads open GitHub issues only — no code path turns a tree node into work until this brief is filed.

**Independent Test**: the filed issue body carries the four headings below, in order, and its Boundary names files or the single `UNKNOWN` line.

**Acceptance Scenarios**:
1. **Given** this brief as generated,
   **When** the operator pastes it into a new issue and trims the Boundary to the files the task may actually touch,
   **Then** the issue is delegatable — it carries `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` and `## Boundary`, in that order.

### User Story 2 - bash-process-group itself is settled (P1)

[NEEDS CLARIFICATION: the operator must write the Given/When/Then that settles `bash-process-group`; this skeleton carries the evidence, not the plan.]

## Requirements

- **FR-001**: The blocker recorded above MUST be resolved, or explicitly waived by the operator, before this task is worked.
- **FR-002**: The operator MUST trim the Boundary below to exactly the files this task may touch, and MUST replace an `UNKNOWN` Boundary with named files before the issue is filed.
- **FR-003**: The evidence quoted above MUST travel with the issue unedited, in its redacted form.
- **FR-004**: The filed issue MUST be in English.

## Success Criteria

- The four required headings appear in the filed issue in this order: User Scenarios & Testing, Requirements, Success Criteria, Boundary.
- The Boundary names files, one per line, or carries the single line `UNKNOWN - the operator must name the files`.
- [NEEDS CLARIFICATION: the operator must add the criterion that settles `bash-process-group` — a command and its exit code, a count, or a log line to grep for.]

## Boundary

`agent-server/apps/server/src/tools/filesystem/bash.ts`
`PARALLEL-BEES.md`
