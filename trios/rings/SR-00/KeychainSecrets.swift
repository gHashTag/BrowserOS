import Foundation
import Security

/// Errors raised by KeychainSecrets.
enum KeychainSecretsError: LocalizedError {
    case itemNotFound(service: String, account: String)
    case invalidItemType
    case osStatus(OSStatus)

    var errorDescription: String? {
        switch self {
        case .itemNotFound(let service, let account):
            return "Keychain item not found for \(service)/\(account)"
        case .invalidItemType:
            return "Keychain item has an invalid value type"
        case .osStatus(let status):
            let message = SecCopyErrorMessageString(status, nil) as String?
            return "macOS Keychain error \(status): \(message ?? "unknown error")"
        }
    }
}

/// Minimal Keychain wrapper for storing and retrieving small secrets such as
/// API tokens. Secrets are scoped by (service, account) and stored in the
/// generic-password class. macOS Keychain is the canonical trust boundary for
/// TriOS credentials; env-variable fallbacks are intentionally absent.
enum KeychainSecrets {
    // Bounded-wait machinery for keychain reads, mirroring the pattern in
    // TriOSEncryption.symmetricKey(). At most one background read is allowed
    // at a time, globally; a read that does not answer within the timeout arms
    // a 60-second cooldown so blocked calls don't pile up.
    private static let readLock = NSLock()
    private static var readInFlight: Bool = false
    /// Cooldowns, keyed by what actually stalled.
    ///
    /// This was one global date, so a single slow item disabled the Keychain
    /// for every other item for a minute - the same "one inattentive caller
    /// blinds the whole process" shape as the interaction default. The
    /// provider key was refused for sixty seconds at a time because something
    /// else had been slow, and the warm-up's 65-second cadence walked straight
    /// back into the next window.
    private static var readUnavailableUntil: [String: Date] = [:]

    private static func cooledDown(_ key: String) -> Bool {
        guard let until = readUnavailableUntil[key] else { return false }
        if Date() < until { return true }
        readUnavailableUntil[key] = nil
        return false
    }

    // Bounded-wait machinery for keychain writes, mirroring the read pattern.
    // At most one background write is allowed at a time, globally; a write
    // that does not answer within the timeout arms a 60-second cooldown so
    // blocked calls don't pile up.
    private static let writeLock = NSLock()
    private static var writeInFlight: Bool = false
    private static var writeUnavailableUntil: Date?

    /// True while the app is still coming up. While raised, every keychain
    /// operation returns immediately without touching the Security framework:
    /// reads throw the ordinary not-found result, writes report failure.
    /// Lowered once by ``clearLaunchGate()`` after bootstrap completes.
    static var isLaunching: Bool = true

    /// Lower the launch gate. After this call keychain operations proceed
    /// normally.
    static func clearLaunchGate() {
        isLaunching = false
    }

