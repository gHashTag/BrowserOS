# TriOS Cycle 10 — Runtime Data-at-Rest Encryption + SafeFilePath Hardening

**Date:** 2026-07-25  
**Branch:** `feat/zai-provider`  
**Trigger:** "исследуй слабые места задачи, исследуй конкурентов по теме, создай декомпозированный план и реализуй все и в конце отчет и три варианта"

---

## 1. Weak spots researched

After Cycle 9 closed the highest-impact P0/P1 surface (FTS injection, chat request sanitization, Slack/Extension URL safety, command sandbox, conversation encryption), the remaining runtime-state gaps are:

| Rank | Issue | File(s) + Line(s) | Severity | Why it matters |
|---|---|---|---|---|
| 1 | **Hotkey analytics JSON stored in plaintext** | `trios/BR-OUTPUT/HotkeyAnalytics.swift:175-189` | P1 | Usage telemetry (`hotkey`, `action`, `context`, timestamp) is flushed to `Application Support/ai.browseros.trios/Analytics/usage_<epoch>.json` unencrypted. The data reveals user workflow patterns and is readable by any process with user privileges. |
| 2 | **Dropped chat images persisted without path validation or encryption** | `trios/rings/SR-01/ChatAttachmentImporter.swift:123-153` | P1 | Pasted/dropped images are written to `Application Support/Trinity S3AI/Attachments/` without `SafeFilePath` validation and without encryption. Screenshots may contain sensitive information. |
| 3 | **No reusable at-rest encryption helper** | `trios/rings/SR-02/ConversationEncryption.swift` | P2 | `ConversationEncryption` is a hard-coded singleton for `UserDefaults` conversation payloads. Other runtime stores reinvent the wheel or skip encryption. |
| 4 | **Memory SQLite file is plaintext on disk** | `trios/rings/SR-01/MemoryStore.swift:91-117` | P2 | The durable agent-memory SQLite database is not encrypted at rest. Redaction mitiges secrets in records but the corpus is still exposed. |

---

## 2. Competitor snapshot — runtime data-at-rest / agent file safety

| Competitor | Relevant capability | Lesson for BrowserOS/TriOS |
|---|---|---|
| **OpenClaw** | WhatsApp-to-host RCE via prompt injection + sandbox bypass (July 2026) | File writes and tool calls must be validated against a trusted base path; agent-accessible filesystem needs a sandbox. |
| **Cursor Cloud Agents** | Isolated VM sandboxes with snapshotting | Strong isolation, but data is cloud-hosted. BrowserOS/TriOS can differentiate on local-first encryption. |
| **GitHub Copilot app** | Agent-native desktop with canvases and sandboxes | Enterprise trust through Microsoft stack, but closed. Local-first open encryption is a credible counter-position. |
| **Perplexity Comet** | "CometJacking" prompt-injection phishing | Web-focused; less desktop file exposure, but shows that prompt-driven UI actions need audit gates. |
| **Dia** | AI-first macOS browser, Spaces delayed | Closed source and stuck. BrowserOS/TriOS can ship verifiable privacy primitives faster. |

### Standards pressure

| Standard | Implication |
|---|---|
| **OWASP AISVS 1.0** | Secure storage (V2) and input validation (V5) requirements. Plaintext telemetry and unvalidated file writes fail L2/L3. |
| **OWASP ASI 2026** | ASI02 (tool misuse) and ASI09 (unexpected execution) map directly to unsafe file writes and unvalidated paths. |
| **NIST AI Agent Standards** | Least agency and auditability: every runtime mutation should be logged and bounded. |
| **EU AI Act** | High-risk systems need audit trails and human oversight by Aug 2, 2026. |

---

## 3. Decomposed plan — Cycle 10 implementation

### A — Reusable at-rest encryption helper

#### A1. Create `TriOSEncryption`
- **File:** `trios/rings/SR-00/TriOSEncryption.swift`
- **Changes:**
  - AES-256-GCM sealed box with combined `nonce || ciphertext || tag` format (same as `ConversationEncryption`).
  - Named per-purpose keys stored in `Application Support/trios/keys/<name>.key`.
  - Excluded from Time Machine / iCloud backup.
  - `encrypt(_ data: Data, keyName: String) throws -> Data`
  - `decrypt(_ sealed: Data, keyName: String) throws -> Data`
  - `prepareKey(keyName:)` returns a `SymmetricKey`, creating a random 256-bit key if missing.
  - Errors: `keyGenerationFailure`, `sealFailure`, `openFailure`.

#### A2. Refactor `ConversationEncryption` to delegate to `TriOSEncryption`
- **File:** `trios/rings/SR-02/ConversationEncryption.swift`
- **Changes:**
  - Keep the singleton API.
  - Internally use `TriOSEncryption` with key name `"conversation"`.
  - Preserve the existing key file location (`Application Support/trios/conversation.key`) for compatibility.

