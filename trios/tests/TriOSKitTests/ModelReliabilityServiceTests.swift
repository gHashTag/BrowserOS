import Foundation
import XCTest
@testable import TriOSKit

final class ModelReliabilityServiceTests: XCTestCase {
    private var store: VolatileMemoryStore!
    private var adapter: MemoryStoreReliabilityAdapter!
    private var service: ModelReliabilityService!

    override func setUp() async throws {
        store = VolatileMemoryStore()
        adapter = MemoryStoreReliabilityAdapter(store: store)
        service = ModelReliabilityService(store: adapter, historyLimit: 20, emaAlpha: 0.3)
    }

    func testEmptyReliabilityIsUnknown() async {
        let reliability = await service.reliability(
            for: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com"
        )
        XCTAssertEqual(reliability.score, 0.5)
        XCTAssertEqual(reliability.totalOutcomes, 0)
        XCTAssertEqual(reliability.failureStreak, 0)
    }

    func testSuccessImprovesScore() async {
        await service.record(
            model: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            success: true,
            reason: nil
        )
        let reliability = await service.reliability(
            for: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com"
        )
        XCTAssertGreaterThan(reliability.score, 0.5)
        XCTAssertEqual(reliability.totalOutcomes, 1)
        XCTAssertEqual(reliability.failureStreak, 0)
    }

    func testFailureLowersScore() async {
        await service.record(
            model: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            success: false,
            reason: "timeout"
        )
        let reliability = await service.reliability(
            for: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com"
        )
        XCTAssertLessThan(reliability.score, 0.5)
        XCTAssertEqual(reliability.totalOutcomes, 1)
        XCTAssertEqual(reliability.failureStreak, 1)
    }

    func testEMAConvergesToRecentPattern() async {
        let model = "claude-sonnet-4-5"
        let provider = ModelProvider.anthropic
        let baseURL = "https://api.anthropic.com"
        for _ in 0..<10 {
            await service.record(model: model, provider: provider, baseURL: baseURL, success: false, reason: nil)
        }
        for _ in 0..<10 {
            await service.record(model: model, provider: provider, baseURL: baseURL, success: true, reason: nil)
        }
        let reliability = await service.reliability(for: model, provider: provider, baseURL: baseURL)
        XCTAssertGreaterThan(reliability.score, 0.6)
        XCTAssertEqual(reliability.totalOutcomes, 20)
    }

    func testHealthOutcomeRecorded() async {
        await service.recordHealth(
            model: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            health: .unavailable(reason: "probe failed")
        )
        let reliability = await service.reliability(
            for: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com"
        )
        XCTAssertLessThan(reliability.score, 0.5)
        XCTAssertEqual(reliability.totalOutcomes, 1)
    }

    func testRankedFallbacksPreferHigherScore() async {
        let provider = ModelProvider.anthropic
        let baseURL = "https://api.anthropic.com"
        await service.record(model: "claude-opus-4-5", provider: provider, baseURL: baseURL, success: true, reason: nil)
        await service.record(model: "claude-opus-4-5", provider: provider, baseURL: baseURL, success: true, reason: nil)
        await service.record(model: "claude-haiku-4-5", provider: provider, baseURL: baseURL, success: false, reason: nil)

        let ranked = await service.rankedFallbacks(
            excluding: "claude-sonnet-4-5",
            from: ["claude-haiku-4-5", "claude-opus-4-5"],
            provider: provider,
            baseURL: baseURL
        )
        XCTAssertEqual(ranked.first, "claude-opus-4-5")
    }

    func testFallbackRankingExcludesCurrentModel() async {
        let provider = ModelProvider.anthropic
        let baseURL = "https://api.anthropic.com"
        let ranked = await service.rankedFallbacks(
            excluding: "claude-sonnet-4-5",
            from: ["claude-sonnet-4-5", "claude-opus-4-5"],
            provider: provider,
            baseURL: baseURL
        )
        XCTAssertFalse(ranked.contains("claude-sonnet-4-5"))
    }

