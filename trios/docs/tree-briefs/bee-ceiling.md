# bee-ceiling

- **Label**: Raise the bee ceiling: cap 4 -> 19, after key rotation and process-group kills
- **Status**: planned
- **Layer**: supervisor
- **Generated from**: `.trinity/dashboard/tech-tree.json` by `tools/tree-to-briefs.mjs` — a skeleton the operator finishes and files; the generator itself files nothing.

> Evidence, verbatim from the tree (home directories redacted):
>
> Confirmed today: rings/SR-00/QueenDelegation.swift:470 `public static let maximumConcurrentWorkers = 4`, against a container that took 96 concurrent calls with no degradation (CLOUD-MIGRATION.md:1047 shows the cap firing: 'refusal: 4 workers already running (limit 4)'). PARALLEL-BEES.md:136-147 orders the prerequisites: multi-key rotation exists at ModelConfigurationStore+KeyRotation.swift:44-59 and has NO caller on the request path (its only callers are a UI toggle in ModelsTabView.swift), while QueenRetryPolicy.swift:88-108 classifies a 429 as producedNothing and :67 retires the issue after two.

> Note, verbatim from the tree (home directories redacted):
>
> PARALLEL-BEES refutes the cap's own stated reasons: verdicts are one-shot requests with empty history, and merge conflicts are already handled structurally by pathsOverlap/conflictingTasks. It is a policy number, not a measured limit. Item 1 of that list is already done: awaitingReview boundaries age out after 48h (QueenDelegation.swift:572), which ended 13 consecutive ticks that ran zero bees.

## User Scenarios & Testing

### User Story 1 - Filing this node is mechanical, not authoring (P1)

**Why this priority**: the technology tree holds `bee-ceiling` as `planned`, and the Queen's candidate list reads open GitHub issues only — no code path turns a tree node into work until this brief is filed.

**Independent Test**: the filed issue body carries the four headings below, in order, and its Boundary names files or the single `UNKNOWN` line.

**Acceptance Scenarios**:
1. **Given** this brief as generated,
   **When** the operator pastes it into a new issue and trims the Boundary to the files the task may actually touch,
   **Then** the issue is delegatable — it carries `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` and `## Boundary`, in that order.

### User Story 2 - bee-ceiling itself is settled (P1)

[NEEDS CLARIFICATION: the operator must write the Given/When/Then that settles `bee-ceiling`; this skeleton carries the evidence, not the plan.]

## Requirements

- **FR-001**: The operator MUST trim the Boundary below to exactly the files this task may touch, and MUST replace an `UNKNOWN` Boundary with named files before the issue is filed.
- **FR-002**: The evidence quoted above MUST travel with the issue unedited, in its redacted form.
- **FR-003**: The filed issue MUST be in English.

## Success Criteria

- The four required headings appear in the filed issue in this order: User Scenarios & Testing, Requirements, Success Criteria, Boundary.
- The Boundary names files, one per line, or carries the single line `UNKNOWN - the operator must name the files`.
- [NEEDS CLARIFICATION: the operator must add the criterion that settles `bee-ceiling` — a command and its exit code, a count, or a log line to grep for.]

## Boundary

`rings/SR-00/QueenDelegation.swift`
`CLOUD-MIGRATION.md`
`PARALLEL-BEES.md`
`ModelConfigurationStore+KeyRotation.swift`
`ModelsTabView.swift`
`QueenRetryPolicy.swift`
