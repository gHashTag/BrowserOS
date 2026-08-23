// Standalone unit tests for KeychainReadStacking - Foundation only.
//
// Run (from trios root):
//   swiftc tests/swift/keychain_read_stacking_test.swift \
//     rings/SR-00/KeychainReadStacking.swift \
//     -o /tmp/trios_keychain_read_stacking_test && /tmp/trios_keychain_read_stacking_test
//
// Why this suite exists.
//
// The guard it covers was written on 2026-08-23 and, across the five launches
// that followed, never fired once. Its condition - a Keychain read still
// unsettled when the sixty-second cooldown expires - simply did not occur. So
// the branch shipped in the running release having never executed, and the one
// honest thing that could be said about it was "not disproven".
//
// Waiting for the right launch window is not a test. These checks trigger every
// branch on demand by injecting the clock, which is why `decide` takes `now`
// instead of calling Date() itself.
//
// What they cannot show: that KeychainSecrets calls this correctly, or that the
// log line reaches the journal. Those need the live window. The suite proves the
// decision, not the wiring, and saying otherwise would be the defect this
// repository keeps paying for.

import Foundation

@main
enum KeychainReadStackingTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static let t0 = Date(timeIntervalSince1970: 1_787_000_000)
    static let patience: TimeInterval = 600

    static func main() {
        nothingOutstandingDispatches()
        aYoungReadIsWaitedFor()
        anAbandonedReadDoesNotLatch()
        theBoundaryBelongsToRefusal()
        aBackwardsClockDoesNotRefuseForever()
        theMeasuredPileUpIsRefused()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All KeychainReadStacking tests passed.")
    }

    static func nothingOutstandingDispatches() {
        scenario("no outstanding read - the ordinary case is untouched")
        check(
            KeychainReadStacking.decide(oldestOutstanding: nil, now: t0, patience: patience)
                == .dispatch,
            "nil outstanding dispatches"
        )
    }

    static func aYoungReadIsWaitedFor() {
        scenario("a read still running is waited for, not stacked on")

        let d = KeychainReadStacking.decide(
            oldestOutstanding: t0,
            now: t0.addingTimeInterval(69),
            patience: patience
        )
        check(d == .refuseOutstanding(ageSeconds: 69), "a 69s-old read is refused, not restacked")

        // 69 seconds is the measured spacing: the 60s cooldown plus overhead.
        // This is the exact moment the old code dispatched read number two.
        if case let .refuseOutstanding(age) = d {
            check(age == 69, "the refusal carries the age, so the log can name it")
        } else {
            check(false, "expected refuseOutstanding")
        }
    }

    static func anAbandonedReadDoesNotLatch() {
        scenario("past patience the guard steps aside rather than becoming a latch")

        let d = KeychainReadStacking.decide(
            oldestOutstanding: t0,
            now: t0.addingTimeInterval(601),
            patience: patience
        )
        check(
            d == .dispatchAbandoning(ageSeconds: 601),
            "a read older than patience is abandoned and a fresh dispatch allowed"
        )

        // The whole reason the boolean was cleared on timeout: one read that
        // never returns must not blind the app for the life of the process.
        // If this branch ever stops existing, that bug comes back.
        if case .refuseOutstanding = d {
            check(false, "a stuck read must never refuse callers forever")
        }
    }

    static func theBoundaryBelongsToRefusal() {
        scenario("exactly at patience the read is still worth waiting for")

        check(
            KeychainReadStacking.decide(
                oldestOutstanding: t0,
                now: t0.addingTimeInterval(patience),
                patience: patience
            ) == .refuseOutstanding(ageSeconds: patience),
            "age == patience refuses; only STRICTLY older is abandoned"
        )
    }

    static func aBackwardsClockDoesNotRefuseForever() {
        scenario("a dispatch stamped in the future is a clock, not a read")

        // Without the clamp a negative age is smaller than any patience, so
        // every caller would be refused until the clock caught up - a latch
        // arriving through arithmetic rather than through logic.
        let d = KeychainReadStacking.decide(
            oldestOutstanding: t0.addingTimeInterval(120),
            now: t0,
            patience: patience
        )
        check(d == .refuseOutstanding(ageSeconds: 0), "a negative age is clamped to zero")
    }

    static func theMeasuredPileUpIsRefused() {
        scenario("the five reads measured at 2026-08-23T07:10 would not have stacked")

        // Elapsed values from the release log: five dispatches of one item, all
        // settling together at +299.4s. Ages at the moment each later dispatch
        // was decided, relative to the first.
        let dispatchOffsets: [Double] = [0, 69, 138, 207, 262]
        var refused = 0
        for offset in dispatchOffsets.dropFirst() {
            let d = KeychainReadStacking.decide(
                oldestOutstanding: t0,
                now: t0.addingTimeInterval(offset),
                patience: patience
            )
            if case .refuseOutstanding = d { refused += 1 }
        }
        check(refused == 4, "four of the five dispatches are refused, leaving one read")
    }
}
