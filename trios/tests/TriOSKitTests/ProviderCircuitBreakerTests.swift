import XCTest
@testable import TriOSKit

final class ProviderCircuitBreakerTests: XCTestCase {
    private let key = ProviderEndpointKey(provider: .openrouter, baseURL: "https://openrouter.ai/api/v1")

    func testInitialStateIsClosed() async {
        let breaker = ProviderCircuitBreaker()
        let value1 = await breaker.state(for: key)
        XCTAssertEqual(value1, .closed)
        let value2 = await breaker.canSend(to: key)
        XCTAssertTrue(value2)
    }

    func testStaysClosedBelowThreshold() async {
        let breaker = ProviderCircuitBreaker(failureThreshold: 3)
        await breaker.recordFailure(key, kind: .gateway)
        await breaker.recordFailure(key, kind: .gateway)
        let value3 = await breaker.state(for: key)
        XCTAssertEqual(value3, .closed)
        let value4 = await breaker.canSend(to: key)
        XCTAssertTrue(value4)
    }

    func testTripsOpenAtThreshold() async {
        let breaker = ProviderCircuitBreaker(failureThreshold: 2)
        await breaker.recordFailure(key, kind: .gateway)
        await breaker.recordFailure(key, kind: .gateway)
        let value5 = await breaker.state(for: key)
        XCTAssertEqual(value5, .open)
        let value6 = await breaker.canSend(to: key)
        XCTAssertFalse(value6)
    }

    func testCooldownTransitionsToHalfOpen() async {
        var now = Date()
        let breaker = ProviderCircuitBreaker(
            failureThreshold: 2,
            baseCooldown: 30,
            clock: { now }
        )
        await breaker.recordFailure(key, kind: .gateway)
        await breaker.recordFailure(key, kind: .gateway)
        let value7 = await breaker.canSend(to: key)
        XCTAssertFalse(value7)

        // Ask the breaker when it will allow a retry instead of assuming
        // baseCooldown + 1. The cooldown carries +/-10% jitter, so 31 s against
        // a 30 s base clears it only when the jitter happens to be negative -
        // and which way it lands is a property of the endpoint key, not of
        // anything this test controls. Four of these read as flaky for exactly
        // that reason and two more passed by luck.
        now = (await breaker.nextRetryAt(for: key) ?? now).addingTimeInterval(1)
        let value8 = await breaker.canSend(to: key)
        XCTAssertTrue(value8)
        let value9 = await breaker.state(for: key)
        XCTAssertEqual(value9, .halfOpen)
    }

    func testRetryAfterOverridesComputedCooldown() async {
        var now = Date()
        let breaker = ProviderCircuitBreaker(
            failureThreshold: 2,
            baseCooldown: 30,
            clock: { now }
        )
        await breaker.recordFailure(key, kind: .rateLimit, retryAfter: 120)
        await breaker.recordFailure(key, kind: .rateLimit, retryAfter: 120)

        let nextRetry = await breaker.nextRetryAt(for: key)
        XCTAssertEqual(try XCTUnwrap(nextRetry).timeIntervalSince(now), 120, accuracy: 0.1)

        now.addTimeInterval(119)
        let value10 = await breaker.canSend(to: key)
        XCTAssertFalse(value10)
        now.addTimeInterval(2)
        let value11 = await breaker.canSend(to: key)
        XCTAssertTrue(value11)
    }

