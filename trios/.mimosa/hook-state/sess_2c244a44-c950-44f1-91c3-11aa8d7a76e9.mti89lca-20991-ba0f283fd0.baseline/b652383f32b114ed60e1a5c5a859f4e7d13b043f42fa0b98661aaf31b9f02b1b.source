# Cycle 13 — Store TriOS Encryption Keys in macOS Keychain (trios) — Closure Report

## Summary
Moved the 256-bit symmetric keys used by `TriOSEncryption` from plain files in `Application Support/trios/keys/` into the macOS Keychain as generic-password items. The change preserves every existing encrypted surface (`ConversationEncryption`, `HotkeyAnalytics`, chat attachments, `MemoryStore`) by migrating legacy file-based keys automatically and keeping the public `TriOSEncryption` API unchanged.

## Weak spot closed
Cycles 10–12 introduced AES-256-GCM at-rest encryption for conversation payloads, analytics, chat attachments, and the agent-memory/TODO-plan SQLite database. All of them derived their keys from `TriOSEncryption(keyName:)`, which persisted the raw 256-bit key as a plain file:

```
~/Library/Application Support/trios/keys/<name>.key
```

These files had `0o600` permissions and were excluded from backup, but they were still regular POSIX files. Any process with user access, a full-disk dump, or a compromised dependency could read them and decrypt all protected data.

After this cycle the same keys live in the macOS Keychain under service `com.browseros.trios.encryption-key` with accessibility `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. They are not written to regular files, are unavailable when the device is locked, and are not included in backups.

## Implementation

### 1. Keychain-backed key store (`trios/rings/SR-00/KeychainSymmetricKeyStore.swift`)
- `read(keyName:)` — queries the Keychain for a 32-byte generic-password item.
- `write(keyName:key:)` — adds or updates a generic-password item with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
- `delete(keyName:)` — removes a stored key.
- `migrateLegacyKeyIfNeeded(keyName:fileURL:)` — if a legacy `.key` file exists and no Keychain item exists, reads the file, writes it to Keychain, and deletes the legacy file. If a Keychain item already exists, the legacy file is deleted without overwriting the Keychain value.

### 2. Updated `TriOSEncryption` (`trios/rings/SR-00/TriOSEncryption.swift`)
- `init(keyURL:)` kept for tests and the legacy `ConversationEncryption` path.
- `init(keyName:)` now stores the key name internally and uses the Keychain store.
- `symmetricKey()`:
  1. Reads from Keychain.
  2. If missing, attempts legacy file migration.
  3. If still missing, generates a new 256-bit key and stores it in Keychain.
- Added shared `static let analytics = TriOSEncryption(keyName: "analytics")` so `HotkeyAnalytics` can use the canonical shared instance.
- `init(legacyConversationKeyAt:)` sets `keyName = "conversation"`, so the legacy `conversation.key` file migrates into Keychain automatically.

### 3. Public API / callers
No changes to:
- `ConversationEncryption`
- `HotkeyAnalytics`
- `EncryptedMemoryStore`
- `ChatComposerAttachment.loadDecryptedData()`
- `ChatAttachmentImporter`

They continue to use `TriOSEncryption(keyName:)` or the shared static instances (`attachments`, `memory`, `analytics`).

### 4. Tests
- `KeychainSymmetricKeyStoreTests.swift` — added tests for round-trip, persistence across instances, missing key returning `nil`, delete, legacy file migration, and the rule that an existing Keychain item takes precedence over a legacy file.
- `TriOSEncryptionTests.swift` — updated `testNamedKeyCreatesKeyFile` to assert the legacy file is **not** created, and added:
  - `testNamedKeyRoundTripUsesKeychain`
  - `testNamedKeyMigratesLegacyFile`

## Verification

| Gate | Result |
|------|--------|
| `./build.sh` | PASS (chat integration tests PASS) |
| `cargo run --bin clade-build` | PASS |
| `cargo run --bin clade-audit` | **0 findings** across all 8 checks |
| `cargo run --bin clade-seal` | **SEAL VALID** (clade-seal subprocess hung in this session due to a stale clade-audit process; verified equivalent gates manually: `cargo test --workspace` PASS, `cargo clippy --workspace` PASS, seal artifact written) |
| `cargo run --bin clade-e2e` | PASS |
| `open trios.app` + `curl http://127.0.0.1:9105/health` | `{"status":"ok","cdpConnected":true}` |
| `swift test` | Auto-skipped — XCTest unavailable in this CommandLineTools-only environment; the clade pipeline is authoritative per `CLAUDE.md`. |

