# TriOS Weak-Spot Loop — Cycle 14 Plan

**Date:** 2026-07-24  
**Branch:** `feat/zai-provider`  
**Trigger:** "исследуй слабые места задачи, исследуй конкурентов по теме, создай декомпозированный план и реализуй все и в конце отчет и три варианта"

---

## 1. Weak spots researched

After Cycle 13 hardened the clade-audit hard gates (Swift build, security,
error handling, dead code, retain cycles) to zero false positives, the
remaining noisiest self-critic surface is the **TODO/FIXME inventory**.

Current baseline (`cargo run --bin clade-audit`):

| Check | Status | Findings | Nature |
|---|---|---|---|
| Build gate | OK | 0 | — |
| Security scan | OK | 0 | — |
| Shell safety | OK | 0 | — |
| Error handling | OK | 0 | — |
| Concurrency | FAIL | 43 | All `@Published var ... = []` style defaults (info/warning) |
| **TODO/FIXME inventory** | **FAIL** | **~633** | **Mostly regex false positives** |
| Dead code | OK | 0 | — |
| Retain cycles | OK | 0 | — |

The TODO scanner's regex is `(?i)(TODO|FIXME|HACK|XXX|WARN|BUG)\s*[:\-]?\s*(.*)`.
It has no word boundaries, so it matches substrings inside identifiers and
documentation:

| False positive | Real line | Why it matched |
|---|---|---|
| `BUG: , Clone)]` | `#[derive(Debug, Clone)]` | "BUG" inside **Debug** |
| `BUG: ging (critical)` | `TODO / BUG fixes` in markdown tables | Literal "BUG" in prose |
| `WARN: ing = "warning"` | `var warning = "warning"` | "WARN" inside **warning** |
| `TODO: Item]) -> some View` | `func foo(_ item: TODOItem)` | "TODO" inside **TODOItem** |
| `TODO: 001` | `TODOAnimations.swift` filename | "TODO" inside filename string |

Because the check reports **critical** severity for any `BUG` or `FIXME` match,
real code issues are buried under hundreds of documentation/table/derive false
positives. The autonomous loop cannot use this output for prioritization.

**Selected Cycle 14 target:** make the TODO/FIXME inventory scanner truthful and
actionable.

---

## 2. Competitor snapshot — late July 2026

The AI-agent workspace/browser category is in a **trust crisis**. TriOS's moat
remains **local-first, verifiable autonomy**.

