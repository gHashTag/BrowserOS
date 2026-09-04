# Tree evidence re-check

Produced by `node trios/tools/tree-evidence-recheck.mjs` on 2026-09-03. Re-running the tool regenerates this file.

The technology tree `.trinity/dashboard/tech-tree.json` is the Queen's own route from measurement to work, and most of its evidence strings quote the command that produced them. This report re-runs what can be re-run and compares, so a node whose evidence no longer describes today's tree is named before it can dispatch a bee at a defect that no longer exists.

## How this was checked

- **Allowed commands (the only ones re-run; FR-002):** grep, ls, find, wc, git grep, git ls-tree. A quoted command outside that list is reported `unverifiable` and **not executed** — evidence text is data, and executing arbitrary strings out of a data file is how a data file becomes a shell.
- **Every re-run command is printed with its output** (FR-003), so this report can be checked without trusting the checker.
- **A command that errors is `unverifiable`, never `holds`** (FR-004). `grep` exiting 1 ("no lines selected") is a result, not an error.
- **tech-tree.json was not modified (FR-001).** It was opened read-only and never written; sha256 of the file before the run:
  `25d15972958d669f0613242ec81924abb60c5d845200e634241778f2c2ffffef`
  and after the run: `25d15972958d669f0613242ec81924abb60c5d845200e634241778f2c2ffffef` — identical. Correcting a node is a judgement; this reports, a human decides.
- **Reads nothing outside the repository (FR-005).** Node standard library only; every path operand is resolved inside the repository root before anything is spawned; absolute or `..`-escaping operands are rejected.
- When a recorded grep names no path ("over the whole tree"), the re-run adds `.` plus `--exclude-dir`/`--exclude` flags for `.git`, `node_modules`, `.worktrees` and this checker's own two files, so the working tree is what gets compared and two runs of this tool cannot differ by their own output. The command **as actually run** is printed in full.
- **Verdict rule per node:** `DIVERGED` if any check diverged; otherwise `holds` if at least one check re-ran and matched; otherwise `unverifiable` (a finding about the node, not a failure of the checker). Checks cover the node's `evidence` field — quoted commands and `file:line` references — and nothing else.

## Node count — every node is covered

- Checker (JSON `nodes` array): **40** nodes.
- Independent command over the same file:

  ```
  $ grep -c "id": .trinity/dashboard/tech-tree.json
  40
  ```

- Both agree: **40 = 40**, and every one of them is grouped below.

## Result

| group | count |
| --- | --- |
| holds | 29 |
| DIVERGED | 6 |
| unverifiable | 5 |
| **total** | **40** (= node count above) |

## DIVERGED (6) — the evidence no longer matches today's tree

### mvp-dod-and-epics — status partial, layer seed

- evidence (recorded): Queen_T27_MVP_Architecture.md:2834 (S23): `grep -c '^- \[ \]'` = 29 and `grep -c '^- \[x\]'` = 0. Epics at :1829-2484, milestones at :2510-2590, an eight-issue first batch at :3105-3119, the 12-step vertical slice at :1769-1782. STATUS.md:11 instead claims '2 of 29 criteria done (re-classified 2026-08-27)'.

- verdict: **DIVERGED** — quoted text no longer present in the file (not verbatim, and its distinctive words do not co-occur anywhere) — quote: “2 of 29 criteria done (re-classified 2026-08-27)”
  - [unverifiable] command `grep -c '^- \[ \]'` — command errored on re-run (exit 2: grep: .: Is a directory); an error is never 'holds' (FR-004)
      $ grep -c '^- \[ \]' .
          (the recorded command names no path ('over the whole tree'); re-run over '.')
          -> exit 2
      0

      [stderr] grep: .: Is a directory
  - [unverifiable] command `grep -c '^- \[x\]'` — command errored on re-run (exit 2: grep: .: Is a directory); an error is never 'holds' (FR-004)
      $ grep -c '^- \[x\]' .
          (the recorded command names no path ('over the whole tree'); re-run over '.')
          -> exit 2
      0

      [stderr] grep: .: Is a directory
  - [holds] reference Queen_T27_MVP_Architecture.md:2834 — file present with at least that many lines (no quoted text followed the reference to check)
    docs/architecture/Queen_T27_MVP_Architecture.md — 3262 lines (evidence cites :2834)
  - [DIVERGED] reference STATUS.md:11 — quoted text no longer present in the file (not verbatim, and its distinctive words do not co-occur anywhere) — quote: “2 of 29 criteria done (re-classified 2026-08-27)”
    .trinity/dashboard/STATUS.md — 223 lines (evidence cites :11)

### t27c-mut-emit — status blocked, layer seed

- evidence (recorded): Makefile:940-945 names it the chief remaining cause of the 11 non-compiling generated files; STATUS.md:102-121 measures 'Eight errors are that omission'. wave-loop-114.md W2 lists it as one of exactly two ownership boundaries still open.

- verdict: **DIVERGED** — quoted text no longer on/near :102 — found at ~line 175 — quote: “Eight errors are that omission”
  - [holds] reference Makefile:940-945 — file present with at least that many lines (no quoted text followed the reference to check)
    Makefile — 5744 lines (evidence cites :945)
  - [DIVERGED] reference STATUS.md:102-121 — quoted text no longer on/near :102 — found at ~line 175 — quote: “Eight errors are that omission”
    .trinity/dashboard/STATUS.md — 223 lines (evidence cites :121)

### mesh-generated-code-dead — status blocked, layer ring

- evidence (recorded): rings/RUST-13/trios-mesh/src/lib.rs:3-5 - 'The hand-written modules below are the current runtime surface. The generated gen/rust/ stubs are excluded from compilation.' The four shipping modules - crypto.rs (948 lines), router.rs (927), routing.rs (480), wire.rs (155) - are exactly the four categories that submodule's own CLAUDE.md lists as FORBIDDEN to write by hand. build.rs:15-18 looks for t27c at ../t27/target/release/t27c, which does not exist, and returns early in silence. STATUS.md:97-101: 46 of 68 committed artifacts differ from a fresh gen-rust.

- verdict: **DIVERGED** — file not present in this tree (its parent rings/RUST-13/trios-mesh exists but is empty here — an unchecked-out submodule or a directory this checkout does not carry)
  - [DIVERGED] reference rings/RUST-13/trios-mesh/src/lib.rs:3-5 — file not present in this tree (its parent rings/RUST-13/trios-mesh exists but is empty here — an unchecked-out submodule or a directory this checkout does not carry)
  - [unverifiable] reference build.rs:15-18 — no file of this name anywhere in the repository — it likely lives outside (e.g. an unversioned document), which the checker cannot read (FR-005)
  - [holds] reference STATUS.md:97-101 — file present with at least that many lines (no quoted text followed the reference to check)
    .trinity/dashboard/STATUS.md — 223 lines (evidence cites :101)

### t27-rings-02-03-04 — status planned, layer ring

- evidence (recorded): `ls -d rings/T27-*` returns exactly rings/T27-00 and rings/T27-01, run today. `grep -rn 'T27-02' .trinity/ .claude/ docs/` has one hit in the whole tree: the t27-backend skill's own ring table at SKILL.md:33. T27-04 has a design doc and nothing else: docs/t27/tnf-scoring.md:1-7, which disclaims implementation ('no .t27 module in this repository uses it').

