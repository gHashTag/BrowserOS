# TriOS Weak-Spot Loop — Cycle 14 Final Report

**Date:** 2026-07-24  
**Branch:** `feat/zai-provider`  
**Cycle issue:** `TRIOS-TODO-SCANNER-TRUTH-014`  
**Experience:** `.trinity/experience/2026-07-24_todo-scanner-truth-cycle-14.json`

---

## What was implemented

Cycle 14 hardened the **TODO/FIXME inventory scanner** in `clade-audit` so it
stops crying wolf. Cycle 13 made the hard gates truthful (Swift build, security,
error handling, dead code, retain cycles all at zero false positives); the
remaining TODO inventory was still emitting ~633 findings, most of them noise.

### Changes

**`rings/RUST-12/clade-audit/src/main.rs`**

1. Added `should_skip_todo_path()` to exclude planning docs, agent/skill
templates, archived experiments, smoke-test markdown, and installation checklists
that legitimately contain TODO/BUG/WARN text:
   - `.archive/`, `.claude/agents/`, `.claude/skills/`, `.claude/plans/`
   - `.trinity/specs/`, `.trinity/wave-loop*.md`, `.trinity/experience.md`
   - `.llm/plans/`, `trios-mesh/smoke/`
   - `PluginTemplate.swift`, `docs/LAUNCH_PLAN.md`, `docs/INSTALLATION_README.md`,
     `INSTALL_TODO.md`

2. Replaced the substring regex `(?i)(TODO|FIXME|HACK|XXX|WARN|BUG)\s*[:\-]?\s*(.*)`
with context-aware matchers:
   - **Swift/Rust (`code_todo_match`)**: only matches keywords inside comments
     (`//`, `///`, `/*`). Word boundaries prevent `Debug` → `BUG`, `warning` →
     `WARN`, and `TODOItem` → `TODO` false positives.
   - **Markdown (`markdown_todo_match`)**: only matches task checkboxes
     (`- [ ] TODO:`) or section headings (`## BUG`). Inline prose and table cells
     no longer produce findings.

3. Made `todo_check()` use the existing `scannable_content()` helper, which drops
   the auditor's own source and truncates Rust test modules. This removed the
   self-match from the old TODO regex unit test.

### Result

`cargo run --bin clade-audit` TODO/FIXME inventory:

| Before | After |
|---|---|
| ~633 findings | **1 finding** |
| Criticals from `#[derive(Debug, Clone)]`, markdown tables, variable names | None |
| Self-matches from `clade-audit/src` test fixtures | None |

The remaining single finding is a real, tracked code TODO:

```
rings/SR-02/ChatViewModel.swift:474 - TODO: wire to server feedback endpoint when available
```

---

## Verification results

| Gate | Result |
|---|---|
| `cargo run --bin clade-audit` Swift build gate | **0 errors** |
| Security scan | **0 findings** |
| Shell safety | **0 findings** |
| Error handling | **0 findings** |
| TODO/FIXME inventory | **1 real TODO** (no false positives) |
| Dead code | **0 findings** |
| Retain cycles | **0 findings** |
| `./build.sh` | **PASS** (exit 0; ChatSSEEndToEnd tests passed) |
| `cargo test --workspace` | **PASS** |
| `cargo clippy --workspace` | **clean** |
| `cargo run --bin clade-e2e` | report generated at `.trinity/e2e/report_prod_1784965623.md` |
| `open trios.app` + `curl /health` | `{"status":"ok","cdpConnected":true}` |

The Concurrency gate still reports 43 `@Published var ... = []` style defaults
as warnings; these were intentionally left for a future mechanical pass.

---

## Competitor snapshot — late July 2026

The AI-agent workspace/browser category is in a trust crisis. TriOS's moat
remains **local-first, verifiable autonomy**.

