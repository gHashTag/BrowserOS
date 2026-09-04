# ring00-silicon

- **Label**: Ring 00 on silicon: simulated, never synthesised
- **Status**: blocked
- **Layer**: silicon
- **Blocked by**: no board is allocated to the Queen's rings, and trios invokes no synthesis tool
- **Generated from**: `.trinity/dashboard/tech-tree.json` by `tools/tree-to-briefs.mjs` — a skeleton the operator finishes and files; the generator itself files nothing.

> Evidence, verbatim from the tree (home directories redacted):
>
> Simulated and green: `bash tests/t27/ring00_verilog.sh` -> '[OK] ring00_verilog: 14 rows checked, simulation answers the Swift table / generated from rings/T27-00/queen_core.t27, compiled with iverilog, run under vvp' - the same 14-row table as the Rust parity harness by design. Not synthesised: `grep -rn 'yosys|nextpnr|openFPGALoader' --include=Makefile --include='*.sh' --include='*.swift'` over trios returns ZERO hits, although all three tools resolve on this machine. docs/t27/stands.md:13-15: 'The Zynq xc7z020 stand runs tri-net. The Queen's rings do not go there.'

> Note, verbatim from the tree (home directories redacted):
>
> The iverilog run is the strongest evidence in the tree for one-rule-many-targets. But the t27-backend skill's own rule - 'Verify on hardware, never by reading the Verilog' - is unmet for ring 00, and queen_core.t27:23-25's claim that 'it can be synthesised without argument' is unverified here.

## User Scenarios & Testing

### User Story 1 - Filing this node is mechanical, not authoring (P1)

**Why this priority**: the technology tree holds `ring00-silicon` as `blocked`, and the Queen's candidate list reads open GitHub issues only — no code path turns a tree node into work until this brief is filed.

**Independent Test**: the filed issue body carries the four headings below, in order, and its Boundary names files or the single `UNKNOWN` line.

**Acceptance Scenarios**:
1. **Given** this brief as generated,
   **When** the operator pastes it into a new issue and trims the Boundary to the files the task may actually touch,
   **Then** the issue is delegatable — it carries `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` and `## Boundary`, in that order.

### User Story 2 - ring00-silicon itself is settled (P1)

[NEEDS CLARIFICATION: the operator must write the Given/When/Then that settles `ring00-silicon`; this skeleton carries the evidence, not the plan.]

## Requirements

- **FR-001**: The blocker recorded above MUST be resolved, or explicitly waived by the operator, before this task is worked.
- **FR-002**: The operator MUST trim the Boundary below to exactly the files this task may touch, and MUST replace an `UNKNOWN` Boundary with named files before the issue is filed.
- **FR-003**: The evidence quoted above MUST travel with the issue unedited, in its redacted form.
- **FR-004**: The filed issue MUST be in English.

## Success Criteria

- The four required headings appear in the filed issue in this order: User Scenarios & Testing, Requirements, Success Criteria, Boundary.
- The Boundary names files, one per line, or carries the single line `UNKNOWN - the operator must name the files`.
- [NEEDS CLARIFICATION: the operator must add the criterion that settles `ring00-silicon` — a command and its exit code, a count, or a log line to grep for.]

## Boundary

`tests/t27/ring00_verilog.sh`
`rings/T27-00/queen_core.t27`
`Makefile`
`docs/t27/stands.md`
