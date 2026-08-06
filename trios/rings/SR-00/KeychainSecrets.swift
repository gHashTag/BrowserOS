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
    // TriOSEncryption.symmetricKey(). At most one background read per
    // (service, account) pair is allowed; a read that does not answer within
    // the timeout arms a 60-second cooldown so blocked calls don't pile up.
    private static let readLock = NSLock()
    private static var readsInFlight: Set<String> = []
    private static var readTimeouts: [String: Date] = [:]

    // Bounded-wait machinery for keychain writes, mirroring the read pattern.
    // At most one background write per (service, account) pair is allowed; a
    // write that does not answer within the timeout arms a 60-second cooldown
    // so blocked calls don't pile up.
    private static let writeLock = NSLock()
    private static var writesInFlight: Set<String> = []
    private static var writeTimeouts: [String: Date] = [:]

    private static func readKey(service: String, account: String) -> String {
        "\(service)\u{0}\(account)"
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
    /// arm a 60-second cooldown for that (service, account) pair.
    static func readData(
        service: String,
        account: String,
        allowsInteraction: Bool = true
    ) throws -> Data {
        // Dev builds never touch the Keychain; see DevSecretStore.
        if ProjectPaths.isDevVariant {
            guard let data = DevSecretStore.read(service: service, account: account) else {
                throw KeychainSecretsError.itemNotFound(service: service, account: account)
            }
            return data
        }

        let key = readKey(service: service, account: account)

        // After a timeout, do not start new reads for that pair for 60 seconds.
        // At most one read in flight per (service, account) pair.
        readLock.lock()
        if let timedOutAt = readTimeouts[key],
           Date().timeIntervalSince(timedOutAt) < 60
        {
            readLock.unlock()
            throw KeychainSecretsError.itemNotFound(service: service, account: account)
        }
        if readsInFlight.contains(key) {
            readLock.unlock()
            throw KeychainSecretsError.itemNotFound(service: service, account: account)
        }
        readsInFlight.insert(key)
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

        DispatchQueue.global(qos: .utility).async {
            status = SecItemCopyMatching(query as CFDictionary, &result)
            KeychainSecrets.readLock.lock()
            KeychainSecrets.readsInFlight.remove(key)
            KeychainSecrets.readLock.unlock()
            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + 2.0) == .success {
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
        readLock.lock()
        readTimeouts[key] = Date()
        readLock.unlock()
        throw KeychainSecretsError.itemNotFound(service: service, account: account)
    }

    /// Read an existing generic-password secret as a UTF-8 string.
    static func read(
        service: String,
        account: String,
        allowsInteraction: Bool = true
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

    /// Store or overwrite raw generic-password data. Replaces an existing item
    /// with the same (service, account) pair.
    ///
    /// The `SecItemAdd` / `SecItemUpdate` call runs on a background queue and
    /// the caller waits about two seconds. When the write does not answer in
    /// time we report failure rather than hanging the main thread, and arm a
    /// 60-second cooldown for that (service, account) pair.
    static func writeData(service: String, account: String, data: Data) throws {
        if ProjectPaths.isDevVariant {
            guard DevSecretStore.write(service: service, account: account, data: data) else {
                throw KeychainSecretsError.invalidItemType
            }
            return
        }

        let key = readKey(service: service, account: account)

        // After a timeout, do not start new writes for that pair for 60 seconds.
        // At most one write in flight per (service, account) pair.
        // -4093 == errSecTimeout (not bridged to Swift).
        writeLock.lock()
        if let timedOutAt = writeTimeouts[key],
           Date().timeIntervalSince(timedOutAt) < 60
        {
            writeLock.unlock()
            throw KeychainSecretsError.osStatus(OSStatus(-4093))
        }
        if writesInFlight.contains(key) {
            writeLock.unlock()
            throw KeychainSecretsError.osStatus(OSStatus(-4093))
        }
        writesInFlight.insert(key)
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
            KeychainSecrets.writesInFlight.remove(key)
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
        writeTimeouts[key] = Date()
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
        if ProjectPaths.isDevVariant {
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
