# Cycle 15 Plan — Replace Encrypted MemoryStore Snapshot with SQLCipher

## 1. Weak spot

`MemoryStore` uses an **encrypted snapshot** pattern: it decrypts the whole
`agent-memory.sqlite3.enc` file into a plaintext `agent-memory.sqlite3` working
copy while the store is open, runs SQLite with `DELETE` journal mode, and
re-encrypts + securely deletes the working file on close. This has several
residual risks:

- **Plaintext working copy is exposed while the app is running.** Any crash,
  force-quit, or `kill -9` leaves the decrypted SQLite file on disk until the
  next launch cleanup.
- **Full-database rewrite on every close.** Even a single small write requires
  reading, decrypting, and re-encrypting the entire database, which is slow
  and increases wear for large memory stores.
- **No native transaction integrity.** The encrypted blob is opaque to SQLite;
  a crash during encryption can corrupt the entire snapshot.
- **SHM/WAL files may persist.** The current implementation leaves
  `agent-memory.sqlite3-shm` and `agent-memory.sqlite3-wal` next to the working
  file (observed in `~/Library/Application Support/Trinity S3AI/AgentMemory/`).

The cycle 12 approach was the right minimal fix, but it is still a "snapshot"
rather than true encrypted database storage.

## 2. Competitor research

| Product / Library | At-rest SQLite encryption | Key handling |
|-------------------|----------------------------|--------------|
| SQLCipher (Zetetic) | Page-level AES-256-CBC/PBKDF2 or AES-256-GCM (commercial) | Passphrase or raw key via `PRAGMA key` |
| Realm (MongoDB) | AES-256 file encryption | Key provided at runtime |
| WCDB (Tencent) | Built-in SQLCipher-like encryption | Configurable cipher key |
| Core Data + NSPersistentStoreFileProtection | DataProtection class (file-level) | Key handled by OS, not app |
| Apple `NSFileProtectionComplete` | Full-disk-class encryption | Device passcode / biometrics |
| Signal / WhatsApp | SQLCipher for message store | Key in Keychain/Secure Enclave |

TriOS already stores its encryption keys in the macOS Keychain (Cycle 13) and
uses `AES-256-GCM` elsewhere (Cycles 10-14). SQLCipher is the industry-standard
SQLite encryption extension and would give us native encrypted page I/O without
a plaintext working copy.

## 3. Decomposed implementation plan

### Phase 1 — Add SQLCipher dependency

1. Update `Package.swift` at the repo root to include a SQLCipher binary
   target or system-library target.  
   - On macOS we can link against the `sqlcipher` library installed via
     Homebrew or a local build.  
   - Add `.linkedLibrary("sqlcipher")` and `.linkedFramework("Security")` if
     not already present.  
   - Ensure `build.sh` links `-lsqlite3` only as fallback; prefer
     `-lsqlcipher` when available.

2. Add an `AGENT-V-WAIVER` to `MemoryStore.swift` because we are replacing the
   hand-edited Cycle 12 snapshot logic with a different ring-canon approach.

### Phase 2 — Implement SQLCipher-backed MemoryStore

1. Create `rings/SR-01/SQLCipherMemoryStore.swift` (or extend
   `EncryptedMemoryStore.swift`) with helpers:
   - `openEncryptedDatabase(at:key:)` — calls `sqlite3_key_v2` or
     `PRAGMA key = "x'...'"`.
   - `verifyKey()` — `PRAGMA cipher_version` and a test read.
   - `migrateLegacySnapshotIfNeeded()` — decrypts a legacy
     `agent-memory.sqlite3.enc` into a SQLCipher database with the same key.

