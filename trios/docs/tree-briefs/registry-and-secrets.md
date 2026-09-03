# registry-and-secrets

- **Label**: Mac -> cloud address and token: registry mirror and lease contention
- **Status**: blocked
- **Layer**: supervisor
- **Blocked by**: an unpaid operator secret - neither app bundle carries TRIOS_AGENT_SERVER_URL or TRIOS_QUEEN_LEASE_URL, so the mirror never publishes and the Mac never contends
- **Generated from**: `.trinity/dashboard/tech-tree.json` by `tools/tree-to-briefs.mjs` — a skeleton the operator finishes and files; the generator itself files nothing.

> Evidence, verbatim from the tree (home directories redacted):
>
> Measured on the running app (pid 41623): `ps -Eww | grep '^TRIOS_'` returns nothing, and PlistBuddy on trios.app and trios-dev.app lists only TRIOS_A2A_PORT, TRIOS_CANARY_MCP_PORT, TRIOS_VARIANT, TRIOS_MCP_PORT, TRIOS_MESH_PORT. So ProjectPaths.agentServerIsRemote is false (:197-199), QueenDelegationRegistry.swift:717 returns at its guard, and QueenLease.endpoint is nil so acquire returns .uncontested (QueenLease.swift:39-44). The tick then refuses at queen-tick.ts:231-235 with 'no registry mirror published yet'. `grep -n TRIOS_AGENT_SERVER_URL build.sh` returns nothing.

> Note, verbatim from the tree (home directories redacted):
>
> QueenLease.swift:31-37 names the consequence itself: 'an unconfigured Mac standing beside a running cloud tick is two Queens - and this case is what that looks like from here.' Deliberate per CLOUD-MIGRATION.md:546-561: 'the address goes in when the token does, in that order.'

## User Scenarios & Testing

### User Story 1 - Filing this node is mechanical, not authoring (P1)

**Why this priority**: the technology tree holds `registry-and-secrets` as `blocked`, and the Queen's candidate list reads open GitHub issues only — no code path turns a tree node into work until this brief is filed.

**Independent Test**: the filed issue body carries the four headings below, in order, and its Boundary names files or the single `UNKNOWN` line.

**Acceptance Scenarios**:
1. **Given** this brief as generated,
   **When** the operator pastes it into a new issue and trims the Boundary to the files the task may actually touch,
   **Then** the issue is delegatable — it carries `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` and `## Boundary`, in that order.

### User Story 2 - registry-and-secrets itself is settled (P1)

[NEEDS CLARIFICATION: the operator must write the Given/When/Then that settles `registry-and-secrets`; this skeleton carries the evidence, not the plan.]

## Requirements

- **FR-001**: The blocker recorded above MUST be resolved, or explicitly waived by the operator, before this task is worked.
- **FR-002**: The operator MUST trim the Boundary below to exactly the files this task may touch, and MUST replace an `UNKNOWN` Boundary with named files before the issue is filed.
- **FR-003**: The evidence quoted above MUST travel with the issue unedited, in its redacted form.
- **FR-004**: The filed issue MUST be in English.

## Success Criteria

- The four required headings appear in the filed issue in this order: User Scenarios & Testing, Requirements, Success Criteria, Boundary.
- The Boundary names files, one per line, or carries the single line `UNKNOWN - the operator must name the files`.
- [NEEDS CLARIFICATION: the operator must add the criterion that settles `registry-and-secrets` — a command and its exit code, a count, or a log line to grep for.]

## Boundary

`QueenDelegationRegistry.swift`
`QueenLease.swift`
`queen-tick.ts`
`build.sh`
`CLOUD-MIGRATION.md`
