# Plan: BR-OUTPUT Swift → T27 Agent-Driven Refactor + L2 Hand-Edit Freeze

**Date:** 2026-07-21  
**Scope:** Only `trios/BR-OUTPUT/*.swift` (35 files, ~6.8 kLOC). Rust rings and `trios-mesh` are out of scope.  
**Automation model:** Existing T27 agent lattice (`t27-creator` → `t27-verifier` under `t27-queen`) and skills (`/t27-phi-loop`, `/t27-tri-pipeline`, `/t27-experience-save`, `/t27-wave-loop`).  
**Lockdown goal:** Enforce **L2 GENERATION** — direct hand edits to canon Swift require an `AGENT-V-WAIVER` block; routine changes must flow through `spec → creator → verifier → seal → land → learn`.

---

## 1. Current state

| Layer | Status |
|---|---|
| Constitution (`SOUL.md` Article IX, `CLAUDE.md` L2/L6, `coordination-law.md`) | **Landed** (commit `056bbaf5` per `current-issue.md`). |
| T27 agents (`t27-creator`, `t27-verifier`, `t27-learner`, `t27-experience`, `t27-queen`) | **Created** and registered in `.claude/agents/registry.json`. |
| T27 skills (`t27-phi-loop`, `t27-tri-pipeline`, `t27-experience-save`, `t27-wave-loop`) | **Created**. |
| Queue/claims/events | Skeleton exists (`queue/*.json`, `claims/active/`, `events/akashic-log.jsonl`). |
| Pilot spec | `trios/.trinity/specs/recursion-guard.md` exists in `draft` status. |
| Pilot implementation | `BR-OUTPUT/RecursionGuard.swift` is still hand-written; no seal/verdict. |
| L2 enforcement | Declared in law, **not mechanically enforced** yet (no `seals/`, no `verdicts/`, no ownership index, no hooks/ring guard). |
| Uncommitted hand edits | `trios/BR-OUTPUT/ChatPanelView.swift`, `MessageBubbleView.swift`, and root `CLAUDE.md` are modified on current branch `feat/zai-provider`. These need either an L2 waiver or a retroactive spec pass before freeze. |

---

## 2. Definition of Done

- [ ] Every `BR-OUTPUT/*.swift` file is mapped in `.trinity/state/ownership-index.json` to a spec and an agent owner.
- [ ] Every file has either:
  - an active T27 seal in `.trinity/seals/{file-stem}.json`, or
  - an explicit `// AGENT-V-WAIVER:` block with a follow-up issue.
- [ ] `RecursionGuard.swift` is the **first fully sealed pilot** (spec → creator → verifier → seal → experience).
- [ ] A mechanical guard blocks routine hand edits to canon files without an active claim + verifier verdict.
- [ ] No new `.sh` on the engineering critical path except existing grandfathered scripts (L7 UNITY).
- [ ] All artifacts remain ASCII-only (L3 PURITY).
- [ ] Every land commit carries `Closes #N` (L1 TRACEABILITY).

---

## 3. Decomposition

### Phase 0 — L2 Enforcement Foundation (P0)
*Goal: make L2 GENERATION enforceable before touching any canon file.*

#### 0.1 Canon directories and schemas
Create:
- `trios/.trinity/seals/` — seal artifacts.
- `trios/.trinity/state/verdicts/` — t27-verifier verdict files.
- `trios/.trinity/state/ownership-index.json` — canonical map.

Seal schema:
```json
{
  "file": "BR-OUTPUT/RecursionGuard.swift",
  "spec": ".trinity/specs/recursion-guard.md",
  "agent": "t27-creator",
  "verifier": "t27-verifier",
  "claim_id": "...",
  "sealed_at": "2026-07-21T10:00:00Z",
  "build": "PASS",
  "e2e": "PASS",
  "l1_l7": "CLEAN"
}
```

#### 0.2 Ownership index
Populate `ownership-index.json` for all 35 `BR-OUTPUT/*.swift` files, mapping each to:
- spec path,
- owner agent (from AGENTS.md alphabet or T27 role),
- seal status,
- L6 SSOT flag for `ProjectPaths.swift` and `TriosTheme.swift`.

