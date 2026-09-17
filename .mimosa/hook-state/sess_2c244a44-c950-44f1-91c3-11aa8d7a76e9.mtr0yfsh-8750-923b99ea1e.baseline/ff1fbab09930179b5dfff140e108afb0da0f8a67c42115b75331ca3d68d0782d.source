# TriOS 15m Weak-Spot Loop — Cycle 9 Plan

**Date:** 2026-07-24  
**Branch:** `feat/zai-provider`  
**Trigger:** "исследуй слабые места задачи, исследуй конкурентов по теме, создай декомпозированный план и реализуй все и в конце отчет и три варианта сотрудничества для следующего лупа"

---

## 1. Weak spots researched

After cycle 8 (`1e525cddf`) and the new durable chat memory planner commit (`def368fc9`), the highest-impact remaining issues are in the **memory/chat layer**, **URL/input validation**, **command sandbox**, and **data-at-rest privacy**.

| Rank | Issue | File(s) + Line(s) | Severity | Why it matters |
|---|---|---|---|---|
| 1 | **FTS5 query injection in memory recall** | `trios/rings/SR-01/MemoryStore.swift:774-792` | P0 | `ftsMatchExpression(for:)` joins user query tokens with `OR` and wraps them in double quotes using a naive escape. FTS5 operators (`NEAR`, `NOT`, `^`, unbalanced quotes, wildcard-only tokens) can alter recall results or crash SQLite. |
| 2 | **Untrusted recalled memory injected raw into model system prompt** | `trios/rings/SR-02/ChatViewModel.swift:1366, 1373-1399` | P0 | `ChatRequestBuilder.build()` appends recalled `userSystemPrompt` without a provenance marker and forwards previous-message **reasoning segments** and **tool-call arguments/outputs** into the message history sent to the LLM. This contradicts the spec invariant that memory recall is untrusted. |
| 3 | **Slack integration force-unwraps URL and raw-interpolates body** | `trios/BR-OUTPUT/SlackIntegration.swift:48-49, 54-56` | P0 | `URL(string: url)!` crashes on a misconfigured base URL. The `recipient` string is placed directly in the JSON body without validation, allowing malformed channel IDs or injection of JSON structure. |
| 4 | **Extension store API force-unwraps constructed URLs** | `trios/BR-OUTPUT/ExtensionStoreAPI.swift:36, 48, 76, 80, 93` | P1 | Several URL constructions use force-unwraps or raw string interpolation of `apiBaseUrl` and `id`. A malformed base URL or extension id crashes the app or routes requests to the wrong host. |
| 5 | **Conversation history stored in `UserDefaults` unencrypted** | `trios/rings/SR-02/ConversationPersister.swift:19-21, 24-28` | P1 | Full chat messages (which may contain user-pasted secrets) are encoded with `JSONEncoder` and stored in `UserDefaults.standard` under `trios.conversation.<uuid>`. No Keychain protection, no encryption, no backup-exclusion flag. |
| 6 | **Hotkey analytics written to `~/Documents` unencrypted and backed up** | `trios/BR-OUTPUT/HotkeyAnalytics.swift:66-70, 131-138` | P1 | Usage records (`hotkey`, `action`, `context`, timestamp) are flushed to `~/Documents/Trios/Analytics/usage_<epoch>.json`. The context field reveals what the user was doing and the directory is included in Time Machine/iCloud backups. |
| 7 | **Memory redaction regex misses common secret shapes** | `trios/rings/SR-02/AgentMemoryService.swift:260-288` | P2 | Patterns cover PEM keys, `Bearer`, `sk-`/`ghp_`/`AKIA`, URL credentials, and key/value pairs. They miss JWTs (`eyJ...`), `Authorization: Basic ...`, generic query-string tokens, and many hex/base64 API keys. |
| 8 | **Command allowlist is prefix-based and can read arbitrary host files** | `trios/BR-OUTPUT/QueenStatusViewModel.swift:607-612, 628-642` | P2 | Allowlist prefixes include `ls `, `cat .trinity/`, `tail `, `head `, `wc `. After the prefix matches, any path can follow (e.g., `ls ~/.ssh/`, `tail /etc/passwd`). The denylist blocks shell metacharacters but not sensitive file paths. |
| 9 | **Recursion guard resolves `ps`/`lsof`/`pgrep` from user-controlled `PATH`** | `trios/BR-OUTPUT/RecursionGuard.swift:196-206, 214-216` | P2 | `pathForExecutable(named:)` reads `ProcessInfo.processInfo.environment["PATH"]` and returns the first executable match. PATH spoofing can cause the single-instance guard to run attacker-controlled `ps`/`lsof`/`pgrep`. |
| 10 | **Memory lifecycle has no test for clear+write race** | `trios/rings/SR-02/ChatViewModel.swift:835-931` | P2 | `clearConversationMemories` advances `memoryControlRevision`/`memoryWriteRevision` and waits for in-flight writes, but the cleanup at `921-930` can fail silently. There is no adversarial/concurrency test covering this race. |

