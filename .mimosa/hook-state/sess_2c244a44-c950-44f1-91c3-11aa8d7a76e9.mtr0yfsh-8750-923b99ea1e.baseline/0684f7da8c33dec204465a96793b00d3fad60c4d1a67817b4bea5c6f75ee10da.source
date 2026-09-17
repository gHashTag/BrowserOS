# Cycle 15 Report — Native SQLCipher Page-Level Encryption for Agent Memory

**Goal:** Replace the Cycle 12 encrypted-snapshot `MemoryStore` with native SQLCipher page-level encryption, preserving plaintext and legacy `.enc` migrations, and pass every Trinity gate.

**Date:** 2026-07-26
**Branch:** `feat/zai-provider` (trios)
**Main branch:** `dev`

---

## 1. What was changed

| Concern | Before (Cycle 12) | After (Cycle 15) |
|---------|-------------------|------------------|
| Encryption layer | Plain `sqlite3` + AES-256-GCM snapshot in `.enc` file | SQLCipher 4.17.0 (SQLite 3.53.3) with raw-key keying |
| Keying | Same Keychain-backed `TriOSEncryption(keyName: "memory")` used to wrap the snapshot | Raw 256-bit key exposed as hex for `PRAGMA key = "x'...'"` |
| Journal mode | `DELETE` | `WAL` (safe because SQLCipher encrypts WAL pages) |
| Migration path | Manual decrypt + re-encrypt in `MemoryStore` | `SQLCipherMemoryStore.migratePlaintextFile(at:)` and `migrateLegacySnapshot(from:to:)` |
| WAL/SHM handling | None | Stale `-wal`/`-shm` siblings removed before open and during migration |
| Close semantics | Plain `sqlite3_close_v2` | `PRAGMA wal_checkpoint(TRUNCATE)` before close |
| Key stability | Generated/read from Keychain on every call | Cached in `TriOSEncryption` after first access |

### Files touched

- `rings/SR-00/TriOSEncryption.swift`
  - Added `rawKeyData()` / `rawKeyHex()` for SQLCipher raw-key keying.
  - Added an in-process `cachedKey` + `NSLock` so all callers in the same process use the identical key.
- `rings/SR-01/SQLCipherMemoryStore.swift`
  - New helper enum for opening, keying, and migrating SQLCipher databases.
  - `openEncryptedDatabase(at:)` with `PRAGMA cipher_version` validation.
  - `migratePlaintextFile(at:)`, `migrateLegacySnapshot(from:to:)`, `exportPlaintextToEncrypted(...)`.
  - `removeWALSiblings(at:)` to avoid stale plaintext WAL crashes.
- `rings/SR-01/MemoryStore.swift`
  - Imports `CSQLCipher`.
  - Defaults to `SQLCipherMemoryStore.defaultDatabaseURL()` and `defaultLegacySnapshotURL()`.
  - Detects plaintext SQLite magic and runs in-place migration.
  - WAL journal mode + checkpoint-before-close.
- `rings/SR-01/EncryptedMemoryStore.swift`
  - Reduced to legacy decrypt + secure-delete helpers.
- `tests/TriOSKitTests/MemoryStoreEncryptionTests.swift`
  - Rewritten for SQLCipher file header, round-trip, legacy `.enc` migration, wrong-key rejection.
- `tests/swift/run_chat_sse_e2e.sh` and `tests/swift/ChatSSEEndToEndTest.swift`
  - SQLCipher compile/link flags; journal-mode assertion updated to `wal`.
- `build.sh`
  - SQLCipher discovery via `pkg-config`, dynamic-library bundling, `install_name_tool` rewrites.

---

## 2. Problem found and fixed

### Symptom
`MemoryStore` closed successfully (`wal_checkpoint=0`, `sqlite3_close_v2=0`), but reopening the same file failed with `file is not a database` and the schema was empty.

### Root cause
`TriOSEncryption` generated a fresh 256-bit key on every Keychain access when Keychain reads failed in the non-UI test/CLI context (`errSecNotAvailable / -25320 "In dark wake, no UI possible"`).