#### 0.3 Mechanical guard (Rust, not shell)
Extend `rings/RUST-12/clade-audit/src/main.rs` with an `audit --canon` mode that checks:
1. Every modified `BR-OUTPUT/*.swift` file has a matching active claim in `.trinity/claims/active/` or an `AGENT-V-WAIVER` block.
2. A seal exists for files not marked as L6 SSOT.
3. No unexplained hand edits.

This satisfies L7 UNITY (no new `.sh`). If a Claude `PreToolUse` hook is also desired, it should call the Rust ring or a tiny Swift helper, not a new shell script.

#### 0.4 Verdict persistence
Update `t27-verifier` agent instructions to **require** writing `.trinity/state/verdicts/{task_id}.json` before reporting `CLEAN`.

#### 0.5 Current branch reconciliation
For the uncommitted `ChatPanelView.swift` and `MessageBubbleView.swift` changes:
- Option A: add an `AGENT-V-WAIVER` block retroactively and open a follow-up issue to respec.
- Option B: revert the hand edits and re-apply via `t27-creator` from a spec update.

---

### Phase 1 — Pilot: RecursionGuard (P0)
*Goal: prove the full T27 loop on one safety-critical file.*

1. **Issue** — reuse `#T27-EPIC-001` or create a real GitHub issue number.
2. **Spec** — move `recursion-guard.md` from `draft` to `active`; add `claim_id` and `agent: K`.
3. **Claim** — `t27-queen` acquires claim on `recursion_guard` graph node.
4. **TDD** — ensure tests T-1..T-6 from the spec are executable (build + existing e2e + rust tests).
5. **Code/Impl** — `t27-creator` blesses or rewrites `BR-OUTPUT/RecursionGuard.swift` from the spec.
6. **Review** — `t27-verifier` reviews the diff.
7. **Seal** — `/t27-tri-pipeline seal` runs `./build.sh` + `cargo run --bin clade-e2e`.
8. **Verify** — `t27-verifier` writes verdict; result must be `CLEAN`.
9. **Land** — commit `ring-SR-00-seal: RecursionGuard T27 spec-driven (Closes #N)`.
10. **Learn** — `/t27-experience-save` writes episode.
11. **Freeze** — add seal file and flip `ownership-index.json` → `"sealed": true`.

---

### Phase 2 — Safety Core (P0-P1)
*Files with safety/state business logic. Each gets its own spec and seal.*

| File | Owner agent | Spec to create / reuse |
|---|---|---|
| `ChatLogic.swift` | L (Language) + K (Kernel) | `.trinity/specs/chat-logic.md` |
| `CladeGuard.swift` | K (Kernel) | reuse/extend `.trinity/specs/clade-guard.md` |
| `SessionGuard.swift` | K | `.trinity/specs/session-guard.md` |
| `WindowManager.swift` | H (UI) + K | `.trinity/specs/window-manager.md` |

Execution per file: spec → claim → t27-creator → t27-verifier → `/t27-tri-pipeline seal` → experience save → freeze.

---

### Wave 1 — Chat/Queen VM (P1)
*High-touch UI/UX business logic.*

| File | Owner | Spec |
|---|---|---|
| `BrowserOSChatViewModel.swift` | X (External/MCP) | `browseros-chat-vm.md` |
| `QueenStatusViewModel.swift` | Q (Queue) / T (Queen) | `queen-status-vm.md` |
| `ChatPanelView.swift` | H (UI) | `chat-panel-view.md` |
| `MessageBubbleView.swift` | H (UI) | `message-bubble-view.md` |
| `RichTextRenderer.swift` | L (Language) | `rich-text-renderer.md` (replace `manualMarkdown()` with spec-driven renderer) |
| `TypingIndicatorView.swift` | H (UI) | `typing-indicator-view.md` |
| `AgentTaskBubbleView.swift` | H (UI) | `agent-task-bubble-view.md` |
| `StreamingAnimations.swift` | H (UI) + P (Physics/phi) | `streaming-animations.md` |

