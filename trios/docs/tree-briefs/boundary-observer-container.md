# boundary-observer-container

- **Label**: Write-time boundary enforcement in the container
- **Status**: blocked
- **Layer**: supervisor
- **Blocked by**: the observer exists only on the Mac, and the cassette that would prove it fires is one of the four blocked by the main.swift launch Task
- **Generated from**: `.trinity/dashboard/tech-tree.json` by `tools/tree-to-briefs.mjs` — a skeleton the operator finishes and files; the generator itself files nothing.

> Evidence, verbatim from the tree (home directories redacted):
>
> `grep -rln 'queen.observer.outOfBounds'` over the whole tree returns exactly one file, confirmed today: rings/SR-02/ChatViewModel.swift. Nothing in agent-server emits it. CLOUD-MIGRATION.md:956-968: #1244 declared one path, the commit carried two, 'Nothing noticed. The log has no queen.observer.outOfBounds for it.'

> Note, verbatim from the tree (home directories redacted):
>
> The first real cloud bee did precisely the thing those cassettes exist to catch, and the catching is the broken part. The document's own closing line: 'the loop runs, and its supervision has a measured hole in it.'

## User Scenarios & Testing

### User Story 1 - Filing this node is mechanical, not authoring (P1)

**Why this priority**: the technology tree holds `boundary-observer-container` as `blocked`, and the Queen's candidate list reads open GitHub issues only — no code path turns a tree node into work until this brief is filed.

**Independent Test**: the filed issue body carries the four headings below, in order, and its Boundary names files or the single `UNKNOWN` line.

**Acceptance Scenarios**:
1. **Given** this brief as generated,
   **When** the operator pastes it into a new issue and trims the Boundary to the files the task may actually touch,
   **Then** the issue is delegatable — it carries `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` and `## Boundary`, in that order.

### User Story 2 - boundary-observer-container itself is settled (P1)

[NEEDS CLARIFICATION: the operator must write the Given/When/Then that settles `boundary-observer-container`; this skeleton carries the evidence, not the plan.]

## Requirements

- **FR-001**: The blocker recorded above MUST be resolved, or explicitly waived by the operator, before this task is worked.
- **FR-002**: The operator MUST trim the Boundary below to exactly the files this task may touch, and MUST replace an `UNKNOWN` Boundary with named files before the issue is filed.
- **FR-003**: The evidence quoted above MUST travel with the issue unedited, in its redacted form.
- **FR-004**: The filed issue MUST be in English.

## Success Criteria

- The four required headings appear in the filed issue in this order: User Scenarios & Testing, Requirements, Success Criteria, Boundary.
- The Boundary names files, one per line, or carries the single line `UNKNOWN - the operator must name the files`.
- [NEEDS CLARIFICATION: the operator must add the criterion that settles `boundary-observer-container` — a command and its exit code, a count, or a log line to grep for.]

## Boundary

`rings/SR-02/ChatViewModel.swift`
`CLOUD-MIGRATION.md`
