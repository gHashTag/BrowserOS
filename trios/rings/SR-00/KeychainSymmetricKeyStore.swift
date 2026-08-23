import CryptoKit
import Foundation
import Security

/// Errors raised by KeychainSymmetricKeyStore.
enum KeychainSymmetricKeyStoreError: LocalizedError {
    case invalidKeyLength(Int)
    case keychainReadFailed(OSStatus)
    case keychainWriteFailed(OSStatus)
    case keychainDeleteFailed(OSStatus)
    /// The key exists but reading it would require showing a password prompt.
    case interactionRequired
    /// TriOS's own launch gate refused the read. The Keychain was never asked
    /// for the secret.
    ///
    /// This used to be a bare `nil` return, indistinguishable from "the item is
    /// not there". The caller then checked `exists()` - which DOES ask the
    /// Keychain, and answers yes - and concluded "stored but unreadable". So a
    /// gate TriOS closed itself was reported as a completed Keychain read that
    /// returned nothing. Measured 2026-08-23T07:06: 55 such reports in one
    /// launch window, none of which reached securityd.
    case launchGateClosed

    var errorDescription: String? {
        switch self {
        case .interactionRequired:
            return "The encryption key exists but the Keychain needs your permission to read it."
        case .launchGateClosed:
            return "TriOS's launch gate refused this key read; the Keychain was not asked."
        case .invalidKeyLength(let length):
            return "Invalid symmetric key length: \(length) bytes (expected 32)"
        case .keychainReadFailed(let status):
            let message = SecCopyErrorMessageString(status, nil) as String?
            return "Keychain read failed: \(status) — \(message ?? "unknown error")"
        case .keychainWriteFailed(let status):
            let message = SecCopyErrorMessageString(status, nil) as String?
            return "Keychain write failed: \(status) — \(message ?? "unknown error")"
        case .keychainDeleteFailed(let status):
            let message = SecCopyErrorMessageString(status, nil) as String?
            return "Keychain delete failed: \(status) — \(message ?? "unknown error")"
        }
    }
}

/// Stores 256-bit symmetric keys in the macOS Keychain as generic-password items.
///
/// Each key is scoped by (service, account) where `account` is the key name.
/// Items use `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` so they are not
/// included in backups and are unavailable when the device is locked.
enum KeychainSymmetricKeyStore {
    private static let service = "com.browseros.trios.encryption-key"
    private static let accessibility = kSecAttrAccessibleWhenUnlockedThisDeviceOnly