---

### Wave 2 — MCP / Bridge / Server (P1-P2)
*External integration logic.*

| File | Owner | Spec |
|---|---|---|
| `TriosMCPClient.swift` | X (External/MCP) | `trios-mcp-client.md` |
| `A2AMessageRouter.swift` | X | `a2a-message-router.md` |
| `LLMClient.swift` | X | `llm-client.md` |
| `ServerManager.swift` | B (Build) + X | `server-manager.md` |
| `QueenQuickActionsSheet.swift` | H (UI) + Q | `queen-quick-actions.md` |
| `QueenTabView.swift` | H (UI) + T | `queen-tab-view.md` |

---

### Wave 3 — Git / GitHub (P2)
*Source-control UI and models.*

| File | Owner | Spec |
|---|---|---|
| `GitButlerPanelView.swift` | H (UI) | `gitbutler-panel-view.md` |
| `GitButlerViewModel.swift` | W (Workflow) | `gitbutler-vm.md` |
| `GitHubDashboardView.swift` | H (UI) | `github-dashboard-view.md` |
| `GitHubAPIClient.swift` | X (External) | `github-api-client.md` |
| `GitHubModels.swift` | S (Specs) | `github-models.md` |
| `GitWorkspaceView.swift` | W (Workflow) | `git-workspace-view.md` |

---

### Wave 4 — Mesh (P2)
*Mesh tab and models.*

| File | Owner | Spec |
|---|---|---|
| `MeshTabView.swift` | H (UI) + G (Graph) | `mesh-tab-view.md` |
| `MeshStatusViewModel.swift` | G (Graph) | `mesh-status-vm.md` |
| `MeshModels.swift` | S (Specs) | `mesh-models.md` |

---

### Wave 5 — Terminal / E2E / Helpers (P2-P3)

| File | Owner | Spec |
|---|---|---|
| `TerminalTabView.swift` | W (Workflow) | reuse/extend `.trinity/specs/terminal-shell-free.md` |
| `E2ETestRunner.swift` | F (Conformance) | `e2e-test-runner.md` |
| `MenuBuilder.swift` | H (UI) | `menu-builder.md` |

---

### Wave 6 — UI Chrome (P3)
*Low business-logic, high UI glue. Specs are thin but still enforce provenance.*

| File | Owner | Spec |
|---|---|---|
| `TriosTabView.swift` | H (UI) | `trios-tab-view.md` |
| `GlassmorphismBackground.swift` | H (UI) + P (Physics) | `glassmorphism-background.md` |
| `QueenStatusBadge.swift` | H (UI) | `queen-status-badge.md` |
| `ToolCallCardView.swift` | H (UI) | `tool-call-card-view.md` |

---

### Wave 7 — L6 SSOT Files (P3, special)
*Per L6 CEILING these two files remain the UI SSOT. They are canon but cannot be deleted/replaced by generated code.*

| File | Owner | Spec |
|---|---|---|
| `ProjectPaths.swift` | A (Architecture) | `project-paths.md` — spec **describes** the SSOT contract; file remains authoritative. |
| `TriosTheme.swift` | H (UI) + P (Physics/phi) | `trios-theme.md` — spec documents theme constants and sacred-constant usage. |

Handling:
- t27-creator generates/updates the spec and verifies the file matches it.
- Any change to these files requires an explicit L6 waiver in the spec and a V verdict.
- They still get a seal, but the seal type is `"ssot"` rather than `"generated"`.

---

## 4. L2 Hand-Edit Freeze Enforcement

### 4.1 What is blocked
A direct `Write` or `Edit` to any `BR-OUTPUT/*.swift` file is blocked unless one of:
1. An active claim in `.trinity/claims/active/{file-stem}.json` covers the file and has not expired.
2. The file contains an `// AGENT-V-WAIVER:` block with issue URL and reason, and the issue is still open.
3. The file is an L6 SSOT file and the spec documents the change.

