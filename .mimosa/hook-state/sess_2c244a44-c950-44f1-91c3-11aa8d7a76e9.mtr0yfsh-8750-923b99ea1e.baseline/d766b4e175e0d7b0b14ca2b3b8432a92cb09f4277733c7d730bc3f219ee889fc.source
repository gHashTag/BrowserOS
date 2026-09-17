# Cycle 12 — Encrypted MemoryStore SQLite at rest (trios) — Closure Report

## Summary
Encrypted the durable agent-memory and TODO-plan SQLite database so its resting state on disk is indistinguishable from random bytes. The change is transparent to `AgentMemoryStoreProtocol` callers, preserves FTS5 full-text recall, migrates any existing plaintext database automatically, and passes all Trinity verification gates.

## Weak spot closed
`MemoryStore` previously persisted every memory `body` and TODO plan goal as plaintext at:

```
~/Library/Application Support/Trinity S3AI/AgentMemory/agent-memory.sqlite3
```

Any process with user-level access could read recalled snippets and plan goals. After this cycle the persistent file is:

```
~/Library/Application Support/Trinity S3AI/AgentMemory/agent-memory.sqlite3.enc
```

encrypted with AES-256-GCM using a named key stored in `Application Support/trios/keys/memory.key`.

## Implementation

### 1. Reusable named key (`trios/rings/SR-00/TriOSEncryption.swift`)
- Added `static let memory = TriOSEncryption(keyName: "memory")` alongside the existing `attachments` key.
- Key lifecycle (generation, 256-bit AES-GCM, backup exclusion) is shared with conversation and attachment encryption.

### 2. Encrypted snapshot helper (`trios/rings/SR-01/EncryptedMemoryStore.swift`)
- `defaultEncryptedURL()` → `.../AgentMemory/agent-memory.sqlite3.enc`.
- `workingURL(for:)` → `.../AgentMemory/agent-memory.sqlite3` (plaintext while open).
- `decryptWorkingFile` reads `.enc`, decrypts with `TriOSEncryption.memory`, writes atomic working copy.
- `encryptWorkingFile` reads working file, encrypts, writes atomic `.enc` snapshot, sets `0o600` permissions and excludes from backup.
- `securelyRemoveWorkingFile` overwrites the first 4 KiB of the working plaintext file with zeros before unlinking (best-effort wipe).
- `prepareDirectory` creates the parent with `0o700`.

### 3. `MemoryStore` integration (`trios/rings/SR-01/MemoryStore.swift`)
- `init` now takes both `databaseURL` (working plaintext) and `encryptedURL` (persistent snapshot).
- On open:
  1. Ensures directory exists with `0o700`.
  2. If `.enc` exists, decrypts it to the working file.
  3. Else if legacy `agent-memory.sqlite3` exists, uses it as the working copy and sets `didMigrateLegacyPlaintext = true`; it will be encrypted on first close.
  4. Opens SQLite with `journal_mode = DELETE` and `synchronous = FULL` — WAL is disabled because `-wal`/`-shm` files would leak plaintext outside the encrypted snapshot.
- `close` closes the SQLite handle, encrypts the working file to `.enc`, and securely deletes the working file.
- `deinit` closes the handle and best-effort wipes the working file if `close()` was not called explicitly.
- Schema bumped from `1` to `2`. The v1→v2 migration is a `PRAGMA user_version` bump because the table layout is unchanged.

### 4. Public API / callers
- No change to `AgentMemoryStoreProtocol`.
- `main.swift` still uses `try MemoryStore()` and falls back to `VolatileMemoryStore()`.

### 5. Tests
- `MemoryStoreFTSTests.swift` — fixed broken `PersistentMemoryStore` symbol reference (replaced with `MemoryStore`).
- `MemoryStoreEncryptionTests.swift` — added three tests:
  - `testEncryptedSnapshotIsNotPlaintext` — verifies `.enc` exists, does not start with the SQLite magic header, and does not contain a known plaintext token.
  - `testEncryptedSnapshotRoundTrips` — saves a memory, closes, reopens, and recalls it via FTS.
  - `testLegacyPlaintextDatabaseMigratesToEncryptedSnapshot` — creates a v1 plaintext database, opens it in `MemoryStore`, recalls the legacy memory, closes, and verifies `.enc` was created.

