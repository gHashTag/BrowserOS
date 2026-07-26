import Foundation

// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: Cycle 15 keeps only the legacy-decrypt helper for migrating the
// Cycle 12 encrypted snapshot into SQLCipher.
import Foundation

/// Errors raised by legacy encrypted snapshot migration operations.
enum EncryptedMemoryStoreError: LocalizedError {
    case keyUnavailable
    case decryptFailed(String)
    case workingDirectory(String)
    case secureDeleteFailed(String)

    var errorDescription: String? {
        switch self {
        case .keyUnavailable:
            return "MemoryStore encryption key is unavailable"
        case .decryptFailed(let message):
            return "Failed to decrypt memory database: \(message)"
        case .workingDirectory(let message):
            return "Failed to prepare memory working directory: \(message)"
        case .secureDeleteFailed(let message):
            return "Failed to securely remove plaintext migration file: \(message)"
        }
    }
}

/// Helpers for migrating the Cycle 12 encrypted snapshot (`agent-memory.sqlite3.enc`)
/// into the Cycle 15 SQLCipher database. Only decryption and secure cleanup remain;
/// the re-encrypt-on-close snapshot dance has been removed.
enum EncryptedMemoryStore {
    static let encryption = TriOSEncryption.memory

    /// Returns the default legacy Cycle 12 encrypted snapshot URL.
    static func defaultEncryptedURL() -> URL {
        FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )
        .first!
        .appendingPathComponent("Trinity S3AI", isDirectory: true)
        .appendingPathComponent("AgentMemory", isDirectory: true)
        .appendingPathComponent("agent-memory.sqlite3.enc")
    }

    /// Reads the legacy encrypted snapshot and decrypts it to a temporary
    /// plaintext file used by the SQLCipher migration exporter.
    static func decryptWorkingFile(
        encryptedURL: URL,
        workingURL: URL
    ) throws {
        let ciphertext = try Data(contentsOf: encryptedURL)
        let plaintext = try encryption.decrypt(ciphertext)
        try prepareDirectory(at: workingURL)
        try plaintext.write(to: workingURL, options: .atomic)
        try setRestrictedPermissions(workingURL)
    }

    /// Securely removes a temporary plaintext file by overwriting its first 4 KiB
    /// with zeros before unlinking. This is a best-effort wipe; the OS/FS may
    /// still retain snapshots or journal blocks.
    static func securelyRemoveWorkingFile(_ url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        let zeros = Data(repeating: 0, count: 4096)
        if FileManager.default.isWritableFile(atPath: url.path) {
            try? zeros.write(to: url, options: .atomic)
        }
        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            throw EncryptedMemoryStoreError.secureDeleteFailed(error.localizedDescription)
        }
    }

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
            throw EncryptedMemoryStoreError.workingDirectory(error.localizedDescription)
        }
    }

    static func setRestrictedPermissions(_ url: URL) throws {
        let fm = FileManager.default
        do {
            try fm.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: url.path
            )
        } catch {
            throw EncryptedMemoryStoreError.workingDirectory(error.localizedDescription)
        }
    }

    static func excludeFromBackup(_ url: URL) throws {
        var mutable = url
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        try mutable.setResourceValues(resourceValues)
    }
}
