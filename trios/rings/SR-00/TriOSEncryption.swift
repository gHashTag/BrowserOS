import CryptoKit
import Foundation

/// Errors raised by TriOS at-rest encryption.
enum TriOSEncryptionError: LocalizedError {
    case keyGenerationFailure
    case sealFailure
    case openFailure
    /// A key is stored but cannot be read without user approval. Never treat
    /// this as "no key" - minting a replacement would orphan existing data.
    case keyUnavailableLocked

    var errorDescription: String? {
        switch self {
        case .keyUnavailableLocked:
            return "The encryption key is locked. Approve the Keychain prompt, "
                + "or sign the app with a stable identity so it stops asking."
        case .keyGenerationFailure:
            return "Failed to generate an encryption key"
        case .sealFailure:
            return "Failed to seal data"
        case .openFailure:
            return "Failed to open sealed data (wrong key or tampered ciphertext)"
        }
    }
}

/// Reusable AES-256-GCM encryption for runtime data stored on disk.
///
/// Named keys are stored in the macOS Keychain as generic-password items under
/// service `com.browseros.trios.encryption-key`. Keys are marked
/// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` so they are unavailable when
/// the device is locked and are not included in backups.
///
/// For tests and the legacy `ConversationEncryption` path, a specific key file
/// URL may still be used via `init(keyURL:)`. File-based keys are automatically
/// migrated into the Keychain on first access and then removed.
///
/// Sealed boxes use CryptoKit's combined `nonce || ciphertext || tag` format.
final class TriOSEncryption {
    private let keyURL: URL
    private let keyName: String?
    private let lock = NSLock()
    private var cachedKey: SymmetricKey?

    /// Creates an encryption helper with a fully specified key file URL.
    /// This path is used for direct file-based access and for migrating legacy
    /// keys into the Keychain.
    init(keyURL: URL) {
        self.keyURL = keyURL
        self.keyName = nil
    }

    /// Creates an encryption helper using a named key stored in the macOS
    /// Keychain. The key name becomes the Keychain account value.
    convenience init(keyName: String) {
        let fm = FileManager.default
        let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport
            .appendingPathComponent("trios", isDirectory: true)
            .appendingPathComponent("keys", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("\(keyName).key")
        self.init(keyURL: url, keyName: keyName)
    }

    /// Convenience matching the legacy `ConversationEncryption` key location.
    convenience init(legacyConversationKeyAt appSupport: URL) {
        let dir = appSupport.appendingPathComponent("trios", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: dir,
            withIntermediateDirectories: true
        )
        let url = dir.appendingPathComponent("conversation.key")
        self.init(keyURL: url, keyName: "conversation")
    }

    private init(keyURL: URL, keyName: String) {
        self.keyURL = keyURL
        self.keyName = keyName
    }

    /// Shared named-key instance for persisted chat attachments.
    static let attachments = TriOSEncryption(keyName: "attachments")

    /// Shared named-key instance for the encrypted MemoryStore database snapshot.
    static let memory = TriOSEncryption(keyName: "memory")

    /// Shared named-key instance for hotkey analytics telemetry.
    static let analytics = TriOSEncryption(keyName: "analytics")

    /// Shared named-key instance for encrypted session recovery packages.
    static let recovery = TriOSEncryption(keyName: "recovery")

    /// Encrypts plaintext data. Returns the combined sealed-box bytes.
    func encrypt(_ plaintext: Data) throws -> Data {
        let key = try symmetricKey()
        let sealed = try AES.GCM.seal(plaintext, using: key)
        guard let combined = sealed.combined else {
            throw TriOSEncryptionError.sealFailure
        }
        return combined
    }

    /// Decrypts combined sealed-box bytes back to plaintext.
    func decrypt(_ combined: Data) throws -> Data {
        let key = try symmetricKey()
        let sealed = try AES.GCM.SealedBox(combined: combined)
        return try AES.GCM.open(sealed, using: key)
    }

    /// Returns the raw 256-bit key bytes for use with external crypto layers
    /// such as SQLCipher's raw-key pragma.
    func rawKeyData() throws -> Data {
        let key = try symmetricKey()
        return key.withUnsafeBytes { Data($0) }
    }

    /// Returns the raw key as a 64-character lowercase hexadecimal string.
    func rawKeyHex() throws -> String {
        try rawKeyData().map { String(format: "%02x", $0) }.joined()
    }

    /// Loads an existing 256-bit key from the Keychain, migrating any legacy
    /// file-based key, or creates and persists a new one. The result is cached
    /// in memory so every call within a process returns the same key, avoiding
    /// repeated keychain reads (which can fail in non-UI contexts) and keeping
    /// SQLCipher databases decryptable across the lifetime of the app.
    private func symmetricKey() throws -> SymmetricKey {
        lock.lock()
        if let key = cachedKey {
            lock.unlock()
            return key
        }
        lock.unlock()

        // Always perform the keychain read on a background queue.  The
        // caller waits for it with a bounded timeout (~2 s) instead of
        // refusing on the main thread outright.  When the read answers
        // in time the key is cached and returned exactly as before;
        // when it does not, we throw keyUnavailableLocked and leave the
        // background read running so it still caches for later callers.
        let semaphore = DispatchSemaphore(value: 0)
        var result: SymmetricKey?

        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else {
                semaphore.signal()
                return
            }
            let key = try? self.loadOrCreateSymmetricKey()
            if let key {
                self.lock.lock()
                if self.cachedKey == nil {
                    self.cachedKey = key
                }
                self.lock.unlock()
                result = key
            }
            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + 2.0) == .success, let key = result {
            return key
        }

        // Timed out (or the read threw): the background work is still
        // in flight and will cache the key when it lands.  Never mint a
        // replacement key on this path.
        throw TriOSEncryptionError.keyUnavailableLocked
    }