    func testResetClearsScores() async {
        let provider = ModelProvider.anthropic
        let baseURL = "https://api.anthropic.com"
        await service.record(model: "claude-sonnet-4-5", provider: provider, baseURL: baseURL, success: false, reason: nil)
        await service.reset(provider: provider, baseURL: baseURL)
        let reliability = await service.reliability(for: "claude-sonnet-4-5", provider: provider, baseURL: baseURL)
        XCTAssertEqual(reliability.score, 0.5)
        XCTAssertEqual(reliability.totalOutcomes, 0)
    }

    func testHistoryLimitTruncatesOldest() async {
        let limitedService = ModelReliabilityService(store: adapter, historyLimit: 3, emaAlpha: 0.5)
        let provider = ModelProvider.anthropic
        let baseURL = "https://api.anthropic.com"
        await limitedService.record(model: "m", provider: provider, baseURL: baseURL, success: true, reason: nil)
        await limitedService.record(model: "m", provider: provider, baseURL: baseURL, success: true, reason: nil)
        await limitedService.record(model: "m", provider: provider, baseURL: baseURL, success: true, reason: nil)
        await limitedService.record(model: "m", provider: provider, baseURL: baseURL, success: false, reason: nil)
        let reliability = await limitedService.reliability(for: "m", provider: provider, baseURL: baseURL)
        XCTAssertEqual(reliability.totalOutcomes, 3)
    }

    func testBestModelRanksByReliability() async {
        let provider = ModelProvider.anthropic
        let baseURL = "https://api.anthropic.com"
        await service.record(model: "claude-opus-4-5", provider: provider, baseURL: baseURL, success: true, reason: nil)
        await service.record(model: "claude-opus-4-5", provider: provider, baseURL: baseURL, success: true, reason: nil)
        await service.record(model: "claude-haiku-4-5", provider: provider, baseURL: baseURL, success: false, reason: nil)

        let best = await service.bestModel(
            from: ["claude-haiku-4-5", "claude-opus-4-5"],
            provider: provider,
            baseURL: baseURL
        )
        XCTAssertEqual(best, "claude-opus-4-5")
    }

    func testBestModelExcludesCurrentModel() async {
        let provider = ModelProvider.anthropic
        let baseURL = "https://api.anthropic.com"
        await service.record(model: "claude-opus-4-5", provider: provider, baseURL: baseURL, success: true, reason: nil)

        let best = await service.bestModel(
            from: ["claude-opus-4-5"],
            provider: provider,
            baseURL: baseURL,
            excluding: "claude-opus-4-5"
        )
        XCTAssertNil(best)
    }

    func testBestModelFallsBackToProviderOrderWithoutHistory() async {
        let provider = ModelProvider.anthropic
        let baseURL = "https://api.anthropic.com"
        let best = await service.bestModel(
            from: ["claude-opus-4-5", "claude-sonnet-4-5"],
            provider: provider,
            baseURL: baseURL
        )
        XCTAssertEqual(best, "claude-opus-4-5")
    }

    func testBestModelRespectsCostTier() async {
        let provider = ModelProvider.openai
        let baseURL = "https://api.openai.com"
        await service.record(model: "gpt-4o", provider: provider, baseURL: baseURL, success: true, reason: nil)
        await service.record(model: "gpt-4o-mini", provider: provider, baseURL: baseURL, success: true, reason: nil)

        let best = await service.bestModel(
            from: ["gpt-4o", "gpt-4o-mini"],
            provider: provider,
            baseURL: baseURL,
            tier: .cheap
        )
        XCTAssertEqual(best, "gpt-4o-mini")
    }

    func testBestModelRelaxesTierFilterWhenNoMatch() async {
        let provider = ModelProvider.openai
        let baseURL = "https://api.openai.com"
        await service.record(model: "gpt-4o", provider: provider, baseURL: baseURL, success: true, reason: nil)

        let best = await service.bestModel(
            from: ["gpt-4o"],
            provider: provider,
            baseURL: baseURL,
            tier: .free
        )
        XCTAssertEqual(best, "gpt-4o")
    }
}
