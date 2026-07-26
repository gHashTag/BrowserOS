# Cycle 14 Report — Encrypted Session Recovery Package

## 1. Weak spot addressed

`SessionRecoveryPackageWriter` exported the entire TriOS session (conversations,
browser context, runtime diagnostics, system logs, and companion logs) as a
**plaintext ZIP archive**, even though the manifest claimed
`encryptionScheme: "local-aes256-gcm-v1"`. This left user chat content, BrowserOS
tool history, and runtime fingerprints exposed if the file landed in a synced,
shared, or otherwise accessible directory. Regex redaction of secrets is not a
substitute for encryption.

## 2. Competitor research

| Product / Pattern | Recovery/diagnostic packaging | Encryption posture |
|-------------------|-------------------------------|--------------------|
| Apple sysdiagnose | Compressed diagnostic archive | Plaintext; protected only by file-system ACLs |
| Chrome/Edge crash reporter | Minidump + log bundle | Not user-encrypted; uploaded over TLS |
| Signal backups | Encrypted message archive | AES-256-CBC or similar with user passphrase |
| 1Password export (OPVault) | JSON-like encrypted vault | AES-256-GCM, key derived from account password |
| JetBrains / VS Code logs | Plaintext rolling logs | No at-rest encryption |
| WhatsApp cloud backups | Encrypted chat backup | AES-256-GCM with server-assisted key or passphrase |

Most desktop diagnostic formats remain plaintext. TriOS now matches the
Signal/1Password pattern for exported bundles: the recovery package is encrypted
with a device-bound Keychain key.

## 3. Implementation summary

Chosen variant: **A — encrypt the whole ZIP envelope**.

### Files changed

- `rings/SR-00/TriOSEncryption.swift`  
  Added `static let recovery = TriOSEncryption(keyName: "recovery")` so the
  recovery package uses the same Keychain-backed AES-256-GCM helper as MemoryStore
  and attachments.

- `rings/SR-01/SessionRecoveryPackageWriter.swift`  
  - Writes the final archive with a `.triosrecovery` extension.  
  - Compresses a plaintext ZIP only into a staging partial file.  
  - Encrypts the staged ZIP bytes with `TriOSEncryption.recovery` and writes the
    encrypted output to the destination path.  
  - Deletes the plaintext staging ZIP immediately.  
  - Updates the README inside the package to state that the archive is encrypted
    and can only be opened by TriOS on the originating Mac.  

- `rings/SR-01/SessionRecoveryPackageReader.swift`  
  - Detects encrypted `.triosrecovery` archives, decrypts them to a temporary
    plaintext ZIP inside the staging directory, then extracts with `ditto`.  
  - Preserves backward compatibility: legacy plaintext `.zip` archives whose
    manifest lacks an encryption scheme are read directly.  
  - Added `SessionRecoveryPackageReaderError.decryptionFailed` for corrupted or
    tampered encrypted packages.

- `rings/SR-00/SessionRecoveryExport.swift`  
  Updated `SessionRecoveryPackageNaming.fileName()` to produce
  `Trinity-Recovery-<timestamp>.triosrecovery`.

- `tests/TriOSKitTests/SessionRecoveryPackageEncryptionTests.swift` (new)  
  - Encrypted round-trip write + read.  
  - Verifies the archive is not a plaintext ZIP (`PK` magic).  
  - Backward-compatibility: decrypt and read as legacy `.zip`.  
  - Manifest integrity after encryption.  
  - Tamper detection (corrupted bytes fail with `.decryptionFailed`).

## 4. Verification results

| Gate | Command | Result |
|------|---------|--------|
| Swift build | `TRIOS_SKIP_CHAT_E2E=1 TRIOS_SKIP_SWIFT_TEST=1 ./build.sh` | **PASS** (0 Swift errors) |
| Canonical build | `cargo run --bin clade-build` | **PASS** |
| E2E | `cargo run --bin clade-e2e` | **PASS** (`report_prod_1785006144.md`) |
| Self-critic | `TRIOS_SKIP_CHAT_E2E=1 TRIOS_SKIP_SWIFT_TEST=1 cargo run --bin clade-audit -- --json` | **PASS** (0 findings across all 8 checks) |
| Promotion seal | `TRIOS_SKIP_CHAT_E2E=1 TRIOS_SKIP_SWIFT_TEST=1 cargo run --bin clade-seal` | **VALID** |
| Functional check | Standalone `/tmp/trios_recovery_verify/main.swift` | **PASS** — encrypted round-trip and legacy `.zip` import both work |
| Health | `curl http://127.0.0.1:9105/health` | `{"status":"ok","cdpConnected":true}` |

Note: `swift test` is unavailable in this CommandLineTools-only environment and
was skipped; the clade gates are the authoritative verification per
`CLAUDE.md`.

## 5. Three variants (recap)

### Variant A — Encrypt the whole ZIP envelope (chosen)

Compress a plaintext ZIP in a staging partial file, then encrypt the entire ZIP
with AES-256-GCM and write it as `.triosrecovery`. The reader decrypts to a
staging ZIP and extracts normally.

**Pros:** Minimal change, reuses `ditto`, manifest/checksum logic stays the
same, backward compatible with old `.zip` packages.
**Cons:** Whole package must be decrypted before any file can be read.

### Variant B — Encrypt each file inside the ZIP

Keep the ZIP structure but encrypt each member file individually before adding
it to the archive, leaving the manifest and README in plaintext.

**Pros:** Reader could inspect the manifest without decrypting the payload.
**Cons:** Requires custom ZIP read/write logic (currently delegated to `ditto`),
more code, harder to maintain, marginal benefit for a diagnostic bundle.

### Variant C — Replace ZIP with an encrypted SQLite/JSON bundle

Drop the ZIP format and store all files as encrypted BLOBs inside a single
SQLite file or JSON envelope.

**Pros:** Strong integrity, no dependency on external archive tools, easier to
add per-file ACLs or audit metadata.
**Cons:** Breaks existing recovery tooling and hand-off workflows, larger
refactor, no clear user-facing benefit.

## 6. Remaining surfaces

- Runtime logs in `.trinity/logs/` are still plaintext. They are diagnostic-only
  and are now redacted before inclusion in a recovery package, but they could be
  encrypted at rest in a future cycle.
- The encrypted recovery package is bound to the Mac that created it. A future
  variant could add optional passphrase-based export for cross-machine transfer.

## 7. Memory

- `.trinity/experience.md` updated with Cycle 14 closure.  
- Episode JSON saved to `.trinity/experience/YYYY-MM-DD_HH-MM-SS_CYCLE14-RECOVERY-ENCRYPTION.json`.  
- Persistent memory entry: `trios-cycle14-recovery-package-encryption.md`.

---

`φ² + 1/φ² = 3 | TRINITY`