    /// Read an existing generic-password secret as raw bytes.
    /// Reads a secret.
    ///
    /// `allowsInteraction: false` makes macOS fail fast with
    /// `errSecInteractionNotAllowed` instead of putting up a "enter your login
    /// keychain password" dialog. Callers that can regenerate the secret should
    /// use it: a re-fetchable token is not worth a modal prompt, and blocking on
    /// one froze the app at launch.
    ///
    /// The `SecItemCopyMatching` call runs on a background queue and the caller
    /// waits about two seconds. When the read does not answer in time we throw
    /// the ordinary not-found result rather than hanging the main thread, and
    /// arm a 60-second cooldown.
    /// `allowsInteraction` defaults to FALSE, and that is the important word.
    ///
    /// It defaulted to true, so every caller that did not think about it could
    /// raise a login-keychain dialog. This app is ad-hoc signed and its items
    /// live in the legacy file keychain, so macOS treats each rebuild as a new
    /// application and the dialog is asked for constantly - with nobody there
    /// to answer it in a background path. The read then blocks on securityd,
    /// hits the two-second deadline, and arms a sixty-second cooldown that
    /// makes every OTHER keychain read answer "nothing there".
    ///
    /// One inattentive caller therefore disabled the Keychain for the whole
    /// process, and the provider key looked absent while sitting in plain view
    /// of `security find-generic-password`. A caller that genuinely wants to
    /// prompt - a settings screen with a person in front of it - says so.
    static func readData(
        service: String,
        account: String,
        allowsInteraction: Bool = false,
        deadline: TimeInterval = 2.0
    ) throws -> Data {
        // Dev builds never touch the Keychain; see DevSecretStore.
        if ProjectPaths.usesFileSecretStore {
            guard let data = DevSecretStore.read(service: service, account: account) else {
                throw KeychainSecretsError.itemNotFound(service: service, account: account)
            }
            return data
        }

        if isLaunching {
            throw KeychainSecretsError.itemNotFound(service: service, account: account)
        }

        // After a timeout, refuse all reads globally for 60 seconds.
        // At most one read in flight at a time.
        readLock.lock()
        if cooledDown("\(service)/\(account)") {
            readLock.unlock()
            throw KeychainSecretsError.itemNotFound(service: service, account: account)
        }
        if readInFlight {
            readLock.unlock()
            // Same reasoning as the enumeration: a collision is not an absence,
            // and throwing `itemNotFound` here told every caller the credential
            // did not exist because another read happened to be in flight.
            guard waitForReadSlot() else {
                throw KeychainSecretsError.itemNotFound(service: service, account: account)
            }
            readLock.lock()
            if readInFlight {
                readLock.unlock()
                throw KeychainSecretsError.itemNotFound(service: service, account: account)
            }
        }
        readInFlight = true
        readLock.unlock()

        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if !allowsInteraction {
            query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUISkip
        }

        // Perform the keychain read on a background queue. The caller waits
        // with a bounded timeout (~2 s). When the read answers in time the
        // data is returned; when it does not, we throw the ordinary not-found
        // result and arm the cooldown.
        let semaphore = DispatchSemaphore(value: 0)
        var result: AnyObject?
        var status: OSStatus = errSecSuccess

        // Measured: how long until the block even STARTS. A saturated global
        // queue looks exactly like a slow Keychain from the caller's side, and
        // the same query from an idle process returns in milliseconds.
        let dispatchedAt = Date()
        DispatchQueue.global(qos: .utility).async {
            let waited = Date().timeIntervalSince(dispatchedAt)
            if waited > 0.2 {
                TriosLogBus.shared.warn(
                    .security, "keychain.queue.starved",
                    "the keychain call waited "
                        + String(format: "%.2f", waited)
                        + "s for a queue slot before it could start",
                    [:]
                )
            }
            status = SecItemCopyMatching(query as CFDictionary, &result)
            KeychainSecrets.readLock.lock()
            KeychainSecrets.readInFlight = false
            KeychainSecrets.readLock.unlock()
            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + deadline) == .success {
            guard status == errSecSuccess else {
                if status == errSecItemNotFound {
                    throw KeychainSecretsError.itemNotFound(service: service, account: account)
                }
                // Treat "we would have to ask the user" as absent, so the
                // caller bootstraps a fresh secret rather than failing.
                if status == errSecInteractionNotAllowed || status == errSecAuthFailed {
                    throw KeychainSecretsError.itemNotFound(service: service, account: account)
                }
                throw KeychainSecretsError.osStatus(status)
            }
            guard let data = result as? Data else {
                throw KeychainSecretsError.invalidItemType
            }
            return data
        }

        // Timed out: the background read is still in flight. Arm the cooldown
        // so repeated callers don't pile up blocked reads, and return the
        // ordinary not-found result rather than hanging the main thread.
        // Release the in-flight flag as well as arming the cooldown.
        //
        // The background block clears it when the call returns - and a read
        // blocked on securityd waiting for an ACL approval nobody can give
        // never returns, so the flag stayed raised for the life of the process.
        // Every later enumeration then answered "another read held the slot",
        // which the store reported as "no entries listed" and the Queen read as
        // "there is no key". One stuck read at launch, and the app never
        // touched the Keychain again.
        //
        // The flag exists to stop callers piling up, not to latch. Worst case
        // the orphaned read finishes later and clears an already-clear flag.
        readLock.lock()
        readUnavailableUntil["\(service)/\(account)"] = Date().addingTimeInterval(60)
        readInFlight = false
        readLock.unlock()
        // Name the read that stalled. The cooldown it arms makes every other
        // keychain read answer "nothing there" for a minute, so the caller that
        // caused it is the only thing worth knowing - and until now the stall
        // was silent, which is why four fixes went in before this one.
        TriosLogBus.shared.warn(
            .security,
            "keychain.read.stalled",
            "\(service) / \(account) did not answer in 2s "
                + "(interaction \(allowsInteraction ? "allowed" : "skipped")); "
                + "every keychain read is refused for 60s",
            ["service": service, "account": account]
        )
        throw KeychainSecretsError.itemNotFound(service: service, account: account)
    }

    /// Read an existing generic-password secret as a UTF-8 string.
    static func read(
        service: String,
        account: String,
        allowsInteraction: Bool = false
    ) throws -> String {
        let data = try readData(
            service: service,
            account: account,
            allowsInteraction: allowsInteraction
        )
        guard let value = String(data: data, encoding: .utf8) else {
            throw KeychainSecretsError.invalidItemType
        }
        return value
    }