- verdict: **DIVERGED** — recorded count 1, today 14
  - [holds] command `ls -d rings/T27-*` — still exactly: rings/T27-00, rings/T27-01
      $ ls -d rings/T27-00 rings/T27-01
          -> exit 0
      rings/T27-00
      rings/T27-01

  - [DIVERGED] command `grep -rn 'T27-02' .trinity/ .claude/ docs/` — recorded count 1, today 14
      $ grep -rn T27-02 .trinity .claude docs --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.worktrees --exclude=tree-evidence-recheck.mjs --exclude=tree-evidence-report.md
          (checker added --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.worktrees --exclude=tree-evidence-recheck.mjs --exclude=tree-evidence-report.md so .git/, dependency trees and this checker's own outputs are not mistaken for the working tree (and so re-runs are stable))
          -> exit 0
      .trinity/wave-loop-116.md:11:  спека T27-02 (Queen tick), сгенерированные .rs под T27-*, хостящий
      .trinity/wave-loop-116.md:43:  1b rings-спеки (t27c не блокер; нужны спека T27-02, .rs, крейт;
      .trinity/wave-loop-116.md:53:  содержит `can_start_another`; T27-02 каталога нет.
      .trinity/wave-loop-116.md:72:3. **Движение в ~/t27 или по rings** (T27-02, крейт, .rs) → tri
      .trinity/dashboard/STATUS.md:208:(223 lines) exist; T27-02 (the Queen tick) does not; zero generated .rs
      .trinity/dashboard/iterations.jsonl:218:{"iteration": 219, "ts": "2026-09-01T00:15:00Z", "title": "tick skipped - MAJOR queue update: t27c measured NOT the blocker", "failures_first": ["Board/handover t27 narrative is stale: neighbour 5d837a855 measured t27c exit 0 + 121 lines Rust on RING-00 decision core - the blocker is NOT the generator for RING-00; what is missing: T27-02 spec (Queen tick), generated .rs artifacts, hosting Rust crate; can_start_another duplicated queen_core.t27:198 + QueenDelegation.swift:472; cloud bees cannot do ring work (bun image, no Swift/Rust/t27c)."], "did": ["Skipped per rule (last commit 6d3b9dcc7 27s ago - round guessed wrong repo/checkout). Captured t27 boundary reshape from 5d837a855 for next full wave: fold into STATUS.md + tri handover. Cassette fix still not landed."], "next": ["Full wave when window opens: (1) fold t27 measurement into board/handover, (2) cassette re-measure if fix landed, (3) board compile refresh floor 15."], "gate": "skip per protocol rule"}
      .trinity/dashboard/iterations.jsonl:220:{"iteration": 221, "ts": "2026-09-01T00:55:00Z", "title": "wave 116 - t27 split folded into board + handover", "failures_first": ["STATUS.md cassettes block contradicted ITSELF: root cause (backtick 4d56070ef) named at top, tail still prescribed fs_usage as the cure - stale residue of a partial wave-113 edit; fixed this wave", "Cassette fix still not landed - 4 real failures stand, no re-measure without the fix"], "did": ["STATUS.md: TWO t27 populations section (mesh-submodule corpus vs rings T27-00/01/02) with file:line evidence (queen_core.t27:198, QueenDelegation.swift:472); t27c measured NOT the rings blocker (5d837a855)", "STATUS.md: MVP section header now cites in-repo docs/architecture copy (6d1d50656)", "tri handover: two boundaries -> three (1a mesh mut-emit, 1b rings artifacts+T27-02+crate, 2 release); wave 116 report written"], "next": ["Cassette fix lands -> flat make cassettes first green; quiet window -> re-measure board live numbers; t27/rings motion -> tri spec-diag"], "gate": "bash -n tri OK + live tri handover run read clean; STATUS.md references verified against tree (arch doc exists, T27-00:198, no T27-02 dir)"}
      .trinity/dashboard/tech-tree.json:145:      "label": "T27-02 orchestration / T27-03 transport / T27-04 TNF scoring",
      .trinity/dashboard/tech-tree.json:148:      "evidence": "`ls -d rings/T27-*` returns exactly rings/T27-00 and rings/T27-01, run today. `grep -rn 'T27-02' .trinity/ .claude/ docs/` has one hit in the whole tree: the t27-backend skill's own ring table at SKILL.md:33. T27-04 has a design doc and nothing else: docs/t27/tnf-scoring.md:1-7, which disclaims implementation ('no .t27 module in this repository uses it').",
      .trinity/dashboard/tech-tree.json:542:    "T27 RING TABLE. The t27-backend skill lists rings T27-00 through T27-04; `ls -d rings/T27-*` returns two directories and `grep -rn 'T27-02'` over .trinity/, .claude/ and docs/ has one hit - the skill's own table. Also stale in the same skill: '14 of 1286 emitted functions are unimplemented!() stubs' against a measured 1300 emitted, 0 stubs.",
      .trinity/dashboard/tech-tree.json:575:      "shouldSay": "Measured today over the same 70 specs: 1300 emitted, 0 stubs - the skill's own later 'gaps measured 2026-08-28' section made the earlier paragraph stale. And only T27-00 and T27-01 exist; T27-02/03/04 appear nowhere in the tree except that table. Otherwise the best-evidenced skill in the library."
      .claude/skills/t27-backend/SKILL.md:62:| **T27-02** | Orchestration: the Queen's tick, delegation, review sweep, bounded send-back | 00, 01 | Rust + inngest |
      .claude/skills/t27-backend/SKILL.md:78:| `rings/T27-02` — the Queen's tick | **does not exist**, never started |
      .claude/skills/t27-backend/SKILL.md:123:- The honest next step is `rings/T27-02` — orchestration — because that ring is

  - [unverifiable] reference SKILL.md:33 — bare name matches 54 files (.claude/skills/agent-safe-build/SKILL.md, .claude/skills/ascii-lint/SKILL.md, .claude/skills/brain-atlas/SKILL.md, .claude/skills/bridge/SKILL.md, …); which one is meant is not machine-decidable
  - [holds] reference docs/t27/tnf-scoring.md:1-7 — file present, ≥ 7 lines; quoted text still on/near :1 — quote: “no .t27 module in this repository uses it”
    docs/t27/tnf-scoring.md — 135 lines (evidence cites :7)

### boundary-observer-container — status blocked, layer supervisor

- evidence (recorded): `grep -rln 'queen.observer.outOfBounds'` over the whole tree returns exactly one file, confirmed today: rings/SR-02/ChatViewModel.swift. Nothing in agent-server emits it. CLOUD-MIGRATION.md:956-968: #1244 declared one path, the commit carried two, 'Nothing noticed. The log has no queen.observer.outOfBounds for it.'

- verdict: **DIVERGED** — recorded 'exactly 1 file'; today 4: ./.trinity/dashboard/CLOUD-MIGRATION.md, ./.trinity/dashboard/tech-tree.json, ./rings/SR-02/ChatViewModel.swift, ./Makefile
  - [DIVERGED] command `grep -rln 'queen.observer.outOfBounds'` — recorded 'exactly 1 file'; today 4: ./.trinity/dashboard/CLOUD-MIGRATION.md, ./.trinity/dashboard/tech-tree.json, ./rings/SR-02/ChatViewModel.swift, ./Makefile
      $ grep -rln queen.observer.outOfBounds . --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.worktrees --exclude=tree-evidence-recheck.mjs --exclude=tree-evidence-report.md
          (the recorded command names no path ('over the whole tree'); re-run over '.')
          (checker added --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.worktrees --exclude=tree-evidence-recheck.mjs --exclude=tree-evidence-report.md so .git/, dependency trees and this checker's own outputs are not mistaken for the working tree (and so re-runs are stable))
          -> exit 0
      ./.trinity/dashboard/CLOUD-MIGRATION.md
      ./.trinity/dashboard/tech-tree.json
      ./rings/SR-02/ChatViewModel.swift
      ./Makefile

  - [holds] reference CLOUD-MIGRATION.md:956-968 — file present, ≥ 968 lines; quoted text still on/near :956 — quote: “Nothing noticed. The log has no queen.observer.outOfBounds f…”
    .trinity/dashboard/CLOUD-MIGRATION.md — 1149 lines (evidence cites :968)

- **what changed** (checker-defined probes, allowlisted and printed like any other command — the recorded evidence predates this code):
  - why: the function that computes which committed files fell outside the boundary
    ```
    $ grep -n boundaryStrays agent-server/apps/server/src/api/services/queen-tick.ts
    1188:async function boundaryStrays(
    1297:    const strays = await boundaryStrays(files, row.owned_paths ?? [])
    ```
  - why: the migration that stores those files per dispatch
    ```
    $ grep -n ADD COLUMN IF NOT EXISTS strays agent-server/apps/server/src/api/services/queen-tick.ts
    254:      ADD COLUMN IF NOT EXISTS strays jsonb NOT NULL DEFAULT '[]'::jsonb;
    ```
  - why: the log line that fires when a bee strays
    ```
    $ grep -n Queen found work outside the boundary she gave agent-server/apps/server/src/api/services/queen-tick.ts
    1300:      logger.warn('Queen found work outside the boundary she gave', {
    ```

  The node's evidence says "Nothing in agent-server emits it" and its `blockedBy` says the observer "exists only on the Mac". The container-side detection now exists in `agent-server/apps/server/src/api/services/queen-tick.ts`: `boundaryStrays()` asks queend which committed files fell outside the boundary, the `strays` jsonb column stores them per dispatch, and `Queen found work outside the boundary she gave` is the warn that fires on one. The Mac-side marker `queen.observer.outOfBounds` still lives only in `rings/SR-02/ChatViewModel.swift` — the recorded grep result of "exactly one file" is stale for a different reason (see the re-run) — but the defect the node describes, no write-time boundary enforcement in the container, is fixed. This node was one edit away from dispatching a bee at a defect that no longer exists.

### registry-and-secrets — status blocked, layer supervisor

- evidence (recorded): Measured on the running app (pid 41623): `ps -Eww | grep '^TRIOS_'` returns nothing, and PlistBuddy on trios.app and trios-dev.app lists only TRIOS_A2A_PORT, TRIOS_CANARY_MCP_PORT, TRIOS_VARIANT, TRIOS_MCP_PORT, TRIOS_MESH_PORT. So ProjectPaths.agentServerIsRemote is false (:197-199), QueenDelegationRegistry.swift:717 returns at its guard, and QueenLease.endpoint is nil so acquire returns .uncontested (QueenLease.swift:39-44). The tick then refuses at queen-tick.ts:231-235 with 'no registry mirror published yet'. `grep -n TRIOS_AGENT_SERVER_URL build.sh` returns nothing.

- verdict: **DIVERGED** — quoted text no longer on/near :231 — found at ~line 674 — quote: “no registry mirror published yet”
  - [unverifiable] command `ps -Eww | grep '^TRIOS_'` — 'ps' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [holds] command `grep -n TRIOS_AGENT_SERVER_URL build.sh` — still no output, as recorded
      $ grep -n TRIOS_AGENT_SERVER_URL build.sh
          -> exit 1 (no output)
  - [holds] reference QueenDelegationRegistry.swift:717 — file present with at least that many lines (no quoted text followed the reference to check)
    rings/SR-02/QueenDelegationRegistry.swift — 760 lines (evidence cites :717)
  - [holds] reference QueenLease.swift:39-44 — file present with at least that many lines (no quoted text followed the reference to check)
    rings/SR-01/QueenLease.swift — 168 lines (evidence cites :44)
  - [DIVERGED] reference queen-tick.ts:231-235 — quoted text no longer on/near :231 — found at ~line 674 — quote: “no registry mirror published yet”
    agent-server/apps/server/src/api/services/queen-tick.ts — 1738 lines (evidence cites :235)

## unverifiable (5) — reported with the reason; a finding about the node

### rust13-trios-mesh — status partial, layer ring

- evidence (recorded): `git submodule status` -> 2257dea0e5, heads/feat/trios-integration. 68 .t27 specs, 68 files in gen/rust/, 84 .rs files / 17363 lines. Measured: 11 of the 68 generated Rust files fail a full `rustc --crate-type lib` build.

- verdict: **unverifiable** — held 0 of 2 checks; unverifiable: command `git submodule status`: 'git submodule' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002); command `rustc --crate-type lib`: 'rustc' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [unverifiable] command `git submodule status` — 'git submodule' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [unverifiable] command `rustc --crate-type lib` — 'rustc' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)

### swift-rings-sr — status shipped, layer ring

- evidence (recorded): 105 + 30 + 19 .swift files; `TRIOS_PRINT_SOURCES=1 ./build.sh` lists every one of them, so all 154 ship in the binary. SR-01 holds transport/storage/log bus (SSETransport, SQLCipherMemoryStore, TriosLogBus, ReplayTransport); SR-02 holds the ViewModels and Queen services.

- verdict: **unverifiable** — held 0 of 1 checks; unverifiable: command `TRIOS_PRINT_SOURCES=1 ./build.sh`: './build.sh' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [unverifiable] command `TRIOS_PRINT_SOURCES=1 ./build.sh` — './build.sh' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)