| Competitor | Recent move / July 2026 incident | Lesson for TriOS |
|---|---|---|
| **OpenAI Workspace Agents / Atlas** | "AgentForger" disclosed July 23, 2026: a single tampered `chatgpt.com/agents/studio/new` link could create a rogue autonomous agent under the victim's identity, reuse authorized enterprise connectors, and run every 5 minutes ([The Decoder](https://the-decoder.com/one-tampered-chatgpt-link-could-spawn-a-rogue-ai-agent-that-took-orders-from-an-attacker-every-five-minutes/)) | Cloud agent builders are dangerous when a URL can autorun creation + connectors. TriOS must keep agent creation local and require explicit user authorization. |
| **OpenAI Atlas, Perplexity Comet, Anthropic Claude extension, Fellou, Genspark, Sigma** | "BioShocking" attack July 2026: a malicious "game" page convinced AI browsers to drop guardrails and exfiltrate GitHub SSH credentials. Atlas fixed; Comet closed without confirmed fix; others unresponsive ([Lemma](https://lemma.frame00.com/critical/briefs/098-bioshocking-agentic-browser-context/), [Yahoo/Forbes](https://ca.news.yahoo.com/ai-browsers-safe-single-page-141500881.html)) | Indirect prompt injection is still undefeated. Untrusted web content must be isolated from the instruction channel; local trust boundaries matter more than cloud prompt filters. |
| **Perplexity Comet** | Trail of Bits red-team (pre-launch, disclosed Feb 2026) showed four prompt-injection paths that exfiltrated Gmail via fake CAPTCHA, fragments, and policy-update pages ([Trail of Bits](https://blog.trailofbits.com/2026/02/20/using-threat-modeling-and-prompt-injection-to-audit-comet/)) | Even well-funded red-teaming only *addresses* findings; it doesn't close the attack class. TriOS should market continuous local self-critic, not just one-time audits. |
| **Dia Browser** | Earlier XPIA research (Repello, July 2025) and CVE-2025-13132 fullscreen spoofing show UI-layer trust failures ([Repello](https://repello.ai/blog/security-threats-in-agentic-ai-browsers), [CVE-2025-13132](https://cve.imfht.com/detail/CVE-2025-13132?lang=en)) | Browser UI itself is a trust surface; TriOS's menu-bar/logo invariant and local status indicators are defensive assets. |

### Strategic takeaway

Competitors are losing trust because their agents cannot prove what they will
or won't do. TriOS must make its **self-critic output demonstrably accurate**:
a clean audit must mean the code is actually clean. Cycle 13 fixed the hard
gates; Cycle 14 finishes the job by making the TODO inventory actionable.
Once the gate is trustworthy, Cycle 15 can turn it into a promotion-sealing
system (Option B below).

---

## 3. Decomposed implementation plan

### Slice A — Harden the TODO scanner regex and context

**File:** `trios/rings/RUST-12/clade-audit/src/main.rs`

**Changes:**
1. Replace the substring regex with word-boundary, comment-aware patterns:
   - Swift/Rust: require `//`, `///`, `/*`, or `*/` before the keyword, OR the
     keyword at the start of a `//` / `///` / `/*` comment.
   - Markdown: require the keyword in a task-style marker (`- [ ]`, `- [x]`,
     `## TODO`, `## FIXME`) rather than inline prose/link text.
2. Add word boundaries (`\b`) around each keyword so `Debug` / `warning` /
   `TODOAnimations` no longer match.
3. Keep severity mapping: `FIXME`/`BUG` → critical, `TODO`/`HACK`/`XXX` →
   warning, `WARN` → info.

**Tests:** Run `cargo run --bin clade-audit`; the `#[derive(Debug, Clone)]`
lines, `warning` variable names, and markdown link text must no longer produce
criticals.

### Slice B — Scope the scanner to actionable code and curated docs

**File:** `trios/rings/RUST-12/clade-audit/src/main.rs`

**Changes:**
1. Exclude directories that are not part of the shipped product:
   - `.archive/`
   - `.claude/agents/`, `.claude/skills/`, `.claude/plans/`
   - `.trinity/specs/`, `.trinity/wave-loop*.md`, `.trinity/experience.md`
   - `.llm/plans/`
   - `docs/LAUNCH_PLAN.md`, `docs/INSTALLATION_README.md` (planning/checklist docs)
   - `PluginTemplate.swift` (a template, not runtime code)
2. For `.md` files, scan only a curated allowlist if needed; default behavior
   should focus on Swift/Rs source.
3. Add `should_skip_todo_path(path)` helper consistent with the existing
   `should_skip_audit_path` helper.

**Tests:** `cargo run --bin clade-audit` TODO check should drop from ~633 to a
much smaller number of real actionable items.

### Slice C — Handle remaining real findings

After the scanner is hardened, inspect the remaining findings. Any remaining
`BUG`/`FIXME` in real Swift/Rust code that is small and safe to fix in this
cycle should be addressed or waived with `AGENT-V-WAIVER`. Any large remaining
items become backlog for Cycle 15.

---

## 4. Verification gates

- `cargo run --bin clade-audit` — TODO/FIXME findings reduced to real,
  actionable items; hard gates still at zero.
- `./build.sh` — pass.
- `cargo test --workspace` — pass.
- `cargo clippy --workspace` — clean.
- `cargo run --bin clade-e2e` — report generated.
- `open trios.app` relaunch and `curl http://127.0.0.1:9105/health` — ok.

---

## 5. Three cooperation options for Cycle 15

### Option 1 — Fix all @Published array defaults (clean Concurrency gate)
Convert the 43 `@Published var foo: [Type] = []` defaults to explicit empty
initializers for Swift 6 actor-isolation clarity. Mechanical, touches many
BR-OUTPUT files, but would make the Concurrency gate pass.

### Option 2 — `clade-seal` automation *(recommended)*
Build on Cycle 13–14 audit work: create a `clade-seal` ring that runs
build/test/clippy/ASCII/tmp-zero gates, collects a verdict, and writes a signed
seal to `.trinity/state/seal.json`. `clade-promote` can then gate promotion on a
valid seal. This turns TriOS's truthful self-critic into an auditable
release gate.

### Option 3 — Local agent-creation authorization
Competitor research showed one malicious link can spawn a rogue cloud agent.
Add a local, explicit human-approval step before Queen creates new A2A agents
or registers new skills, with a Keychain-backed authorization token. Direct
product differentiation against AgentForger/BioShocking class of attacks.
