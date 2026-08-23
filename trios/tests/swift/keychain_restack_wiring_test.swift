// Wiring test for the restack guard in KeychainSecrets.
//
// Run (from trios root):
//   swiftc tests/swift/keychain_restack_wiring_test.swift \
//     tests/swift/TriosLogBusTestStubs.swift \
//     rings/SR-00/KeychainReadStacking.swift rings/SR-00/KeychainSecrets.swift \
//     rings/SR-00/DevSecretStore.swift BR-OUTPUT/ProjectPaths.swift \
//     rings/SR-00/BuildVariantPolicy.swift rings/SR-01/TriosLogBus.swift \
//     rings/SR-01/TriosOTLPExporter.swift \
//     -o /tmp/trios_keychain_restack_wiring_test \
//     && /tmp/trios_keychain_restack_wiring_test
//
// Why this exists, and what it is worth.
//
// keychain_read_stacking_test proves the DECISION. It cannot show that
// KeychainSecrets asks the decision, honours the answer, or clears the entry
// when a call settles. Those are the wiring, and the wiring had no proof: the
// guard's real condition - a call still unsettled when the sixty-second
// cooldown expires - fired zero times across five launches, because it needs
// securityd to be slow that minute and no round can arrange that.
//
// So the state is seeded directly. `outstandingReads` is module-internal for
// exactly this reason, and the seam is stated in its own doc comment rather
// than left for a reader to discover.
//
// Still NOT proved here: that securityd behaves as the incident described, and
// that the log line reaches the on-disk journal (TriosLogBus is stubbed). The
// unproven surface is now one process boundary instead of a whole branch.

import Foundation

@main
enum KeychainRestackWiringTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static func reset() {
        KeychainSecrets.outstandingReads = [:]
    }

    static func main() {
        theGuardRefusesASecondDispatch()
        aSettledCallStopsRefusingTheNext()
        theListingPathIsGuardedToo()
        anAbandonedEntryIsForgottenNotLatched()
        theTwoPathsDoNotShareAKey()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All KeychainRestackWiring tests passed.")
    }

    /// The measured cadence: the old code dispatched read number two 69 seconds
    /// after number one, once per cooldown expiry.
    static func theGuardRefusesASecondDispatch() {
        scenario("a call outstanding for 69s refuses the next dispatch")
        reset()

        let key = "com.browseros.trios.model-keys/zai"
        KeychainSecrets.noteDispatchLocked(key, at: Date().addingTimeInterval(-69))

        let decision = KeychainSecrets.stackingDecisionLocked(key)
        guard case let .refuseOutstanding(age) = decision else {
            check(false, "expected refuseOutstanding, got \(decision)")
            return
        }
        check(age >= 68 && age <= 71, "the refusal carries the measured age (\(Int(age))s)")
        check(
            KeychainSecrets.outstandingReads[key]?.count == 1,
            "a refusal does not add a second entry - refusing must not look like dispatching"
        )
    }

    static func aSettledCallStopsRefusingTheNext() {
        scenario("once the call settles the next caller may dispatch")
        reset()

        let key = "com.browseros.trios.model-keys/zai"
        let stamp = Date().addingTimeInterval(-69)
        KeychainSecrets.noteDispatchLocked(key, at: stamp)
        KeychainSecrets.noteSettledLocked(key, at: stamp)

        check(
            KeychainSecrets.stackingDecisionLocked(key) == .dispatch,
            "a settled call no longer blocks the next dispatch"
        )
        check(
            KeychainSecrets.outstandingReads[key] == nil,
            "the empty list is removed, not left as an empty array that reads as truthy"
        )
    }

    /// Four listings stalled in the same window as the five reads, on the same
    /// service, on the same 69-second cadence. Guarding only the reads would
    /// have left half the pile-up dispatching.
    static func theListingPathIsGuardedToo() {
        scenario("the enumeration path uses the same guard, under its own key")
        reset()

        let listKey = "list/com.browseros.trios.model-keys"
        KeychainSecrets.noteDispatchLocked(listKey, at: Date().addingTimeInterval(-137))

        guard case let .refuseOutstanding(age) = KeychainSecrets.stackingDecisionLocked(listKey)
        else {
            check(false, "expected the listing to be refused")
            return
        }
        check(age >= 136, "the listing refusal carries its age (\(Int(age))s)")
    }

    static func anAbandonedEntryIsForgottenNotLatched() {
        scenario("past patience the entry is dropped so it cannot refuse forever")
        reset()

        let key = "com.browseros.trios.model-keys/zai"
        let ancient = Date().addingTimeInterval(-(KeychainSecrets.outstandingReadPatience + 30))
        KeychainSecrets.noteDispatchLocked(key, at: ancient)

        guard case .dispatchAbandoning = KeychainSecrets.stackingDecisionLocked(key) else {
            check(false, "an entry older than patience must not refuse")
            return
        }
        check(
            KeychainSecrets.outstandingReads[key] == nil,
            "the abandoned entry is FORGOTTEN - if it survived, the guard becomes the "
                + "latch it was written to replace"
        )
        check(
            KeychainSecrets.stackingDecisionLocked(key) == .dispatch,
            "and the very next caller dispatches cleanly"
        )
    }

    /// A read of a service and a listing of the same service are different
    /// operations. Sharing one key would make a stalled listing refuse reads of
    /// items that are answering fine.
    static func theTwoPathsDoNotShareAKey() {
        scenario("a stalled listing does not refuse reads of the same service")
        reset()

        let service = "com.browseros.trios.model-keys"
        KeychainSecrets.noteDispatchLocked("list/\(service)", at: Date().addingTimeInterval(-100))

        check(
            KeychainSecrets.stackingDecisionLocked("\(service)/zai") == .dispatch,
            "a keyed read is unaffected by a stalled listing of the same service"
        )
    }
}
