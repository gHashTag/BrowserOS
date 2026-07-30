import Foundation

/// A persisted snapshot of one candidate's rolling outcome window.
struct WarmupVolatilityRecord: Codable, Sendable, Equatable {
    static let currentVersion = 2

    let version: Int
    /// `true` for success, `false` for failure; ordered newest-first so the tail
    /// is dropped when the window is bounded. Kept for backward decoding only.
    let outcomes: [Bool]?
    /// Number of successes in the window. If missing, falls back to counting
    /// `true` values in `outcomes`.
    let successes: Int?
    /// Number of failures in the window. If missing, falls back to counting
    /// `false` values in `outcomes`.
    let failures: Int?
    /// Count of failures per `ProviderCircuitBreakerFailureKind` raw value.
    /// If missing or incomplete, missing failures are treated as `.unknown`.
    let failureKinds: [String: Int]?
    /// The window size the snapshot was recorded with. If the live tracker uses a
    /// different size, the snapshot is discarded to avoid a mismatched signal.
    let windowSize: Int
    let updatedAt: Date

    init(
        outcomes: [Bool]? = nil,
        successes: Int? = nil,
        failures: Int? = nil,
        failureKinds: [String: Int]? = nil,
        windowSize: Int,
        updatedAt: Date = Date()
    ) {
        self.version = Self.currentVersion
        self.outcomes = outcomes
        self.successes = successes
        self.failures = failures
        self.failureKinds = failureKinds
        self.windowSize = windowSize
        self.updatedAt = updatedAt
    }

    init(
        successes: Int,
        failures: Int,
        failureKinds: [ProviderCircuitBreakerFailureKind: Int],
        windowSize: Int,
        updatedAt: Date = Date()
    ) {
        self.version = Self.currentVersion
        self.outcomes = nil
        self.successes = successes
        self.failures = failures
        self.failureKinds = failureKinds.reduce(into: [:]) { $0[$1.key.rawValue] = $1.value }
        self.windowSize = windowSize
        self.updatedAt = updatedAt
    }
}

/// Persists `WarmupVolatilityTracker` windows to an encrypted JSON file so
/// adaptive warmup TTL/interval decisions survive app restarts.
///
/// The file is encrypted with `TriOSEncryption(keyName: "warmup-volatility")`
/// and stored alongside the encrypted `MemoryStore` database under
/// `~/Library/Application Support/Trinity S3AI/AgentMemory/`.
actor VolatilityHistoryStore: Sendable {
    private let encryption: TriOSEncryption
    private let fileURL: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(
        encryption: TriOSEncryption = TriOSEncryption(keyName: "warmup-volatility"),
        fileURL: URL = VolatilityHistoryStore.defaultFileURL()
    ) {
        self.encryption = encryption
        self.fileURL = fileURL
        self.encoder = JSONEncoder()
        self.encoder.outputFormatting = .prettyPrinted
        self.encoder.dateEncodingStrategy = .iso8601
        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .iso8601

        let directory = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [FileAttributeKey.posixPermissions: 0o700]
        )
    }

    /// Returns the canonical encrypted file URL.
    static func defaultFileURL() -> URL {
        FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )
        .first!
        .appendingPathComponent("Trinity S3AI", isDirectory: true)
        .appendingPathComponent("AgentMemory", isDirectory: true)
        .appendingPathComponent("warmup-volatility.json.enc")
    }

    /// Loads the persisted dictionary keyed by stable candidate key, or `nil`
    /// when no snapshot exists or the snapshot cannot be parsed.
    func load() async -> [String: WarmupVolatilityRecord]? {
        let fm = FileManager.default
        guard fm.fileExists(atPath: fileURL.path) else { return nil }

        do {
            let encrypted = try Data(contentsOf: fileURL)
            let plaintext = try encryption.decrypt(encrypted)
            let records = try decoder.decode([String: WarmupVolatilityRecord].self, from: plaintext)
            return records
        } catch {
            NSLog("[VolatilityHistoryStore] Load failed: %@", error.localizedDescription)
            return nil
        }
    }

    /// Atomically replaces the persisted snapshot with the given records.
    func save(_ records: [String: WarmupVolatilityRecord]) async {
        do {
            let plaintext = try encoder.encode(records)
            let encrypted = try encryption.encrypt(plaintext)
            try encrypted.write(to: fileURL, options: [.atomic])
        } catch {
            NSLog("[VolatilityHistoryStore] Save failed: %@", error.localizedDescription)
        }
    }

    /// Deletes the persisted snapshot, if any.
    func reset() async {
        do {
            try FileManager.default.removeItem(at: fileURL)
        } catch {
            // Ignore missing-file errors.
            let nsError = error as NSError
            if nsError.domain != NSCocoaErrorDomain || nsError.code != NSFileNoSuchFileError {
                NSLog("[VolatilityHistoryStore] Reset failed: %@", error.localizedDescription)
            }
        }
    }
}
