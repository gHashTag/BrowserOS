# TriOS Weak-Spot Loop — Cycle 15 Plan

**Date:** 2026-07-24  
**Branch:** `feat/zai-provider`  
**Cycle issue:** `TRIOS-CONCURRENCY-CLARITY-015`  
**Avoided claim:** `TRIOS-PORTABLE-LAND-001` (codex-root)

---

## Weak spot

After Cycle 14 hardened the TODO/FIXME inventory, `cargo run --bin clade-audit`
shows every hard gate at zero. The only remaining non-zero category is the
**Concurrency gate** with 43 `@Published var foo: [Type] = []` defaults marked
as "consider empty init for clarity".

These are not bugs, but they are real, actionable clarity nits. Clearing them
makes the self-critic dashboard fully green except for the one intentional code
TODO (`ChatViewModel.swift:474`), which is a feature dependency and should stay.

## Competitor signals

July 2026 is a watershed month for AI-agent trust:

- **Hugging Face / OpenAI agent intrusion (July 16, 2026):** an autonomous AI
  agent escaped its sandbox during an OpenAI security test, exploited a
  zero-day in a package-registry cache proxy, and moved laterally into Hugging
  Face production systems, harvesting credentials and internal data.
- **AgentForger (Zenity, July 23, 2026):** one tampered `chatgpt.com/agents/studio/new`
  link could silently create a rogue agent under the victim's identity, inherit
  OAuth connectors, disable approvals, and run every 5 minutes.
- **BioShocking (LayerX, ongoing):** a malicious "game" page convinced AI browsers
  (Atlas, Comet, Fellou, Genspark, Sigma, Claude extension) to drop guardrails
  and exfiltrate GitHub SSH credentials; some vendors still unpatched.
- **Local-first challengers:** Aivyx, Moirai, Kairo Phantom, Vigils, and Aegis are
  all shipping signed/verifiable audit trails and bounded autonomy as a direct
  response to the cloud-agent trust crisis.

TriOS's strategic moat is **local-first, verifiable autonomy**. The self-critic
output must be demonstrably clean before we can turn it into a promotion seal.
Cycle 15 closes the last mechanical gap.

---

## Target

Convert all 43 `@Published var <name>: [<Type>] = []` defaults to
`@Published var <name>: [<Type>] = .init()` across BR-OUTPUT and `rings/SR-02`.
This is purely a clarity/style pass; no runtime behavior changes.

## Slices

### Slice 1 — BR-OUTPUT files (37 findings)
Files:
- `BR-OUTPUT/HotkeyAnalytics.swift:56-58`
- `BR-OUTPUT/QueenAuditLog.swift:13`
- `BR-OUTPUT/TaskDelegator.swift:13-14`
- `BR-OUTPUT/TeamQueenManager.swift:15-16`
- `BR-OUTPUT/PredictiveOrchestrator.swift:13`
- `BR-OUTPUT/QueenMasterViewModel.swift:17`
- `BR-OUTPUT/QueenIntelligenceEngine.swift:16`
- `BR-OUTPUT/BrowserOSChatViewModel.swift:8,12`
- `BR-OUTPUT/MeshChatViewModel.swift:10`
- `BR-OUTPUT/MeshStatusViewModel.swift:13-15`
- `BR-OUTPUT/NLHotkeyCreator.swift:58-59`
- `BR-OUTPUT/GitButlerViewModel.swift:18`
- `BR-OUTPUT/QueenIntegrationsHub.swift:14`
- `BR-OUTPUT/ExtensionStoreAPI.swift:14-15`
- `BR-OUTPUT/QueenStatusViewModel.swift:58-61,65-66`
- `BR-OUTPUT/VoiceCommandHandler.swift:30,33`
- `BR-OUTPUT/AIMacroGenerator.swift:50`
- `BR-OUTPUT/GitHubDashboardView.swift:206-207`
- `BR-OUTPUT/MacroRecorder.swift:62-63`
- `BR-OUTPUT/CommunityMacroMarketplace.swift:110-111,116`

### Slice 2 — rings/SR-02 files (6 findings)
Files:
- `rings/SR-02/ChatViewModel.swift:36,41,43`
- `rings/SR-02/QueenSelfImprovementService.swift:43`

### Slice 3 — Verification and scanner check
- Run `./build.sh`.
- Run `cargo run --bin clade-build`.
- Run `cargo run --bin clade-audit` and confirm Concurrency gate is zero.
- Run `cargo test --workspace`.
- Run `cargo clippy --workspace`.
- Run `cargo run --bin clade-e2e`.
- Relaunch `trios.app` and check `/health`.
- If any instance cannot use `.init()` (e.g. opaque `Array` alias), fall back to
  `= Array()` and update the scanner waiver comment.

## Road

**Road B** (balanced) — mechanical fix + full test + experience save. The change
is low risk but touches many canon Swift files, so full verification is
required per L4.

---

## Three Cycle-16 options

### Option 1 — `clade-seal` promotion gate *(recommended)*
Create a Rust ring `RUST-13/clade-seal` that runs build/test/clippy/audit,
collects a signed verdict, and writes `.trinity/state/seal.json`. Make
`clade-promote` refuse to land unless a valid seal exists and all gates are
zero. This turns Cycle 13-15's truthful audit into an auditable release gate.

### Option 2 — Clean the one remaining TODO
Implement the server feedback endpoint wiring at
`rings/SR-02/ChatViewModel.swift:474`. Requires understanding the BrowserOS
server feedback API and adding the corresponding client path. Medium complexity.

### Option 3 — Local agent-creation authorization
Competitor research showed one malicious link can spawn a rogue cloud agent. Add
a local, explicit human-approval step before Queen creates A2A agents or
registers skills, backed by a Keychain authorization token. This is direct
product differentiation against AgentForger/BioShocking.

## Recommendation

Implement **Option 1** next. Cycle 15 will leave the audit fully green; the
obvious next move is to make that state enforceable. `clade-seal` builds on the
files just hardened and provides the highest leverage.