### 4.2 How it is blocked
- **Git level:** extend `clade-audit --canon` and run it in `trios/lefthook.yml` `pre-commit` (Rust, not shell).
- **Session level:** Claude Code `.claude/settings.json` `PreToolUse` hook invokes `cargo run --bin clade-audit --canon` (or a dedicated `clade-t27-guard` ring) before `Write`/`Edit` on canon paths.
- **CI level:** add a GitHub Actions job that runs `cargo run --bin clade-audit --canon` on PR diffs.

### 4.3 Waiver format
```swift
// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/NNN
// Reason: critical hotfix for menu-bar logo invariant; follow-up spec in issue #NNN.
// Expires: 2026-07-28
```

---

## 5. Risk register

| Risk | Mitigation |
|---|---|
| 35 files × 9-phase loop is large and repetitive. | Use `/t27-wave-loop` to batch 1–3 related files per wave; stop after each wave for user confirmation. |
| Current uncommitted `ChatPanelView.swift` / `MessageBubbleView.swift` edits. | Retroactive waiver (Option A) or revert + respec via agent (Option B); decide before Phase 0. |
| Agent-driven edits may break UI in subtle ways. | Every wave ends with `./build.sh` + `cargo run --bin clade-e2e` + screenshot anomaly checklist. |
| t27-verifier may be too strict for pure view files. | Pure-view specs can be thin; verifier checks only L1-L7 and build, not semantic equivalence. |
| `ProjectPaths.swift` / `TriosTheme.swift` are touched by many specs. | Special L6 SSOT seal type; changes require Architect agent + explicit spec update. |
| Mechanical guard may block legitimate emergency fixes. | Waiver path always available; waived files tracked in `.trinity/state/waivers.json` with expiry. |

---

## 6. Milestones & estimates

| Milestone | Deliverables | Priority | Owner | Estimate |
|---|---|---|---|---|
| M0 | L2 foundation: `seals/`, `verdicts/`, ownership index, `clade-audit --canon` | P0 | A + V | 1 day |
| M1 | Pilot sealed: `RecursionGuard.swift` + `recursion-guard.md` active + seal | P0 | K + C + V | 1–2 days |
| M2 | Safety core sealed: `ChatLogic`, `CladeGuard`, `SessionGuard`, `WindowManager` | P0-P1 | K + L + H + V | 2–3 days |
| M3 | Chat/Queen VM wave sealed | P1 | H + X + T + V | 2–3 days |
| M4 | MCP/Bridge wave sealed | P1-P2 | X + B + V | 2 days |
| M5 | Git/GitHub wave sealed | P2 | W + H + V | 2 days |
| M6 | Mesh wave sealed | P2 | G + H + V | 1–2 days |
| M7 | Terminal/E2E/UI chrome sealed | P2-P3 | F + H + W + V | 2 days |
| M8 | L6 SSOT files sealed (`ProjectPaths`, `TriosTheme`) | P3 | A + H + P + V | 1 day |
| M9 | Docs update + memory save | P3 | Z + E | 0.5 day |

---

## 7. First concrete steps (after plan approval)

1. Decide on branch: continue from `feat/zai-provider` or create `feat/t27-brooutput` from `dev`.
2. Reconcile current uncommitted `ChatPanelView.swift` / `MessageBubbleView.swift` edits (waiver or revert).
3. Create `trios/.trinity/seals/` and `trios/.trinity/state/verdicts/`.
4. Write `trios/.trinity/state/ownership-index.json` for all 35 files.
5. Extend `clade-audit` with `--canon` mode.
6. Run the RecursionGuard pilot through the full T27 loop.
7. After pilot success, run Wave 1 (Safety Core) and ask for confirmation before subsequent waves.

---

## 8. Out-of-scope notes (for future epics)

- `trios-mesh` `.t27` → `t27c gen-rust` convergence.
- Rust clade rings (`clade-monitor`, `clade-promote`, `clade-audit`, etc.) spec governance.
- Swift rings `rings/SR-00/` / `SR-01/` / `SR-02/`.
- Adding a `gen-swift` backend to `t27c`.

These stay in `#T27-EPIC-001` backlog.

---

*phi^2 + 1/phi^2 = 3 | TRINITY*