### t27-01-a2a — status partial, layer ring

- evidence (recorded): rings/T27-01/a2a.t27, 223 lines, 9 fns: gen-rust 9/9 with 0 stubs, Zig 9, Verilog 10, rustc clean. tests/t27/ring01_rules.sh -> '[OK] ring01_rules: the A2A rules hold in the generated Rust'.

- verdict: **unverifiable** — the evidence is prose: no quoted command and no file:line reference to re-check (a finding about the node, not a failure of the checker)

### agent-server-bun — status shipped, layer runtime

- evidence (recorded): Full bun workspace. Nine A2A routes verified at apps/server/src/api/routes/a2a.ts (:70,79,88,100,105,114,123,132,144) with an SSE fan-out at :144 and per-agent buffers at :52,:58. Live tools/list on 127.0.0.1:9105 returned 80 tools including fs_read, fs_write, fs_edit, fs_list and shell_execute; /health returned ok. .github/workflows/code-quality.yml runs biome + typecheck on `paths: trios/agent-server/**` - the only CI in the repository.

- verdict: **unverifiable** — the evidence is prose: no quoted command and no file:line reference to re-check (a finding about the node, not a failure of the checker)

### mission-bee-contracts — status partial, layer supervisor

- evidence (recorded): rings/SR-00/QueenMissionContract.swift and QueenBeeResult.swift exist with unit tests, and QueenBeeResult.swift:471 already computes a loweringGateRequirement naming `make t27-lowering` (:486). Confirmed today that neither has a production caller: `grep -rln 'QueenMissionContract|QueenBeeResult' --include=*.swift` returns only the two files, their two tests and their two Linux twins. `ls .trinity/missions` -> No such file or directory.

