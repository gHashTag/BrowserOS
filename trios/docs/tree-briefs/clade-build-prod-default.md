# clade-build-prod-default

- **Label**: clade-build: a second builder that defaults to prod and has no dev arm
- **Status**: blocked
- **Layer**: ring
- **Blocked by**: resolve_variant has only a staging arm and an else that writes prod; five skills still tell an agent to run it bare
- **Generated from**: `.trinity/dashboard/tech-tree.json` by `tools/tree-to-briefs.mjs` — a skeleton the operator finishes and files; the generator itself files nothing.

> Evidence, verbatim from the tree (home directories redacted):
>
> Read today: rings/RUST-01/clade-build/src/main.rs:54 `env::var("TRIOS_VARIANT").unwrap_or_else(|_| "prod".into())`; resolve_variant at :330 tests only `name == "staging"` and otherwise returns prod writing {project_dir()}/trios.app at :347; its own unit test at :551 is named resolve_variant_unknown_defaults_to_prod. Against it: build.sh:19 `VARIANT="${TRIOS_VARIANT:-dev}"` and build.sh:32 hard-rejects 'staging'. `grep -c clade-build Makefile` = 0.

> Note, verbatim from the tree (home directories redacted):
>
> THE HEADLINE HAZARD. Running it as doctor, clade-seal, t27-tri-pipeline, t27-phi-loop and phi-loop instruct replaces the app the user is running - the exact accident build.sh:10-12 and the agent-safe-build skill exist to prevent. `TRIOS_VARIANT=dev cargo run --bin clade-build` also builds prod, because no dev arm exists.

## User Scenarios & Testing

### User Story 1 - Filing this node is mechanical, not authoring (P1)

**Why this priority**: the technology tree holds `clade-build-prod-default` as `blocked`, and the Queen's candidate list reads open GitHub issues only — no code path turns a tree node into work until this brief is filed.

**Independent Test**: the filed issue body carries the four headings below, in order, and its Boundary names files or the single `UNKNOWN` line.

**Acceptance Scenarios**:
1. **Given** this brief as generated,
   **When** the operator pastes it into a new issue and trims the Boundary to the files the task may actually touch,
   **Then** the issue is delegatable — it carries `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` and `## Boundary`, in that order.

### User Story 2 - clade-build-prod-default itself is settled (P1)

[NEEDS CLARIFICATION: the operator must write the Given/When/Then that settles `clade-build-prod-default`; this skeleton carries the evidence, not the plan.]

## Requirements

- **FR-001**: The blocker recorded above MUST be resolved, or explicitly waived by the operator, before this task is worked.
- **FR-002**: The operator MUST trim the Boundary below to exactly the files this task may touch, and MUST replace an `UNKNOWN` Boundary with named files before the issue is filed.
- **FR-003**: The evidence quoted above MUST travel with the issue unedited, in its redacted form.
- **FR-004**: The filed issue MUST be in English.

## Success Criteria

- The four required headings appear in the filed issue in this order: User Scenarios & Testing, Requirements, Success Criteria, Boundary.
- The Boundary names files, one per line, or carries the single line `UNKNOWN - the operator must name the files`.
- [NEEDS CLARIFICATION: the operator must add the criterion that settles `clade-build-prod-default` — a command and its exit code, a count, or a log line to grep for.]

## Boundary

`rings/RUST-01/clade-build/src/main.rs`
`build.sh`
`Makefile`