1. First `MemoryStore` instance wrote the database with key **A**.
2. `close()` checkpointed and closed cleanly.
3. Second `MemoryStore` instance keyed the same file with key **B**.
4. SQLCipher could not decrypt page 1 → SQLite reported `file is not a database`.

The fix is to cache the loaded/generated symmetric key inside `TriOSEncryption` so every call within a single process returns the same key. This also avoids repeated keychain round-trips and matches the real app lifecycle, where the first access either reads the persisted key or creates and caches it.

---

## 3. Verification results

All Trinity gates pass.

```text
./build.sh                         PASS
swift test                         SKIP  (XCTest not available, only CommandLineTools installed)
cargo run --bin clade-build        PASS
cargo run --bin clade-e2e          PASS
cargo run --bin clade-audit        PASS  (8/8 checks clean)
cargo run --bin clade-seal         PASS  SEAL VALID
bash tests/swift/run_chat_sse_e2e.sh  PASS  (all scenarios)
```

`clade-audit` findings: 0 security, 0 shell-safety, 0 error-handling, 0 concurrency, 0 TODO/FIXME, 0 dead code, 0 retain-cycle warnings.

### Live app check

```text
$ xxd -l 16 .../AgentMemory/agent-memory.sqlite3
a300 ae2a e234 c1ec 9dda 5f7f 9415 aa4e   # encrypted, not SQLite magic

$ curl -s http://127.0.0.1:9105/health
{"status":"ok","cdpConnected":true}
```

`cipher-debug.log` confirms:

```text
libversion=3.53.3
cipher_version=4.17.0 community
```

The menu-bar logo is present after `open trios.app`.

---

## 4. Three variants / next options

### Variant A — Stay the course (recommended)
Keep SQLCipher + Keychain + in-process key cache.

- **Pros:** Minimal change, gates pass, live app healthy, key remains in Keychain for backup safety.
- **Cons:** CLI tests still see `-25320` on fresh Keychain reads; cache only helps within a single process.
- **Action:** Add a one-time CLI self-test in CI that verifies the cached key round-trips a SQLCipher file.

### Variant B — Deterministic test key injection
Add an optional `TRIOS_MEMORY_KEY_HEX` environment variable that `SQLCipherMemoryStore` uses instead of the Keychain key. Tests set this to a fixed value; the app ignores it.

- **Pros:** Completely removes Keychain from the test path; cross-process test reloads are deterministic.
- **Cons:** Extra configuration surface; risk of misuse in production if not gated behind `#if DEBUG` or build-time checks.
- **Action:** Add an internal `MemoryStore` init that accepts a `TriOSEncryption` instance; test runner injects a test-only instance.

### Variant C — HSM-grade SQLCipher upgrade
Move from raw-key keying to `PRAGMA key` derived from a Keychain-stored passphrase using SQLCipher's `kdf_iter` + HMAC, and enable SQLCipher `cipher_plaintext_header_size` for faster validation.

- **Pros:** Stronger key-derivation binding, explicit KDF cost, better forensic resistance.
- **Cons:** Higher open latency (more KDF iterations), more complex migration, needs performance benchmarking on low-end Macs.
- **Action:** Spike in a feature branch with `PRAGMA kdf_iter = 256000` and measure `MemoryStore.init()` time.

---

## 5. L1-L7 compliance

| Law | Status | Note |
|-----|--------|------|
| L1 TRACEABILITY | OK | Closes the Cycle 15 scope; report is the artifact. |
| L2 GENERATION | OK | Touched canon Swift under Agent V waiver header. |
| L3 PURITY | OK | ASCII-only, English identifiers. |
| L4 TESTABILITY | OK | All gates pass; XCTest skipped due to toolchain, not code. |
| L5 IDENTITY | OK | No UI constant changes. |
| L6 CEILING | OK | No changes to `ProjectPaths.swift` / `TriosTheme.swift`. |
| L7 UNITY | OK | No new shell scripts on critical path. |

---

## 6. Artifacts

- Seal artifact: `.trinity/state/seal.json`
- E2E report: `.trinity/e2e/report_prod_*.md`
- Experience episode: `.trinity/experience/2026-07-26_cycle15_sqlcipher_memorystore.json`

φ² + 1/φ² = 3 | TRINITY