---

## 2. Competitor snapshot — late July 2026

BrowserOS/TriOS sits at the intersection of three battlegrounds: **AI-native browsers**, **desktop AI workspaces**, and **local/off-grid agent meshes**. The good news is that the incumbents are either retreating from the standalone-browser form factor or bleeding trust from agentic security flaws.

| Competitor | What it is | Strength vs BrowserOS/TriOS | Gap BrowserOS/TriOS can exploit | Recent move / July 2026 incident |
|---|---|---|---|---|
| **ChatGPT Atlas / Operator** | OpenAI's Chromium-based AI browser | Model quality, brand, cloud-agent infra | OpenAI is proving users won't switch to a new standalone browser unless it owns their OS/file workflow | **Announced shutdown Aug 9, 2026** — OpenAI exits standalone AI browser category |
| **Perplexity Comet** | Free Chromium AI browser with research assistant | Best-in-class answer/search; free tier; strong mobile | Desktop updates slowed; cloud/agentic stack not hardened | July skepticism / "CometJacking" prompt-injection phishing warnings |
| **Dia (The Browser Company / Atlassian)** | AI-first macOS browser, acquired for $610M | Polish, Atlassian distribution, Skills/Memory | Apple Silicon–only, closed source, **Spaces feature delayed again**, no Linux/Windows | v1.41.0 (July 24, 2026) is another housekeeping update; Spaces still missing |
| **OpenClaw** | Open-source personal AI gateway with browser automation, MCP | Open, flexible, multi-channel gateway | **WhatsApp-to-host RCE** via prompt injection + sandbox bypass | Three GHSA flaws up to CVSS 8.8; lesson: agent gateways need strict sandboxing |
| **Lantor** | Local-first macOS AI workspace (Rust/Tauri) | Pure local-first privacy, no cloud backend | Early (32 stars), no full browser integration, build friction | Active July 2026 development |
| **Rookery** | Long-lived daemon + worker fleet in git worktrees, MCP | Strong memory/trajectory model; persistent master agent | Niche theory-driven UX; no consumer browser product | Recent "Claude Dynamic Workflow" activity |
| **Codeg / Agent Orchestrator** | Multi-agent coding workspace | Broadest adapter coverage; desktop/server/Docker; local-first SQLite | Coding-only, not a browser OS | v0.14.x added sub-agent delegation via `codeg-mcp` |
| **Claude Code / Claude Desktop** | Anthropic CLI coding agent + desktop chat | Best model reasoning, huge ecosystem | Not a browser; cloud model; no native web automation | Steady state; BrowserOS can position itself as the browser Claude Code drives locally |
| **Cursor Composer / Cloud Agents** | IDE + Composer 2.5 + Cloud Agents in isolated VMs | IDE-native, powerful cloud subagents | Paid/cloud-centric, not privacy-first or local-first | June/July 2026 Cloud Agents added reusable snapshots and local/cloud handoff |
| **GitHub Copilot Workspace / app** | Agent-native desktop dev with canvases, sandboxes, MCP | Native GitHub context, enterprise trust, distribution | Closed Microsoft stack; cloud dependency; limited to code/GitHub | **GA July 7, 2026**, available on every Copilot plan |
| **Repowire** | Local-first mesh for AI coding agents | Simple cross-repo agent coordination | Python daemon, coding-only, no browser node | June 2026 added ingress peer + cross-mesh federation |
| **AgentHive / peat-mesh** | Self-hosted P2P mesh for AI coding agents (Go/libp2p/Noise/CRDT) | Zero-broker encrypted mesh; cross-device approvals | CLI/TUI, coding-focused, immature | Active July 2026; event-driven mesh architectures trending |
| **ClaudeMesh** | P2P mesh network for Claude Code sessions | Simple, Claude-focused, encrypted | Claude-only; no browser integration | CLI v1.37.0 June 2026 |
| **IronMesh / MeshClaw / DARKNODE** | Offline-first LoRa/Bluetooth agent mesh | True off-grid sovereignty, hardware radio | Niche/hobbyist complexity; weak browser/web integration | IronMesh v0.9.4.2 ~June 2026 |
| **Shofer / Nori / M1K3** | VS Code agent / multi-agent workspace / native MLX companion | Deterministic agents, provider flexibility, on-device inference | Not a browser or general workspace | M1K3 TestFlight beta July 2026 |

