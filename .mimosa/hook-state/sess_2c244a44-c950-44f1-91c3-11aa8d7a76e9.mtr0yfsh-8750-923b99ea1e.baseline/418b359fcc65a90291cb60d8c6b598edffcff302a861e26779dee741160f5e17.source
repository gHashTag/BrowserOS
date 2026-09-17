# Cycle 11 Report — Encrypted Persisted Chat Attachments

## 1. Weak spot researched
Chat attachments (images dropped or pasted into the composer) were persisted as plaintext files under:

```
~/Library/Application Support/Trinity S3AI/Attachments/image-<uuid>.png
```

The UI preview read them with `NSImage(contentsOf:)` and the outbound message embedded local file paths, forcing the BrowserOS server to read plaintext image data from disk via `filesystem_read`. Any process with user-level filesystem access could scrape every image ever shared with an agent.

Cycle 10 left an explicit marker in `ChatAttachmentImporter.persistImageData`:

```swift
// CYCLE-11: encrypt the image data with TriOSEncryption(keyName: "attachments")
// before writing, then decrypt in the preview and outbound pipelines.
```

## 2. Competitor / threat landscape
| Source | Relevant finding |
|--------|------------------|
| OpenClaw-style tooling | Local files are untrusted prompt content; plaintext attachments are trivial exfiltration targets if another local agent is compromised. |
| Cursor Cloud Agent / 2026 browser sandbox escape advisory | A sandbox escape first seeks user-data files; unencrypted media is low-hanging fruit. |
| Local-first AI apps (HammerLock, Heirloom, KeyRing AI) | Encrypt all local media with named keys and pass base64 payloads to the model host so plaintext never touches disk. |

## 3. Implementation
### Model layer (`trios/rings/SR-00`)
- `ChatComposerAttachment` gained `isEncrypted: Bool` (default `false`) and `loadDecryptedData()`.
- `TriOSEncryption` gained `static let attachments = TriOSEncryption(keyName: "attachments")` so all attachment code shares one named key.

### Persistence (`trios/rings/SR-01`)
- `ChatAttachmentImporter.persistImageData` now:
  1. Validates the destination with `SafeFilePath.validateWritePath`.
  2. Encrypts the image bytes with `TriOSEncryption.attachments.encrypt`.
  3. Writes the combined `nonce || ciphertext || tag` blob atomically.
  4. Returns `ChatComposerAttachment(..., isEncrypted: true)`.

### UI preview (`trios/BR-OUTPUT/ChatPanelView.swift`)
- `attachmentPreview(_:)` now decrypts the image in memory (`try? attachment.loadDecryptedData()`) and renders via `NSImage(data:)`, falling back to a placeholder icon if decryption fails.

### Outbound request (`trios/rings/SR-02`)
- `ChatPanelView.triggerSend` splits attachments into `imageAttachments` and `fileAttachments`.
- File attachments still travel via the existing `<local_attachments>` block for server-side `filesystem_read`.
- Image attachments are decrypted, base64-encoded, and passed to a new `ChatViewModel.sendMessage(imageAttachments:)` parameter.
- `ChatRequestBuilder` accepts `attachments: [ChatRequestAttachment]?` and emits:
  ```json
  "attachments": [
    { "kind": "image", "mediaType": "image/png", "dataUrl": "data:image/png;base64,..." }
  ]
  ```
  This matches the existing `parseChatBody` contract in `packages/browseros-agent/apps/server/src/api/routes/agents.ts`, so the server never needs to read a plaintext image file from disk.

### Tests
- Fixed `ChatAttachmentImporterSafePathTests` to use the real `Trinity S3AI/Attachments` path and the actual `ChatComposerAttachment` API.
- Added `ChatAttachmentEncryptionTests` with round-trip and legacy plaintext pass-through coverage.
- Added `ChatRequestBuilderTests.testImageAttachmentsAreEncodedAsDataURLs` verifying the request JSON shape.

## 4. Trinity verification
| Gate | Result |
|------|--------|
| `./build.sh` | PASS (chat integration tests PASS) |
| `cargo run --bin clade-build` | PASS |
| `cargo run --bin clade-audit` | **0 findings** |
| `cargo run --bin clade-seal` | **SEAL VALID** |
| `cargo run --bin clade-e2e` | PASS |
| `curl http://127.0.0.1:9105/health` | `{"status":"ok","cdpConnected":true}` |
| `swift test` | SKIPPED (XCTest not available in this CommandLineTools-only environment) |

## 5. Three variants
### Variant A — Minimal
Encrypt only dropped/pasted image data in `ChatAttachmentImporter`; leave file attachments and `MemoryStore` plaintext. Fastest to land and closes the most visible weak spot, but does not protect file attachments or durable chat memory.

### Variant B — Balanced (implemented)
Encrypt image attachments + structured base64 outbound + in-memory preview decryption + tests. The server receives encrypted payloads and never reads a plaintext image from disk. File attachments keep their local-path flow, and `MemoryStore` remains out of scope. This matches the existing server contract and the Cycle 10 marker.

### Variant C — Comprehensive
- Add SQLCipher to `MemoryStore` so the durable agent-memory SQLite database is encrypted at rest.
- Copy file attachments into the encrypted attachment directory and decrypt them before server-side read, removing all plaintext file paths from prompts.
- Rotate a per-conversation attachment sub-key derived from the master attachment key so a compromised key only exposes one conversation's media.

## 6. Next recommended step
Cycle 12 should evaluate Variant C's SQLCipher integration for `MemoryStore` and the per-conversation key rotation for attachments, because `MemoryStore` is now the largest remaining plaintext surface in the chat pipeline.

## 7. Files touched
- `trios/rings/SR-00/ChatComposerAttachment.swift`
- `trios/rings/SR-00/TriOSEncryption.swift`
- `trios/rings/SR-01/ChatAttachmentImporter.swift`
- `trios/rings/SR-02/ChatViewModel.swift`
- `trios/BR-OUTPUT/ChatPanelView.swift`
- `trios/tests/TriOSKitTests/ChatAttachmentImporterSafePathTests.swift`
- `trios/tests/TriOSKitTests/ChatAttachmentEncryptionTests.swift`
- `trios/tests/TriOSKitTests/ChatRequestBuilderTests.swift`
- `.claude/plans/trios-cycle11-attachment-encryption-plan.md`
- `.claude/plans/trios-cycle11-attachment-encryption-report.md`
- `.trinity/experience/2026-07-26_00-21-04_CYCLE11-ATTACHMENT-ENCRYPTION.json`
- `.trinity/experience.md`