- verdict: **unverifiable** — held 0 of 4 checks; unverifiable: command `make t27-lowering`: 'make' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002); command `grep -rln 'QueenMissionContract|QueenBeeResult' --include=*.swift`: command re-ran cleanly, but its recorded result is prose — nothing machine-comparable to compare against (the output above is the current result); command `ls .trinity/missions`: command errored on re-run (exit 2: ls: cannot access '.trinity/missions': No such file or directory); an error is never 'holds' (FR-004); QueenBeeResult.swift:471: bare name matches 2 files (agent-server/queen-core/Sources/QueenCore/QueenBeeResult.swift, rings/SR-00/QueenBeeResult.swift); which one is meant is not machine-decidable
  - [unverifiable] command `make t27-lowering` — 'make' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [unverifiable] command `grep -rln 'QueenMissionContract|QueenBeeResult' --include=*.swift` — command re-ran cleanly, but its recorded result is prose — nothing machine-comparable to compare against (the output above is the current result)
      $ grep -rln --include=*.swift 'QueenMissionContract|QueenBeeResult' . --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.worktrees --exclude=tree-evidence-recheck.mjs --exclude=tree-evidence-report.md
          (the recorded command names no path ('over the whole tree'); re-run over '.')
          (checker added --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.worktrees --exclude=tree-evidence-recheck.mjs --exclude=tree-evidence-report.md so .git/, dependency trees and this checker's own outputs are not mistaken for the working tree (and so re-runs are stable))
          -> exit 1 (no output)
  - [unverifiable] command `ls .trinity/missions` — command errored on re-run (exit 2: ls: cannot access '.trinity/missions': No such file or directory); an error is never 'holds' (FR-004)
      $ ls .trinity/missions
          -> exit 2 (no output)
      [stderr] ls: cannot access '.trinity/missions': No such file or directory
  - [unverifiable] reference QueenBeeResult.swift:471 — bare name matches 2 files (agent-server/queen-core/Sources/QueenCore/QueenBeeResult.swift, rings/SR-00/QueenBeeResult.swift); which one is meant is not machine-decidable

## holds (29) — re-ran and matched

### mvp-architecture-doc — status partial, layer seed

- evidence (recorded): /Users/playra/Downloads/Queen_T27_MVP_Architecture.md, 91776 bytes, mtime 2026-08-23. `git log --all -- '**/Queen_T27_MVP_Architecture.md'` returns nothing and no copy exists under trios/. Referenced from STATUS.md:9, RELEASE-BLOCKER.md:13, rings/SR-00/QueenMissionContract.swift:5 and its Linux twin.

- verdict: **holds** — held 3 of 4 checks; unverifiable: command `git log --all -- '**/Queen_T27_MVP_Architecture.md'`: 'git log' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [unverifiable] command `git log --all -- '**/Queen_T27_MVP_Architecture.md'` — 'git log' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [holds] reference STATUS.md:9 — file present with at least that many lines (no quoted text followed the reference to check)
    .trinity/dashboard/STATUS.md — 223 lines (evidence cites :9)
  - [holds] reference RELEASE-BLOCKER.md:13 — file present with at least that many lines (no quoted text followed the reference to check)
    .trinity/dashboard/RELEASE-BLOCKER.md — 167 lines (evidence cites :13)
  - [holds] reference rings/SR-00/QueenMissionContract.swift:5 — file present with at least that many lines (no quoted text followed the reference to check)
    rings/SR-00/QueenMissionContract.swift — 733 lines (evidence cites :5)

### t27-epic-001-sealing — status partial, layer seed

- evidence (recorded): .trinity/current-issue.md:14-18 - one box checked, four open (pilot RecursionGuard, expand to all BR-OUTPUT, govern Rust rings, enforce via hooks/queue/claims). Measured: 3 seals in .trinity/seals/ (ChatLogic, CladeGuard, RecursionGuard) against 52 BR-OUTPUT/*.swift.

- verdict: **holds** — all 1 check(s) re-ran and matched
  - [holds] reference .trinity/current-issue.md:14-18 — file present with at least that many lines (no quoted text followed the reference to check)
    .trinity/current-issue.md — 32 lines (evidence cites :18)

### t27c — status shipped, layer seed

- evidence (recorded): .trinity/t27c-build/release/t27c (10830368 bytes, 2026-08-23) and /Users/playra/t27/target/release/t27c (2026-08-26). gen-rust / gen / gen-verilog run clean over all 70 specs. Makefile:713 builds it into .trinity/t27c-build so no product lands in the sibling checkout.

- verdict: **holds** — all 1 check(s) re-ran and matched
  - [holds] reference Makefile:713 — file present with at least that many lines (no quoted text followed the reference to check)
    Makefile — 5744 lines (evidence cites :713)

### t27c-frontend-gaps — status blocked, layer seed

- evidence (recorded): Verified verbatim today at /Users/playra/t27/bootstrap/src/compiler.rs:1887-1893 - Parser::parse_fn_body does `Err(_) => { self.recover_to_stmt_boundary(); }`, dropping the error and skipping to the next `;`. STATUS.md:35-48 adds two more: `t27c typecheck` prints FAILED and exits 0 so its only consumer (`suite.rs cmd_typecheck`, which tests `!st.status.success()`) can never fire; and all four gen_* entry points take the raw &Node, so no semantic stage exists between parse and codegen.

- verdict: **holds** — held 1 of 2 checks; unverifiable: /Users/playra/t27/bootstrap/src/compiler.rs:1887-1893: absolute path outside the repository; the checker reads nothing outside it (FR-005)
  - [unverifiable] reference /Users/playra/t27/bootstrap/src/compiler.rs:1887-1893 — absolute path outside the repository; the checker reads nothing outside it (FR-005)
  - [holds] reference STATUS.md:35-48 — file present, ≥ 48 lines; quoted text still on/near :35 — quote: “t27c typecheck”
    .trinity/dashboard/STATUS.md — 223 lines (evidence cites :48)

### clade-build-prod-default — status blocked, layer ring

- evidence (recorded): Read today: rings/RUST-01/clade-build/src/main.rs:54 `env::var("TRIOS_VARIANT").unwrap_or_else(|_| "prod".into())`; resolve_variant at :330 tests only `name == "staging"` and otherwise returns prod writing {project_dir()}/trios.app at :347; its own unit test at :551 is named resolve_variant_unknown_defaults_to_prod. Against it: build.sh:19 `VARIANT="${TRIOS_VARIANT:-dev}"` and build.sh:32 hard-rejects 'staging'. `grep -c clade-build Makefile` = 0.

- verdict: **holds** — all 4 check(s) re-ran and matched
  - [holds] command `grep -c clade-build Makefile` — counted 0, as recorded
      $ grep -c clade-build Makefile
          -> exit 1
      0

  - [holds] reference rings/RUST-01/clade-build/src/main.rs:54 — file present, ≥ 54 lines; quoted text still on/near :54 — quote: “env::var("TRIOS_VARIANT").unwrap_or_else(|_| "prod".into())”
    rings/RUST-01/clade-build/src/main.rs — 556 lines (evidence cites :54)
  - [holds] reference build.sh:19 — file present, ≥ 19 lines; quoted text still on/near :19 — quote: “VARIANT="${TRIOS_VARIANT:-dev}"”
    build.sh — 1193 lines (evidence cites :19)
  - [holds] reference build.sh:32 — file present with at least that many lines (no quoted text followed the reference to check)
    build.sh — 1193 lines (evidence cites :32)

### queen-core-sync-gate — status partial, layer ring

- evidence (recorded): Makefile:1077-1106 compares each rings/SR-00 policy file with its agent-server/queen-core copy via `cmp -s`. Run today: '[FAIL] the Linux copy of the Queen's policy has drifted: DIFFERS QueenLocalisation.swift' - identical at HEAD, so the drift is another agent's uncommitted work. Confirmed wired to nothing: `check:` at Makefile:1931 lists 25 targets and neither queen-core nor queen-core-sync is among them, and no .github workflow mentions it.

- verdict: **holds** — held 2 of 3 checks; unverifiable: command `cmp -s`: 'cmp' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [unverifiable] command `cmp -s` — 'cmp' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [holds] reference Makefile:1077-1106 — file present with at least that many lines (no quoted text followed the reference to check)
    Makefile — 5744 lines (evidence cites :1106)
  - [holds] reference Makefile:1931 — file present with at least that many lines (no quoted text followed the reference to check)
    Makefile — 5744 lines (evidence cites :1931)

### queend-linux-policy — status shipped, layer ring

- evidence (recorded): agent-server/queen-core/Sources/queend/main.swift - stdin/stdout, four question kinds (boundary :102, retry :114, choose :131, language :206), with QueenIssueBoundary.paths at :177 and conflictingTasks at :183-192 producing per-issue refusals. Dockerfile:45 builds it, :53-55 smoke-runs it, :128 copies it to /usr/local/bin/queend; queen-tick.ts:41 consumes it and rejects rather than defaulting when it is missing (:152-165).

- verdict: **holds** — all 2 check(s) re-ran and matched
  - [holds] reference Dockerfile:45 — file present with at least that many lines (no quoted text followed the reference to check)
    agent-server/Dockerfile — 152 lines (evidence cites :45)
  - [holds] reference queen-tick.ts:41 — file present with at least that many lines (no quoted text followed the reference to check)
    agent-server/apps/server/src/api/services/queen-tick.ts — 1738 lines (evidence cites :41)

### rust-clade-crates — status partial, layer ring

- evidence (recorded): Cargo.toml declares 17 workspace members. `ls target/release` and `target/debug` show exactly one built binary: clade-e2e, and Makefile:742 is the only place any of them is invoked. Panic hardening is genuinely complete: [workspace.lints.clippy] denies unwrap_used and expect_used, all 17 crates opt in with a two-line [lints]/workspace stanza, and only 2 prod-side unwraps remain (RUST-13 src/bin/smoke_m1.rs).

- verdict: **holds** — held 1 of 2 checks; unverifiable: command `ls target/release`: command errored on re-run (exit 2: ls: cannot access 'target/release': No such file or directory); an error is never 'holds' (FR-004)
  - [unverifiable] command `ls target/release` — command errored on re-run (exit 2: ls: cannot access 'target/release': No such file or directory); an error is never 'holds' (FR-004)
      $ ls target/release
          -> exit 2 (no output)
      [stderr] ls: cannot access 'target/release': No such file or directory
  - [holds] reference Makefile:742 — file present with at least that many lines (no quoted text followed the reference to check)
    Makefile — 5744 lines (evidence cites :742)

### t27-00-queen-core — status partial, layer ring

- evidence (recorded): rings/T27-00/queen_core.t27, 209 lines, 7 fns: gen-rust 7/7 with 0 stubs, Zig 7, Verilog 8, `rustc --crate-type lib` clean. tests/t27/ring00_parity.sh -> '[OK] ring00_parity: 14 rows checked and 21 constants pinned'. But `find . -name queen_core.rs -o -name queen_core.v` (worktrees excluded) returns NOTHING - re-confirmed today.

- verdict: **holds** — held 1 of 2 checks; unverifiable: command `rustc --crate-type lib`: 'rustc' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [unverifiable] command `rustc --crate-type lib` — 'rustc' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [holds] command `find . -name queen_core.rs -o -name queen_core.v` — still no output, as recorded
      $ find . -name queen_core.rs -o -name queen_core.v
          -> exit 0 (no output)

### t27-lowering-gate — status shipped, layer ring

- evidence (recorded): Makefile:1135-1229, wired into `check:` at Makefile:1931. Reproduced by hand over the same 70 specs: 0 files with declared != emitted, 11 non-compiling - exactly T27_NOCOMPILE_CEILING := 11 (Makefile:946). All 11 are in the tri-net submodule; both trios rings compile clean.

- verdict: **holds** — all 3 check(s) re-ran and matched
  - [holds] reference Makefile:1135-1229 — file present with at least that many lines (no quoted text followed the reference to check)
    Makefile — 5744 lines (evidence cites :1229)
  - [holds] reference Makefile:1931 — file present with at least that many lines (no quoted text followed the reference to check)
    Makefile — 5744 lines (evidence cites :1931)
  - [holds] reference Makefile:946 — file present with at least that many lines (no quoted text followed the reference to check)
    Makefile — 5744 lines (evidence cites :946)

### t27-parity-gates — status shipped, layer ring

- evidence (recorded): Makefile:1232-1258 and 710-735, both members of `check:` at Makefile:1931. Run live today: ring00_parity.sh, ring01_rules.sh and ring00_verilog.sh all green, all writing only to mktemp dirs. The chain compiles the generated ring with bare rustc and the Swift twin, runs both over one input grid and diffs.

- verdict: **holds** — all 2 check(s) re-ran and matched
  - [holds] reference Makefile:1232-1258 — file present with at least that many lines (no quoted text followed the reference to check)
    Makefile — 5744 lines (evidence cites :1258)
  - [holds] reference Makefile:1931 — file present with at least that many lines (no quoted text followed the reference to check)
    Makefile — 5744 lines (evidence cites :1931)

### ring00-silicon — status blocked, layer silicon

- evidence (recorded): Simulated and green: `bash tests/t27/ring00_verilog.sh` -> '[OK] ring00_verilog: 14 rows checked, simulation answers the Swift table / generated from rings/T27-00/queen_core.t27, compiled with iverilog, run under vvp' - the same 14-row table as the Rust parity harness by design. Not synthesised: `grep -rn 'yosys|nextpnr|openFPGALoader' --include=Makefile --include='*.sh' --include='*.swift'` over trios returns ZERO hits, although all three tools resolve on this machine. docs/t27/stands.md:13-15: 'The Zynq xc7z020 stand runs tri-net. The Queen's rings do not go there.'

- verdict: **holds** — held 2 of 3 checks; unverifiable: command `bash tests/t27/ring00_verilog.sh`: 'bash' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [unverifiable] command `bash tests/t27/ring00_verilog.sh` — 'bash' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [holds] command `grep -rn 'yosys|nextpnr|openFPGALoader' --include=Makefile --include='*.sh' --include='*.swift'` — still no output, as recorded
      $ grep -rn --include=Makefile 'yosys|nextpnr|openFPGALoader' --include=*.sh --include=*.swift
          -> exit 1 (no output)
  - [holds] reference docs/t27/stands.md:13-15 — file present, ≥ 15 lines; quoted text present on/near :13 (matched by its distinctive words — the evidence quotes loosely or the file's markdown differs) — quote: “The Zynq xc7z020 stand runs tri-net. The Queen”
    docs/t27/stands.md — 16 lines (evidence cites :15)

### ascii-purity-law — status blocked, layer runtime

- evidence (recorded): Measured today: 37 of 206 .swift files under rings/ and BR-OUTPUT/ contain non-ASCII (BR-OUTPUT/SmoothStreamingEnhancements.swift:55 carries a Russian comment in shipped source; rings/SR-02/ChatViewModel.swift has ~491 such lines), and 5 of 31 SKILL.md files do too. `grep -ciE ascii Makefile build.sh` = 0 and no .github workflow mentions it. The law is asserted at .trinity/specs/ascii-purity.md:4 (which explicitly extends it to .claude/skills/*/*.md), AGENTS.md:154, and the ascii-lint skill.

