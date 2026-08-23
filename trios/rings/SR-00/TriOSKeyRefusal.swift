import Foundation

/// The two numbers the key-read path enforces, in one place so a refusal can
/// report the deadline the code actually waited instead of a literal copied
/// into a sentence. `key_refusal_test` asserts the pair.
enum TriOSKeyTiming {
    /// How long a caller waits for the Keychain before giving up.
    static let readDeadlineSeconds: Double = 2.0
    /// How long new reads are refused after one has timed out.
    static let cooldownSeconds: Double = 60
}

/// Why a key read produced no key.
///
/// One case per condition the refusing code actually measured. The old single
/// `keyUnavailableLocked` said "The encryption key is locked. Approve the
/// Keychain prompt" at all five throw sites, and four of the five had measured
/// something else entirely: two of them had not asked the Keychain at all.
/// Measured on 2026-08-23 in the release log - two reads refused as "locked"
/// settled with OSStatus 0 after 40.7s and 37.7s, so the key was never locked,
/// only slow, and the Queen's transcript was written to plaintext on the
/// strength of that sentence.
enum TriOSKeyRefusal: Equatable, Sendable {
    /// A read of this key is already in flight and a second was refused, so
    /// blocked reads cannot pile up. The Keychain was not asked.
    case readAlreadyInFlight
    /// TriOS refused this read itself: a cool-down armed by an earlier timeout
    /// is still running. The Keychain was not asked.
    case cooldownArmed(secondsRemaining: Int)
    /// The Keychain was asked and had not answered by the caller's deadline.
    /// The read is still in flight and may still settle.
    case readTimedOut(afterSeconds: Double)
    /// The Keychain answered and said interaction is required. This is the one
    /// case in which the key is genuinely locked.
    case interactionRequired
    /// A key item exists, but a non-interactive read returned nothing. Minting
    /// a replacement here would orphan every existing encrypted record.
    case storedButUnreadable

    /// True only when the Keychain itself was consulted. Two of these refusals
    /// never reach it, and a caller that reports "the Keychain refused" for
    /// them is naming a subsystem it did not call.
    var keychainWasAsked: Bool {
        switch self {
        case .readAlreadyInFlight, .cooldownArmed:
            return false
        case .readTimedOut, .interactionRequired, .storedButUnreadable:
            return true
        }
    }

    /// A short tag suitable for a log attribute, so a reader can histogram the
    /// refusals instead of reading five sentences.
    var tag: String {
        switch self {
        case .readAlreadyInFlight: return "read_already_in_flight"
        case .cooldownArmed: return "cooldown_armed"
        case .readTimedOut: return "read_timed_out"
        case .interactionRequired: return "interaction_required"
        case .storedButUnreadable: return "stored_but_unreadable"
        }
    }

    var explanation: String {
        switch self {
        case .readAlreadyInFlight:
            return "another read of the encryption key is already in flight, so "
                + "this one was refused to keep blocked reads from piling up; "
                + "the Keychain was not asked"
        case let .cooldownArmed(remaining):
            return "TriOS refused this read itself - a cool-down armed after an "
                + "earlier read timed out has \(remaining)s left to run; "
                + "the Keychain was not asked"
        case let .readTimedOut(seconds):
            return String(
                format: "the Keychain had not answered %.1fs after it was asked; "
                    + "the read is still in flight and may still settle, so this "
                    + "is a deadline, not a verdict about the key",
                seconds
            )
        case .interactionRequired:
            return "the encryption key is locked. Approve the Keychain prompt, "
                + "or sign the app with a stable identity so it stops asking"
        case .storedButUnreadable:
            return "an encryption key is stored but a non-interactive read "
                + "returned nothing; TriOS will not mint a replacement, which "
                + "would orphan every existing encrypted record"
        }
    }
}

/// Errors raised by TriOS at-rest encryption.
enum TriOSEncryptionError: LocalizedError {
    case keyGenerationFailure
    case sealFailure
    case openFailure
    /// No key was produced. The payload says which condition was measured -
    /// never treat any of them as "no key", because minting a replacement
    /// would orphan existing data.
    case keyUnavailable(TriOSKeyRefusal)

    var errorDescription: String? {
        switch self {
        case let .keyUnavailable(refusal):
            return "The encryption key was not read: \(refusal.explanation)."
        case .keyGenerationFailure:
            return "Failed to generate an encryption key"
        case .sealFailure:
            return "Failed to seal data"
        case .openFailure:
            return "Failed to open sealed data (wrong key or tampered ciphertext)"
        }
    }

    /// The measured refusal, when this error carries one.
    var keyRefusal: TriOSKeyRefusal? {
        if case let .keyUnavailable(refusal) = self { return refusal }
        return nil
    }
}