### B — Encrypt `HotkeyAnalytics`

#### B1. Update `HotkeyAnalyticsViewModel`
- **File:** `trios/BR-OUTPUT/HotkeyAnalytics.swift:175-212`
- **Changes:**
  - In `flushBuffer()`, encode usage array to JSON, then encrypt with `TriOSEncryption(keyName: "analytics")`, write `.json.enc` files.
  - In `loadAnalytics()`, read files matching `usage_*.json.enc`, decrypt, then decode JSON. Keep a one-cycle backward-compat read of any legacy plaintext `.json` files and migrate them to encrypted files on load.
  - Set `posixPermissions: 0o600` on the analytics directory.

### C — SafeFilePath + encryption for chat attachments

#### C1. Apply `SafeFilePath` to `ChatAttachmentImporter`
- **File:** `trios/rings/SR-01/ChatAttachmentImporter.swift:123-153`
- **Changes:**
  - Compute the intended destination URL under `Application Support/Trinity S3AI/Attachments`.
  - Validate with `SafeFilePath.validateWritePath(candidate:destination, baseURL:baseURL)` before writing.
  - On failure throw `ChatAttachmentImportError.persistenceFailed`.

#### C2. Encrypt persisted attachment images (deferred to Cycle 11)
- **File:** `trios/rings/SR-01/ChatAttachmentImporter.swift`
- **Reason:** Encrypting persisted images also requires updating the preview (`NSImage(contentsOf:)`) and the outbound message pipeline (`ChatComposerAttachmentPolicy.outboundMessage` / BrowserOS `fs_read`) to decrypt inline or transmit base64. That cross-stack change is larger than one cycle. This cycle lays the groundwork by introducing `TriOSEncryption` and validating write paths.
- **Changes for this cycle:**
  - After `SafeFilePath` validation, write the plaintext image file as before, but ensure the directory is excluded from backup and the file mode is restrictive.
  - Leave a `// CYCLE-11: encrypt with TriOSEncryption(keyName: "attachments")` marker.

### D — Tests

- **D1.** `trios/tests/TriOSKitTests/TriOSEncryptionTests.swift` — round-trip, tamper detection, different key names produce different ciphertext, key persistence.
- **D2.** `trios/tests/TriOSKitTests/HotkeyAnalyticsEncryptionTests.swift` — encrypted flush produces non-JSON bytes, load decrypts correctly, legacy plaintext migration.
- **D3.** `trios/tests/TriOSKitTests/ChatAttachmentImporterSafePathTests.swift` — SafeFilePath validation succeeds for allowed destination, rejects symlink escapes and sensitive components.

---

## 4. Implementation order

1. Create `TriOSEncryption.swift`.
2. Refactor `ConversationEncryption.swift` to delegate to `TriOSEncryption`.
3. Update `HotkeyAnalytics.swift` to encrypt flushes and decrypt loads with legacy migration.
4. Update `ChatAttachmentImporter.swift` to validate with `SafeFilePath` and encrypt persisted images; add `decryptAttachmentData` helper.
5. Write tests D1-D3.
6. Run `./build.sh`, `cargo run --bin clade-build`, `cargo run --bin clade-audit`, `cargo run --bin clade-seal`, `cargo run --bin clade-e2e`, `bun run test:api`.
7. Relaunch `trios.app` and verify `/health`.
8. Write report and three variants.

---

## 5. Verification gates

- `bash build.sh` — pass.
- `cargo run --bin clade-build` — pass.
- `cargo run --bin clade-audit` — 0 hard-gate findings.
- `cargo run --bin clade-seal` — SEAL VALID.
- `cargo run --bin clade-e2e` — pass.
- `bun run test:api` — pass.
- `open trios.app` + `curl http://127.0.0.1:9105/health` — ok.
- New tests pass (build.sh swift test path if XCTest available; otherwise clade gates + manual test runs).

---

## 6. Three variants for Cycle 11

### Variant A — Minimal encryption coverage
Keep the shared `TriOSEncryption` helper but only use it for `ConversationPersister` (already done) and `HotkeyAnalytics`. Skip attachment encryption and SafeFilePath adoption. Fastest, but leaves dropped-image weak spot open.

### Variant B — Balanced runtime encryption + SafeFilePath (this cycle)
Implement A1-A2 + B + C1 + D. Covers analytics with a shared helper, validates attachment write paths, and lays the groundwork for attachment encryption. Achievable in one cycle and closes the highest-impact plaintext-at-rest gaps without breaking the chat sending pipeline.

### Variant C — Comprehensive runtime encryption
Extend Variant B to encrypt the `MemoryStore` SQLite file (SQLCipher or field-level encryption), encrypt `HotkeyAnalytics` thumbnails, and add an audit log for every file write performed by agents. Highest privacy bar, but SQLCipher integration is larger and may require a C dependency.

**Recommendation:** Variant B — it ships measurable improvements without adding external dependencies.
