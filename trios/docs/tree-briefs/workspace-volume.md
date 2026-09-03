# workspace-volume

- **Label**: /workspace survives a redeploy
- **Status**: blocked
- **Layer**: runtime
- **Blocked by**: an operator action - no Railway volume exists on the agent-server service
- **Generated from**: `.trinity/dashboard/tech-tree.json` by `tools/tree-to-briefs.mjs` — a skeleton the operator finishes and files; the generator itself files nothing.

> Evidence, verbatim from the tree (home directories redacted):
>
> Measured inside the running container: `df -h /workspace` -> overlay; `mount | grep workspace` -> nothing; `railway volume list` -> one volume, redis-volume, on the Redis service. Dockerfile:97-115 now states it plainly and gives the fix: `railway volume add --service trios-agent-server --mount-path /workspace`.

> Note, verbatim from the tree (home directories redacted):
>
> The old comment claimed 'A volume mounts here in production' and no volume was ever created - it described an intention and read as a fact. Already cost a real artifact: e52f41ad, the seal a real model wrote for #1244, gone with the deploy that followed it.

## User Scenarios & Testing

### User Story 1 - Filing this node is mechanical, not authoring (P1)

**Why this priority**: the technology tree holds `workspace-volume` as `blocked`, and the Queen's candidate list reads open GitHub issues only — no code path turns a tree node into work until this brief is filed.

**Independent Test**: the filed issue body carries the four headings below, in order, and its Boundary names files or the single `UNKNOWN` line.

**Acceptance Scenarios**:
1. **Given** this brief as generated,
   **When** the operator pastes it into a new issue and trims the Boundary to the files the task may actually touch,
   **Then** the issue is delegatable — it carries `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` and `## Boundary`, in that order.

### User Story 2 - workspace-volume itself is settled (P1)

[NEEDS CLARIFICATION: the operator must write the Given/When/Then that settles `workspace-volume`; this skeleton carries the evidence, not the plan.]

## Requirements

- **FR-001**: The blocker recorded above MUST be resolved, or explicitly waived by the operator, before this task is worked.
- **FR-002**: The operator MUST trim the Boundary below to exactly the files this task may touch, and MUST replace an `UNKNOWN` Boundary with named files before the issue is filed.
- **FR-003**: The evidence quoted above MUST travel with the issue unedited, in its redacted form.
- **FR-004**: The filed issue MUST be in English.

## Success Criteria

- The four required headings appear in the filed issue in this order: User Scenarios & Testing, Requirements, Success Criteria, Boundary.
- The Boundary names files, one per line, or carries the single line `UNKNOWN - the operator must name the files`.
- [NEEDS CLARIFICATION: the operator must add the criterion that settles `workspace-volume` — a command and its exit code, a count, or a log line to grep for.]

## Boundary

`Dockerfile`
