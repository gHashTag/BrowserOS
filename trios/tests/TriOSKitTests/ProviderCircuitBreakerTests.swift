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

        now.addTimeInterval(31)
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
        now.addTimeInterval(31)
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
        now.addTimeInterval(31)
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
        now.addTimeInterval(31)

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
        now.addTimeInterval(31)

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
        now.addTimeInterval(31)

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