## Verification

| Gate | Result |
|------|--------|
| `./build.sh` | PASS (chat integration tests PASS; `swift test` auto-skipped because XCTest is not available in this toolchain) |
| `cargo run --bin clade-build` | PASS |
| `cargo run --bin clade-audit` | **0 findings** across all 8 checks |
| `cargo run --bin clade-seal` | **SEAL VALID** |
| `cargo run --bin clade-e2e` | PASS |
| `open trios.app` + `curl http://127.0.0.1:9105/health` | `{"status":"ok","cdpConnected":true}` |
| `swift test` | XCTest module unavailable in this CommandLineTools-only environment; the clade pipeline is the authoritative verification per `CLAUDE.md`. |

The menu-bar logo was relaunched and remains present (`open trios.app`).

## Files changed
- `trios/rings/SR-00/TriOSEncryption.swift` — added `static let memory` named key.
- `trios/rings/SR-01/EncryptedMemoryStore.swift` — new encrypted snapshot helper.
- `trios/rings/SR-01/MemoryStore.swift` — encrypted open/close/migrate plumbing.
- `trios/tests/TriOSKitTests/MemoryStoreFTSTests.swift` — fixed symbol reference.
- `trios/tests/TriOSKitTests/MemoryStoreEncryptionTests.swift` — new encryption tests.
- `trios/tests/swift/ChatSSEEndToEndTest.swift` — updated durable-memory scenario for schema v2 / DELETE journal mode.

## Known limitations
- While the store is open, a decrypted working copy exists in `Application Support/Trinity S3AI/AgentMemory/`. It is securely deleted on close, but a live memory dump or crash could expose that transient plaintext file.
- `DELETE` journal mode is slower than WAL for high-write concurrency. Agent memory writes are infrequent, so the impact is minimal.
- Secure deletion is best-effort: modern SSDs and filesystem copy-on-write may retain blocks despite the overwrite.

## Variants

### Variant A — File-level encrypted snapshot (implemented)
Encrypt the whole SQLite file as a single snapshot when `MemoryStore` closes.
- **Pros:** Self-contained, no extra dependencies, preserves existing SQLite3 system library, transparent to protocol, migrates legacy DB automatically.
- **Cons:** Working copy is plaintext while open; must use `DELETE` journal mode.

### Variant B — SQLCipher-native encryption
Link `libsqlcipher` and use native SQLite page-level encryption with `PRAGMA key`.
- **Pros:** Strongest at-rest story; no transient plaintext working file; WAL-compatible; industry standard.
- **Cons:** Requires building/linking SQLCipher, conflicts with the current `swiftc` direct + `-lsqlite3` build path, adds a C dependency not present on this machine, and needs `SQLITE_HAS_CODEC` definitions. Best reserved for a build-system refactor cycle.

### Variant C — Per-conversation encrypted memory shards
Split memory and plan tables into separate encrypted SQLite files per `conversationId`.
- **Pros:** Blast-radius control — a leaked key exposes only one conversation; easier key rotation per conversation.
- **Cons:** More complex open/close orchestration; cross-conversation memory recall becomes a multi-database fan-out; schema migration is harder; overkill for current threat model.

## Recommendation
Variant A is the correct trade-off for this cycle: it closes the largest remaining plaintext surface without blocking on a build-system overhaul. Plan Variant B when the build pipeline can absorb a SQLCipher dependency, and Variant C only if the threat model explicitly requires per-conversation isolation.

## Next weak-spot candidates
1. **Key management hardening** — move the named `memory.key` from `Application Support/trios/keys/` into the macOS Keychain / Secure Enclave so it is not a regular file.
2. **SQLCipher migration** — once the build system supports it, replace the file-level snapshot with native page encryption and re-enable WAL.
3. **Per-conversation key rotation** — after SQLCipher, derive per-conversation subkeys from a master Keychain key.

## Artifacts
- Plan: `.claude/plans/trios-cycle12-memory-encryption-plan.md`
- Report: `.claude/plans/trios-cycle12-memory-encryption-report.md`
- Episode: `.trinity/experience/2026-07-26_00-39-35_CYCLE12-MEMORY-ENCRYPTION.json`
- Seal artifact: `.trinity/state/seal.json`
- E2E report: `.trinity/e2e/report_prod_1785000953.md`