    /// List all generic-password items for a service, returning their
    /// attributes without secret data.
    ///
    /// Shares the same read guard as ``readData``: at most one read in
    /// flight globally, a 60-second cooldown after a timeout, empty array
    /// on expiry.
    /// Waits for an in-flight Keychain read to finish, briefly.
    ///
    /// `readInFlight` is a global single-flight lock, and both readers used to
    /// answer "empty" the moment they found it taken. Empty is indistinguishable
    /// from "no such item", so a *collision* was reported as an *absence* - and
    /// this app reads the Keychain from several places at once: the key warm-up,
    /// the timeline token, the issue fetcher and the credential resolve. Whoever
    /// lost the race was told the key did not exist, refused the dispatch, and
    /// left the swarm idle with "store: no entries listed".
    ///
    /// A single-flight lock is supposed to serialise callers, not fail them.
    /// Bounded because the reason all of this is defensive is that a blocking
    /// Keychain read once froze the app at launch: after the deadline the old
    /// behaviour stands.
    /// The wait must outlast the holder's own deadline.
    ///
    /// At 1.5 seconds against a 2-second read deadline the waiter gave up
    /// half a second before the holder was obliged to finish, so it lost every
    /// contested race - and reported the loss as "no entries listed", which the
    /// Queen read as "there is no key" and refused to dispatch. The whole swarm
    /// idled on half a second of arithmetic.
    private static func waitForReadSlot(deadline: TimeInterval = 2.6) -> Bool {
        let limit = Date().addingTimeInterval(deadline)
        while Date() < limit {
            readLock.lock()
            let busy = readInFlight
            readLock.unlock()
            if !busy { return true }
            usleep(25_000)
        }
        readLock.lock()
        let stillBusy = readInFlight
        readLock.unlock()
        return !stillBusy
    }

    /// Why the last enumeration returned nothing. Read by the credential
    /// diagnosis, because "no entries listed" has five different causes and
    /// four of them are not "there are no entries".
    private(set) nonisolated(unsafe) static var lastEnumerationOutcome = "not attempted"

    /// `deadline` is how long the CALLER waits, not how long the Keychain is
    /// given. Two seconds protects an interactive path; a background warm-up
    /// has no responsiveness to protect and must not be told the key does not
    /// exist because securityd took two and a half seconds.
    ///
    /// Measured here: the dispatched block starts immediately - there is no
    /// queue starvation - and `SecItemCopyMatching` itself exceeds two seconds
    /// inside the app, while the identical query from an idle process returns
    /// in milliseconds. The app is ad-hoc signed and these items live in the
    /// legacy file keychain, so its identity does not match the ACL recorded
    /// when they were written.
    static func readAllAttributes(
        service: String,
        deadline: TimeInterval = 2.0
    ) -> [[String: Any]] {
        if isLaunching {
            lastEnumerationOutcome = "refused: still inside the launch gate"
            return []
        }

        readLock.lock()
        if cooledDown("list/\(service)") {
            readLock.unlock()
            lastEnumerationOutcome = "refused: cooldown armed after an earlier stall "
                + "on this service"
            return []
        }
        if readInFlight {
            readLock.unlock()
            // Busy is not absent. Wait for the slot instead of reporting that
            // the item does not exist.
            guard waitForReadSlot() else {
                lastEnumerationOutcome = "refused: another read held the slot"
                return []
            }
            readLock.lock()
            if readInFlight {
                readLock.unlock()
                return []
            }
        }
        readInFlight = true
        readLock.unlock()

        // Attributes only, and never a dialog.
        //
        // These items live in the legacy file keychain, where the ACL names the
        // application that created them - and this app is ad-hoc signed, so a
        // rebuilt binary is a different application to macOS. Without the skip,
        // the enumeration blocks on securityd waiting for an approval nobody is
        // there to give, hits the two-second deadline, arms the sixty-second
        // cooldown, and returns empty. The warm-up then retries every 65
        // seconds - straight back into the same trap.
        //
        // Reported to the caller as "no entries listed", which is why the swarm
        // sat idle claiming the key did not exist while `security
        // find-generic-password` found it from a terminal in one go.
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip
        ]

        let semaphore = DispatchSemaphore(value: 0)
        var result: CFTypeRef?
        var status: OSStatus = errSecSuccess

