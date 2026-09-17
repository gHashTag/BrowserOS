# Cycle 14 Plan — Encrypt TriOS Session Recovery Package

## 1. Weak spot

`SessionRecoveryPackageWriter` exports the full TriOS session (conversations,
browser context, runtime diagnostics, system logs, and companion logs) as a
plaintext ZIP archive. The manifest already advertises
`encryptionScheme: "local-aes256-gcm-v1"`, but the archive bytes are not actually
encrypted. This is a false security claim and leaves sensitive user chat
content, browser tool history, and runtime fingerprints exposed if the exported
file is placed in a synced, shared, or otherwise accessible directory.

While `SessionRecoveryRedactor` strips many secret token patterns, it is
regex-based and cannot guarantee that a conversation transcript contains no
personally sensitive or confidential information.

## 2. Competitor research

| Product / Pattern | Recovery/diagnostic packaging | Encryption posture |
|-------------------|-------------------------------|--------------------|
| Apple sysdiagnose | Compressed diagnostic archive | Plaintext; protected only by file-system ACLs |
| Chrome/Edge crash reporter | Minidump + log bundle | Not user-encrypted; uploaded over TLS |
| Signal backups | Encrypted message archive | AES-256-CBC or similar with user passphrase |
| 1Password export (OPVault) | JSON-like encrypted vault | AES-256-GCM, key derived from account password |
| JetBrains / VS Code logs | Plaintext rolling logs | No at-rest encryption |
| WhatsApp cloud backups | Encrypted chat backup | AES-256-GCM with server-assisted key or passphrase |

Conclusion: most desktop diagnostics are plaintext. TriOS already encrypts
MemoryStore (Cycle 12) and chat attachments (Cycle 11) with Keychain-backed
AES-256-GCM keys. The recovery package should use the same infrastructure so
that the exported bundle is unreadable outside the originating Mac.

## 3. Decomposed implementation plan

1. **Key plumbing**  
   Add a shared `TriOSEncryption(keyName: "recovery")` instance for the
   recovery package. This reuses the Keychain-backed key store from Cycle 13.

2. **Writer hardening** (`rings/SR-01/SessionRecoveryPackageWriter.swift`)  
   - Produce the final archive with a `.triosrecovery` extension.  
   - Keep the intermediate ZIP plaintext only in a staging partial file.  
   - Encrypt the staged ZIP bytes with the recovery key and write the encrypted
     output to the final path.  
   - Delete the plaintext intermediate immediately.  
   - Update the manifest `encryptionScheme` to reflect real encryption.  
   - Update the package README to state that the bundle is encrypted and can only
     be read by TriOS on the same Mac.

3. **Reader hardening** (`rings/SR-01/SessionRecoveryPackageReader.swift`)  
   - Detect encrypted packages by file extension (`.triosrecovery`) and decrypt
     the archive bytes into a temporary plaintext ZIP before extraction.  
   - Keep backward compatibility for legacy plaintext `.zip` packages whose
     manifest has an empty or missing `encryptionScheme`.  
   - Verify the decrypted manifest and file checksums as before.

4. **Naming** (`rings/SR-00/SessionRecoveryExport.swift`)  
   Change `SessionRecoveryPackageNaming.fileName()` to use the
   `.triosrecovery` extension.

5. **Tests** (`tests/TriOSKitTests/SessionRecoveryPackageEncryptionTests.swift`)  
   - Round-trip write + read with an encrypted package.  
   - Backward compatibility: a plaintext legacy `.zip` package can still be
     read.  
   - Manifest integrity after encryption.  
   - Tamper detection: corrupted encrypted bytes fail with a decryption error.

6. **Verification**  
   - `./build.sh` must pass.  
   - `cargo run --bin clade-build` must pass.  
   - `clade-audit` hard gates must remain clean.  
   - `cargo run --bin clade-e2e` must pass.

## 4. Three variants

### Variant A — Encrypt the whole ZIP envelope (chosen)

Compress a plaintext ZIP in a staging partial file, then encrypt the entire ZIP
with AES-256-GCM and write it as `.triosrecovery`. The reader decrypts to a
staging ZIP and extracts normally.  
**Pros:** Minimal change, reuses `ditto`, manifest/checksum logic stays the same,
backward compatible with old `.zip` packages.  
**Cons:** The whole package must be decrypted before any file can be read.

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

**Chosen: Variant A** — it hardens the most exposed surface with the least
risk and the most reuse of the existing encryption/keychain infrastructure.

## 5. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Reader cannot open package if Keychain item is lost | Key is backed by macOS Keychain with device-only accessibility; legacy plaintext `.zip` import still supported |
| Encrypted file extension confuses users | README clearly states the file is encrypted and bound to the originating Mac |
| Encryption/decryption adds I/O overhead | Packages are capped by existing 16 MiB per-file log limits; AES-GCM is fast on Apple Silicon |
| Build/test environment lacks XCTest | Unit tests are written but skipped at build time; `./build.sh` is the authoritative gate |

## 6. Success criteria

- [ ] `./build.sh` passes with no Swift compilation errors.  
- [ ] `cargo run --bin clade-build` passes.  
- [ ] `clade-audit` reports zero hard-gate findings (or only pre-existing waivers).  
- [ ] A recovery package written after the change is not readable as plaintext.  
- [ ] A legacy plaintext `.zip` recovery package can still be imported.  
- [ ] Report and three variants are written to `.claude/plans/trios-cycle14-recovery-package-encryption-report.md`.  
- [ ] Experience episode is saved and memory is updated.
