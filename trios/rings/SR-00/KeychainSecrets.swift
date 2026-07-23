import Foundation
import Security

/// Errors raised by KeychainSecrets.
enum KeychainSecretsError: Error {
    case itemNotFound(service: String, account: String)
    case invalidItemType
    case osStatus(OSStatus)
}

/// Minimal Keychain wrapper for storing and retrieving small secrets such as
/// API tokens. Secrets are scoped by (service, account) and stored in the
/// generic-password class. macOS Keychain is the canonical trust boundary for
/// TriOS credentials; env-variable fallbacks are intentionally absent.
enum KeychainSecrets {
    /// Read an existing generic-password secret.
    /// - Parameters:
    ///   - service: Typically a reverse-DNS identifier, e.g. "ai.browseros.trios".
    ///   - account: A short identifier for the credential, e.g. "github-token".
    /// - Returns: The UTF-8 string value stored in the keychain.
    static func read(service: String, account: String) throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseDataProtectionKeychain as String: true,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else {
            if status == errSecItemNotFound {
                throw KeychainSecretsError.itemNotFound(service: service, account: account)
            }
            throw KeychainSecretsError.osStatus(status)
        }
        guard let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            throw KeychainSecretsError.invalidItemType
        }
        return value
    }

    /// Store or overwrite a generic-password secret. Replaces an existing item
    /// with the same (service, account) pair.
    static func write(service: String, account: String, secret: String) throws {
        guard let data = secret.data(using: .utf8) else {
            throw KeychainSecretsError.invalidItemType
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecUseDataProtectionKeychain as String: true,
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update: [String: Any] = [
                kSecValueData as String: data,
            ]
            let updateStatus = SecItemUpdate(
                [
                    kSecClass as String: kSecClassGenericPassword,
                    kSecAttrService as String: service,
                    kSecAttrAccount as String: account,
                ] as CFDictionary,
                update as CFDictionary
            )
            guard updateStatus == errSecSuccess else {
                throw KeychainSecretsError.osStatus(updateStatus)
            }
        } else if status != errSecSuccess {
            throw KeychainSecretsError.osStatus(status)
        }
    }

    /// Delete a stored secret.
    static func delete(service: String, account: String) throws {
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