        // Measured: how long until the block even STARTS. A saturated global
        // queue looks exactly like a slow Keychain from the caller's side, and
        // the same query from an idle process returns in milliseconds.
        let dispatchedAt = Date()
        DispatchQueue.global(qos: .utility).async {
            let waited = Date().timeIntervalSince(dispatchedAt)
            if waited > 0.2 {
                TriosLogBus.shared.warn(
                    .security, "keychain.queue.starved",
                    "the keychain call waited "
                        + String(format: "%.2f", waited)
                        + "s for a queue slot before it could start",
                    [:]
                )
            }
            status = SecItemCopyMatching(query as CFDictionary, &result)
            KeychainSecrets.readLock.lock()
            KeychainSecrets.readInFlight = false
            KeychainSecrets.readLock.unlock()
            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + deadline) == .success {
            guard status == errSecSuccess else {
                lastEnumerationOutcome = "SecItemCopyMatching returned \(status)"
                return []
            }
            guard let items = result as? [[String: Any]] else {
                lastEnumerationOutcome = "the result could not be read as attributes"
                return []
            }
            lastEnumerationOutcome = "\(items.count) item(s)"
            return items
        }

        readLock.lock()
        readUnavailableUntil["list/\(service)"] = Date().addingTimeInterval(60)
        readInFlight = false
        readLock.unlock()
        lastEnumerationOutcome = "timed out; cooldown armed for 60s on this service"
        TriosLogBus.shared.warn(
            .security,
            "keychain.enumeration.stalled",
            "listing \(service) did not answer in 2s; every keychain read is "
                + "refused for 60s",
            ["service": service]
        )
        return []
    }

    /// Store or overwrite raw generic-password data. Replaces an existing item
    /// with the same (service, account) pair.
    ///
    /// The `SecItemAdd` / `SecItemUpdate` call runs on a background queue and
    /// the caller waits about two seconds. When the write does not answer in
    /// time we report failure rather than hanging the main thread, and arm a
    /// 60-second cooldown.
    static func writeData(service: String, account: String, data: Data) throws {
        if ProjectPaths.usesFileSecretStore {
            guard DevSecretStore.write(service: service, account: account, data: data) else {
                throw KeychainSecretsError.invalidItemType
            }
            return
        }

        if isLaunching {
            throw KeychainSecretsError.osStatus(OSStatus(-4093))
        }

        // After a timeout, refuse all writes globally for 60 seconds.
        // At most one write in flight at a time.
        // -4093 == errSecTimeout (not bridged to Swift).
        writeLock.lock()
        if let until = writeUnavailableUntil,
           Date() < until
        {
            writeLock.unlock()
            throw KeychainSecretsError.osStatus(OSStatus(-4093))
        }
        if writeInFlight {
            writeLock.unlock()
            throw KeychainSecretsError.osStatus(OSStatus(-4093))
        }
        writeInFlight = true
        writeLock.unlock()

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String:
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data,
        ]

        // Perform the keychain write on a background queue. The caller waits
        // with a bounded timeout (~2 s). When the write answers in time the
        // status is checked normally; when it does not, we report failure and
        // arm the cooldown.
        let semaphore = DispatchSemaphore(value: 0)
        var status: OSStatus = errSecSuccess

        DispatchQueue.global(qos: .utility).async {
            let addStatus = SecItemAdd(query as CFDictionary, nil)
            if addStatus == errSecDuplicateItem {
                let update: [String: Any] = [
                    kSecValueData as String: data,
                ]
                status = SecItemUpdate(
                    [
                        kSecClass as String: kSecClassGenericPassword,
                        kSecAttrService as String: service,
                        kSecAttrAccount as String: account,
                    ] as CFDictionary,
                    update as CFDictionary
                )
            } else {
                status = addStatus
            }
            KeychainSecrets.writeLock.lock()
            KeychainSecrets.writeInFlight = false
            KeychainSecrets.writeLock.unlock()
            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + 2.0) == .success {
            if status == errSecSuccess {
                return
            }
            throw KeychainSecretsError.osStatus(status)
        }

        // Timed out: the background write is still in flight. Arm the cooldown
        // so repeated callers don't pile up blocked writes, and report failure
        // rather than hanging the main thread.
        writeLock.lock()
        writeUnavailableUntil = Date().addingTimeInterval(60)
        writeLock.unlock()
        throw KeychainSecretsError.osStatus(OSStatus(-4093))
    }

    /// Store or overwrite a generic-password secret string.
    static func write(service: String, account: String, secret: String) throws {
        guard let data = secret.data(using: .utf8) else {
            throw KeychainSecretsError.invalidItemType
        }
        try writeData(service: service, account: account, data: data)
    }

    /// Delete a stored secret.
    static func delete(service: String, account: String) throws {
        if ProjectPaths.usesFileSecretStore {
            DevSecretStore.delete(service: service, account: account)
            return
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainSecretsError.osStatus(status)
        }
    }
}
