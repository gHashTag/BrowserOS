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

    /// True when the symmetric key can be read right now. A probe, not a
    /// mutation: sealing empty data exercises exactly the key path every
    /// caller uses, so "answers" here means "a save this instant would
    /// encrypt". Used by the heal sweep to wait out a launch-window outage.
    func keyAnswers() -> Bool {
        (try? encryption.encrypt(Data())) != nil
    }

    /// Encrypts plaintext conversation data. Returns the combined sealed-box bytes.
    func encrypt(_ plaintext: Data) throws -> Data {
        do {
            return try encryption.encrypt(plaintext)
        } catch TriOSEncryptionError.keyUnavailable(let refusal) {
            // "The key cannot be read right now" and "sealing failed" are
            // different facts. Collapsing them into sealFailure made every
            // launch-window refusal log as "Failed to seal conversation
            // data" - an encryption failure nobody measured, over a cipher
            // that was never invoked. The refusal travels with the error so
            // the caller can say WHICH of the five conditions it was.
            throw TriOSEncryptionError.keyUnavailable(refusal)
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
        } catch TriOSEncryptionError.keyUnavailable(let refusal) {
            // Same distinction on the read side: a refused key is not
            // "wrong key or tampered ciphertext", and callers that cannot
            // tell them apart quarantine healthy data.
            throw TriOSEncryptionError.keyUnavailable(refusal)
        } catch {
            throw ConversationEncryptionError.openFailure
        }
    }
}
