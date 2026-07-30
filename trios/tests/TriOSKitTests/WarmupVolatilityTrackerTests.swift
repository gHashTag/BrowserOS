import Foundation
import XCTest
@testable import TriOSKit

final class WarmupVolatilityTrackerTests: XCTestCase {
    private var tracker: WarmupVolatilityTracker!
    private var historyStore: VolatilityHistoryStore!
    private var storeDirectory: URL!
    private var keyURL: URL!
    private let candidate = CrossProviderModelCandidate(
        provider: .anthropic,
        baseURL: "https://api.anthropic.com",
        model: "claude-sonnet-4-5"
    )

    override func setUp() async throws {
        let fm = FileManager.default
        storeDirectory = fm.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: storeDirectory, withIntermediateDirectories: true)
        let fileURL = storeDirectory.appendingPathComponent("volatility.json.enc")
        keyURL = storeDirectory.appendingPathComponent("test.key")
        historyStore = VolatilityHistoryStore(
            encryption: TriOSEncryption(keyURL: keyURL),
            fileURL: fileURL
        )
        tracker = WarmupVolatilityTracker(
            windowSize: 4,
            minTTL: 15,
            maxTTL: 300,
            minInterval: 15,
            maxInterval: 600,
            historyStore: historyStore
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: storeDirectory)
    }

    func testFailureRateStartsAtZero() async {
        let rate = await tracker.failureRate(for: candidate)
        XCTAssertEqual(rate, 0)
    }

    func testFailureRateComputesCorrectly() async {
        await tracker.record(.success, for: candidate)
        await tracker.record(.success, for: candidate)
        await tracker.record(.failure(kind: .unknown), for: candidate)
        let rate = await tracker.failureRate(for: candidate)
        XCTAssertEqual(rate, 1.0 / 3.0, accuracy: 0.001)
    }

    func testWindowIsBounded() async {
        for _ in 0..<6 {
            await tracker.record(.success, for: candidate)
        }
        await tracker.record(.failure(kind: .unknown), for: candidate)
        await tracker.record(.failure(kind: .unknown), for: candidate)
        let rate = await tracker.failureRate(for: candidate)
        XCTAssertEqual(rate, 0.5, accuracy: 0.001)
    }

    func testRecommendedTTLShrinksWithFailures() async {
        await tracker.record(.failure(kind: .unknown), for: candidate)
        await tracker.record(.failure(kind: .unknown), for: candidate)
        let ttl = await tracker.recommendedTTL(baseTTL: 120, for: candidate)
        XCTAssertLessThan(ttl, 120)
        XCTAssertGreaterThanOrEqual(ttl, 15)
    }

    func testRecommendedTTLRelaxesWithSuccesses() async {
        for _ in 0..<4 {
            await tracker.record(.success, for: candidate)
        }
        let ttl = await tracker.recommendedTTL(baseTTL: 120, for: candidate)
        XCTAssertEqual(ttl, 120, accuracy: 0.001)
    }

    func testRecommendedIntervalShrinksMoreAggressivelyThanTTL() async {
        await tracker.record(.failure(kind: .unknown), for: candidate)
        await tracker.record(.failure(kind: .unknown), for: candidate)
        await tracker.record(.success, for: candidate)
        let ttl = await tracker.recommendedTTL(baseTTL: 120, for: candidate)
        let interval = await tracker.recommendedInterval(baseInterval: 120, for: candidate)
        XCTAssertLessThan(interval, ttl)
    }

    func testResetClearsHistory() async {
        await tracker.record(.failure(kind: .unknown), for: candidate)
        await tracker.reset()
        let rate = await tracker.failureRate(for: candidate)
        XCTAssertEqual(rate, 0)
    }

    func testLoadHistoryRestoresWindows() async {
        await tracker.record(.failure(kind: .unknown), for: candidate)
        await tracker.record(.failure(kind: .unknown), for: candidate)
        await tracker.record(.success, for: candidate)

        let secondTracker = WarmupVolatilityTracker(
            windowSize: 4,
            minTTL: 15,
            maxTTL: 300,
            minInterval: 15,
            maxInterval: 600,
            historyStore: historyStore
        )
        await secondTracker.loadHistory()

        let rate = await secondTracker.failureRate(for: candidate)
        XCTAssertEqual(rate, 2.0 / 3.0, accuracy: 0.001)
        let hasHistory = await secondTracker.hasHistory
        XCTAssertTrue(hasHistory)
        let learnedCount = await secondTracker.learnedCandidateCount
        XCTAssertEqual(learnedCount, 1)
    }

    func testLoadHistoryIgnoresMismatchedWindowSize() async {
        await tracker.record(.failure(kind: .unknown), for: candidate)

        let mismatchedStore = VolatilityHistoryStore(
            encryption: TriOSEncryption(keyURL: keyURL),
            fileURL: storeDirectory.appendingPathComponent("mismatched.json.enc")
        )
        let firstTracker = WarmupVolatilityTracker(
            windowSize: 4,
            historyStore: mismatchedStore
        )
        await firstTracker.record(.failure(kind: .unknown), for: candidate)
        await firstTracker.record(.success, for: candidate)

        let secondTracker = WarmupVolatilityTracker(
            windowSize: 10,
            historyStore: mismatchedStore
        )
        await secondTracker.loadHistory()

        let history = await secondTracker.hasHistory
        XCTAssertFalse(history)
    }

    func testResetClearsPersistedHistory() async {
        await tracker.record(.failure(kind: .unknown), for: candidate)
        await tracker.reset()

        let secondTracker = WarmupVolatilityTracker(
            windowSize: 4,
            minTTL: 15,
            maxTTL: 300,
            minInterval: 15,
            maxInterval: 600,
            historyStore: historyStore
        )
        await secondTracker.loadHistory()

        let history = await secondTracker.hasHistory
        XCTAssertFalse(history)
    }

    func testSevereKindShrinksTTLMoreThanUnknownFailure() async {
        let authCandidate = CrossProviderModelCandidate(
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            model: "claude-sonnet-4-5"
        )
        let unknownCandidate = CrossProviderModelCandidate(
            provider: .openai,
            baseURL: "https://api.openai.com",
            model: "gpt-4o"
        )

        await tracker.record(.failure(kind: .auth), for: authCandidate)
        await tracker.record(.failure(kind: .unknown), for: unknownCandidate)

        let authTTL = await tracker.recommendedTTL(baseTTL: 120, for: authCandidate)
        let unknownTTL = await tracker.recommendedTTL(baseTTL: 120, for: unknownCandidate)
        XCTAssertLessThan(authTTL, unknownTTL, "Auth failure should shrink TTL more aggressively")
    }

    func testDominantFailureKindReturned() async {
        await tracker.record(.failure(kind: .rateLimit), for: candidate)
        await tracker.record(.failure(kind: .rateLimit), for: candidate)
        await tracker.record(.failure(kind: .auth), for: candidate)

        let dominant = await tracker.dominantFailureKind(for: candidate)
        XCTAssertEqual(dominant, .rateLimit)
    }

    func testSevereKindDisablesStaleness() async {
        await tracker.record(.failure(kind: .balance), for: candidate)
        let allowed = await tracker.recommendedMaxStaleness(baseMaxStaleness: 120, for: candidate)
        XCTAssertEqual(allowed, 0, accuracy: 0.001, "Balance failure should disable stale service")
    }

    func testKindCountsPersistAndLoad() async {
        await tracker.record(.failure(kind: .rateLimit), for: candidate)
        await tracker.record(.success, for: candidate)

        let secondTracker = WarmupVolatilityTracker(
            windowSize: 4,
            minTTL: 15,
            maxTTL: 300,
            minInterval: 15,
            maxInterval: 600,
            historyStore: historyStore
        )
        await secondTracker.loadHistory()

        let rate = await secondTracker.failureRate(for: .rateLimit, candidate: candidate)
        XCTAssertEqual(rate, 0.5, accuracy: 0.001)
    }
}
