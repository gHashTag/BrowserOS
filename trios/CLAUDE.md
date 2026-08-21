# CLAUDE.md — Instructions for Claude Code and autonomous agents (trios)

Use this file **together with** `[AGENTS.md](AGENTS.md)`. Repo-specific law always overrides generic tooling defaults.

---

## Autonomous Execution Loop (AEL v2.0)

When operating as the Trinity Agent (Queen), follow this 6-phase loop:

```
┌─────────────────────────────────────────────────────────────┐
│  OBSERVE → PLAN → DELEGATE → VERIFY → SYNTHESIZE → LEARN   │
│         ↓       ↓        ↓        ↓         ↓         ↓    │
│  [E]     [T]     [C/V]    [V]      [L]      [L]           │
└─────────────────────────────────────────────────────────────┘
```

### Phase 1: OBSERVE
- Call Experience Agent (E) for context — read `.trinity/experience.md` and `.trinity/experience/*.json`
- Check `.trinity/current_task/activity.md` for active task details
- Gather relevant files and context from trios Swift codebase
- Run `cargo run --bin clade-build` to establish baseline

### Phase 2: PLAN
- Break down task into subtasks
- Identify required skills: `/phi-loop`, `/tri-pipeline`, `/experience-save`
- Determine which agents to delegate to (see AGENTS.md alphabet)
- Estimate complexity and dependencies
- Select road from `.trinity/state/three-roads.json`:
  - **Road A** (fastest) — direct fix, minimal ceremony
  - **Road B** (balanced) — fix + test + experience save
  - **Road C** (deep) — spec-first, full PHI LOOP, agent spawn

### Phase 3: DELEGATE
- Delegate implementation to specialized agent (C)
- Delegate validation to Verifier Agent (V)
- Coordinate parallel execution where possible (max 3 agents simultaneous)
- Monitor agent progress via `.trinity/agent_events.jsonl`

### Phase 4: VERIFY
- Review agent outputs
- Run `cargo run --bin clade-build` — must pass
- Run `cargo run --bin clade-e2e` — must pass
- Check L1-L7 law compliance
- Ensure no regression in other tabs/features

### Phase 5: SYNTHESIZE
- Combine agent results
- Resolve conflicts (if two agents touched same file)
- Create cohesive solution
- Prepare for integration

### Phase 6: LEARN
- Call Learner Agent (L) for pattern extraction
- Update `.trinity/experience.md` via `/experience-save`
- Save ring-specific learnings as `.trinity/experience/YYYY-MM-DD_title.json`
- Improve future execution

---

## 1. Mandatory read order for this repository

1. `[AGENTS.md](AGENTS.md)` — entry point and constitutional stack.
2. `[.trinity/SOUL.md](.trinity/SOUL.md)` — canonical law (TDD, language, validation, T27 canon files).
3. `[.trinity/policy/coordination-law.md](.trinity/policy/coordination-law.md)` — shared-state mutation protocol (claims, queue, Akashic log).
4. The L1-L7 law table at the bottom of this file. (`docs/T27-CONSTITUTION.md`
   was listed here for months and does not exist in this tree; the table below
   is the law that is actually present.)
5. `[AGENTS.md](AGENTS.md)` — 27-agent alphabet and coordination rules.
6. `[.claude/agents/t27-queen.md](.claude/agents/t27-queen.md)` — T27 Queen AEL v2.0 orchestration.
7. `[.trinity/experience.md](.trinity/experience.md)` — prior learnings and mistakes.
   (`.trinity/state/session_summary.md` was listed here and does not exist;
   the experience files and `git log` are what record what was built last.)

---

## 2. Engineering workflow

- **Build:** `DEVELOPER_DIR=/Library/Developer/CommandLineTools make` builds
  the DEV app; `make release` is a deliberate act that replaces `trios.app`.
  Make is the interface; `./build.sh` is its implementation detail and is not
  invoked by hand.
- **Gate:** `make check` at the START of a round and before landing anything.
- **Run:** `open trios.app` (preferred — loads `Bundle.main` resources incl. the
  menu-bar logo). `make relaunch` refuses while a worker is running.
- **E2E:** `make e2e`; `make verify` proves the chat answers after a change.
- **Health:** `curl -s http://127.0.0.1:9105/health`
- **Mesh ring:** `cargo test -p trios-mesh` (RUST-13, submodule from `gHashTag/tri-net`)
- **Git:** main branch is `dev`; work happens on feature branches (this file
  once pinned `feat/zai-provider` here and went stale — read the branch from
  `git status`, not from a document)
- **T27 pipeline:** `/t27-phi-loop` or `/t27-tri-pipeline` for spec-first work on canon files

> **INVARIANT — menu-bar logo:** the trios status-bar logo must never disappear.
> It only vanishes when the **app process dies**. After any `./build.sh` /
> `clade-build` you MUST relaunch the app (`open trios.app`) — the running app
> otherwise keeps the old binary, and if it was killed the logo is gone until
> restarted. `clade-monitor`'s app watchdog relaunches it within ~60s as a
> backstop. See `.claude/rules/cron-life.md` → "INVARIANT: trios menu-bar logo".

---

## 3. PHI LOOP Execution

Follow the 9-phase PHI LOOP for ring-based development:

1. **Issue** — Define problem or requirement (GitHub issue #N)
2. **Spec** — Write agent instruction or skill spec
3. **TDD** — Define test criteria (build passes, e2e passes, no regressions)
4. **Code/Impl** — Implement in Swift according to spec
5. **Gen** — Not applicable (trios has no code generator; Swift is canonical)
6. **Seal** — Verify build and run e2e
7. **Verify** — Run tests, check UI anomalies
8. **Land** — Merge changes to `dev` branch
9. **Learn** — Capture learnings and update knowledge base

### Phase Completion Marker

When a phase is complete, include in your output:
```
Phase complete: [phase name]
→ Phase [next phase number]: [next phase name]
```

---

## 4. Autonomous subagent behavior (when spawned unattended)

- Finish the assigned task without waiting for clarification unless the repo's own rules require human input.
- If blocked after reasonable retries, stop and report what failed (logs, commands, file paths).
- Prefer small, reviewable diffs; match existing style and naming in touched files.
- **Output persistence:** when the parent workflow requires it, write the full final report to `/tmp/claude_code_output.md`.

---

## 5. Skills and tooling

### T27 Skills (spec-first / canon governance)

- `/t27-phi-loop` — T27 9-phase PHI LOOP adapted for trios
- `/t27-tri-pipeline` — `clade-build` → `clade-e2e` → `clade-seal` → `clade-promote`
- `/t27-experience-save` — Save episodes to `.trinity/experience/`
- `/t27-wave-loop` — Standing-wave charter for multi-variant work

### trios-Specific Skills

- `/phi-loop` — Execute 9-phase PHI LOOP
- `/tri-pipeline` — Execute tri commands (build, e2e, verify)
- `/experience-save` — Save learnings to persistent memory
- `/doctor` — Diagnose and heal build/dirty state
- `/god-mode` — Full oversight and audit
- `/bridge` — BrowserOS MCP bridge operations

Load these skills when their functionality matches the task.

---

## 6. Security and secrets

- Never commit secrets. Root `.env` patterns are gitignored; use `.env.example` patterns only in docs.
- The `.env` file in `trios-mcp-rag` contains LIVE credentials — never copy to trios.
- API keys (OpenRouter, etc.) are read from environment or `~/.trios/config.json`.

---

## L0b — TERRITORY: the seed and the boards belong to another agent

A second agent owns the **t27 repository** and the **FPGA stands** (wave W931,
branch `claude/igla-fpga-improvements`), with an active yosys/nextpnr sweep and
the TNF publication gate.

- **Do not edit `/Users/playra/t27`.** Compiler gaps are reported to them.
- **Do not program a board.** A route job may be in flight.
- `t27/fpga/HARDWARE_SSOT.md` is authoritative for hardware. Do not keep a
  second register here; point at it.

This repository owns the `.t27` ring sources, their parity harnesses, and the
service that runs them.

---

## L0 — SOURCE: everything is T27 except the seed

**Added 2026-08-19 by the operator's decision. Sits above L1.**

Every component below the user interface is written in `.t27` and generated to
its target. Swift keeps the interface and nothing under it. The single
exception is the seed: `t27/bootstrap`, the minimal Rust compiler `t27c`, where
hand-written Rust is the point.

A rule transcribed into Swift, Rust, Zig and Verilog is four rules that agree
until someone edits one. Generated from one `.t27` it is one rule. That is the
whole argument.

**Generated files are artifacts.** They are not edited. A diff that changes a
generated file without changing its `.t27` is a defect.

Migration goes in rings, innermost first, and a ring is not started until the
one inside it runs in production. See `.claude/skills/t27-backend/SKILL.md` for
the ring table, the verified toolchain, the compiler gaps that block generation
today, and the Railway and A2A modules to build on rather than replace.

**Targets:** `t27c gen-rust` (server), `gen` (Zig), `gen-c`, `gen-verilog`
(silicon). The Zynq XC7Z020 on this machine answers over JTAG, and the flow
`yosys` + `nextpnr-xilinx` + `openFPGALoader` needs no Vivado - so a ring that
claims to be synthesisable is checkable, and must be checked rather than read.

---

## The 7 Invariant Laws (trios adaptation)

| Law | Name | Description |
|------|------|-------------|
| L1 | TRACEABILITY | No code merged without `Closes #N` |
| L2 | GENERATION | Agent instructions/skills/specs are source of truth; canon Swift files (`BR-OUTPUT/`, selected `rings/`) are generated/reviewed artifacts; hand edits require Agent V waiver |
| L3 | PURITY | **Everything is written in English** - source, comments, documentation, issues, commit messages. Source files ASCII-only. Extended from "English identifiers" by the operator on 2026-08-19; issues written before that date are in Russian, which is why `## Границы` and `## Boundary` both open a boundary section |
| L4 | TESTABILITY | Every change must pass `./build.sh` + e2e flow + agent V verdict |
| L5 | IDENTITY | φ² = φ + 1; φ² + φ⁻² = 3; sacred constants in UI (GoldenFloat) |
| L6 | CEILING | `ProjectPaths.swift` + `TriosTheme.swift` are UI SSOT |
| L7 | UNITY | No new `*.sh` on critical path; use `build.sh` or MCP tools |

**Law Priority:** L1 > L2 > L3 > L4 > L5 > L6 > L7 (Asimov-style hierarchy)

---

**Repository:** trios — Swift macOS app for Trinity A2A network. **φ² + 1/φ² = 3 | TRINITY**
