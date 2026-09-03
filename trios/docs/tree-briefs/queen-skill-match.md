# queen-skill-match

- **Label**: Skill routing reaches 2 of 31 skills - the rules are dead on case
- **Status**: blocked
- **Layer**: supervisor
- **Blocked by**: a case bug: skill(forBoundary:) lowercases the path at line 54 and then applies case-sensitive uppercase patterns at lines 24-27
- **Generated from**: `.trinity/dashboard/tech-tree.json` by `tools/tree-to-briefs.mjs` — a skeleton the operator finishes and files; the generator itself files nothing.

> Evidence, verbatim from the tree (home directories redacted):
>
> Read in full today. rings/SR-00/QueenSkillMatch.swift:54 `let lower = path.lowercased()` then :55 `rules.first(where: { $0.matches(lower) })`. The rules at :24-27 include `$0.hasSuffix("Tests.swift")`, `$0.hasSuffix("Makefile")` and `$0.contains("rings/RUST-")` - none can ever match a lowercased string. Only tests/, build.sh and .swift survive, so e2e-testing and agent-safe-build are the only reachable skills of 31 installed. A rings/RUST- boundary matches nothing, hits `guard let match ... else { return nil }` and gets NO skill.

> Note, verbatim from the tree (home directories redacted):
>
> tests/swift/ChatSSEEndToEndTest.swift:8065 says 'the Rust rule was dead from the moment it was written' - it was fixed for the name and is still dead for the case, and no test covers a rings/RUST- boundary. The file's own doc comment still says 'Twenty-six of them'; there are 31. One of the three skills the rules name, t27-tri-pipeline, is among the most stale in the library - so the one live routing path leads to a skill that would overwrite the user's app.

## User Scenarios & Testing

### User Story 1 - Filing this node is mechanical, not authoring (P1)

**Why this priority**: the technology tree holds `queen-skill-match` as `blocked`, and the Queen's candidate list reads open GitHub issues only — no code path turns a tree node into work until this brief is filed.

**Independent Test**: the filed issue body carries the four headings below, in order, and its Boundary names files or the single `UNKNOWN` line.

**Acceptance Scenarios**:
1. **Given** this brief as generated,
   **When** the operator pastes it into a new issue and trims the Boundary to the files the task may actually touch,
   **Then** the issue is delegatable — it carries `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` and `## Boundary`, in that order.

### User Story 2 - queen-skill-match itself is settled (P1)

[NEEDS CLARIFICATION: the operator must write the Given/When/Then that settles `queen-skill-match`; this skeleton carries the evidence, not the plan.]

## Requirements

- **FR-001**: The blocker recorded above MUST be resolved, or explicitly waived by the operator, before this task is worked.
- **FR-002**: The operator MUST trim the Boundary below to exactly the files this task may touch, and MUST replace an `UNKNOWN` Boundary with named files before the issue is filed.
- **FR-003**: The evidence quoted above MUST travel with the issue unedited, in its redacted form.
- **FR-004**: The filed issue MUST be in English.

## Success Criteria

- The four required headings appear in the filed issue in this order: User Scenarios & Testing, Requirements, Success Criteria, Boundary.
- The Boundary names files, one per line, or carries the single line `UNKNOWN - the operator must name the files`.
- [NEEDS CLARIFICATION: the operator must add the criterion that settles `queen-skill-match` — a command and its exit code, a count, or a log line to grep for.]

## Boundary

`rings/SR-00/QueenSkillMatch.swift`
`Tests.swift`
`Makefile`
`build.sh`
`tests/swift/ChatSSEEndToEndTest.swift`
