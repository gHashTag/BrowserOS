import Foundation
import XCTest
@testable import TriOSKit

final class PredictiveWarmupCacheTests: XCTestCase {
    private var cache: PredictiveWarmupCache!

    override func setUp() async throws {
        cache = PredictiveWarmupCache(defaultTTL: 10)
    }

    private func result(
        provider: ModelProvider = .anthropic,
        baseURL: String = "https://api.anthropic.com",
        model: String = "claude-sonnet-4-5",
        reason: String = "fastest"
    ) -> ModelWarmupResult {
        ModelWarmupResult(
            selected: CrossProviderModelCandidate(provider: provider, baseURL: baseURL, model: model),
            didSwitch: true,
            probes: [],
            reason: reason
        )
    }

    func testRecordsAndReturnsWinner() async {
        let winner = result()
        await cache.record(winner, tier: .any, strictQuotaGating: false)

        let cached = await cache.winner(tier: .any, strictQuotaGating: false)
        XCTAssertEqual(cached?.selected, winner.selected)
        XCTAssertEqual(cached?.reason, winner.reason)
        XCTAssertTrue(cached?.isFresh() ?? false)
    }

    func testDifferentKeysAreIndependent() async {
        let cheap = result(provider: .openai, model: "gpt-4o-mini", reason: "cheap")
        let strict = result(provider: .anthropic, model: "claude-sonnet-4-5", reason: "strict")

        await cache.record(cheap, tier: .cheap, strictQuotaGating: false)
        await cache.record(strict, tier: .any, strictQuotaGating: true)

        let cheapCached = await cache.winner(tier: .cheap, strictQuotaGating: false)
        let strictCached = await cache.winner(tier: .any, strictQuotaGating: true)
        let anyCached = await cache.winner(tier: .any, strictQuotaGating: false)

        XCTAssertEqual(cheapCached?.selected.model, "gpt-4o-mini")
        XCTAssertEqual(strictCached?.selected.model, "claude-sonnet-4-5")
        XCTAssertNil(anyCached)
    }

    func testStaleWinnerIsNotReturned() async {
        let winner = result()
        let now = Date()
        await cache.record(winner, tier: .any, strictQuotaGating: false, ttl: -1)

        let cached = await cache.winner(tier: .any, strictQuotaGating: false, relativeTo: now.addingTimeInterval(5))
        XCTAssertNil(cached)
    }

    func testInvalidateClearsAllEntries() async {
        await cache.record(result(), tier: .any, strictQuotaGating: false)
        await cache.record(result(provider: .openai), tier: .cheap, strictQuotaGating: true)

        await cache.invalidate()

        XCTAssertNil(await cache.winner(tier: .any, strictQuotaGating: false))
        XCTAssertNil(await cache.winner(tier: .cheap, strictQuotaGating: true))
    }

    func testInvalidateProviderBaseURLRemovesMatchingEntries() async {
        let anthropic = result(provider: .anthropic, baseURL: "https://api.anthropic.com")
        let openai = result(provider: .openai, baseURL: "https://api.openai.com")

        await cache.record(anthropic, tier: .any, strictQuotaGating: false)
        await cache.record(openai, tier: .cheap, strictQuotaGating: false)

        await cache.invalidate(provider: .anthropic, baseURL: "https://api.anthropic.com")

        XCTAssertNil(await cache.winner(tier: .any, strictQuotaGating: false))
        let openaiCached = await cache.winner(tier: .cheap, strictQuotaGating: false)
        XCTAssertEqual(openaiCached?.selected.provider, .openai)
    }

    func testRecordsReplacePriorEntryForSameKey() async {
        let first = result(model: "first")
        let second = result(model: "second")

        await cache.record(first, tier: .any, strictQuotaGating: false)
        await cache.record(second, tier: .any, strictQuotaGating: false)

        let cached = await cache.winner(tier: .any, strictQuotaGating: false)
        XCTAssertEqual(cached?.selected.model, "second")
    }

    func testRemainingTTLReturnsExpectedValue() async {
        let winner = result()
        let now = Date()
        await cache.record(winner, tier: .any, strictQuotaGating: false, ttl: 30)

        let remaining = await cache.remainingTTL(
            tier: .any,
            strictQuotaGating: false,
            relativeTo: now.addingTimeInterval(5)
        )
        XCTAssertEqual(remaining, 25, accuracy: 1)
    }

    func testRemainingTTLReturnsNilWhenStale() async {
        let winner = result()
        let now = Date()
        await cache.record(winner, tier: .any, strictQuotaGating: false, ttl: 10)

        let remaining = await cache.remainingTTL(
            tier: .any,
            strictQuotaGating: false,
            relativeTo: now.addingTimeInterval(15)
        )
        XCTAssertNil(remaining)
    }

    func testPerRecordTTLOverridesDefault() async {
        let winner = result()
        let now = Date()
        await cache.record(winner, tier: .any, strictQuotaGating: false, ttl: 5)

        let cached = await cache.winner(
            tier: .any,
            strictQuotaGating: false,
            relativeTo: now.addingTimeInterval(3)
        )
        XCTAssertNotNil(cached)

        let stale = await cache.winner(
            tier: .any,
            strictQuotaGating: false,
            relativeTo: now.addingTimeInterval(7)
        )
        XCTAssertNil(stale)
    }

    func testWinnerOrStalePrefersFresh() async {
        let winner = result()
        let now = Date()
        await cache.record(winner, tier: .any, strictQuotaGating: false, ttl: 10)

        let selection = await cache.winnerOrStale(
            tier: .any,
            strictQuotaGating: false,
            maxStaleness: 30,
            relativeTo: now.addingTimeInterval(5)
        )
        XCTAssertNotNil(selection)
        XCTAssertFalse(selection?.isStale ?? true)
        XCTAssertEqual(selection?.winner.selected, winner.selected)
    }

    func testWinnerOrStaleReturnsStaleWithinWindow() async {
        let winner = result()
        let now = Date()
        await cache.record(winner, tier: .any, strictQuotaGating: false, ttl: 10)

        let selection = await cache.winnerOrStale(
            tier: .any,
            strictQuotaGating: false,
            maxStaleness: 30,
            relativeTo: now.addingTimeInterval(20)
        )
        XCTAssertNotNil(selection)
        XCTAssertTrue(selection?.isStale ?? false)
        XCTAssertEqual(selection?.winner.selected, winner.selected)
    }

    func testWinnerOrStaleIgnoresStaleBeyondWindow() async {
        let winner = result()
        let now = Date()
        await cache.record(winner, tier: .any, strictQuotaGating: false, ttl: 10)

        let selection = await cache.winnerOrStale(
            tier: .any,
            strictQuotaGating: false,
            maxStaleness: 15,
            relativeTo: now.addingTimeInterval(30)
        )
        XCTAssertNil(selection)
    }

    func testWinnerOrStaleDisablesStaleWhenMaxStalenessZero() async {
        let winner = result()
        let now = Date()
        await cache.record(winner, tier: .any, strictQuotaGating: false, ttl: 10)

        let selection = await cache.winnerOrStale(
            tier: .any,
            strictQuotaGating: false,
            maxStaleness: 0,
            relativeTo: now.addingTimeInterval(15)
        )
        XCTAssertNil(selection)
    }
}