    func testHalfOpenSuccessClosesBreaker() async {
        var now = Date()
        let breaker = ProviderCircuitBreaker(
            failureThreshold: 2,
            baseCooldown: 30,
            clock: { now }
        )
        await breaker.recordFailure(key, kind: .gateway)
        await breaker.recordFailure(key, kind: .gateway)
        // Ask the breaker when it will allow a retry instead of assuming
        // baseCooldown + 1. The cooldown carries +/-10% jitter, so 31 s against
        // a 30 s base clears it only when the jitter happens to be negative -
        // and which way it lands is a property of the endpoint key, not of
        // anything this test controls. Four of these read as flaky for exactly
        // that reason and two more passed by luck.
        now = (await breaker.nextRetryAt(for: key) ?? now).addingTimeInterval(1)
        await breaker.recordSuccess(key)
        let value12 = await breaker.state(for: key)
        XCTAssertEqual(value12, .closed)
        let value13 = await breaker.canSend(to: key)
        XCTAssertTrue(value13)
        let value14 = await breaker.failureStreak(for: key)
        XCTAssertEqual(value14, 0)
    }

    func testHalfOpenFailureReopensBreaker() async {
        var now = Date()
        let breaker = ProviderCircuitBreaker(
            failureThreshold: 2,
            baseCooldown: 30,
            clock: { now }
        )
        await breaker.recordFailure(key, kind: .gateway)
        await breaker.recordFailure(key, kind: .gateway)
        // Ask the breaker when it will allow a retry instead of assuming
        // baseCooldown + 1. The cooldown carries +/-10% jitter, so 31 s against
        // a 30 s base clears it only when the jitter happens to be negative -
        // and which way it lands is a property of the endpoint key, not of
        // anything this test controls. Four of these read as flaky for exactly
        // that reason and two more passed by luck.
        now = (await breaker.nextRetryAt(for: key) ?? now).addingTimeInterval(1)
        await breaker.recordFailure(key, kind: .gateway)
        let value15 = await breaker.state(for: key)
        XCTAssertEqual(value15, .open)
        let value16 = await breaker.canSend(to: key)
        XCTAssertFalse(value16)
    }

    func testPersistentKindUsesLongerCooldown() async {
        var now = Date()
        let breaker = ProviderCircuitBreaker(
            failureThreshold: 2,
            baseCooldown: 30,
            persistentBackoffMultiplier: 4,
            clock: { now }
        )
        await breaker.recordFailure(key, kind: .auth)
        await breaker.recordFailure(key, kind: .auth)
        let authRetry = await breaker.nextRetryAt(for: key)!

        let authKey = ProviderEndpointKey(provider: .anthropic, baseURL: "https://api.anthropic.com")
        now = Date()
        let transientBreaker = ProviderCircuitBreaker(
            failureThreshold: 2,
            baseCooldown: 30,
            transientBackoffMultiplier: 2,
            clock: { now }
        )
        await transientBreaker.recordFailure(authKey, kind: .gateway)
        await transientBreaker.recordFailure(authKey, kind: .gateway)
        let gatewayRetry = await transientBreaker.nextRetryAt(for: authKey)!

        XCTAssertGreaterThan(authRetry.timeIntervalSince(now), gatewayRetry.timeIntervalSince(now))
    }

    func testResetClearsState() async {
        let breaker = ProviderCircuitBreaker(failureThreshold: 1)
        await breaker.recordFailure(key, kind: .balance)
        await breaker.reset(key)
        let value17 = await breaker.state(for: key)
        XCTAssertEqual(value17, .closed)
        let value18 = await breaker.lastFailureKind(for: key)
        XCTAssertNil(value18)
    }

    func testTransportErrorMapping() {
        let rateLimit = TransportError.serverError(
            statusCode: 429,
            bodySample: "Rate limited",
            url: nil,
            retryAfter: 5
        )
        XCTAssertEqual(rateLimit.circuitBreakerFailureKind, .rateLimit)
        XCTAssertEqual(rateLimit.retryAfter, 5)

        let auth = TransportError.serverError(statusCode: 401, bodySample: "Unauthorized", url: nil)
        XCTAssertEqual(auth.circuitBreakerFailureKind, .auth)

        let balance = TransportError.serverError(statusCode: 402, bodySample: "Insufficient balance", url: nil)
        XCTAssertEqual(balance.circuitBreakerFailureKind, .balance)

        let unavailable = TransportError.serverError(statusCode: 503, bodySample: "Unavailable", url: nil)
        XCTAssertEqual(unavailable.circuitBreakerFailureKind, .gateway)

        let timeout = TransportError.requestTimedOut(
            URL(string: "https://example.invalid")!, 30
        )
        XCTAssertEqual(timeout.circuitBreakerFailureKind, .timeout)
    }

