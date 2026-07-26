# Cycle 13 — Store TriOS Encryption Keys in macOS Keychain (trios)

## Weak spot
Cycles 10–12 moved several sensitive data surfaces to AES-256-GCM at-rest encryption (`ConversationEncryption`, `HotkeyAnalytics`, chat attachments, `MemoryStore`). All of them rely on `TriOSEncryption`, which persists 256-bit keys as plain files under:

```
~/Library/Application Support/trios/keys/<name>.key
```

These files are excluded from Time Machine/iCloud backup but are still regular POSIX files with `0o600` permissions. Any process with user access, a backup tool, a full-disk dump, or a compromised dependency can read them and therefore decrypt every encrypted surface. This is now the highest-leverage remaining gap in the at-rest encryption stack.

## Competitor / threat landscape
- **Apple platform guidance** — macOS Keychain Services (`kSecClassGenericPassword`, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`) is the canonical place for small secrets. It stores items in a secure database and, on modern hardware, can bind them to the Secure Enclave via `kSecAttrTokenIDSecureEnclave` or `SecKey` biometrics.
- **1Password / Bitwarden** — master secrets live in the Keychain or Secure Enclave; secondary data is encrypted with keys derived from those secrets.
- **Signal** — iOS Keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, never writes symmetric message keys to regular files.
- **Jot** (Cycle 12 competitor reference) — SQLCipher + Argon2 + **secure keychain storage** for on-device journaling AI.
- **Heirloom** — Argon2id + Secure Enclave / keychain for local-first memory.

Industry pattern: the encryption key itself must be at least as well protected as the encrypted data. Storing a symmetric key next to its ciphertext in a regular file defeats most of the at-rest protection.

## Goal
Move the `TriOSEncryption` named keys from plain files into the macOS Keychain as generic-password items, scoped by a stable service/account pair. Preserve all existing encrypted data by migrating legacy file-based keys into the Keychain on first access. Keep the public `TriOSEncryption` API unchanged so `ConversationEncryption`, `HotkeyAnalytics`, `EncryptedMemoryStore`, and attachment decryption continue to work without modifications.

## Decomposition

### 1. Approach selection
We will store each named key as a single generic-password item in the macOS Keychain:
- Service: `com.browseros.trios.encryption-key`
- Account: the key name (e.g. `"conversation"`, `"analytics"`, `"attachments"`, `"memory"`).
- Value: the 32-byte raw symmetric key.
- Accessibility: `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` so the key is unavailable when the device is locked and is not included in iCloud Keychain or backups.

This is better than the current file storage and is landable in this cycle. It is a stepping stone to Secure Enclave / biometric key storage (Variant B/C).

### 2. Keychain-backed key store (`trios/rings/SR-00`)
Create `KeychainSymmetricKeyStore`:
- `func read(keyName: String) throws -> SymmetricKey`
- `func write(keyName: String, key: SymmetricKey) throws`
- `func delete(keyName: String) throws`
- Uses `KeychainSecrets` (existing helper) or direct `Security` APIs for generic-password items.
- Accessibility: `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
- Migration helper: `migrateFileBasedKeyIfNeeded(keyName: String, fileURL: URL) throws -> SymmetricKey?` — if a legacy `.key` file exists, read it, write it to Keychain, and delete the legacy file.

### 3. Update `TriOSEncryption` (`trios/rings/SR-00/TriOSEncryption.swift`)
- Keep `init(keyURL:)` for tests and the legacy `ConversationEncryption` path.
- Change `init(keyName:)` so that `symmetricKey()` uses `KeychainSymmetricKeyStore` by default.
- In `symmetricKey()`:
  1. Try reading from Keychain.
  2. If missing, check the legacy file path (`Application Support/trios/keys/<name>.key`); if present, migrate it into Keychain and delete the file.
  3. If still missing, generate a new 256-bit key and store it in Keychain.
- Add `static func migrateAllLegacyKeys() throws` or `migrateLegacyKeys()` that scans `Application Support/trios/keys/` for known key names and migrates them. Call this from `main.swift` at launch or lazily per key.
- Ensure key file deletion is best-effort (log on failure, do not throw if the migration itself succeeded).

### 4. Preserve public API / callers
No changes to:
- `ConversationEncryption`
- `HotkeyAnalytics`
- `EncryptedMemoryStore`
- `ChatComposerAttachment.loadDecryptedData()`
- `ChatAttachmentImporter`
They all continue to use `TriOSEncryption(keyName:)` or the shared static instances.

### 5. Legacy key migration
- On first access of a named key, migrate the file to Keychain.
- Optionally, on app launch, proactively migrate all known keys (`conversation`, `analytics`, `attachments`, `memory`) so the `trios/keys/` directory can be removed.
- If the Keychain item already exists, do not overwrite it from the legacy file (Keychain is the source of truth).

### 6. Tests
Add `KeychainSymmetricKeyStoreTests.swift`:
- Round-trip read/write/delete with a test service/account.
- Key persists across store instances.
- Legacy file migration reads a pre-seeded `.key` file, stores it in Keychain, and removes the file.
- Missing key generates a new 256-bit key.

Update `TriOSEncryptionTests.swift`:
- `testNamedKeyUsesKeychain` — a named key does not create a file in `Application Support/trios/keys/` (or creates it only as a fallback/migration path and then removes it).
- Keep existing `keyURL` tests untouched.

### 7. Trinity gates
- `./build.sh`
- `cargo run --bin clade-build`
- `cargo run --bin clade-audit`
- `cargo run --bin clade-seal`
- `cargo run --bin clade-e2e`
- Relaunch `trios.app` and verify `/health`.

### 8. Report & variants
Write `.claude/plans/trios-cycle13-keychain-encryption-report.md`.
Produce three variants:
- (A) Keychain generic-password storage — implemented; uses macOS Keychain, migrates legacy file keys.
- (B) Secure Enclave / biometric-bound key — strongest; generate and store the key inside the Secure Enclave (or bind to biometrics via `kSecAccessControlBiometryCurrentSet`), requires UI for unlock and fallback handling.
- (C) HSM-backed key with per-data-type wrapping — wrap each named key with a master Keychain/SE key and rotate per cycle; more complex but allows key rotation without re-encrypting all data.

## Selected road
**Road B** — balanced: fix + tests + experience save. The surface is contained to `TriOSEncryption` and a new helper; no public API changes.
