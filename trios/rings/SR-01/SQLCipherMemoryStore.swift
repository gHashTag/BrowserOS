// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: Cycle 15 replaces the encrypted snapshot with native SQLCipher
// page-level encryption. Seal against .trinity/specs/agent-memory-todo-planner.md.
import Foundation
@_exported import CSQLCipher

/// Errors raised by the SQLCipher-backed memory store layer.
enum SQLCipherMemoryStoreError: LocalizedError {
    case keyUnavailable
    case openFailed(String)
    case migrationFailed(String)
    case notEncrypted

    var errorDescription: String? {
        switch self {
        case .keyUnavailable:
            return "MemoryStore SQLCipher key is unavailable"
        case .openFailed(let message):
            return "Unable to open encrypted memory database: \(message)"
        case .migrationFailed(let message):
            return "Failed to migrate legacy encrypted memory snapshot: \(message)"
        case .notEncrypted:
            return "MemoryStore database is not encrypted by SQLCipher"
        }
    }
}

/// Helpers for opening and migrating a SQLCipher-encrypted SQLite database
/// used as the durable agent-memory and TODO-plan store.
enum SQLCipherMemoryStore {
    static let encryption = TriOSEncryption.memory

    /// Returns the default persistent SQLCipher database URL.
    static func defaultDatabaseURL() -> URL {
        FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )
        .first!
        .appendingPathComponent("Trinity S3AI", isDirectory: true)
        .appendingPathComponent("AgentMemory", isDirectory: true)
        .appendingPathComponent("agent-memory.sqlite3")
    }

    /// Returns the legacy Cycle 12 encrypted snapshot URL used for migration.
    static func defaultLegacySnapshotURL() -> URL {
        FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )
        .first!
        .appendingPathComponent("Trinity S3AI", isDirectory: true)
        .appendingPathComponent("AgentMemory", isDirectory: true)
        .appendingPathComponent("agent-memory.sqlite3.enc")
    }

    /// Removes SQLite WAL and SHM siblings for a database path.
    /// This is used during migration and recovery to avoid SQLCipher trying
    /// to replay stale plaintext WAL pages against an encrypted database.
    static func removeWALSiblings(at url: URL) {
        let fm = FileManager.default
        for suffix in ["-wal", "-shm"] {
            let sibling = URL(fileURLWithPath: url.path + suffix)
            if fm.fileExists(atPath: sibling.path) {
                try? fm.removeItem(at: sibling)
            }
        }
    }

    /// Prepares the parent directory with restricted permissions.
    static func prepareDirectory(at url: URL) throws {
        let dir = url.deletingLastPathComponent()
        let fm = FileManager.default
        do {
            try fm.createDirectory(
                at: dir,
                withIntermediateDirectories: true,
                attributes: [FileAttributeKey.posixPermissions: 0o700]
            )
        } catch {
            throw SQLCipherMemoryStoreError.openFailed(
                "failed to create directory: \(error.localizedDescription)"
            )
        }
    }

    /// Opens a SQLCipher database with the raw 256-bit key.
    ///
    /// If the file does not exist it is created and then keyed; if it exists it
    /// is decrypted on every page read by SQLCipher. `PRAGMA cipher_version` is
    /// read after keying to confirm that SQLCipher (not plain SQLite) is active.
    static func openEncryptedDatabase(at url: URL) throws -> OpaquePointer {
        debugLog(at: url, "openEncryptedDatabase top: path=\(url.path)")
        try prepareDirectory(at: url)

        // If a previous plaintext or failed migration left WAL/SHM siblings
        // without a main database file, SQLCipher will try to recover them and
        // may crash. Remove stale siblings when the main file is absent.
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) {
            removeWALSiblings(at: url)
        }

        let keyHex = try encryption.rawKeyHex()
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_CREATE
            | SQLITE_OPEN_READWRITE
            | SQLITE_OPEN_FULLMUTEX
        let openResult = sqlite3_open_v2(url.path, &handle, flags, nil)
        guard openResult == SQLITE_OK, let db = handle else {
            let message = handle.flatMap { String(cString: sqlite3_errmsg($0)) }
                ?? "unknown SQLite error"
            if let handle { sqlite3_close_v2(handle) }
            throw SQLCipherMemoryStoreError.openFailed(message)
        }

        do {
            Self.debugLog(at: url, "about to set key, length=\(keyHex.count)")
            try execute(db, sql: "PRAGMA key = \"x'\(keyHex)'\"")
            Self.debugLog(at: url, "key set")
            let libVersion = String(cString: sqlite3_libversion())
            Self.debugLog(at: url, "libversion=\(libVersion)")
            let cipherVersion = try pragmaText(db, name: "cipher_version")
            Self.debugLog(at: url, "cipher_version=\(cipherVersion)")
            guard !cipherVersion.isEmpty else {
                throw SQLCipherMemoryStoreError.notEncrypted
            }
        } catch {
            Self.debugLog(at: url, "openEncryptedDatabase error: \(error.localizedDescription)")
            sqlite3_close_v2(db)
            throw SQLCipherMemoryStoreError.openFailed(error.localizedDescription)
        }

        return db
    }

    static func debugLog(at url: URL, _ message: String) {
        let fm = FileManager.default
        let debugLog = url.deletingLastPathComponent()
            .appendingPathComponent("cipher-debug.log")
        let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        if fm.fileExists(atPath: debugLog.path),
           let handle = try? FileHandle(forWritingTo: debugLog) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: debugLog, options: .atomic)
        }
    }

    /// Migrates a legacy Cycle 12 `.enc` snapshot into a native SQLCipher file.
    ///
    /// The snapshot is decrypted to a temporary plaintext file, exported into a
    /// new SQLCipher database under the same key, and the temporary plaintext is
    /// securely deleted. The legacy snapshot is removed once the new file opens
    /// successfully.
    /// Migrates an existing plaintext `agent-memory.sqlite3` file into a
    /// SQLCipher-encrypted database in place, preserving all data.
    static func migratePlaintextFile(at databaseURL: URL) throws -> OpaquePointer {
        let fm = FileManager.default
        let debugLog = databaseURL.deletingLastPathComponent()
            .appendingPathComponent("migrate-debug.log")
        func log(_ message: String) {
            let line = "[migratePlaintextFile] \(message)\n"
            guard let data = line.data(using: .utf8) else { return }
            if fm.fileExists(atPath: debugLog.path),
               let handle = try? FileHandle(forWritingTo: debugLog) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            } else {
                try? data.write(to: debugLog, options: .atomic)
            }
        }
        log("starting")
        let plaintextBackup = databaseURL.appendingPathExtension("plaintext.bak")
        if fm.fileExists(atPath: plaintextBackup.path) {
            log("removing stale backup")
            try? fm.removeItem(at: plaintextBackup)
        }
        do {
            log("moving original to backup")
            try fm.moveItem(at: databaseURL, to: plaintextBackup)
            // The WAL/SHM siblings still belong to the original path; the backup
            // is a separate file and will create its own WAL. Remove stale
            // siblings so they cannot be mistaken for the backup's journal.
            removeWALSiblings(at: databaseURL)
        } catch {
            log("move failed: \(error.localizedDescription)")
            throw error
        }

        do {
            // If a previous failed run left WAL/SHM at the destination, remove
            // them before SQLCipher tries to recover stale plaintext pages.
            removeWALSiblings(at: databaseURL)
            log("exporting plaintext to encrypted")
            try exportPlaintextToEncrypted(
                plaintextURL: plaintextBackup,
                encryptedURL: databaseURL
            )
            log("export done; opening encrypted")
            let db = try openEncryptedDatabase(at: databaseURL)
            log("open encrypted OK")
            try? fm.removeItem(at: plaintextBackup)
            for suffix in ["-wal", "-shm"] {
                let sibling = URL(fileURLWithPath: plaintextBackup.path + suffix)
                try? fm.removeItem(at: sibling)
            }
            return db
        } catch {
            log("migration failed: \(error.localizedDescription)")
            // Restore the plaintext file so the next launch can retry.
            if !fm.fileExists(atPath: databaseURL.path),
               fm.fileExists(atPath: plaintextBackup.path) {
                log("restoring backup")
                removeWALSiblings(at: databaseURL)
                try? fm.moveItem(at: plaintextBackup, to: databaseURL)
            }
            throw error
        }
    }

    static func migrateLegacySnapshot(
        from encryptedURL: URL,
        to databaseURL: URL
    ) throws -> OpaquePointer {
        let fm = FileManager.default
        let migrationPlaintext = databaseURL.appendingPathExtension("migration")
        let legacyBackup = encryptedURL.appendingPathExtension("enc.bak")

        do {
            try EncryptedMemoryStore.decryptWorkingFile(
                encryptedURL: encryptedURL,
                workingURL: migrationPlaintext
            )
        } catch {
            throw SQLCipherMemoryStoreError.migrationFailed(
                "legacy decryption: \(error.localizedDescription)"
            )
        }

        do {
            try exportPlaintextToEncrypted(
                plaintextURL: migrationPlaintext,
                encryptedURL: databaseURL
            )
        } catch {
            throw SQLCipherMemoryStoreError.migrationFailed(error.localizedDescription)
        }

        // Best-effort secure wipe of the temporary plaintext file.
        try? EncryptedMemoryStore.securelyRemoveWorkingFile(migrationPlaintext)

        // Move the legacy snapshot to a backup location; it will be deleted after
        // the new encrypted database is verified.
        do {
            if fm.fileExists(atPath: legacyBackup.path) {
                try fm.removeItem(at: legacyBackup)
            }
            try fm.moveItem(at: encryptedURL, to: legacyBackup)
        } catch {
            throw SQLCipherMemoryStoreError.migrationFailed(
                "backup legacy snapshot: \(error.localizedDescription)"
            )
        }

        // Open the newly created encrypted database and confirm it is keyed.
        do {
            let db = try openEncryptedDatabase(at: databaseURL)
            // If we got here the migration is verified by SQLCipher itself.
            try? fm.removeItem(at: legacyBackup)
            return db
        } catch {
            // Restore the legacy snapshot so the next launch can retry.
            try? fm.moveItem(at: legacyBackup, to: encryptedURL)
            throw error
        }
    }

    // MARK: - Private helpers

    private static func exportPlaintextToEncrypted(
        plaintextURL: URL,
        encryptedURL: URL
    ) throws {
        var plaintextDB: OpaquePointer?
        let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        let openResult = sqlite3_open_v2(plaintextURL.path, &plaintextDB, flags, nil)
        guard openResult == SQLITE_OK, let pt = plaintextDB else {
            let message = plaintextDB.flatMap { String(cString: sqlite3_errmsg($0)) }
                ?? "unknown SQLite error"
            _ = plaintextDB.map { sqlite3_close_v2($0) }
            throw SQLCipherMemoryStoreError.migrationFailed(message)
        }

        do {
            let keyHex = try encryption.rawKeyHex()
            let escapedPath = encryptedURL.path.replacingOccurrences(of: "'", with: "''")
            try execute(pt, sql: """
                ATTACH DATABASE '\(escapedPath)' AS encrypted KEY "x'\(keyHex)'"
                """)
            try execute(pt, sql: "SELECT sqlcipher_export('encrypted')")
            try execute(pt, sql: "DETACH DATABASE encrypted")
        } catch {
            sqlite3_close_v2(pt)
            try? FileManager.default.removeItem(at: encryptedURL)
            throw SQLCipherMemoryStoreError.migrationFailed(error.localizedDescription)
        }
        sqlite3_close_v2(pt)
    }

    private static func execute(_ database: OpaquePointer, sql: String) throws {
        var errorPointer: UnsafeMutablePointer<CChar>?
        let result = sqlite3_exec(database, sql, nil, nil, &errorPointer)
        guard result == SQLITE_OK else {
            let message = errorPointer.map { String(cString: $0) }
                ?? String(cString: sqlite3_errmsg(database))
            sqlite3_free(errorPointer)
            throw MemoryStoreError.sqlite(operation: "execute statement", message: message)
        }
    }

    private static func pragmaText(
        _ database: OpaquePointer,
        name: String
    ) throws -> String {
        var statementRef: OpaquePointer?
        let prepareResult = sqlite3_prepare_v2(
            database,
            "PRAGMA \(name)",
            -1,
            &statementRef,
            nil
        )
        guard prepareResult == SQLITE_OK, let stmt = statementRef else {
            throw MemoryStoreError.sqlite(operation: "read pragma \(name)", message: errorMessage(database))
        }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW,
              let text = sqlite3_column_text(stmt, 0) else {
            throw MemoryStoreError.sqlite(operation: "read pragma \(name)", message: errorMessage(database))
        }
        return String(cString: text)
    }

    private static func errorMessage(_ database: OpaquePointer) -> String {
        sqlite3_errmsg(database).map { String(cString: $0) } ?? "unknown SQLite error"
    }
}