    func testDifferentEndpointsAreIsolated() async {
        let breaker = ProviderCircuitBreaker(failureThreshold: 2)
        let keyA = ProviderEndpointKey(provider: .openai, baseURL: "https://api.openai.com")
        let keyB = ProviderEndpointKey(provider: .anthropic, baseURL: "https://api.anthropic.com")
        await breaker.recordFailure(keyA, kind: .gateway)
        await breaker.recordFailure(keyA, kind: .gateway)
        let value19 = await breaker.state(for: keyA)
        XCTAssertEqual(value19, .open)
        let value20 = await breaker.state(for: keyB)
        XCTAssertEqual(value20, .closed)
    }

    func testHalfOpenProbeLockAllowsOnlyOneCaller() async {
        var now = Date()
        let breaker = ProviderCircuitBreaker(
            failureThreshold: 2,
            baseCooldown: 30,
            clock: { now }
        )
        await breaker.recordFailure(key, kind: .gateway)
        await breaker.recordFailure(key, kind: .gateway)
        // Ask the breaker when it will allow a retry instead of assuming
        // baseCooldown + 1. The cooldown carries +/-10% jitter, so 31 s against
        // a 30 s base clears it only when the jitter happens to be negative -
        // and which way it lands is a property of the endpoint key, not of
        // anything this test controls. Four of these read as flaky for exactly
        // that reason and two more passed by luck.
        now = (await breaker.nextRetryAt(for: key) ?? now).addingTimeInterval(1)

        let first = await breaker.beginProbe(key)
        let second = await breaker.beginProbe(key)
        XCTAssertTrue(first)
        XCTAssertFalse(second)

        // A caller while a probe is in flight cannot send.
        let value21 = await breaker.canSend(to: key)
        XCTAssertFalse(value21)

        await breaker.endProbe(key, success: true)
        let value22 = await breaker.state(for: key)
        XCTAssertEqual(value22, .closed)
        let value23 = await breaker.canSend(to: key)
        XCTAssertTrue(value23)
    }

    func testStuckProbeReleasesAfterTimeout() async {
        var now = Date()
        let breaker = ProviderCircuitBreaker(
            failureThreshold: 2,
            baseCooldown: 30,
            halfOpenProbeTimeout: 10,
            clock: { now }
        )
        await breaker.recordFailure(key, kind: .gateway)
        await breaker.recordFailure(key, kind: .gateway)
        // Ask the breaker when it will allow a retry instead of assuming
        // baseCooldown + 1. The cooldown carries +/-10% jitter, so 31 s against
        // a 30 s base clears it only when the jitter happens to be negative -
        // and which way it lands is a property of the endpoint key, not of
        // anything this test controls. Four of these read as flaky for exactly
        // that reason and two more passed by luck.
        now = (await breaker.nextRetryAt(for: key) ?? now).addingTimeInterval(1)

        let value24 = await breaker.beginProbe(key)
        XCTAssertTrue(value24)
        now.addTimeInterval(11)
        // After the probe timeout a new caller can start a probe.
        let value25 = await breaker.canSend(to: key)
        XCTAssertTrue(value25)
        let value26 = await breaker.beginProbe(key)
        XCTAssertTrue(value26)
    }