- verdict: **holds** — all 4 check(s) re-ran and matched
  - [holds] command `grep -ciE ascii Makefile build.sh` — counted 0, as recorded
      $ grep -ciE ascii Makefile build.sh
          -> exit 1
      Makefile:0
      build.sh:0

  - [holds] reference BR-OUTPUT/SmoothStreamingEnhancements.swift:55 — file present with at least that many lines (no quoted text followed the reference to check)
    BR-OUTPUT/SmoothStreamingEnhancements.swift — 256 lines (evidence cites :55)
  - [holds] reference .trinity/specs/ascii-purity.md:4 — file present with at least that many lines (no quoted text followed the reference to check)
    .trinity/specs/ascii-purity.md — 29 lines (evidence cites :4)
  - [holds] reference AGENTS.md:154 — file present with at least that many lines (no quoted text followed the reference to check)
    AGENTS.md — 162 lines (evidence cites :154)

### bash-process-group — status blocked, layer runtime

- evidence (recorded): Confirmed unchanged today: agent-server/apps/server/src/tools/filesystem/bash.ts:208 `proc.kill()` inside the setTimeout, with no setsid or detached handling in the Bun.spawn options at :198-205. PARALLEL-BEES.md:141 marks it verbatim 'Not fixed.' - a 3 s timeout still pending at 25 s; one `bun run dev &` costs a worker slot until the process restarts.

- verdict: **holds** — held 2 of 3 checks; unverifiable: command `bun run dev &`: quoted command contains shell operators ('&'); not a plain read-only command, so it is not executed (FR-002)
  - [unverifiable] command `bun run dev &` — quoted command contains shell operators ('&'); not a plain read-only command, so it is not executed (FR-002)
  - [holds] reference agent-server/apps/server/src/tools/filesystem/bash.ts:208 — file present, ≥ 208 lines; quoted text still on/near :208 — quote: “proc.kill()”
    agent-server/apps/server/src/tools/filesystem/bash.ts — 248 lines (evidence cites :208)
  - [holds] reference PARALLEL-BEES.md:141 — file present with at least that many lines (no quoted text followed the reference to check)
    .trinity/dashboard/PARALLEL-BEES.md — 174 lines (evidence cites :141)

### build-variant-fence — status shipped, layer runtime

- evidence (recorded): build.sh:19 defaults to dev, :32 rejects anything but dev/prod/test. rings/SR-00/BuildVariantPolicy.swift pins bundle ids (:11-13), binaries (:27-29), data roots (:43-45) and ports (:105-109); usesFileSecretStore is `!isRelease` (:72). `variant-fence` is a check target (Makefile:1672) with its own fixture corpus under tests/fixtures/guards/variant-fence/. Verified live: 9105 and 9305 answer /health, 9205 does not.

- verdict: **holds** — all 2 check(s) re-ran and matched
  - [holds] reference build.sh:19 — file present with at least that many lines (no quoted text followed the reference to check)
    build.sh — 1193 lines (evidence cites :19)
  - [holds] reference Makefile:1672 — file present with at least that many lines (no quoted text followed the reference to check)
    Makefile — 5744 lines (evidence cites :1672)

### replay-cassette-suite — status partial, layer runtime

- evidence (recorded): Organ shipped and wired - confirmed today: rings/SR-01/ReplayTransport.swift:19 `actor ReplayTransport: ChatTransportProtocol`, CassetteRecorder at :163, constructed at rings/SR-00/CompositionRoot.swift:66 and consumed at rings/SR-02/QueenWorkerRunner.swift:223; 4 cassettes in tests/cassettes/; `cassettes` is a member of `check:` at Makefile:1931. Suite red: CLOUD-MIGRATION.md:771 measures 't+15s..t+75s alive=0 lines=9 server.launch=0 queen.selftest=0', and wave-loop-113.md reports 4 of 5 replays failing.

- verdict: **holds** — all 5 check(s) re-ran and matched
  - [holds] reference rings/SR-01/ReplayTransport.swift:19 — file present, ≥ 19 lines; quoted text still on/near :19 — quote: “actor ReplayTransport: ChatTransportProtocol”
    rings/SR-01/ReplayTransport.swift — 188 lines (evidence cites :19)
  - [holds] reference rings/SR-00/CompositionRoot.swift:66 — file present with at least that many lines (no quoted text followed the reference to check)
    rings/SR-00/CompositionRoot.swift — 145 lines (evidence cites :66)
  - [holds] reference rings/SR-02/QueenWorkerRunner.swift:223 — file present with at least that many lines (no quoted text followed the reference to check)
    rings/SR-02/QueenWorkerRunner.swift — 471 lines (evidence cites :223)
  - [holds] reference Makefile:1931 — file present with at least that many lines (no quoted text followed the reference to check)
    Makefile — 5744 lines (evidence cites :1931)
  - [holds] reference CLOUD-MIGRATION.md:771 — file present, ≥ 771 lines; quoted text still on/near :771 — quote: “t+15s..t+75s alive=0 lines=9 server.launch=0 queen.selftest=…”
    .trinity/dashboard/CLOUD-MIGRATION.md — 1149 lines (evidence cites :771)

