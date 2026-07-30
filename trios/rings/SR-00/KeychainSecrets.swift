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
    /// Read an existing generic-password secret as raw bytes.
    /// Reads a secret.
    ///
    /// `allowsInteraction: false` makes macOS fail fast with
    /// `errSecInteractionNotAllowed` instead of putting up a "enter your login
    /// keychain password" dialog. Callers that can regenerate the secret should
    /// use it: a re-fetchable token is not worth a modal prompt, and blocking on
    /// one froze the app at launch.
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

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else {
            if status == errSecItemNotFound {
                throw KeychainSecretsError.itemNotFound(service: service, account: account)
            }
            // Treat "we would have to ask the user" as absent, so the caller
            // bootstraps a fresh secret rather than failing the request.
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
    static func writeData(service: String, account: String, data: Data) throws {
        if ProjectPaths.isDevVariant {
            guard DevSecretStore.write(service: service, account: account, data: data) else {
                throw KeychainSecretsError.invalidItemType
            }
            return
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String:
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data,
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
