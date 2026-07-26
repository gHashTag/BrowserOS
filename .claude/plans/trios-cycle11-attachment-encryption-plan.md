# Cycle 11 — Encrypted persisted chat attachments (trios)

## Weak spot
Chat attachments (images dropped/pasted into the composer) are persisted as plaintext files under `~/Library/Application Support/Trinity S3AI/Attachments/`. A malicious or compromised process with user-level access can read every image the user ever shared with an agent. Cycle 10 hardened the runtime key material and analytics log, but left a `// CYCLE-11` marker in `ChatAttachmentImporter.persistImageData`.

## Competitor / threat landscape (summary)
- **OpenClaw-style indirect prompt injection**: local files are untrusted data; plaintext images can be read and re-injected by other tooling.
- **Cursor Cloud Agent / browser sandbox escape (2026 advisory)**: if the agent process escapes its sandbox, unrestricted filesystem reads are the first target.
- **Local-first AI apps (HammerLock, Heirloom, KeyRing AI)**: encrypt all local media with per-feature named keys and pass base64 payloads to the model host so plaintext never touches disk.

## Goal
Encrypt every persisted image attachment with `TriOSEncryption(keyName: "attachments")`, decrypt it in-memory for UI preview, and transmit it as structured base64 `attachments` so the server never needs to read a plaintext file from disk.

## Decomposition

### 1. Model & encryption plumbing (rings/SR-00)
- Add `isEncrypted: Bool` to `ChatComposerAttachment` (default `false`, source-compatible).
- Add `static let attachments = TriOSEncryption(keyName: "attachments")` helper.
- Add `ChatComposerAttachment.loadDecryptedData()` extension that reads the file and decrypts when `isEncrypted == true`.

### 2. Persistence (rings/SR-01)
- `ChatAttachmentImporter.persistImageData(_:typeIdentifier:)`:
  - Encrypt `data` with `TriOSEncryption.attachments` before writing.
  - Return `ChatComposerAttachment(..., isEncrypted: true)`.
  - Keep `SafeFilePath` validation and `0o700`/exclude-from-backup directory.

### 3. UI preview (BR-OUTPUT/ChatPanelView.swift)
- `attachmentPreview(_:)`:
  - Use `try? attachment.loadDecryptedData()` and `NSImage(data:)` instead of `NSImage(contentsOf:)`.
  - Fall back to placeholder icon on decryption failure.

### 4. Outbound request (rings/SR-02)
- Extend `ChatViewModel.sendMessage(appendUser:imageAttachments:onAccepted:)`:
  - Accept `[ChatComposerAttachment]` for images.
  - Decrypt each image in-memory.
  - Base64-encode and build `{ kind: "image", mediaType: String, dataUrl: String }` entries.
- Extend `ChatRequestBuilder` with `attachments: [ChatRequestAttachment]?` and emit `body["attachments"]` in the JSON request.

### 5. Composer policy (rings/SR-00)
- `ChatComposerAttachmentPolicy.outboundMessage` continues to list local **file** attachments only; image attachments are no longer embedded as `<local_attachments>` paths because they travel as structured payloads.

### 6. Tests
- Fix `ChatAttachmentImporterSafePathTests` to match the real `Application Support/Trinity S3AI/Attachments` path and the actual `ChatComposerAttachment` API.
- Add encrypted round-trip assertion (plaintext ≠ ciphertext; decrypt returns plaintext).
- Add `ChatRequestBuilder` test verifying `attachments` array shape, `dataUrl` prefix, and `kind: "image"`.

### 7. Trinity gates
- `./build.sh`
- `cargo run --bin clade-build`
- `cargo run --bin clade-audit`
- `cargo run --bin clade-seal`
- `cargo run --bin clade-e2e`
- Relaunch `trios.app` and verify `/health`.

### 8. Report & variants
- Write `.claude/plans/trios-cycle11-attachment-encryption-report.md`.
- Produce three variants: (A) minimal encrypted persistence + structured attachments, (B) add encrypted SQLite `MemoryStore`, (C) add per-conversation attachment key rotation.
- Save `.trinity/experience/YYYY-MM-DD_HH-MM-SS_CYCLE11-ATTACHMENT-ENCRYPTION.json` and update memory.

## Selected road
**Road B** — balanced: fix + tests + experience save, no full agent spawn because the surface is small and well-defined.