### tmp-zero-gate — status blocked, layer runtime

- evidence (recorded): `grep -rn '/tmp' rings/*/*/src/*.rs | wc -l` = 90 today, almost all production consts rather than tests, e.g. rings/RUST-02/clade-e2e/src/main.rs:193-196 `SwiftLogicSuite { bin: "/tmp/trios_chat_logic_test", ... }`. The checker exists at rings/RUST-99/tmp-zero-gate/src/main.rs and its EXEMPT_DIRS (:12-18) do not include clade-e2e, so it would fail. `grep -c tmp-zero Makefile` = 0.

- verdict: **holds** — all 3 check(s) re-ran and matched
  - [holds] command `grep -rn '/tmp' rings/*/*/src/*.rs | wc -l` — counted 90, as recorded
      $ grep -rn /tmp rings/RUST-00/trios-config/src/lib.rs rings/RUST-01/clade-build/src/main.rs rings/RUST-02/clade-e2e/src/main.rs rings/RUST-03/clade-rollback/src/main.rs rings/RUST-04/clade-improve/src/constitution.rs rings/RUST-04/clade-improve/src/lib.rs rings/RUST-04/clade-improve/src/main.rs rings/RUST-04/clade-improve/src/oversight.rs rings/RUST-04/clade-improve/src/pipeline.rs rings/RUST-04/clade-improve/src/sandbox.rs rings/RUST-04/clade-improve/src/variant.rs rings/RUST-05/clade-monitor/src/main.rs rings/RUST-06/clade-dashboard/src/main.rs rings/RUST-07/clade-experience/src/main.rs rings/RUST-08/clade-promote/src/main.rs rings/RUST-08/clade-promote/src/seal.rs rings/RUST-09/clade-launchd/src/main.rs rings/RUST-10/clade-worktree/src/main.rs rings/RUST-11/clade-diff/src/main.rs rings/RUST-12/clade-audit/src/main.rs rings/RUST-13/clade-meshd/src/chat.rs rings/RUST-13/clade-meshd/src/key_store.rs rings/RUST-13/clade-meshd/src/main.rs rings/RUST-13/clade-meshd/src/security.rs rings/RUST-13/clade-meshd/src/transport.rs rings/RUST-14/clade-tablecloth/src/main.rs rings/RUST-99/tmp-zero-gate/src/main.rs
          -> exit 0
      rings/RUST-02/clade-e2e/src/main.rs:196:        bin: "/tmp/trios_chat_logic_test",
      rings/RUST-02/clade-e2e/src/main.rs:201:        bin: "/tmp/trios_openrouter_credits_parser_test",
      rings/RUST-02/clade-e2e/src/main.rs:209:        bin: "/tmp/trios_zai_error_parser_test",
      rings/RUST-02/clade-e2e/src/main.rs:217:        bin: "/tmp/trios_log_bus_test",
      rings/RUST-02/clade-e2e/src/main.rs:227:        bin: "/tmp/trios_plan_step_naming_test",
      rings/RUST-02/clade-e2e/src/main.rs:235:        bin: "/tmp/trios_release_promotion_test",
      rings/RUST-02/clade-e2e/src/main.rs:243:        bin: "/tmp/trios_build_variant_test",
      rings/RUST-02/clade-e2e/src/main.rs:251:        bin: "/tmp/trios_queen_delegation_test",
      rings/RUST-02/clade-e2e/src/main.rs:276:        bin: "/tmp/trios_plan_nesting_revision_test",
      rings/RUST-02/clade-e2e/src/main.rs:286:        bin: "/tmp/trios_chat_pane_layout_test",
      rings/RUST-02/clade-e2e/src/main.rs:294:        bin: "/tmp/trios_todo_planner_state_test",
      rings/RUST-02/clade-e2e/src/main.rs:303:        bin: "/tmp/trios_todo_plan_deriver_test",
      rings/RUST-02/clade-e2e/src/main.rs:311:        bin: "/tmp/trios_chat_diagnostics_test",
      rings/RUST-02/clade-e2e/src/main.rs:320:        bin: "/tmp/trios_keychain_restack_wiring_test",
      rings/RUST-02/clade-e2e/src/main.rs:334:        bin: "/tmp/trios_keychain_read_stacking_test",
      rings/RUST-02/clade-e2e/src/main.rs:342:        bin: "/tmp/trios_key_refusal_test",
      rings/RUST-02/clade-e2e/src/main.rs:350:        bin: "/tmp/trios_model_key_rotation_test",
      rings/RUST-02/clade-e2e/src/main.rs:359:        bin: "/tmp/trios_log_parser_app_test",
      rings/RUST-02/clade-e2e/src/main.rs:370:        bin: "/tmp/trios_assistant_action_bar_policy_test",
      rings/RUST-02/clade-e2e/src/main.rs:378:        bin: "/tmp/trios_chat_editing_shortcut_policy_test",
      rings/RUST-02/clade-e2e/src/main.rs:386:        bin: "/tmp/trios_chat_loading_indicator_layout_test",
      rings/RUST-02/clade-e2e/src/main.rs:394:        bin: "/tmp/trios_chat_scroll_restoration_policy_test",
      rings/RUST-02/clade-e2e/src/main.rs:402:        bin: "/tmp/trios_chat_workspace_layout_test",
      rings/RUST-02/clade-e2e/src/main.rs:410:        bin: "/tmp/trios_companion_server_config_test",
      rings/RUST-02/clade-e2e/src/main.rs:418:        bin: "/tmp/trios_markdown_block_parser_test",
      rings/RUST-02/clade-e2e/src/main.rs:426:        bin: "/tmp/trios_model_catalog_reconciler_test",
      rings/RUST-02/clade-e2e/src/main.rs:434:        bin: "/tmp/trios_model_provider_test",
      rings/RUST-02/clade-e2e/src/main.rs:442:        bin: "/tmp/trios_reasoning_presentation_policy_test",
      rings/RUST-02/clade-e2e/src/main.rs:450:        bin: "/tmp/trios_structured_detail_parser_test",
      rings/RUST-02/clade-e2e/src/main.rs:458:        bin: "/tmp/trios_tri_net_repository_status_test",
      … output truncated after 30 of 91 lines
      $ wc -l
          -> exit 0
      90

  - [holds] command `grep -c tmp-zero Makefile` — counted 0, as recorded
      $ grep -c tmp-zero Makefile
          -> exit 1
      0

  - [holds] reference rings/RUST-02/clade-e2e/src/main.rs:193-196 — file present, ≥ 196 lines; quoted text present on/near :193 (matched by its distinctive words — the evidence quotes loosely or the file's markdown differs) — quote: “SwiftLogicSuite { bin: "/tmp/trios_chat_logic_test", ... }”
    rings/RUST-02/clade-e2e/src/main.rs — 1276 lines (evidence cites :196)

### workspace-volume — status blocked, layer runtime

- evidence (recorded): Measured inside the running container: `df -h /workspace` -> overlay; `mount | grep workspace` -> nothing; `railway volume list` -> one volume, redis-volume, on the Redis service. Dockerfile:97-115 now states it plainly and gives the fix: `railway volume add --service trios-agent-server --mount-path /workspace`.

- verdict: **holds** — held 1 of 5 checks; unverifiable: command `df -h /workspace`: 'df' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002); command `mount | grep workspace`: 'mount' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002); command `railway volume list`: 'railway' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002); command `railway volume add --service trios-agent-server --mount-path /workspace`: 'railway' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [unverifiable] command `df -h /workspace` — 'df' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [unverifiable] command `mount | grep workspace` — 'mount' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [unverifiable] command `railway volume list` — 'railway' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [unverifiable] command `railway volume add --service trios-agent-server --mount-path /workspace` — 'railway' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [holds] reference Dockerfile:97-115 — file present with at least that many lines (no quoted text followed the reference to check)
    agent-server/Dockerfile — 152 lines (evidence cites :115)

### bee-ceiling — status planned, layer supervisor