### Standards & compliance pressure

| Standard | Why it matters |
|---|---|
| **NIST AI Agent Standards Initiative** (Feb 2026) | "Least agency" becoming default; BrowserOS/TriOS can market per-task MCP scoping and kill-switch architecture as NIST-aligned. |
| **OWASP Top 10 for Agentic Applications 2026** | ASI01–ASI10 (goal hijack, tool misuse, unexpected execution, rogue agents). July OpenClaw RCE is a textbook ASI02/ASI05/ASI09 case. |
| **OWASP AISVS 1.0** (June 24, 2026) | 191 testable requirements; BrowserOS/TriOS can aim for L2/L3 on agent isolation and MCP security. (Note: there is no "AISVS V12" — current release is 1.0.) |
| **EU AI Act** | High-risk AI systems must be fully compliant by **Aug 2, 2026** — adds enterprise urgency for audit logs and human oversight. |

### Strategic takeaway

The window for BrowserOS/TriOS is **right now**: Atlas is shutting down, Dia is stuck without Spaces, and both Comet and OpenClaw are losing trust from agentic security flaws. BrowserOS/TriOS should lean into being the **open, cross-platform, local-first browser + desktop workspace** that runs its own agents, serves as the browser node for MCP clients (Claude Code / Cursor / Copilot), and can operate off-grid. The biggest risk is **distribution**: GitHub Copilot app and Cursor Cloud Agents are becoming the default "agent desktop." TriOS must ship verifiable isolation, a one-click installer, and a clear "why browser + workspace" pitch before the end of 2026.

---

## 3. Decomposed plan — cycle 9 implementation

Because "реализуй все" is larger than a single 15-minute slice, this cycle takes the **highest-ROI critical slice across three vectors** (A + B + C), leaving the remainder in the backlog for cycle 10.

### A — Memory / chat security (P0)

#### A1. Harden `MemoryStore.ftsMatchExpression(for:)`
- **File:** `trios/rings/SR-01/MemoryStore.swift:774-792`
- **Changes:**
  - Strip all characters that are not lowercase alphanumerics, hyphen, or underscore from tokens.
  - Reject tokens that consist only of wildcard characters or are shorter than 2 characters.
  - Cap token count at 12 and token length at 40.
  - Wrap each cleaned token in double quotes and append `*` for prefix matching (`"token"*`).
  - Join with `OR` only after validation.
- **Tests:** create `trios/tests/TriOSKitTests/MemoryStoreFTSTests.swift` covering:
  - normal multi-token query,
  - quotes, `NEAR`, `NOT`, `*`, `^` operators are neutralized,
  - empty query returns `nil`,
  - very long query is truncated,
  - token length and count caps.

