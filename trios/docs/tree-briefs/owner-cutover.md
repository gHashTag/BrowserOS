# owner-cutover

- **Label**: Owner decisions: rebuild the release app; rule on the agent-server rename
- **Status**: blocked
- **Layer**: supervisor
- **Blocked by**: two decisions only the owner can make - authorising the release rebuild (her provider key then travels to the container in each request body) and choosing whether the bun runtime lives in trios/agent-server or packages/browseros-agent
- **Generated from**: `.trinity/dashboard/tech-tree.json` by `tools/tree-to-briefs.mjs` — a skeleton the operator finishes and files; the generator itself files nothing.

> Evidence, verbatim from the tree (home directories redacted):
>
> PARALLEL-BEES.md:150 gives the exact commands (`DEVELOPER_DIR=/Library/Developer/CommandLineTools make release`, then `open -a trios.app --env TRIOS_AGENT_SERVER_URL=...`) and notes the running release app 'predates all of it and knows nothing of the boundary ageing or the patch transport'. STATUS.md:84-92 measures the consequence: treeStateFingerprint on 0 of the release store's tasks, 12 tasks with no acceptance criteria. RELEASE-BLOCKER.md:95-102: 763 commits ahead, 17 behind, 570 conflict markers over 1096 files, of which packages/browseros-agent (546) and trios/agent-server (436) are the same directory in two places.

> Note, verbatim from the tree (home directories redacted):
>
> 'The choice is about which repository owns the runtime, which is an ownership question, not a merge question.' And it decays: 'This number will be worse next week than it is today.'

## User Scenarios & Testing

### User Story 1 - Filing this node is mechanical, not authoring (P1)

**Why this priority**: the technology tree holds `owner-cutover` as `blocked`, and the Queen's candidate list reads open GitHub issues only — no code path turns a tree node into work until this brief is filed.

**Independent Test**: the filed issue body carries the four headings below, in order, and its Boundary names files or the single `UNKNOWN` line.

**Acceptance Scenarios**:
1. **Given** this brief as generated,
   **When** the operator pastes it into a new issue and trims the Boundary to the files the task may actually touch,
   **Then** the issue is delegatable — it carries `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` and `## Boundary`, in that order.

### User Story 2 - owner-cutover itself is settled (P1)

[NEEDS CLARIFICATION: the operator must write the Given/When/Then that settles `owner-cutover`; this skeleton carries the evidence, not the plan.]

## Requirements

- **FR-001**: The blocker recorded above MUST be resolved, or explicitly waived by the operator, before this task is worked.
- **FR-002**: The operator MUST trim the Boundary below to exactly the files this task may touch, and MUST replace an `UNKNOWN` Boundary with named files before the issue is filed.
- **FR-003**: The evidence quoted above MUST travel with the issue unedited, in its redacted form.
- **FR-004**: The filed issue MUST be in English.

## Success Criteria

- The four required headings appear in the filed issue in this order: User Scenarios & Testing, Requirements, Success Criteria, Boundary.
- The Boundary names files, one per line, or carries the single line `UNKNOWN - the operator must name the files`.
- [NEEDS CLARIFICATION: the operator must add the criterion that settles `owner-cutover` — a command and its exit code, a count, or a log line to grep for.]

## Boundary

`PARALLEL-BEES.md`
`STATUS.md`
`RELEASE-BLOCKER.md`