- evidence (recorded): Confirmed today: rings/SR-00/QueenDelegation.swift:470 `public static let maximumConcurrentWorkers = 4`, against a container that took 96 concurrent calls with no degradation (CLOUD-MIGRATION.md:1047 shows the cap firing: 'refusal: 4 workers already running (limit 4)'). PARALLEL-BEES.md:136-147 orders the prerequisites: multi-key rotation exists at ModelConfigurationStore+KeyRotation.swift:44-59 and has NO caller on the request path (its only callers are a UI toggle in ModelsTabView.swift), while QueenRetryPolicy.swift:88-108 classifies a 429 as producedNothing and :67 retires the issue after two.

- verdict: **holds** — held 4 of 5 checks; unverifiable: QueenRetryPolicy.swift:88-108: bare name matches 2 files (agent-server/queen-core/Sources/QueenCore/QueenRetryPolicy.swift, rings/SR-00/QueenRetryPolicy.swift); which one is meant is not machine-decidable
  - [holds] reference rings/SR-00/QueenDelegation.swift:470 — file present, ≥ 470 lines; quoted text still on/near :470 — quote: “public static let maximumConcurrentWorkers = 4”
    rings/SR-00/QueenDelegation.swift — 1232 lines (evidence cites :470)
  - [holds] reference CLOUD-MIGRATION.md:1047 — file present, ≥ 1047 lines; quoted text still on/near :1047 — quote: “refusal: 4 workers already running (limit 4)”
    .trinity/dashboard/CLOUD-MIGRATION.md — 1149 lines (evidence cites :1047)
  - [holds] reference PARALLEL-BEES.md:136-147 — file present with at least that many lines (no quoted text followed the reference to check)
    .trinity/dashboard/PARALLEL-BEES.md — 174 lines (evidence cites :147)
  - [holds] reference ModelConfigurationStore+KeyRotation.swift:44-59 — file present with at least that many lines (no quoted text followed the reference to check)
    rings/SR-00/ModelConfigurationStore+KeyRotation.swift — 108 lines (evidence cites :59)
  - [unverifiable] reference QueenRetryPolicy.swift:88-108 — bare name matches 2 files (agent-server/queen-core/Sources/QueenCore/QueenRetryPolicy.swift, rings/SR-00/QueenRetryPolicy.swift); which one is meant is not machine-decidable

### cloud-dispatch — status shipped, layer supervisor

- evidence (recorded): queen-dispatch.ts:415 dispatchBee, called from queen-tick.ts:355; the credential check (:423) precedes prepareWorktree (:434) so a refusal costs no branch. Live run at CLOUD-MIGRATION.md:850-853 ('16:13:06 Queen dispatch issue=1244 branch="queen-1244" started=true') and a real-model commit at :946-951 (e52f41ad, glm-4.6). reapStalledDispatches at queen-dispatch.ts:387-402 runs at queen-tick.ts:261, before the in-flight board read at :280.

- verdict: **holds** — all 5 check(s) re-ran and matched
  - [holds] reference queen-dispatch.ts:415 — file present with at least that many lines (no quoted text followed the reference to check)
    agent-server/apps/server/src/api/services/queen-dispatch.ts — 1368 lines (evidence cites :415)
  - [holds] reference queen-tick.ts:355 — file present with at least that many lines (no quoted text followed the reference to check)
    agent-server/apps/server/src/api/services/queen-tick.ts — 1738 lines (evidence cites :355)
  - [holds] reference CLOUD-MIGRATION.md:850-853 — file present, ≥ 853 lines; quoted text still on/near :850 — quote: “16:13:06 Queen dispatch issue=1244 branch="queen-1244" start…”
    .trinity/dashboard/CLOUD-MIGRATION.md — 1149 lines (evidence cites :853)
  - [holds] reference queen-dispatch.ts:387-402 — file present with at least that many lines (no quoted text followed the reference to check)
    agent-server/apps/server/src/api/services/queen-dispatch.ts — 1368 lines (evidence cites :402)
  - [holds] reference queen-tick.ts:261 — file present with at least that many lines (no quoted text followed the reference to check)
    agent-server/apps/server/src/api/services/queen-tick.ts — 1738 lines (evidence cites :261)

### cloud-tick — status shipped, layer supervisor

- evidence (recorded): queen-tick.ts:516 startQueenTick(), wired unconditionally after migrations at main.ts:87, gated on TRIOS_QUEEN_TICK_SECONDS (:81, :518). TTL 180 / heartbeat 60 at :77-78, renewed at :192-196. Measured self-firing round at CLOUD-MIGRATION.md:333-340: 'lease : held by 9680f61f-...:1 fence=1 / tick : same holder ... Nobody asked for that round. It fired on its own interval.'

- verdict: **holds** — all 3 check(s) re-ran and matched
  - [holds] reference queen-tick.ts:516 — file present with at least that many lines (no quoted text followed the reference to check)
    agent-server/apps/server/src/api/services/queen-tick.ts — 1738 lines (evidence cites :516)
  - [holds] reference main.ts:87 — file present with at least that many lines (no quoted text followed the reference to check)
    agent-server/apps/server/src/main.ts — 370 lines (evidence cites :87)
  - [holds] reference CLOUD-MIGRATION.md:333-340 — file present with at least that many lines (no quoted text followed the reference to check)
    .trinity/dashboard/CLOUD-MIGRATION.md — 1149 lines (evidence cites :340)

### owner-cutover — status blocked, layer supervisor

- evidence (recorded): PARALLEL-BEES.md:150 gives the exact commands (`DEVELOPER_DIR=/Library/Developer/CommandLineTools make release`, then `open -a trios.app --env TRIOS_AGENT_SERVER_URL=...`) and notes the running release app 'predates all of it and knows nothing of the boundary ageing or the patch transport'. STATUS.md:84-92 measures the consequence: treeStateFingerprint on 0 of the release store's tasks, 12 tasks with no acceptance criteria. RELEASE-BLOCKER.md:95-102: 763 commits ahead, 17 behind, 570 conflict markers over 1096 files, of which packages/browseros-agent (546) and trios/agent-server (436) are the same directory in two places.

- verdict: **holds** — held 3 of 5 checks; unverifiable: command `DEVELOPER_DIR=/Library/Developer/CommandLineTools make release`: 'make' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002); command `open -a trios.app --env TRIOS_AGENT_SERVER_URL=...`: 'open' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [unverifiable] command `DEVELOPER_DIR=/Library/Developer/CommandLineTools make release` — 'make' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [unverifiable] command `open -a trios.app --env TRIOS_AGENT_SERVER_URL=...` — 'open' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [holds] reference PARALLEL-BEES.md:150 — file present, ≥ 150 lines; quoted text still on/near :150 — quote: “DEVELOPER_DIR=/Library/Developer/CommandLineTools make relea…”
    .trinity/dashboard/PARALLEL-BEES.md — 174 lines (evidence cites :150)
  - [holds] reference STATUS.md:84-92 — file present with at least that many lines (no quoted text followed the reference to check)
    .trinity/dashboard/STATUS.md — 223 lines (evidence cites :92)
  - [holds] reference RELEASE-BLOCKER.md:95-102 — file present with at least that many lines (no quoted text followed the reference to check)
    .trinity/dashboard/RELEASE-BLOCKER.md — 167 lines (evidence cites :102)

### queen-lease — status shipped, layer supervisor

- evidence (recorded): agent-server/apps/server/src/api/services/queen-lease.ts:72-84 - one `INSERT ... ON CONFLICT (name) DO UPDATE ... WHERE queen_lease.expires_at < now() OR queen_lease.holder = EXCLUDED.holder RETURNING holder, fence, expires_at`; release expires rather than deletes (:131). Live race at CLOUD-MIGRATION.md:316-324: '6 contenders, fired together, at a free lease ... VERDICT: exactly one Queen'. Verified live today: /queen/lease -> 403 unauthenticated.

- verdict: **holds** — all 2 check(s) re-ran and matched
  - [holds] reference agent-server/apps/server/src/api/services/queen-lease.ts:72-84 — file present with at least that many lines (no quoted text followed the reference to check)
    agent-server/apps/server/src/api/services/queen-lease.ts — 181 lines (evidence cites :84)
  - [holds] reference CLOUD-MIGRATION.md:316-324 — file present, ≥ 324 lines; quoted text still on/near :316 — quote: “6 contenders, fired together, at a free lease ... VERDICT: e…”
    .trinity/dashboard/CLOUD-MIGRATION.md — 1149 lines (evidence cites :324)

