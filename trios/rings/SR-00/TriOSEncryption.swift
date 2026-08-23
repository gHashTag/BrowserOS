import CryptoKit
import Foundation

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
    private var readInFlight = false
    private var unavailableSince: Date?

    // How long callers were refused before this key first answered.
    //
    // Measured 2026-08-23: the plaintext fallback is TRANSIENT, not resting.
    // Two conversations were written unencrypted at 06:05:17 and 06:05:24;
    // by the 06:05:58 heal pass the store held 55 slots and ZERO plaintext
    // markers. So the exposure is a window at launch, and the question that
    // decides how to close it is exactly one number: how long that window is.
    // Nobody had measured it, so the retry length that would remove the
    // plaintext write entirely could only be guessed. These two fields turn
    // it into a logged fact.
    private var firstRefusalAt: Date?
    private var refusalsSinceLastAnswer = 0

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
        // The key read stays OUTSIDE the catch: `keyUnavailableLocked` is a
        // different fact from "this ciphertext is bad", and collapsing them
        // would tell a user with a locked keychain that their data is
        // corrupted.
        let key = try symmetricKey()
        // CryptoKit's own error was propagated raw, so `.openFailure` was
        // declared in the enum and never thrown - a case that could not
        // happen. Callers switching on TriOSEncryptionError to tell a tampered
        // file from a locked key got neither: they got an opaque CryptoKit
        // error that matched no branch.
        do {
            let sealed = try AES.GCM.SealedBox(combined: combined)
            return try AES.GCM.open(sealed, using: key)
        } catch {
            throw TriOSEncryptionError.openFailure
        }
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

    /// Records that a caller was refused. Call with `lock` HELD.
    ///
    /// Only the FIRST refusal since the last answer starts the clock, because
    /// the number worth knowing is how long the window lasted, not how long
    /// the most recent caller waited.
    private func noteRefusalLocked() {
        if firstRefusalAt == nil { firstRefusalAt = Date() }
        refusalsSinceLastAnswer += 1
    }

    /// Returns the refusal window that just closed, or nil if no caller was
    /// refused since the last answer. Call with `lock` HELD.
    private func consumeRefusalGapLocked() -> (seconds: Double, refusals: Int)? {
        guard let since = firstRefusalAt else { return nil }
        let gap = (Date().timeIntervalSince(since), refusalsSinceLastAnswer)
        firstRefusalAt = nil
        refusalsSinceLastAnswer = 0
        return gap
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

        // At most one keychain read in flight at a time.  In the shipped
        // (non-test) app the keychain read can hang indefinitely; without
        // this guard every cache-miss call dispatches another read that
        // never returns, exhausting the GCD thread pool.
        if readInFlight {
            noteRefusalLocked()
            lock.unlock()
            throw TriOSEncryptionError.keyUnavailable(.readAlreadyInFlight)
        }

        // After a read has timed out the key is effectively unavailable.
        // Stop spawning new reads for a cool-down period so the pool can
        // drain instead of filling with blocked keychain work.
        //
        // The cool-down is OUR refusal, not the Keychain's. Reporting it as a
        // locked key is what put the Queen's transcript on disk in plaintext:
        // the cool-down armed at 02:56:28 and the fallback fired at 02:56:38,
        // while the same item settled successfully 33 seconds later.
        if let unavailableSince {
            let elapsed = Date().timeIntervalSince(unavailableSince)
            if elapsed < TriOSKeyTiming.cooldownSeconds {
                let remaining = Int((TriOSKeyTiming.cooldownSeconds - elapsed).rounded(.up))
                noteRefusalLocked()
                lock.unlock()
                throw TriOSEncryptionError.keyUnavailable(
                    .cooldownArmed(secondsRemaining: remaining)
                )
            }
        }

        unavailableSince = nil
        readInFlight = true
        lock.unlock()

        // Perform the keychain read on a background queue.  The caller
        // waits with a bounded timeout (~2 s).  When the read answers in
        // time the key is cached and returned; when it does not, we throw
        // keyUnavailableLocked and leave the background read running so it
        // can still cache for later callers - but only this one read.
        let semaphore = DispatchSemaphore(value: 0)
        var result: SymmetricKey?
        var refusal: Error?
        var answeredGap: (seconds: Double, refusals: Int)?

        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else {
                semaphore.signal()
                return
            }
            // Keep the error, not just its absence: the thrown value is the
            // one line that says WHY the key was refused, and a `try?` here
            // is how a sub-millisecond launch-gate refusal used to become
            // indistinguishable from a hung securityd.
            var key: SymmetricKey?
            var thrown: Error?
            do {
                key = try self.loadOrCreateSymmetricKey()
            } catch {
                thrown = error
            }
            self.lock.lock()
            if let key {
                if self.cachedKey == nil {
                    self.cachedKey = key
                }
                result = key
                answeredGap = self.consumeRefusalGapLocked()
            } else {
                refusal = thrown
            }
            self.readInFlight = false
            self.lock.unlock()
            if let answeredGap {
                TriosLogBus.shared.info(
                    .security,
                    "encryption.key.answered_after_refusal",
                    String(
                        format: "the %@ encryption key answered %.1fs after the first "
                            + "caller was refused, having refused %d caller(s) in between",
                        self.keyName ?? "file-based",
                        answeredGap.seconds,
                        answeredGap.refusals
                    ),
                    [
                        "key": self.keyName ?? "file-based",
                        "elapsed": String(format: "%.1f", answeredGap.seconds),
                        "refusals": String(answeredGap.refusals),
                    ]
                )
            }
            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + TriOSKeyTiming.readDeadlineSeconds) == .success {
            if let key = result {
                return key
            }
            // The read COMPLETED and refused - a deliberate answer, not a
            // hang.  Measured 2026-08-21: the launch gate refuses in under a
            // millisecond, and arming the stall cool-down here kept
            // conversation encryption refused for 55 seconds after the gate
            // had already lifted, writing the Queen's own transcript to
            // plaintext three times.  The cool-down exists to stop callers
            // piling up behind a hung securityd; a fast refusal is not that
            // condition, so the next caller may retry immediately.
            throw refusal ?? TriOSEncryptionError.keyUnavailable(.storedButUnreadable)
        }

        // Timed out: the background read is still in flight (and may never
        // return).  Record the cool-down timestamp so repeated callers don't
        // pile up blocked reads.  Never mint a replacement key on this path.
        //
        // A deadline is not a verdict. This path says how long it waited and
        // that the read is still running; it does NOT say the key is locked,
        // because it has no way to know that and has twice been wrong.
        lock.lock()
        unavailableSince = Date()
        noteRefusalLocked()
        lock.unlock()
        throw TriOSEncryptionError.keyUnavailable(
            .readTimedOut(afterSeconds: TriOSKeyTiming.readDeadlineSeconds)
        )
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
                //
                // This is the ONE site entitled to say the key is locked: the
                // Keychain was asked and answered that interaction is required.
                throw TriOSEncryptionError.keyUnavailable(.interactionRequired)
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
                throw TriOSEncryptionError.keyUnavailable(.storedButUnreadable)
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
