// Standalone unit tests for TriOSKeyRefusal - Foundation only.
//
// Run (from trios root):
//   swiftc tests/swift/key_refusal_test.swift rings/SR-00/TriOSKeyRefusal.swift \
//     -o /tmp/trios_key_refusal_test && /tmp/trios_key_refusal_test
//
// Why this suite exists.
//
// Until 2026-08-23 every failed key read threw one case, and that case said:
//
//     "The encryption key is locked. Approve the Keychain prompt, or sign the
//      app with a stable identity so it stops asking."
//
// Five call sites threw it. Four of them had measured something else, and two
// of those four had never contacted the Keychain at all - they were refused by
// TriOS's own in-flight guard and its own 60-second cool-down. The release log
// for 2026-08-23T02:56 shows what that cost: the cool-down armed at 02:56:28,
// the Queen's conversation was written to disk as PLAINTEXT at 02:56:38 on the
// strength of "the key is locked", and the very same Keychain items settled
// with OSStatus 0 at 02:57:01 and 02:57:06. The key was never locked. It was
// slow, and we blamed the user for it.
//
// These checks exist so that sentence cannot be attached to a condition that
// did not measure it.

import Foundation

@main
enum KeyRefusalTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static func main() {
        onlyOneRefusalMayClaimTheKeyIsLocked()
        refusalsThatNeverAskedSaySo()
        theCooldownNamesItselfAndItsRemainder()
        theDeadlineIsNotAVerdict()
        everyRefusalHasADistinctTag()
        theErrorCarriesTheRefusalToItsCaller()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All KeyRefusal tests passed.")
    }

    static let all: [TriOSKeyRefusal] = [
        .readAlreadyInFlight,
        .cooldownArmed(secondsRemaining: 42),
        .readTimedOut(afterSeconds: 2.0),
        .interactionRequired,
        .storedButUnreadable,
    ]

    /// The guard this file exists for.
    static func onlyOneRefusalMayClaimTheKeyIsLocked() {
        scenario("only a Keychain answer of interactionRequired may say 'locked'")

        for refusal in all {
            let saysLocked = refusal.explanation.lowercased().contains("is locked")
            let maySayLocked = (refusal == .interactionRequired)
            check(
                saysLocked == maySayLocked,
                "\(refusal.tag): says 'is locked' == \(maySayLocked)"
            )
        }

        check(
            TriOSKeyRefusal.interactionRequired.explanation
                .contains("Approve the Keychain prompt"),
            "the one true locked case still tells the operator what to do about it"
        )

        for refusal in all where refusal != .interactionRequired {
            check(
                !refusal.explanation.contains("Approve the Keychain prompt"),
                "\(refusal.tag) does not send the operator to a prompt that will not appear"
            )
        }
    }

    /// Two of the five never reach securityd. A message that blames the
    /// Keychain for them names a subsystem the function never called - the
    /// third tell in the unmeasured-cause skill.
    static func refusalsThatNeverAskedSaySo() {
        scenario("a refusal that never asked the Keychain admits it")

        check(
            TriOSKeyRefusal.readAlreadyInFlight.keychainWasAsked == false,
            "readAlreadyInFlight did not ask the Keychain"
        )
        check(
            TriOSKeyRefusal.cooldownArmed(secondsRemaining: 1).keychainWasAsked == false,
            "cooldownArmed did not ask the Keychain"
        )
        check(
            TriOSKeyRefusal.interactionRequired.keychainWasAsked,
            "interactionRequired is an answer FROM the Keychain"
        )
        check(
            TriOSKeyRefusal.readTimedOut(afterSeconds: 2).keychainWasAsked,
            "readTimedOut asked the Keychain and is still waiting"
        )
        check(
            TriOSKeyRefusal.storedButUnreadable.keychainWasAsked,
            "storedButUnreadable read the item's attributes"
        )

        for refusal in all where !refusal.keychainWasAsked {
            check(
                refusal.explanation.contains("the Keychain was not asked"),
                "\(refusal.tag) states plainly that the Keychain was not asked"
            )
        }
    }

    static func theCooldownNamesItselfAndItsRemainder() {
        scenario("the cool-down is reported as ours, with its remaining time")

        let text = TriOSKeyRefusal.cooldownArmed(secondsRemaining: 37).explanation
        check(text.contains("TriOS refused this read itself"), "the cool-down names its author")
        check(text.contains("37s"), "the cool-down reports how long it still has to run")

        // A reader must be able to tell two cool-downs apart. A constant string
        // is the first tell in the skill.
        check(
            TriOSKeyRefusal.cooldownArmed(secondsRemaining: 1).explanation
                != TriOSKeyRefusal.cooldownArmed(secondsRemaining: 59).explanation,
            "two cool-downs with different remainders do not print the same sentence"
        )
    }

    static func theDeadlineIsNotAVerdict() {
        scenario("a timed-out read reports a deadline, not a conclusion")

        let text = TriOSKeyRefusal.readTimedOut(afterSeconds: 2.0).explanation
        check(text.contains("2.0s"), "the timeout says how long it waited")
        check(
            text.contains("still in flight") && text.contains("may still settle"),
            "the timeout says the read may still succeed - twice it did, at 40.7s and 37.7s"
        )
        check(
            text.contains("not a verdict"),
            "the timeout refuses to draw a conclusion about the key"
        )
        check(
            TriOSKeyTiming.readDeadlineSeconds == 2.0,
            "the deadline the code waits is the deadline the message reports"
        )
        check(
            TriOSKeyTiming.cooldownSeconds == 60,
            "the cool-down the code enforces is the one the remainder is computed against"
        )
    }

    static func everyRefusalHasADistinctTag() {
        scenario("refusals can be histogrammed, not just read")

        let tags = all.map(\.tag)
        check(Set(tags).count == tags.count, "every refusal has a distinct tag")
        for tag in tags {
            check(
                !tag.isEmpty && tag == tag.lowercased()
                    && !tag.contains(" "),
                "tag '\(tag)' is a lowercase log-safe token"
            )
        }
    }

    /// The persister decides whether to write plaintext. It can only attribute
    /// that decision if the refusal survives the throw.
    static func theErrorCarriesTheRefusalToItsCaller() {
        scenario("the measured refusal reaches the caller that writes plaintext")

        for refusal in all {
            let error = TriOSEncryptionError.keyUnavailable(refusal)
            check(error.keyRefusal == refusal, "keyUnavailable(\(refusal.tag)) round-trips")
            check(
                error.errorDescription?.contains(refusal.explanation) == true,
                "\(refusal.tag)'s description carries its own explanation"
            )
        }

        check(
            TriOSEncryptionError.sealFailure.keyRefusal == nil,
            "an error that is not a key refusal reports no refusal"
        )
        check(
            TriOSEncryptionError.openFailure.keyRefusal == nil,
            "a bad ciphertext is not a key refusal"
        )
    }
}