### queen-observer-cost — status partial, layer supervisor

- evidence (recorded): rings/SR-00/QueenObserver.swift:15/:54 with reapStalledWorkers at rings/SR-02/ChatViewModel.swift:8871. Called at ChatViewModel.swift:8467 from an @MainActor runner on every SSE delta, O(all accumulated tool-argument bytes): PARALLEL-BEES.md measures 13.1 s of main-thread CPU for one 100-turn worker - 'The UI freezes long before the container notices.'

- verdict: **holds** — all 3 check(s) re-ran and matched
  - [holds] reference rings/SR-00/QueenObserver.swift:15 — file present with at least that many lines (no quoted text followed the reference to check)
    rings/SR-00/QueenObserver.swift — 210 lines (evidence cites :15)
  - [holds] reference rings/SR-02/ChatViewModel.swift:8871 — file present with at least that many lines (no quoted text followed the reference to check)
    rings/SR-02/ChatViewModel.swift — 13598 lines (evidence cites :8871)
  - [holds] reference ChatViewModel.swift:8467 — file present with at least that many lines (no quoted text followed the reference to check)
    rings/SR-02/ChatViewModel.swift — 13598 lines (evidence cites :8467)

### queen-skill-match — status blocked, layer supervisor

- evidence (recorded): Read in full today. rings/SR-00/QueenSkillMatch.swift:54 `let lower = path.lowercased()` then :55 `rules.first(where: { $0.matches(lower) })`. The rules at :24-27 include `$0.hasSuffix("Tests.swift")`, `$0.hasSuffix("Makefile")` and `$0.contains("rings/RUST-")` - none can ever match a lowercased string. Only tests/, build.sh and .swift survive, so e2e-testing and agent-safe-build are the only reachable skills of 31 installed. A rings/RUST- boundary matches nothing, hits `guard let match ... else { return nil }` and gets NO skill.

- verdict: **holds** — all 1 check(s) re-ran and matched
  - [holds] reference rings/SR-00/QueenSkillMatch.swift:54 — file present, ≥ 54 lines; quoted text still on/near :54 — quote: “let lower = path.lowercased()”
    rings/SR-00/QueenSkillMatch.swift — 65 lines (evidence cites :54)

### salience-learner — status shipped, layer supervisor

- evidence (recorded): rings/SR-00/QueenSalience.swift:13 and rings/SR-01/SalienceLearner.swift:15 form a closed loop: read at rings/SR-02/ChatViewModel.swift:5694 (`QueenDelegationPolicy.learnedWeight = { feature in ... }`, installed against QueenDelegation.swift:993), written at :10986 and :12106 via SalienceLearner.shared.record(task:neededUser:). Laplace-smoothed per-feature tallies persisted to .trinity/state/queen_salience.json.

- verdict: **holds** — held 3 of 4 checks; unverifiable: QueenDelegation.swift:993: bare name matches 2 files (agent-server/queen-core/Sources/QueenPolicy/QueenDelegation.swift, rings/SR-00/QueenDelegation.swift); which one is meant is not machine-decidable
  - [holds] reference rings/SR-00/QueenSalience.swift:13 — file present with at least that many lines (no quoted text followed the reference to check)
    rings/SR-00/QueenSalience.swift — 132 lines (evidence cites :13)
  - [holds] reference rings/SR-01/SalienceLearner.swift:15 — file present with at least that many lines (no quoted text followed the reference to check)
    rings/SR-01/SalienceLearner.swift — 205 lines (evidence cites :15)
  - [holds] reference rings/SR-02/ChatViewModel.swift:5694 — file present, ≥ 5694 lines; quoted text still on/near :5694 — quote: “QueenDelegationPolicy.learnedWeight = { feature in ... }”
    rings/SR-02/ChatViewModel.swift — 13598 lines (evidence cites :5694)
  - [unverifiable] reference QueenDelegation.swift:993 — bare name matches 2 files (agent-server/queen-core/Sources/QueenPolicy/QueenDelegation.swift, rings/SR-00/QueenDelegation.swift); which one is meant is not machine-decidable

### br-output-swiftui — status shipped, layer interface

- evidence (recorded): 52 .swift files, all 52 present in the `TRIOS_PRINT_SOURCES=1 ./build.sh` source list. SOUL.md:174 names BR-OUTPUT/*.swift canon/generated. Chat UX claims verified in code: SmoothStreamingEnhancements.swift:59 `debounceInterval = 0.016`, TypingIndicatorView.swift, glassmorphism in TriosTabView.swift.

- verdict: **holds** — held 2 of 3 checks; unverifiable: command `TRIOS_PRINT_SOURCES=1 ./build.sh`: './build.sh' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [unverifiable] command `TRIOS_PRINT_SOURCES=1 ./build.sh` — './build.sh' is not on the allowed list (grep, ls, find, wc, git grep, git ls-tree); reported unverifiable rather than executed (FR-002)
  - [holds] reference SOUL.md:174 — file present with at least that many lines (no quoted text followed the reference to check)
    .trinity/SOUL.md — 235 lines (evidence cites :174)
  - [holds] reference SmoothStreamingEnhancements.swift:59 — file present, ≥ 59 lines; quoted text present on/near :59 (matched by its distinctive words — the evidence quotes loosely or the file's markdown differs) — quote: “debounceInterval = 0.016”
    BR-OUTPUT/SmoothStreamingEnhancements.swift — 256 lines (evidence cites :59)

### playground — status planned, layer interface

- evidence (recorded): Queen_T27_MVP_Architecture.md:1433-1610 (spec editor, source AST, semantic view, IR explorer, generated outputs, hardware view, verification, provenance timeline) and :2225-2299 (E7-I1..I7). No directory, route or spec for it exists anywhere in this repository. RELEASE-BLOCKER.md:44: 'the Playground has no owner and no code.' STATUS.md scores Playground 0 done / 1 partial / 5 not started.

- verdict: **holds** — all 2 check(s) re-ran and matched
  - [holds] reference Queen_T27_MVP_Architecture.md:1433-1610 — file present with at least that many lines (no quoted text followed the reference to check)
    docs/architecture/Queen_T27_MVP_Architecture.md — 3262 lines (evidence cites :1610)
  - [holds] reference RELEASE-BLOCKER.md:44 — file present, ≥ 44 lines; quoted text still on/near :44 — quote: “the Playground has no owner and no code.”
    .trinity/dashboard/RELEASE-BLOCKER.md — 167 lines (evidence cites :44)

### queen-dashboard — status shipped, layer interface

- evidence (recorded): Cloud shell at agent-server/apps/server/src/api/routes/queen-dashboard.ts, mounted at api/server.ts:295; data route at routes/queen-lease.ts:103-135 returns lease status, last tick decision and the 10 most recent dispatches. Verified live today: /queen/dashboard -> 200, /queen/lease -> 403, /health -> {"status":"ok","pid":1}. Mac-side entry at BR-OUTPUT/QueenDashboardView.swift:118 plus QueenCompactSupervisorBar.swift:14.

- verdict: **holds** — all 4 check(s) re-ran and matched
  - [holds] reference api/server.ts:295 — file present with at least that many lines (no quoted text followed the reference to check)
    agent-server/apps/server/src/api/server.ts — 537 lines (evidence cites :295)
  - [holds] reference routes/queen-lease.ts:103-135 — file present with at least that many lines (no quoted text followed the reference to check)
    agent-server/apps/server/src/api/routes/queen-lease.ts — 176 lines (evidence cites :135)
  - [holds] reference BR-OUTPUT/QueenDashboardView.swift:118 — file present with at least that many lines (no quoted text followed the reference to check)
    BR-OUTPUT/QueenDashboardView.swift — 265 lines (evidence cites :118)
  - [holds] reference QueenCompactSupervisorBar.swift:14 — file present with at least that many lines (no quoted text followed the reference to check)
    BR-OUTPUT/QueenCompactSupervisorBar.swift — 169 lines (evidence cites :14)

## Determinism

The grouping (one `id verdict` line per node, file order) hashes to:

grouping-sha256-this-run: 5a5abc2fa2d7be2c404ed577229449b228d2506b1bf2fadc5699ae4417f91eb8

grouping-sha256-previous-run: 5a5abc2fa2d7be2c404ed577229449b228d2506b1bf2fadc5699ae4417f91eb8

Two consecutive runs produced an **identical** grouping.

---

Exit status: 0. Nodes reported: 40 (holds 29, DIVERGED 6, unverifiable 5).