    func testJitterProducesDifferentCooldownsForDifferentEndpoints() async {
        var now = Date()
        let breaker = ProviderCircuitBreaker(
            failureThreshold: 2,
            baseCooldown: 30,
            jitterFactor: 0.5,
            clock: { now }
        )
        let keyA = ProviderEndpointKey(provider: .openai, baseURL: "https://api.openai.com")
        let keyB = ProviderEndpointKey(provider: .anthropic, baseURL: "https://api.anthropic.com")

        await breaker.recordFailure(keyA, kind: .gateway)
        await breaker.recordFailure(keyA, kind: .gateway)
        await breaker.recordFailure(keyB, kind: .gateway)
        await breaker.recordFailure(keyB, kind: .gateway)

        let retryA = await breaker.nextRetryAt(for: keyA)!
        let retryB = await breaker.nextRetryAt(for: keyB)!
        // Jitter of ±50% on a 30s base means the absolute difference should be
        // non-zero for two different endpoint keys.
        XCTAssertNotEqual(retryA.timeIntervalSince(now), retryB.timeIntervalSince(now), accuracy: 0.1)
    }

    func testHalfOpenFailedProbeReopensBreaker() async {
        var now = Date()
        let breaker = ProviderCircuitBreaker(
            failureThreshold: 2,
            baseCooldown: 30,
            clock: { now }
        )
        await breaker.recordFailure(key, kind: .gateway)
        await breaker.recordFailure(key, kind: .gateway)
        // Ask the breaker when it will allow a retry instead of assuming
        // baseCooldown + 1. The cooldown carries +/-10% jitter, so 31 s against
        // a 30 s base clears it only when the jitter happens to be negative -
        // and which way it lands is a property of the endpoint key, not of
        // anything this test controls. Four of these read as flaky for exactly
        // that reason and two more passed by luck.
        now = (await breaker.nextRetryAt(for: key) ?? now).addingTimeInterval(1)

        let value27 = await breaker.beginProbe(key)
        XCTAssertTrue(value27)
        await breaker.endProbe(key, success: false)
        let value28 = await breaker.state(for: key)
        XCTAssertEqual(value28, .open)
    }

    func testBalanceCooldownFloorIsFourTimesBase() async {
        var now = Date()
        let breaker = ProviderCircuitBreaker(
            failureThreshold: 1,
            baseCooldown: 30,
            clock: { now }
        )
        await breaker.recordFailure(key, kind: .balance)

        let nextRetry = await breaker.nextRetryAt(for: key)!
        XCTAssertGreaterThanOrEqual(nextRetry.timeIntervalSince(now), 120)
    }

    /// The floor holds for EVERY endpoint, not for the one this file happens
    /// to name.
    ///
    /// `testBalanceCooldownFloorIsFourTimesBase` above asserts the same thing
    /// against a single key, and a single key samples one draw of the jitter.
    /// Removing the clamp that keeps jitter above the floor leaves that test
    /// green whenever this endpoint's hash draws upward - which it does. A
    /// property that must hold for all endpoints has to be asked of more than
    /// one, or it is a coin toss wearing an assertion.
    ///
    /// Driven: reverting `max(floor, ...)` in computeCooldown turns this red
    /// and leaves the single-key test green.
    func testCooldownFloorHoldsForEveryEndpoint() async {
        // Enough endpoints that both signs of the jitter are certainly drawn.
        let urls = (0..<64).map { "https://endpoint-\($0).example.com/v1" }
        var lowest = Double.infinity
        for url in urls {
            let endpoint = ProviderEndpointKey(provider: .zai, baseURL: url)
            var now = Date()
            let breaker = ProviderCircuitBreaker(
                failureThreshold: 1,
                baseCooldown: 30,
                clock: { now }
            )
            await breaker.recordFailure(endpoint, kind: .balance)
            guard let retryAt = await breaker.nextRetryAt(for: endpoint) else {
                XCTFail("no retry time recorded for \(url)")
                return
            }
            let cooldown = retryAt.timeIntervalSince(now)
            lowest = min(lowest, cooldown)
            XCTAssertGreaterThanOrEqual(
                cooldown, 120,
                "balance cooldown for \(url) fell below the 4x base floor"
            )
            now = retryAt
        }
        // Guards the guard: if every endpoint drew the same cooldown the loop
        // proved nothing about jitter at all.
        XCTAssertLessThan(
            lowest, 132,
            "every endpoint drew the maximum cooldown - the jitter is not varying, so this test is not testing it"
        )
    }

