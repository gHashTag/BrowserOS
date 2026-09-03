# ascii-purity-law

- **Label**: L3 ASCII purity: stated in three places, measured in none
- **Status**: blocked
- **Layer**: runtime
- **Blocked by**: no gate was ever built, and the spec was never amended to retire the law
- **Generated from**: `.trinity/dashboard/tech-tree.json` by `tools/tree-to-briefs.mjs` — a skeleton the operator finishes and files; the generator itself files nothing.

> Evidence, verbatim from the tree (home directories redacted):
>
> Measured today: 37 of 206 .swift files under rings/ and BR-OUTPUT/ contain non-ASCII (BR-OUTPUT/SmoothStreamingEnhancements.swift:55 carries a Russian comment in shipped source; rings/SR-02/ChatViewModel.swift has ~491 such lines), and 5 of 31 SKILL.md files do too. `grep -ciE ascii Makefile build.sh` = 0 and no .github workflow mentions it. The law is asserted at .trinity/specs/ascii-purity.md:4 (which explicitly extends it to .claude/skills/*/*.md), AGENTS.md:154, and the ascii-lint skill.

> Note, verbatim from the tree (home directories redacted):
>
> Either the law was retired without amending its spec, or the gate was never built. The newest and best skills are among the files breaking it.

## User Scenarios & Testing

### User Story 1 - Filing this node is mechanical, not authoring (P1)

**Why this priority**: the technology tree holds `ascii-purity-law` as `blocked`, and the Queen's candidate list reads open GitHub issues only — no code path turns a tree node into work until this brief is filed.

**Independent Test**: the filed issue body carries the four headings below, in order, and its Boundary names files or the single `UNKNOWN` line.

**Acceptance Scenarios**:
1. **Given** this brief as generated,
   **When** the operator pastes it into a new issue and trims the Boundary to the files the task may actually touch,
   **Then** the issue is delegatable — it carries `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` and `## Boundary`, in that order.

### User Story 2 - ascii-purity-law itself is settled (P1)

[NEEDS CLARIFICATION: the operator must write the Given/When/Then that settles `ascii-purity-law`; this skeleton carries the evidence, not the plan.]

## Requirements

- **FR-001**: The blocker recorded above MUST be resolved, or explicitly waived by the operator, before this task is worked.
- **FR-002**: The operator MUST trim the Boundary below to exactly the files this task may touch, and MUST replace an `UNKNOWN` Boundary with named files before the issue is filed.
- **FR-003**: The evidence quoted above MUST travel with the issue unedited, in its redacted form.
- **FR-004**: The filed issue MUST be in English.

## Success Criteria

- The four required headings appear in the filed issue in this order: User Scenarios & Testing, Requirements, Success Criteria, Boundary.
- The Boundary names files, one per line, or carries the single line `UNKNOWN - the operator must name the files`.
- [NEEDS CLARIFICATION: the operator must add the criterion that settles `ascii-purity-law` — a command and its exit code, a count, or a log line to grep for.]

## Boundary

`BR-OUTPUT/SmoothStreamingEnhancements.swift`
`rings/SR-02/ChatViewModel.swift`
`SKILL.md`
`Makefile`
`build.sh`
`.trinity/specs/ascii-purity.md`
`AGENTS.md`
