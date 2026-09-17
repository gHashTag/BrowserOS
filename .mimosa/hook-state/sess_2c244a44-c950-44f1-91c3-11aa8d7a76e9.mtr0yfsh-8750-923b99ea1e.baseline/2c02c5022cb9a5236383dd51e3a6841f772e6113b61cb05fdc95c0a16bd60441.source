# Cycle 12 — Encrypted MemoryStore SQLite at rest (trios)

## Weak spot
`MemoryStore` keeps durable agent memory and TODO plans in a plaintext SQLite database at:

```
~/Library/Application Support/Trinity S3AI/AgentMemory/agent-memory.sqlite3
```

A malicious or compromised process with user access can read every memory `body` and plan goal, including recalled snippets that may contain redacted-but-still-sensitive context. This is the largest remaining plaintext surface after Cycle 11 closed the image-attachment gap.

## Competitor / threat landscape
- **Heirloom** — local-first Rust memory app using XChaCha20-Poly1305 + Argon2id for its SQLite-like store, exposing memory only via MCP with no plaintext on disk.
- **KausaMemory v2** — per-agent namespace SQLite, AES-256-GCM at rest, with encrypted IPFS backup.
- **Jot** — SQLCipher-encrypted SQLite + Argon2 key derivation + secure keychain storage for on-device journaling AI.
- **Cognexia** — optional AES-256-GCM with blind indexing for project-isolated memory graphs.

Industry pattern: encrypt the whole SQLite database file or use SQLCipher; derive/stash the key in the secure enclave / Keychain; migrate plaintext legacy databases on first launch.

## Goal
Encrypt the `MemoryStore` SQLite database so its file content is indistinguishable from random bytes, while preserving the existing `AgentMemoryStoreProtocol`, FTS5 full-text recall, and schema migration path. Derive the encryption key from a new named `TriOSEncryption` key and migrate any existing plaintext database automatically.

## Decomposition

### 1. Approach selection
SQLCipher requires building/linking a separate `libsqlcipher` and defining `SQLITE_HAS_CODEC`. The trios build path is `swiftc` direct plus `cargo` for Rust tools; adding a C dependency would require either a system-installed SQLCipher (not present on this machine) or building it from source every time. To keep the change self-contained and landable in this cycle, we will implement **file-level encryption of the SQLite database**:

- When `MemoryStore` closes, export the database to an encrypted snapshot (`agent-memory.sqlite3.enc`).
- When `MemoryStore` opens, if only `.enc` exists, decrypt it to a temporary plaintext file, open SQLite, and arrange to re-encrypt on close.
- Use a write-ahead journal (`-wal`, `-shm`) is incompatible with this pattern because they are separate plaintext files; we will switch to `DELETE` journal mode for the encrypted store and use a per-process in-memory/temp working copy.

This is pragmatic but has a limitation: while the app is running, the working database file is plaintext in a sandboxed temp directory. The long-term resting state is encrypted.

### 2. Key plumbing (`trios/rings/SR-00`)
- Add `TriOSEncryption(keyName: "memory")` shared instance: `static let memory = TriOSEncryption(keyName: "memory")`.

### 3. Encrypted file store (`trios/rings/SR-01`)
- Create `EncryptedDatabaseStore` helper:
  - `encryptDatabase(at: URL) throws -> Data` — read file, encrypt, return ciphertext.
  - `decryptDatabase(data: Data, to: URL) throws` — decrypt, write to temp path.
  - `defaultEncryptedURL()` — returns `Application Support/Trinity S3AI/AgentMemory/agent-memory.sqlite3.enc`.
  - Exclude the encrypted file from backup and set `0o600` permissions.

### 4. `MemoryStore` integration
- Replace `databaseURL` semantics with a working (temp/decrypted) URL and a persistent encrypted URL.
- In `init`:
  1. Ensure `AgentMemory` directory exists with `0o700`.
  2. If `agent-memory.sqlite3.enc` exists, decrypt it to a temp file inside the directory (e.g., `agent-memory.sqlite3`).
  3. If legacy plaintext `agent-memory.sqlite3` exists and no `.enc` exists, use it as-is and encrypt on first close (migration).
  4. Open SQLite with `journal_mode = DELETE` instead of WAL, because WAL files would leak plaintext outside the encrypted snapshot.
- In `close`:
  1. Close SQLite handle.
  2. Encrypt the working file to `.enc`.
  3. Secure-delete the working plaintext file (overwrite first N bytes, then remove).
- Add a `deinit` that calls `close()` if still open.
- Update `schemaVersionNumber` to `2`; migration from v1 must happen after the database is opened on the plaintext working copy.

### 5. `AgentMemoryStoreProtocol` / callers
- No public API changes. `MemoryStore` remains an `actor` conforming to the protocol.
- `main.swift` still uses `try MemoryStore()` and falls back to `VolatileMemoryStore()`.

### 6. Tests
- Update `MemoryStoreFTSTests` to reference `MemoryStore` instead of `PersistentMemoryStore` (fix existing broken symbol reference).
- Add `MemoryStoreEncryptionTests`:
  - Open a `MemoryStore` at a temp path, save a memory, close it, verify the `.enc` file exists and is not plaintext.
  - Reopen and recall the memory (decrypt + open round-trip).
  - Verify that a legacy plaintext `agent-memory.sqlite3` without `.enc` is loaded and then migrated to `.enc` on close.

### 7. Trinity gates
- `./build.sh`
- `cargo run --bin clade-build`
- `cargo run --bin clade-audit`
- `cargo run --bin clade-seal`
- `cargo run --bin clade-e2e`
- Relaunch `trios.app` and verify `/health`.

### 8. Report & variants
- Write `.claude/plans/trios-cycle12-memory-encryption-report.md`.
- Produce three variants:
  - (A) File-level encrypted snapshot — implemented; resting state is encrypted, runtime working copy is plaintext in a temp dir.
  - (B) SQLCipher integration — strongest SQLite-native encryption, requires building/linking SQLCipher and conflicts with system `sqlite3`.
  - (C) Per-conversation encrypted memory shards — split memory/plan tables into separate encrypted SQLite files per conversation so a leaked key exposes only one conversation.

## Selected road
**Road B** — balanced: fix + tests + experience save. The surface is contained to `MemoryStore` and `TriOSEncryption`.