    /// The jitter ratio must be the same in the next process, not just this one.
    ///
    /// Swift seeds `Hashable` per process, so `key.hashValue` - what this used
    /// to use - gives a different jitter on every launch. Pinned to a golden
    /// value rather than to "is it stable within this run", because that
    /// weaker question is one `hashValue` answers correctly, which is exactly
    /// how it survived here.
    /// The COOLDOWN itself must be reproducible in the next process.
    ///
    /// Pinning `stableHash` alone is not enough and the gap is instructive:
    /// reverting the jitter to `key.hashValue` leaves `stableHash` correct and
    /// simply stops using it, so a test of the function passes while the
    /// behaviour it exists for is gone. Within one process `hashValue` is
    /// stable too, so nothing observable inside a single run distinguishes
    /// them - except a golden number carried over from a previous one.
    ///
    /// Driven: swapping `stableHash` back to `hashValue` turns this red.
    func testCooldownIsReproducibleAcrossProcesses() async {
        let endpoint = ProviderEndpointKey(
            provider: .zai,
            baseURL: "https://api.z.ai/api/coding/paas/v4"
        )
        let now = Date()
        let breaker = ProviderCircuitBreaker(
            failureThreshold: 1,
            baseCooldown: 30,
            clock: { now }
        )
        await breaker.recordFailure(endpoint, kind: .gateway)
        guard let retryAt = await breaker.nextRetryAt(for: endpoint) else {
            XCTFail("no retry time recorded")
            return
        }
        XCTAssertEqual(
            retryAt.timeIntervalSince(now), 27.64071, accuracy: 0.000_001,
            "the cooldown for a fixed endpoint changed. Recompute the golden "
                + "value if the jitter formula changed on purpose; if it differs "
                + "from run to run, the jitter is reading a per-process hash again."
        )
    }

    func testStableHashIsTheSameInEveryProcess() {
        let endpoint = ProviderEndpointKey(
            provider: .zai,
            baseURL: "https://api.z.ai/api/coding/paas/v4"
        )
        XCTAssertEqual(
            endpoint.stableHash, 12_327_293_447_867_106_785,
            "the endpoint hash changed. If this was deliberate, recompute the "
                + "golden value; if it is because the implementation went back "
                + "to hashValue, it will differ on every run."
        )
        XCTAssertNotEqual(
            endpoint.stableHash,
            ProviderEndpointKey(provider: .zai, baseURL: "https://api.z.ai/api/coding/paas/v5").stableHash,
            "two endpoints must not share a jitter draw"
        )
    }

    func testContextLengthFailureKindMapping() {
        let error = TransportError.serverError(
            statusCode: 400,
            bodySample: "context_length_exceeded",
            url: nil
        )
        XCTAssertEqual(error.circuitBreakerFailureKind, .contextLength)
    }

    func testContextLengthCooldownIsPersistent() async {
        var now = Date()
        let breaker = ProviderCircuitBreaker(
            failureThreshold: 2,
            baseCooldown: 30,
            persistentBackoffMultiplier: 4,
            clock: { now }
        )
        await breaker.recordFailure(key, kind: .contextLength)
        await breaker.recordFailure(key, kind: .contextLength)
        let value29 = await breaker.lastFailureKind(for: key)
        XCTAssertEqual(value29, .contextLength)
        let value30 = await breaker.state(for: key)
        XCTAssertEqual(value30, .open)
    }

    func testContextLengthNotEligibleForCrossProviderFailover() {
        let error = TransportError.serverError(
            statusCode: 413,
            bodySample: "Payload Too Large",
            url: nil
        )
        XCTAssertFalse(error.isEligibleForCrossProviderFailover)
    }
}