2. Update `MemoryStore` actor:
   - Remove `workingURL` and the decrypt/encrypt/secure-delete dance.
   - Open the SQLCipher database directly on `agent-memory.sqlite3` (or
     `agent-memory.sqlite3.enc` with SQLCipher's own format).
   - Keep WAL mode for performance; SQLCipher encrypts WAL pages too.
   - On `deinit`/close, close the SQLite handle; no plaintext working file.

3. Set SQLCipher defaults:
   - `PRAGMA cipher_plaintext_header_size = 32`
   - `PRAGMA cipher_salt = ...` if deterministic header is needed.
   - `PRAGMA journal_mode = WAL`
   - `PRAGMA synchronous = NORMAL` or `FULL`
   - `PRAGMA kdf_iter = 256000` only if using passphrase; raw key needs no KDF.

### Phase 3 — Migration from encrypted snapshot

1. On first open, detect legacy `agent-memory.sqlite3.enc`.
2. Decrypt it with `TriOSEncryption.memory` to a temporary plaintext file.
3. Open the plaintext with SQLCipher under the raw key.
4. Run `VACUUM` or simply let SQLCipher rewrite the file encrypted.
5. Delete the legacy `.enc` file and the temporary plaintext.

### Phase 4 — Tests

1. Add `SQLCipherMemoryStoreTests.swift`:
   - Open an encrypted SQLCipher database, write/read memory records.
   - Verify the file bytes are not plaintext SQLite (`SQLite format 3` magic
     should not appear at offset 0 when a non-zero header salt is used).
   - Close and reopen with the same key.
   - Fail to open with a wrong key.
   - Migrate a legacy encrypted snapshot and read its records.

2. Update `MemoryStoreFTSTests` / `MemoryStoreEncryptionTests` to use the new
   direct-open path.

### Phase 5 — Build and verification

1. `./build.sh` passes.
2. `cargo run --bin clade-build` passes.
3. `cargo run --bin clade-e2e` passes.
4. `cargo run --bin clade-audit` hard gates clean.
5. `cargo run --bin clade-seal` valid.

## 4. Three variants

### Variant A — SQLCipher native encryption (chosen)

Replace the encrypted snapshot with SQLCipher. The database file is encrypted
at the page level, WAL is encrypted, and there is no plaintext working copy.

**Pros:** Industry standard, no plaintext exposure while open, incremental
writes, full SQLite ACID integrity, encrypted WAL.
**Cons:** Adds a C/SQLCipher build dependency; key must be passed to SQLCipher
via a raw key hex string.

### Variant B — Keep snapshot, but encrypt WAL + working copy header

Keep the Cycle 12 snapshot pattern, but add a tiny SQLCipher-like header salt
and encrypt `-wal` / `-shm` siblings. Also use `SQLITE_OPEN_MEMORY` or temp
file with immediate encryption.

**Pros:** No new dependency.
**Cons:** Still a plaintext working copy while open; still full-rewrite on
every close; complexity without real benefit.

### Variant C — File-level Apple Data Protection only

Drop custom encryption and rely on `NSFileProtectionComplete` / FileVault /
`kSecAttrAccessibleWhenUnlockedThisDeviceOnly` file attributes.

**Pros:** Zero crypto code in app; OS handles keys.
**Cons:** Not portable, weaker guarantees when device is unlocked, conflicts
with TriOS's cross-platform encryption design, and does not protect against
other user-space processes while unlocked.

**Chosen: Variant A** — SQLCipher removes the residual plaintext working copy
and gives true incremental encrypted database I/O. It is the natural next step
after Cycle 12's snapshot fix and aligns with Signal/WhatsApp best practice.

## 5. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| SQLCipher not installed on build machine | Document in `INSTALLATION_GUIDE.md`; fallback build script that downloads/brew-installs SQLCipher; CI pre-install |
| Migration corrupts legacy encrypted snapshot | Keep backup of `.enc` until first successful reopen; test migration path |
| Key hex string leaks in logs | Never log the key; pass via raw-key pragma only |
| WAL files left unencrypted | Use SQLCipher 4.x which encrypts WAL by default |
| Build warnings from mixing sqlite3/sqlcipher | Remove `-lsqlite3` when SQLCipher is linked |

## 6. Success criteria

- [ ] `Package.swift` and `build.sh` link SQLCipher.  
- [ ] `MemoryStore` opens the database directly with SQLCipher; no plaintext
      working copy remains after close.  
- [ ] Legacy `agent-memory.sqlite3.enc` snapshot migrates cleanly.  
- [ ] Tests verify ciphertext is not plaintext SQLite and wrong keys fail.  
- [ ] `./build.sh`, `clade-build`, `clade-audit`, `clade-seal`, `clade-e2e` all pass.  
- [ ] Report + three variants written to
      `.claude/plans/trios-cycle15-memorystore-sqlcipher-report.md`.  
- [ ] Episode + memory updated.