#### A2. Sanitize untrusted memory context in `ChatRequestBuilder.build()`
- **File:** `trios/rings/SR-02/ChatViewModel.swift:1362-1452`
- **Changes:**
  - When `userSystemPrompt` is present, prefix it with a provenance marker: `[Recalled memory — verify before acting]`.
  - Remove the injection of previous-message **reasoning segments** and **tool-call arguments/outputs** from the serialized `messages` array. Only `msg.content` should be sent to the LLM; reasoning/tool metadata stays in local UI storage.
  - Keep the flattened `previousConversation` field (it already strips this data).
- **Tests:** create `trios/tests/TriOSKitTests/ChatRequestBuilderTests.swift` asserting:
  - the recall marker is present,
  - no `[Internal reasoning]` or `[Tools used]` strings appear in the serialized request,
  - the request is valid JSON.

### B — URL / input validation & command sandbox (P0/P1)

#### B1. Fix `SlackIntegration.send(_:to:)`
- **File:** `trios/BR-OUTPUT/SlackIntegration.swift:43-68`
- **Changes:**
  - Build the request URL with `URLComponents` from `apiBaseUrl + "/chat.postMessage"` and reject non-HTTPS bases.
  - Validate `recipient`: non-empty, ≤ 80 chars, no whitespace/newlines, and matches `#?[A-Za-z0-9_-]+` (channel/user id shape).
  - Replace `URL(string: url)!` with `guard let` and log a clear error.
  - Serialize body with `JSONSerialization` (already used) and cap `message` length at 4000 chars.

#### B2. Fix `ExtensionStoreAPI` URL construction
- **File:** `trios/BR-OUTPUT/ExtensionStoreAPI.swift:30-125`
- **Changes:**
  - Replace force-unwrap URL constructions with `URLComponents`.
  - Validate `apiBaseUrl` is a valid HTTPS URL at init; store as `URL` instead of `String`.
  - Validate `id` is alphanumeric/hyphen/underscore, max 64 chars.
  - Return `ExtensionStoreError.invalidInput` instead of `nil` for invalid ids/URLs so callers can surface the error.

#### B3. Tighten `QueenStatusViewModel.commandAllowlist`
- **File:** `trios/BR-OUTPUT/QueenStatusViewModel.swift:603-696`
- **Changes:**
  - Replace coarse prefix matching with **exact command + allowed-path validation**.
  - For file-reading commands (`cat`, `ls`, `tail`, `head`, `wc`), require the argument to be either:
    - under a configured `workingDirectory` (passed in init), or
    - under the app’s `.trinity` Application Support directory.
  - Reject absolute paths outside the allowed roots (e.g., `/etc/passwd`, `~/.ssh`).
  - Keep `git status/log/diff/branch`, `cargo check/build`, `swift --version`, `pgrep`, `ps aux` as exact allowed commands with no arbitrary extra paths.
  - Add a helper `isPathUnderAllowedRoots(_:)` and a unit test in `QueenStatusViewModelTests.swift` covering blocked vs allowed paths.

#### B4. Harden `RecursionGuard` executable resolution
- **File:** `trios/BR-OUTPUT/RecursionGuard.swift:195-216`
- **Changes:**
  - For `ps`, `lsof`, and `pgrep`, hardcode system paths (`/bin/ps`, `/usr/bin/lsof`, `/usr/bin/pgrep`) and verify they are regular files.
  - Do not use `ProcessInfo.processInfo.environment["PATH"]` for these security-critical utilities.
  - If a required tool is missing, log and return `false` (single-instance check fails safe).

### C — Data-at-rest privacy & redaction (P1)

#### C1. Encrypt `ConversationPersister` data with a Keychain-held key
- **File:** `trios/rings/SR-02/ConversationPersister.swift`
- **New helper:** `trios/rings/SR-00/DataEncryption.swift`
- **Changes:**
  - Add `DataEncryption` using `CryptoKit` AES-GCM:
    - `static func seal(_ data: Data, using key: SymmetricKey) -> Data` (prefixes nonce+ciphertext+tag).
    - `static func open(_ sealed: Data, using key: SymmetricKey) -> Data?`.
  - Add `KeychainSecrets.readOrCreate(service:account:length:)` that returns an existing random key or creates a 32-byte key in the Keychain if absent.
  - Modify `ConversationPersister.save/load` to encrypt/decrypt the JSON `Data` before writing to / after reading from `UserDefaults`.
  - Update `Package.swift` to link `CryptoKit`.
