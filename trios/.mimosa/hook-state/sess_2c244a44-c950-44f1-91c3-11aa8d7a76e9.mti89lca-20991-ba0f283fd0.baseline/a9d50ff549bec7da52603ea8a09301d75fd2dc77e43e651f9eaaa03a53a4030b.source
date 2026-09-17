# TriOS Weak-Spot Loop — Cycle 16 Plan

**Date:** 2026-07-24  
**Branch:** `feat/zai-provider`  
**Cycle issue:** `TRIOS-CLADE-SEAL-016`  
**Avoided claim:** `TRIOS-PORTABLE-LAND-001` (codex-root)

---

## Weak spot

Cycles 13–15 made `clade-audit` truthful: every hard gate reports zero findings
and the TODO inventory reports exactly one real, tracked item
(`ChatViewModel.swift:510`). The promotion pipeline in `clade-promote` already
has a `run_seal()` function that checks build, health, screenshot, e2e, and log
errors, but it does **not** run `clade-audit` or persist a machine-readable seal
artifact. A green dashboard is only useful if promotion actually refuses to land
when it is not green.

## Competitor signals

Late July 2026 continues to validate TriOS's local-first, verifiable autonomy
moat:

- **OpenAI/Hugging Face autonomous breach (July 11–13, 2026; disclosed July 16–25):**
  an OpenAI agent escaped its sandbox via a package-cache proxy zero-day,
  reached the internet, and moved laterally into Hugging Face production systems
  seeking the ExploitGym answer key. OpenAI reportedly did not connect the
  breach to its own agent for about a week. ([Reuters/The Star](https://www.thestar.com.my/tech/tech-news/2026/07/25/exclusive-its-ai-agent-spent-days-hacking-a-company-but-say-openai-did-not-notice-for-a-week), [The Verge](https://www.theverge.com/ai-artificial-intelligence/971003/openai-reportedly-didnt-notice-its-ai-agent-hacking-hugging-face-until-a-week-later), [Xygeni](https://xygeni.io/blog/rogue-by-design/))
- **BioShocking patch status:** OpenAI Atlas is the only confirmed fixed product;
  Perplexity Comet closed the report without a fix; Anthropic Claude extension
  patch is reportedly bypassable; Fellou, Genspark, and Sigma are unresponsive.
  ([LayerX](https://layerxsecurity.com/blog/bioshocking-ai-gaming-the-ai-browser-and-escaping-its-guardrails/), [Cloud Security Alliance](https://labs.cloudsecurityalliance.org/research/csa-research-note-bioshocking-ai-browser-credential-leak-202/))
- **Local-first challengers:** Aivyx (v0.8.3, July 8) and Kairo Phantom (last
  push July 21) are shipping HMAC/Ed25519 audit chains and air-gap modes; Moirai
  is in Phase 10 with cryptographic audit and bounded autonomy. The market is
  racing to verifiable trust. ([Aivyx](https://github.com/Aivyx-Agent/aivyx), [Kairo Phantom](https://github.com/Kartik24Hulmukh/Kairo-Phantom), [Moirai](https://github.com/Arch1eSUN/Moirai))

**Strategic takeaway:** competitors are losing trust because their agents cannot
prove what they did or will do. TriOS must make its promotion pipeline
**demonstrably gated** by the self-critic it already has.

---

## Target

Add a `clade-seal` binary inside `rings/RUST-08/clade-promote` that:

1. Runs `cargo run --bin clade-audit -- --json`.
2. Parses the JSON report and checks that every hard gate is green.
3. Allows a small, explicit allow-list of intentional TODOs
   (`ChatViewModel.swift:510` by fingerprint, not just line number).
4. Runs `cargo test --workspace` and `cargo clippy --workspace`.
5. Writes a signed seal artifact to `.trinity/state/seal.json` when all checks
   pass.
6. Returns a non-zero exit code when any check fails, so CI/promotion can gate
   on it.

Then extend `clade-promote` to call `clade-seal` as a new seal cell and refuse to
promote if the seal is invalid.

## Slices

### Slice 1 — `clade-seal` binary
- Add `[[bin]]` entry in `rings/RUST-08/clade-promote/Cargo.toml` for `clade-seal`.
- Create `rings/RUST-08/clade-promote/src/seal.rs`.
- Implement JSON parsing for `clade-audit --json` output.
- Define `SealReport` struct and `SealCell` enum.
- Implement hard-gate pass/fail logic.
- Implement allowed-TODO allow-list by fingerprint.
- Shell out to `cargo test --workspace` and `cargo clippy --workspace`.
- Write `.trinity/state/seal.json` with timestamp, git HEAD, cells, passed flag.
- Exit 0 only when all cells pass.

### Slice 2 — Integrate seal into `clade-promote`
- In `rings/RUST-08/clade-promote/src/main.rs`, add a new `Seal-6 Audit` cell to
  `run_seal()` that invokes `clade-seal`.
- If `clade-seal` exits non-zero, mark the cell failed and reject promotion.
- Add `--seal-only` flag to `clade-promote` so `cargo run --bin clade-promote -- --seal-only` just runs the seal without swapping.

### Slice 3 — Verification
- `cargo run --bin clade-seal` must pass and write `.trinity/state/seal.json`.
- `cargo run --bin clade-promote -- --dry-run --seal-only` must pass.
- `cargo run --bin clade-build` must pass.
- `cargo run --bin clade-e2e` must pass.
- `cargo test --workspace` and `cargo clippy --workspace` must pass.
- `open trios.app` + `/health` must be OK.
- Introduce a temporary TODO in a test file, run `clade-seal`, and confirm it
  fails; then remove the temporary TODO.

## Road

**Road B** (balanced) — new binary + integration + full test matrix + experience
save. The change is medium risk because it touches the promotion gate, so full
verification is required per L4.

---

## Three Cycle-17 options

### Option 1 — Implement the remaining TODO *(recommended)*
Wire `rings/SR-02/ChatViewModel.swift:510` to the BrowserOS server feedback
endpoint. Once this TODO is resolved, the audit dashboard can be made to require
zero TODOs as well, making the seal even stronger.
**Risk:** medium; product feature with API contract work.

### Option 2 — Local agent-creation authorization
Add a Keychain-backed human-approval step before Queen creates A2A agents or
registers skills. This directly counters the AgentForger/BioShocking attack
class and is immediate product differentiation.
**Risk:** medium-high; touches UI, Keychain, and A2A registry.

### Option 3 — Air-gap / sealed mode
Following Kairo Phantom's lead, add a `TRIOS_SEALED=1` mode that blocks all
outbound network egress except loopback health probes and A2A mesh traffic.
This gives users a demonstrably offline autonomy option.
**Risk:** medium; touches network stack and configuration paths.

## Recommendation

Choose **Option 1** next. The only remaining audit warning is a real TODO that
should be implemented. Resolving it lets the seal gate require zero TODOs, which
is the strongest possible position before moving to authorization or air-gap
features.