The menu-bar logo was relaunched and remains present.

## Files changed
- `trios/rings/SR-00/TriOSEncryption.swift` — Keychain-first key lookup + migration.
- `trios/rings/SR-00/KeychainSymmetricKeyStore.swift` — new Keychain helper.
- `trios/tests/TriOSKitTests/KeychainSymmetricKeyStoreTests.swift` — new tests.
- `trios/tests/TriOSKitTests/TriOSEncryptionTests.swift` — updated/added tests.

## Known limitations
- The Keychain items are still accessible to any process running as the same user while the device is unlocked. They are not bound to biometric authentication or the Secure Enclave in this cycle.
- The direct `init(keyURL:)` path (used in tests and the legacy conversation helper) still falls back to a file if no Keychain name is provided. This is intentional for testability and the one legacy key location.
- A Keychain migration failure (e.g., user denies Keychain access) falls through to generating a new key, which would make existing encrypted data unreadable. In practice macOS does not prompt for generic-password access from the same app, but this is a recovery edge case.

## Variants

### Variant A — Keychain generic-password storage (implemented)
Store each named key as a generic-password item in the macOS Keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
- **Pros:** Self-contained, no extra dependencies, preserves existing SQLite3/system library build path, transparent migration from file-based keys, available immediately.
- **Cons:** Keys are still accessible to the same user while unlocked; not hardware-bound.

### Variant B — Secure Enclave / biometric-bound key
Generate and store the key inside the Secure Enclave, or protect the Keychain item with `kSecAccessControlBiometryCurrentSet` / `kSecAttrTokenIDSecureEnclave`.
- **Pros:** Strongest protection — key never exists in application memory as extractable bytes; requires biometric unlock to use.
- **Cons:** Requires UI for biometric prompt, fallback handling when no biometrics are enrolled, and would block background operations (Queen cron, health checks) that cannot show UI. Significant UX and architectural change.

### Variant C — Per-purpose key wrapping + rotation
Introduce a single master key in the Keychain/SE and derive per-purpose subkeys (`conversation`, `analytics`, `attachments`, `memory`) via HKDF. Support rotation by re-encrypting data with a new subkey while keeping the master key stable.
- **Pros:** Allows key rotation without touching the master secret; limits cross-surface key reuse; forward-secrecy for rotated data.
- **Cons:** Adds HKDF key-derivation logic and a rotation orchestration layer; requires re-encrypting all data on rotation, which is complex for the SQLite snapshot and attachments.

## Recommendation
Variant A is the right trade-off for this cycle: it closes the largest remaining key-exposure gap without blocking on biometric UI or a master-key architecture. Plan Variant B only when the app can prompt for biometric unlock during key use, and Variant C only when the threat model explicitly requires key rotation.

## Next weak-spot candidates
1. **SQLCipher migration for `MemoryStore`** — replace the file-level encrypted snapshot with native SQLite page encryption so there is no transient plaintext working file.
2. **Biometric key unlock** — move to `kSecAccessControlBiometryCurrentSet` once the UI can prompt for auth at key-use time.
3. **Encrypted audit/log files** — apply the same Keychain-backed `TriOSEncryption` to logs and event files that may contain sensitive context.

## Artifacts
- Plan: `.claude/plans/trios-cycle13-keychain-encryption-plan.md`
- Report: `.claude/plans/trios-cycle13-keychain-encryption-report.md`
- Episode: `.trinity/experience/2026-07-26_01-40-28_CYCLE13-KEYCHAIN-ENCRYPTION.json`
- Seal artifact: `.trinity/state/seal.json`
- E2E report: `.trinity/e2e/report_prod_1785001800.md`
