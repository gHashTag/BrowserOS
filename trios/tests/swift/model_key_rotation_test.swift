// Standalone unit tests for ModelKeyRotation - Foundation only.
//
// Run (from trios root):
//   swiftc tests/swift/model_key_rotation_test.swift \
//     rings/SR-00/ModelKeyRotation.swift rings/SR-00/ZAIErrorParser.swift \
//     -o /tmp/trios_model_key_rotation_test && /tmp/trios_model_key_rotation_test
//
// Exits non-zero when any assertion fails.

import Foundation

@main
enum ModelKeyRotationTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond {
            print("ok   - \(name)")
        } else {
            failures += 1
            print("FAIL - \(name)")
        }
    }

    static func scenario(_ name: String) {
        print("\n# Scenario: \(name)")
    }

    static let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    static func main() {
        picksFreshKeysFirst()
        leastRecentlyUsed()
        skipsRateLimited()
        recoversAfterCooldown()
        parksDepletedKeysIndefinitely()
        allParked()
        classifiesResponses()
        membershipChanges()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All ModelKeyRotation tests passed.")
    }

    static func picksFreshKeysFirst() {
        scenario("a newly added key is exercised before reusing an old one")

        var states: [String: ModelKeyState] = [:]
        ModelKeyRotation.recordSuccess(entryID: "a", states: &states, now: t0)
        let next = ModelKeyRotation.nextKey(entryIDs: ["a", "b"], states: states, now: t0)
        check(next == "b", "the never-used key is chosen over the used one")
    }

    static func leastRecentlyUsed() {
        scenario("rotation spreads load least-recently-used first")

        var states: [String: ModelKeyState] = [:]
        ModelKeyRotation.recordSuccess(entryID: "a", states: &states, now: t0)
        ModelKeyRotation.recordSuccess(entryID: "b", states: &states, now: t0.addingTimeInterval(10))
        ModelKeyRotation.recordSuccess(entryID: "c", states: &states, now: t0.addingTimeInterval(20))

        let ids = ["a", "b", "c"]
        let now = t0.addingTimeInterval(30)
        check(
            ModelKeyRotation.nextKey(entryIDs: ids, states: states, now: now) == "a",
            "the oldest use is picked first"
        )

        // Using 'a' should move it to the back of the queue.
        var after = states
        ModelKeyRotation.recordSuccess(entryID: "a", states: &after, now: now)
        check(
            ModelKeyRotation.nextKey(entryIDs: ids, states: after, now: now) == "b",
            "after using it, the next-oldest is picked"
        )
    }

    static func skipsRateLimited() {
        scenario("a rate-limited key is skipped while others are free")

        var states: [String: ModelKeyState] = [:]
        ModelKeyRotation.recordSuccess(entryID: "b", states: &states, now: t0.addingTimeInterval(50))
        ModelKeyRotation.recordFailure(
            entryID: "a",
            reason: .rateLimited,
            retryAfter: 30,
            states: &states,
            now: t0
        )
        let next = ModelKeyRotation.nextKey(
            entryIDs: ["a", "b"],
            states: states,
            now: t0.addingTimeInterval(5)
        )
        check(next == "b", "the cooling key is passed over even though it is older")
        check(
            ModelKeyRotation.availableCount(entryIDs: ["a", "b"], states: states, now: t0.addingTimeInterval(5)) == 1,
            "only one key counts as available"
        )
    }

    static func recoversAfterCooldown() {
        scenario("a rate-limited key returns once its cooldown expires")

        var states: [String: ModelKeyState] = [:]
        ModelKeyRotation.recordFailure(
            entryID: "a",
            reason: .rateLimited,
            retryAfter: 30,
            states: &states,
            now: t0
        )
        check(
            states["a"]?.isAvailable(at: t0.addingTimeInterval(29)) == false,
            "still parked one second before the deadline"
        )
        check(
            states["a"]?.isAvailable(at: t0.addingTimeInterval(31)) == true,
            "available again after the deadline"
        )

        // Provider advice wins over the default pause.
        var other: [String: ModelKeyState] = [:]
        ModelKeyRotation.recordFailure(
            entryID: "b",
            reason: .rateLimited,
            retryAfter: nil,
            states: &other,
            now: t0
        )
        let expected = t0.addingTimeInterval(ModelKeyRotation.defaultRateLimitCooldown)
        check(other["b"]?.cooldownUntil == expected, "no Retry-After falls back to the default pause")
    }

    static func parksDepletedKeysIndefinitely() {
        scenario("an exhausted balance parks a key until the user intervenes")

        var states: [String: ModelKeyState] = [:]
        ModelKeyRotation.recordFailure(
            entryID: "a",
            reason: .depleted,
            retryAfter: 5,
            states: &states,
            now: t0
        )
        check(states["a"]?.cooldownUntil == nil, "a terminal park has no expiry")
        check(
            states["a"]?.isAvailable(at: t0.addingTimeInterval(86_400)) == false,
            "still parked a day later"
        )
        check(
            ModelKeyRotation.nextKey(entryIDs: ["a"], states: states, now: t0) == nil,
            "a single depleted key yields no candidate"
        )

        ModelKeyRotation.reset(entryID: "a", states: &states)
        check(
            states["a"]?.isAvailable(at: t0) == true,
            "resetting brings a topped-up key back"
        )
        check(states["a"]?.failureCount == 1, "reset preserves the failure history")
    }

    static func allParked() {
        scenario("every key parked yields nil rather than a bad choice")

        var states: [String: ModelKeyState] = [:]
        ModelKeyRotation.recordFailure(entryID: "a", reason: .depleted, retryAfter: nil, states: &states, now: t0)
        ModelKeyRotation.recordFailure(entryID: "b", reason: .rejected, retryAfter: nil, states: &states, now: t0)
        check(
            ModelKeyRotation.nextKey(entryIDs: ["a", "b"], states: states, now: t0) == nil,
            "no key is returned when all are parked"
        )
        check(
            ModelKeyRotation.availableCount(entryIDs: ["a", "b"], states: states, now: t0) == 0,
            "available count is zero"
        )
    }

    static func classifiesResponses() {
        scenario("provider responses map onto the right cooldown reason")

        check(
            ModelKeyRotation.reason(forHTTPStatus: 429, providerErrorCode: "1113") == .depleted,
            "Z.AI 1113 is an exhausted balance, not a rate limit"
        )
        check(
            ModelKeyRotation.reason(forHTTPStatus: 429, providerErrorCode: "1302") == .rateLimited,
            "a plain 429 is a rate limit"
        )
        check(
            ModelKeyRotation.reason(forHTTPStatus: 429, providerErrorCode: nil) == .rateLimited,
            "a 429 without a business code is a rate limit"
        )
        check(ModelKeyRotation.reason(forHTTPStatus: 402, providerErrorCode: nil) == .depleted, "402 is depleted")
        check(ModelKeyRotation.reason(forHTTPStatus: 401, providerErrorCode: nil) == .rejected, "401 is rejected")
        check(ModelKeyRotation.reason(forHTTPStatus: 403, providerErrorCode: nil) == .rejected, "403 is rejected")
        check(
            ModelKeyRotation.reason(forHTTPStatus: 500, providerErrorCode: nil) == nil,
            "a server error is not a credential problem and must not park a key"
        )
        check(
            ModelKeyRotation.reason(forHTTPStatus: 200, providerErrorCode: nil) == nil,
            "success parks nothing"
        )
    }

    static func membershipChanges() {
        scenario("adding and removing keys mid-session stays correct")

        var states: [String: ModelKeyState] = [:]
        ModelKeyRotation.recordSuccess(entryID: "a", states: &states, now: t0)
        ModelKeyRotation.recordSuccess(entryID: "b", states: &states, now: t0.addingTimeInterval(5))

        // 'b' deleted, 'c' added: stale state must not resurrect a missing key.
        let next = ModelKeyRotation.nextKey(entryIDs: ["a", "c"], states: states, now: t0.addingTimeInterval(10))
        check(next == "c", "a newly added key is preferred and the deleted one is ignored")

        // State for a key that no longer exists is simply never selected.
        check(
            ModelKeyRotation.nextKey(entryIDs: ["a"], states: states, now: t0.addingTimeInterval(10)) == "a",
            "the only remaining key is chosen even though it was used"
        )
    }
}
