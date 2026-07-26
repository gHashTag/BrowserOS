import Foundation
import CryptoKit

/// Errors raised by conversation encryption at rest.
enum ConversationEncryptionError: LocalizedError {
    case keyGenerationFailure
    case sealFailure
    case openFailure

    var errorDescription: String? {
        switch self {
        case .keyGenerationFailure:
            return "Failed to generate a conversation encryption key"
        case .sealFailure:
            return "Failed to seal conversation data"
        case .openFailure:
            return "Failed to open conversation data (wrong key or tampered ciphertext)"
        }
    }
}

/// Manages the per-device symmetric key used to encrypt conversation payloads
/// stored in `UserDefaults`.
///
/// This type is preserved for source compatibility; it now delegates to
/// `TriOSEncryption` while keeping the legacy key location at
/// `Application Support/trios/conversation.key` so existing installations keep
/// their conversation history decryptable after the upgrade.
final class ConversationEncryption {
    static let shared = ConversationEncryption()

    private let encryption: TriOSEncryption

    private init() {
        let fm = FileManager.default
        let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        self.encryption = TriOSEncryption(legacyConversationKeyAt: appSupport)
    }

    /// Encrypts plaintext conversation data. Returns the combined sealed-box bytes.
    func encrypt(_ plaintext: Data) throws -> Data {
        do {
            return try encryption.encrypt(plaintext)
        } catch is TriOSEncryptionError {
            throw ConversationEncryptionError.sealFailure
        } catch {
            throw ConversationEncryptionError.keyGenerationFailure
        }
    }

    /// Decrypts combined sealed-box bytes back to plaintext.
    func decrypt(_ combined: Data) throws -> Data {
        do {
            return try encryption.decrypt(combined)
        } catch is TriOSEncryptionError {
            throw ConversationEncryptionError.openFailure
        } catch {
            throw ConversationEncryptionError.openFailure
        }
    }
}
