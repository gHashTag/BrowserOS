import CryptoKit
import Foundation
import Security

/// Errors raised by KeychainSymmetricKeyStore.
enum KeychainSymmetricKeyStoreError: LocalizedError {
    case invalidKeyLength(Int)
    case keychainReadFailed(OSStatus)
    case keychainWriteFailed(OSStatus)
    case keychainDeleteFailed(OSStatus)

    var errorDescription: String? {
        switch self {
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
    static func read(keyName: String) throws -> SymmetricKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: keyName,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else {
            if status == errSecItemNotFound {
                return nil
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

        if let existing = try? read(keyName: keyName) {
            try? fm.removeItem(at: fileURL)
            return existing
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