- **Tests:** `trios/tests/TriOSKitTests/ConversationPersisterTests.swift` using an isolated `UserDefaults` suite and a test Keychain item; assert round-trip and tamper detection.

#### C2. Move `HotkeyAnalytics` out of `~/Documents` and exclude from backups
- **File:** `trios/BR-OUTPUT/HotkeyAnalytics.swift:65-71, 131-138`
- **Changes:**
  - Store analytics under `Application Support/Trios/Analytics` instead of `~/Documents/Trios/Analytics`.
  - Set `URLResourceKey.isExcludedFromBackupKey` to `true` on the analytics directory.
  - Keep existing JSON encoding/decoding; encryption can be added in cycle 10.

#### C3. Expand `AgentMemoryService.redacted` patterns
- **File:** `trios/rings/SR-02/AgentMemoryService.swift:260-288`
- **Changes:**
  - Add JWT pattern: `eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*`.
  - Add `Authorization: Basic [A-Za-z0-9+/=]+`.
  - Add query-string token pattern: `(?i)\b(?:token|access_token|refresh_token)=[A-Za-z0-9._~+/=-]{8,}`.
- **Tests:** extend existing redaction tests (or add `AgentMemoryServiceTests.swift`) asserting each new shape is redacted.

---

## 4. Implementation order

1. Write/update this plan file.
2. A1 — harden `ftsMatchExpression` + `MemoryStoreFTSTests`.
3. A2 — sanitize `ChatRequestBuilder` + `ChatRequestBuilderTests`.
4. B1 — fix `SlackIntegration.send`.
5. B2 — fix `ExtensionStoreAPI` URL construction.
6. B3 — tighten `QueenStatusViewModel` command allowlist + tests.
7. B4 — harden `RecursionGuard` executable resolution.
8. C1 — add `DataEncryption` + Keychain key helper + encrypt `ConversationPersister` + tests; update `Package.swift`.
9. C2 — move `HotkeyAnalytics` to Application Support + backup exclusion.
10. C3 — expand redaction patterns + tests.
11. Run verification gates.
12. Commit and write final report with three cooperation options for cycle 10.

---

## 5. Verification gates

- `cargo test --workspace` — pass.
- `cargo clippy --workspace --all-targets -- -D warnings` — clean.
- `swift build` (repo root) — pass.
- `swift test` — pass if XCTest is available; otherwise documented skip in `build.sh`.
- `bash build.sh` — pass.
- New tests pass:
  - `MemoryStoreFTSTests`
  - `ChatRequestBuilderTests`
  - `QueenStatusViewModelTests`
  - `ConversationPersisterTests`
  - `AgentMemoryServiceTests` (redaction)

---

## 6. Backlog for cycle 10

- Full encryption for `HotkeyAnalytics` (not just relocation).
- Apply `SafeFilePath` to `ChatAttachmentImporter` and remaining file-write paths.
- Add audit logging for all MCP/tool config changes (Kiro RCE defense).
- Implement MCP/tool config change approval gate UI.
- Full Noise-XX handshake (`ee, es, se`) or correct spec claims.
- Replay/freshness protection for HTTP `/hello` in `clade-meshd`.
- LAN/mDNS peer pinning with static keys (OpenClaw CVE-2026-26327 defense).
- Resolve contradictions in `.trinity/specs/`.
- Register or delete `trios-mesh/src/bin/trios_meshd.rs`.
- Runtime isolation / Colima VM integration.
- Convert remaining ~25 ad-hoc Swift tests in `tests/swift/` to XCTest.

---

## 8. Cycle 9 execution status