    /// Reads a 256-bit symmetric key from the Keychain. Throws if the stored
    /// value is not exactly 32 bytes.
    /// True when an item exists for this key name.
    ///
    /// Asks for attributes only, never the data, so macOS answers from metadata
    /// and never shows a password prompt. That distinction matters: "missing" is
    /// safe to replace with a fresh key, "present but locked" is not.
    static func exists(keyName: String) -> Bool {
        if ProjectPaths.usesFileSecretStore {
            return DevSecretStore.read(service: service, account: keyName) != nil
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: keyName,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        return SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess
    }

    /// Reads a 256-bit symmetric key. Throws if the stored value is not exactly
    /// 32 bytes.
    ///
    /// With `allowsInteraction: false` the read never blocks: macOS returns
    /// `errSecInteractionNotAllowed` instead of putting up a password dialog.
    /// The app launches through this path, because a blocking read here freezes
    /// `applicationDidFinishLaunching` until the user answers - which is exactly
    /// how the app came to show "Application Not Responding" with no window.
    /// `allowsInteraction` defaults to FALSE, matching `KeychainSecrets`.
    ///
    /// The same reasoning and the same symptom: a background path that raises
    /// a login-keychain dialog asks a question nobody is positioned to answer,
    /// and on this machine the operator was being asked repeatedly while the
    /// night's work stood still. A caller with a person in front of it says so.
    static func read(keyName: String, allowsInteraction: Bool = false) throws -> SymmetricKey? {
        if ProjectPaths.usesFileSecretStore {
            guard let data = DevSecretStore.read(service: service, account: keyName) else {
                return nil
            }
            guard data.count == 32 else {
                throw KeychainSymmetricKeyStoreError.invalidKeyLength(data.count)
            }
            return SymmetricKey(data: data)
        }
        // Returning nil here made a closed gate look like a missing item, and
        // the caller's next step - exists() - DOES reach the Keychain and says
        // the item is there. Two facts from two different sources became one
        // false sentence: "stored but unreadable". Throw instead, so the reason
        // travels with the refusal.
        if KeychainSecrets.isLaunching {
            throw KeychainSymmetricKeyStoreError.launchGateClosed
        }
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: keyName,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if !allowsInteraction {
            query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUISkip
        }

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else {
            if status == errSecItemNotFound {
                return nil
            }
            if status == errSecInteractionNotAllowed || status == errSecAuthFailed {
                throw KeychainSymmetricKeyStoreError.interactionRequired
            }
            throw KeychainSymmetricKeyStoreError.keychainReadFailed(status)
        }

        guard let data = result as? Data else {
            throw KeychainSymmetricKeyStoreError.invalidKeyLength(0)
        }
        guard data.count == 32 else {
            throw KeychainSymmetricKeyStoreError.invalidKeyLength(data.count)
        }
        return SymmetricKey(data: data)
    }

    /// Stores a 256-bit symmetric key in the Keychain, replacing any existing
    /// item with the same key name.
    static func write(keyName: String, key: SymmetricKey) throws {
        let bytes = key.withUnsafeBytes { Data($0) }
        guard bytes.count == 32 else {
            throw KeychainSymmetricKeyStoreError.invalidKeyLength(bytes.count)
        }

        if ProjectPaths.usesFileSecretStore {
            guard DevSecretStore.write(service: service, account: keyName, data: bytes) else {
                throw KeychainSymmetricKeyStoreError.keychainWriteFailed(errSecIO)
            }
            return
        }

        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: keyName,
            kSecAttrAccessible as String: accessibility,
            kSecValueData as String: bytes,
        ]

        let status = SecItemAdd(addQuery as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let updateQuery: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: keyName,
            ]
            let update: [String: Any] = [
                kSecValueData as String: bytes,
            ]
            let updateStatus = SecItemUpdate(
                updateQuery as CFDictionary,
                update as CFDictionary
            )
            guard updateStatus == errSecSuccess else {
                throw KeychainSymmetricKeyStoreError.keychainWriteFailed(updateStatus)
            }
        } else if status != errSecSuccess {
            throw KeychainSymmetricKeyStoreError.keychainWriteFailed(status)
        }
    }

    /// Deletes a stored key.
    static func delete(keyName: String) throws {
        if ProjectPaths.usesFileSecretStore {
            DevSecretStore.delete(service: service, account: keyName)
            return
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: keyName,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainSymmetricKeyStoreError.keychainDeleteFailed(status)
        }
    }

    /// If a legacy file-based key exists at the given URL, reads it, stores it
    /// in the Keychain, and deletes the legacy file. Returns the migrated key
    /// or `nil` if no legacy file exists. The Keychain is always the source of
    /// truth: if a Keychain item already exists, the legacy file is ignored and
    /// deleted without overwriting the Keychain value.
    static func migrateLegacyKeyIfNeeded(
        keyName: String,
        fileURL: URL
    ) throws -> SymmetricKey? {
        let fm = FileManager.default
        guard fm.fileExists(atPath: fileURL.path) else { return nil }

        // Non-interactive: migration runs on the launch path, and an interactive
        // read here puts a password dialog in front of a half-started app.
        if let existing = try? read(keyName: keyName, allowsInteraction: false) {
            try? fm.removeItem(at: fileURL)
            return existing
        }
        // A locked-but-present key must not be replaced by the legacy file.
        if exists(keyName: keyName) {
            throw KeychainSymmetricKeyStoreError.interactionRequired
        }

        let data = try Data(contentsOf: fileURL)
        guard data.count == 32 else {
            try? fm.removeItem(at: fileURL)
            return nil
        }
        let key = SymmetricKey(data: data)
        try write(keyName: keyName, key: key)
        try? fm.removeItem(at: fileURL)
        return key
    }
}