| Competitor | Recent move / July 2026 incident | Lesson for TriOS |
|---|---|---|
| **OpenAI Workspace Agents / Atlas** | "AgentForger" (July 23, 2026): a tampered `chatgpt.com/agents/studio/new` link could create a rogue autonomous agent under the victim's identity, reuse authorized enterprise connectors, and run every 5 minutes ([The Decoder](https://the-decoder.com/one-tampered-chatgpt-link-could-spawn-a-rogue-ai-agent-that-took-orders-from-an-attacker-every-five-minutes/)) | Cloud agent builders are dangerous when a URL can autorun creation + connectors. Keep agent creation local and require explicit user authorization. |
| **OpenAI Atlas, Perplexity Comet, Anthropic Claude extension, Fellou, Genspark, Sigma** | "BioShocking" (July 2026): a malicious "game" page convinced AI browsers to drop guardrails and exfiltrate GitHub SSH credentials. Atlas fixed; Comet closed without confirmed fix; others unresponsive ([Lemma](https://lemma.frame00.com/critical/briefs/098-bioshocking-agentic-browser-context/), [Yahoo/Forbes](https://ca.news.yahoo.com/ai-browsers-safe-single-page-141500881.html)) | Indirect prompt injection is still undefeated. Untrusted web content must be isolated from the instruction channel; local trust boundaries matter more than cloud prompt filters. |
| **Perplexity Comet** | Trail of Bits red-team (Feb 2026, disclosed) showed four prompt-injection paths that exfiltrated Gmail via fake CAPTCHA, fragments, and policy-update pages ([Trail of Bits](https://blog.trailofbits.com/2026/02/20/using-threat-modeling-and-prompt-injection-to-audit-comet/)) | Red-teaming addresses findings but does not close the attack class. Market continuous local self-critic, not one-time audits. |
| **Dia Browser** | Earlier XPIA research and CVE-2025-13132 fullscreen spoofing show UI-layer trust failures ([Repello](https://repello.ai/blog/security-threats-in-agentic-ai-browsers), [CVE-2025-13132](https://cve.imfht.com/detail/CVE-2025-13132?lang=en)) | Browser UI itself is a trust surface; TriOS's menu-bar/logo invariant and local status indicators are defensive assets. |

### Strategic takeaway

Competitors are losing trust because their agents cannot prove what they will or
won't do. TriOS must make its **self-critic output demonstrably accurate**.
Cycle 13 fixed the hard gates; Cycle 14 finished the job by making the TODO
inventory actionable. Once the gate is trustworthy, the next step is to turn it
into an enforceable promotion seal.

---

## Three Cycle-15 options

### Option 1 — Clean the Concurrency gate (mechanical @Published pass)
Convert the 43 `@Published var foo: [Type] = []` defaults in BR-OUTPUT and
`rings/SR-02` to explicit empty initializers (`= .init()` or `= Array()`). This
is a pure style/clarity pass and would make the Concurrency gate green.
**Risk:** low; touches many files but is entirely mechanical.

### Option 2 — `clade-seal` automation *(recommended)*
Build on Cycle 13–14 audit truth work: create a `clade-seal` ring that runs
build/test/clippy/ASCII/tmp-zero gates, collects a verdict, and writes a signed
seal to `.trinity/state/seal.json`. `clade-promote` can then gate promotion on a
valid seal. This turns the truthful self-critic into an auditable release gate.
**Risk:** medium; new Rust ring + integration with promotion flow.

### Option 3 — Local agent-creation authorization
Competitor research showed one malicious link can spawn a rogue cloud agent.
Add a local, explicit human-approval step before Queen creates new A2A agents or
registers new skills, with a Keychain-backed authorization token. This is direct
product differentiation against the AgentForger/BioShocking attack class.
**Risk:** medium-high; touches UI, Keychain, and A2A registry paths.

---

## Recommendation

Choose **Option 2** next. Cycle 14 proved the audit output is now actionable;
the natural next step is to make that action enforce promotion. Option 2 builds
on the files just modified, stays inside the existing T27 verification flow, and
provides the highest leverage before returning to product features.