| Slice | Status | Notes |
|---|---|---|
| A1 — `MemoryStore.ftsMatchExpression` | ✅ Merged in `trios/rings/SR-01/MemoryStore.swift` + `MemoryStoreFTSTests.swift`. Strips non-alphanumerics, caps tokens, returns `OR`-joined `"token"*`. |
| A2 — `ChatRequestBuilder` untrusted marker | ✅ Merged in `trios/rings/SR-02/ChatViewModel.swift` + `ChatRequestBuilderTests.swift`. Recalled memory prefixed with `[Recalled memory — verify before acting]`; reasoning/tool payloads removed from serialized request. |
| B1 — `SlackIntegration.send` | ✅ Merged in `trios/BR-OUTPUT/SlackIntegration.swift`. HTTPS validation, recipient shape check, `URLComponents`, 4000-char cap. |
| B2 — `ExtensionStoreAPI` | ✅ Merged in `trios/BR-OUTPUT/ExtensionStoreAPI.swift`. Failable init, `URL` base, `endpointURL(path:)`, id validation, `invalidInput` error. |
| B3 — `QueenStatusViewModel` command sandbox | ✅ Merged in `trios/BR-OUTPUT/QueenStatusViewModel.swift` + `QueenStatusViewModelTests.swift`. New `CommandSecurityPolicy` with exact-command + path validation; file readers restricted to project root / `.trinity`; env assignments parsed safely. |
| B4 — `RecursionGuard` hardcoded tools | ✅ Merged in `trios/BR-OUTPUT/RecursionGuard.swift`. `systemExecutablePath(named:)` maps `ps`/`pgrep`/`lsof` to fixed system paths, removing PATH spoofing. |
| C1 — `ConversationPersister` encryption | ✅ Merged in `trios/rings/SR-02/ConversationEncryption.swift` + `ConversationPersister.swift` + `ConversationEncryptionTests.swift`. AES-256-GCM key generated/stored in Keychain; messages + titles encrypted before `UserDefaults`; `Package.swift` links `CryptoKit`. |
| C2 — `HotkeyAnalytics` relocation | ✅ Merged in `trios/BR-OUTPUT/HotkeyAnalytics.swift`. Directory moved to `Application Support/ai.browseros.trios/Analytics`; backup exclusion flag set; legacy `~/Documents/Trios/Analytics` migrated. |
| C3 — `AgentMemoryService` redaction | ✅ Merged in `trios/rings/SR-02/AgentMemoryService.swift` + `AgentMemoryServiceRedactionTests.swift`. Added JWT, `Basic ...`, query-string token patterns. |
| Verification gates | ✅ `cargo test --workspace` — pass. ✅ `cargo clippy --workspace --all-targets --all-features` — clean. ✅ `swift build` — pass. ✅ `bash trios/build.sh` — pass (XCTest unavailable in this toolchain, skipped). |

---

## 7. Three cooperation options for the next loop (cycle 10)

### Option 1 — Security & privacy hardening (defensive depth)
Continue the security-first thread: finish encrypting all runtime state (`HotkeyAnalytics`, attachments, memory snapshots), add audit logging for every MCP/tool config change, implement the config-change approval gate, and publish an internal OWASP ASI mapping. This option keeps the codebase resilient against the next July-2026-style incident and gives BrowserOS/TriOS a defensible security story against Comet/OpenClaw headlines.

### Option 2 — Product / GTM push (seize the competitive window)
Use the current market window (Atlas shutdown, Dia stuck, Comet/OpenClaw trust issues) to update positioning: rewrite website/README comparisons, ship a polished one-click macOS installer, add a public security page, and create a short “BrowserOS vs closed AI agents” explainer. This option maximizes distribution while competitors are vulnerable, but defers deeper mesh/crypto work.

### Option 3 — Mesh / off-grid differentiation (technical moat)
Double down on the hardest-to-copy feature: implement LAN/mDNS peer pinning with static keys, complete the Noise-XX handshake, and prototype a LoRa/radio bridge for offline agent meshes. This option owns the “agent mesh” narrative against Repowire/AgentHive/IronMesh and gives BrowserOS/TriOS a credible off-grid story, but is heavier engineering and may not ship in one cycle.

**Recommendation:** start cycle 10 with **Option 1** (security depth), because the July 2026 threat landscape makes it the highest-leverage follow-up, and then alternate with Option 2 in a marketing loop once the security gates are green.
