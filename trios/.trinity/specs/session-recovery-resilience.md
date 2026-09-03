# Session Recovery Resilience

Task: `SESSION-RECOVERY-002`

Issue: T27-EPIC-001

## Problem

The recovery export/import pipeline added in `SESSION-EXPORT-001` successfully
produces and consumes Trinity recovery ZIPs, but it lacks resilience guarantees
observed in competing products: manifest verification, atomic partial import,
progress reporting, duplicate handling, large-file streaming, encryption
portability, and forward-compatible versioning. This makes the feature fragile
for large sessions, untrustworthy for agent handoff, and brittle when the
package format evolves.

## Contract

1. **Manifest integrity on import**
   - `SessionRecoveryPackageReader` reads the `files` array from `manifest.json`.
   - Every extracted file is verified against its manifest entry (path, size,
     SHA-256) before any conversation is imported.
   - Structured errors report `checksumMismatch`, `manifestFileMissing`,
     `archiveCorrupt`, and `unsupportedSchemaVersion` distinctly.

2. **Atomic import with per-item reporting**
   - Conversation import is treated as a single logical transaction.
   - If saving any conversation fails, previously saved conversations in the
     same import are rolled back.
   - The import result reports `successCount`, `failureCount`, and a list of
     `failedConversationIDs` with localized reasons.

3. **Duplicate detection on import**
   - Before writing an imported conversation, compare its UUID and title against
     existing local conversations.
   - If a duplicate exists, prompt via a sheet with options: `replace`,
     `merge` (keep existing messages, append imported messages without
     duplicate IDs), `skip`.
   - Default behavior when UI is unavailable (CLI/AppleScript): `skip`.

4. **Large-file safety**
   - Cap individual copied log/text files at 16 MiB; files exceeding the cap are
     written as a placeholder note, not truncated in memory.
   - Stream file reads where possible instead of `Data(contentsOf:)` for the
     entire file.

5. **Progress and cancellation**
   - Export and import report `Progress` (files processed, bytes, conversation
     count) to a shared `ObservableObject`.
   - `ChatPanelView` shows a determinate progress bar and a Cancel button during
     long operations; cancellation aborts I/O cleanly and removes partial files.

6. **Encryption portability (Phase 1: awareness)**
   - Include `encryptionScheme: "local-aes256-gcm-v1"` and the key file path hint
     in `manifest.json` and `runtime-context.json`.
   - Document that the device-specific `conversation.key` is **not** in the
     package and must be migrated separately for cross-device restore.
   - Do **not** include the raw key in the ZIP. Future phase will add optional
     passphrase-based package encryption.

7. **Version compatibility**
   - Manifest stores `schemaVersion`, `minReaderVersion`, and `createdByAppVersion`.
   - Reader rejects only packages whose `minReaderVersion` is greater than the
     reader's supported version. Unknown non-breaking fields are ignored.
   - Add a forward-compatibility note: bump `schemaVersion` only for breaking
     structural changes.

8. **Error taxonomy**
   - Expand `SessionRecoveryPackageReaderError` and `SessionRecoveryPackageError`
     with explicit cases for all failure modes above.
   - UI alerts preserve structured error identity for diagnostics.

## Invariants

- Import never silently corrupts local encrypted conversation state.
- Manifest verification failures block all conversation writes.
- A cancelled or failed import leaves no new local conversations behind.
- The recovery ZIP never contains the local `conversation.key` file.
- Source and first-party documentation remain English and ASCII-only.

## TDD Cases

1. Export a package, corrupt one file, and verify import fails with
   `checksumMismatch` and names the affected path.
2. Export a package, delete `manifest.json`, and verify import fails with
   `manifestFileMissing`.
3. Simulate a save failure mid-import and verify no imported conversations
   remain in `UserDefaults`.
4. Import the same package twice; second import shows duplicate sheet and,
   on `replace`, overwrites; on `merge`, appends without duplicate message IDs;
   on `skip`, leaves original untouched.
5. Export with a log file larger than 16 MiB and verify the archive contains a
   placeholder, not the full binary blob in memory.
6. Cancel an export after 50 ms; verify no partial archive remains.
7. Verify a v1 package with extra unknown manifest fields imports successfully.
8. Verify a hypothetical v2 package with `minReaderVersion: 99` is rejected with
   `unsupportedSchemaVersion`.

## Verification

- Run the dedicated Swift recovery tests.
- Run `./build.sh` and `cargo run --bin clade-build`.
- Run `cargo run --bin clade-e2e`.
- Relaunch `trios.app`, export a real package, tamper with it, and confirm
  import fails with a specific error.
- Confirm duplicate import sheet appears and options behave correctly.
- Confirm progress bar is visible during large exports/imports.