    private func loadOrCreateSymmetricKey() throws -> SymmetricKey {
        // E2E/test bypass: avoid keychain permission dialogs in non-signed test
        // binaries by using a volatile file-based key instead.
        if ProcessInfo.processInfo.environment["TRIOS_E2E_DISABLE_KEYCHAIN"] == "1" {
            return try loadOrCreateTestKey()
        }

        if let keyName {
            // Non-interactive first. A blocking read here runs during
            // applicationDidFinishLaunching and freezes the whole app behind a
            // password dialog, so never let the launch path put up UI.
            do {
                if let key = try KeychainSymmetricKeyStore.read(
                    keyName: keyName,
                    allowsInteraction: false
                ) {
                    return key
                }
            } catch KeychainSymmetricKeyStoreError.interactionRequired {
                // The key is there, we simply may not read it right now.
                // Falling through would mint a replacement and permanently
                // orphan the existing encrypted database, so stop here instead.
                throw TriOSEncryptionError.keyUnavailableLocked
            }

            if let migrated = try? KeychainSymmetricKeyStore.migrateLegacyKeyIfNeeded(
                keyName: keyName,
                fileURL: keyURL
            ) {
                return migrated
            }

            // Only mint a new key when nothing is stored. `exists` reads
            // attributes only, so this check itself never prompts.
            guard !KeychainSymmetricKeyStore.exists(keyName: keyName) else {
                throw TriOSEncryptionError.keyUnavailableLocked
            }

            let key = SymmetricKey(size: .bits256)
            do {
                try KeychainSymmetricKeyStore.write(keyName: keyName, key: key)
            } catch {
                throw TriOSEncryptionError.keyGenerationFailure
            }
            return key
        }

        // Fallback for direct file-URL initializers (tests / legacy conversation key).
        if let data = try? Data(contentsOf: keyURL),
           data.count == 32 {
            return SymmetricKey(data: data)
        }

        let key = SymmetricKey(size: .bits256)
        let bytes = key.withUnsafeBytes { Data($0) }
        do {
            try bytes.write(to: keyURL, options: .atomic)
            var resourceValues = URLResourceValues()
            resourceValues.isExcludedFromBackup = true
            var mutableURL = keyURL
            try? mutableURL.setResourceValues(resourceValues)
        } catch {
            throw TriOSEncryptionError.keyGenerationFailure
        }
        return key
    }

    /// Returns a volatile 256-bit key stored in a temporary file. Used during
    /// end-to-end tests to avoid keychain permission dialogs from unsigned
    /// test binaries. The key is unique per (keyName, process) and is discarded
    /// when the process exits.
    private func loadOrCreateTestKey() throws -> SymmetricKey {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("trios-e2e-keys", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: tempDir,
            withIntermediateDirectories: true
        )
        let testKeyURL = tempDir.appendingPathComponent(
            "\(keyName ?? "default").key"
        )

        if let data = try? Data(contentsOf: testKeyURL),
           data.count == 32 {
            return SymmetricKey(data: data)
        }

        let key = SymmetricKey(size: .bits256)
        let bytes = key.withUnsafeBytes { Data($0) }
        do {
            try bytes.write(to: testKeyURL, options: .atomic)
            var resourceValues = URLResourceValues()
            resourceValues.isExcludedFromBackup = true
            var mutableURL = testKeyURL
            try? mutableURL.setResourceValues(resourceValues)
        } catch {
            throw TriOSEncryptionError.keyGenerationFailure
        }
        return key
    }
}
