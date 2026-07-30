import Foundation
import XCTest
@testable import TriOSKit

@MainActor
final class ModelReliabilityServiceCrossProviderTests: XCTestCase {
    private var store: VolatileMemoryStore!
    private var adapter: MemoryStoreReliabilityAdapter!
    private var service: ModelReliabilityService!

    override func setUp() async throws {
        store = VolatileMemoryStore()
        adapter = MemoryStoreReliabilityAdapter(store: store)
        service = ModelReliabilityService(store: adapter, historyLimit: 20, emaAlpha: 0.3)
    }

    func testRankedCrossProviderFallbacksExcludeCurrentTuple() async {
        let configs: [(provider: ModelProvider, baseURL: String)] = [
            (.anthropic, "https://api.anthropic.com"),
            (.openai, "https://api.openai.com")
        ]
        let ranked = await service.rankedCrossProviderFallbacks(
            currentProvider: .anthropic,
            currentBaseURL: "https://api.anthropic.com",
            currentModel: "claude-sonnet-4-5",
            providerConfigurations: configs
        )
        XCTAssertFalse(ranked.contains { $0.candidate.provider == .anthropic && $0.candidate.model == "claude-sonnet-4-5" })
    }

    func testRankedCrossProviderFallbacksPreferHigherScore() async {
        let configs: [(provider: ModelProvider, baseURL: String)] = [
            (.anthropic, "https://api.anthropic.com"),
            (.openai, "https://api.openai.com")
        ]
        await service.record(
            model: "gpt-5",
            provider: .openai,
            baseURL: "https://api.openai.com",
            success: true,
            reason: nil
        )
        await service.record(
            model: "claude-haiku-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            success: false,
            reason: nil
        )

        let ranked = await service.rankedCrossProviderFallbacks(
            currentProvider: .anthropic,
            currentBaseURL: "https://api.anthropic.com",
            currentModel: "claude-sonnet-4-5",
            providerConfigurations: configs
        )
        XCTAssertEqual(ranked.first?.candidate.provider, .openai)
        XCTAssertEqual(ranked.first?.candidate.model, "gpt-5")
    }

    func testRankedCrossProviderFallbacksExcludesUnhealthyModels() async {
        let configs: [(provider: ModelProvider, baseURL: String)] = [
            (.openai, "https://api.openai.com")
        ]
        let ranked = await service.rankedCrossProviderFallbacks(
            currentProvider: .anthropic,
            currentBaseURL: "https://api.anthropic.com",
            currentModel: "claude-sonnet-4-5",
            providerConfigurations: configs,
            excludingModels: Set(["gpt-5"])
        )
        XCTAssertFalse(ranked.contains { $0.candidate.model == "gpt-5" })
    }

    func testBestCrossProviderModelReturnsProviderOrderWithoutHistory() async {
        let configs: [(provider: ModelProvider, baseURL: String)] = [
            (.anthropic, "https://api.anthropic.com"),
            (.openai, "https://api.openai.com")
        ]
        let best = await service.bestCrossProviderModel(
            currentProvider: .zai,
            currentBaseURL: "https://api.z.ai/api/paas/v4",
            currentModel: "glm-5",
            providerConfigurations: configs
        )
        XCTAssertEqual(best?.provider, .anthropic)
        XCTAssertEqual(best?.model, "claude-sonnet-4-5")
    }

    func testBestCrossProviderModelRespectsCostTier() async {
        let configs: [(provider: ModelProvider, baseURL: String)] = [
            (.openai, "https://api.openai.com"),
            (.anthropic, "https://api.anthropic.com")
        ]
        let best = await service.bestCrossProviderModel(
            currentProvider: .ollama,
            currentBaseURL: "http://127.0.0.1:11434/v1",
            currentModel: "llama3.1",
            providerConfigurations: configs,
            tier: .cheap
        )
        // gpt-5 is cheap; claude-sonnet-4-5 is premium.
        XCTAssertEqual(best?.provider, .openai)
        XCTAssertEqual(best?.model, "gpt-5")
    }

    func testBestCrossProviderModelRelaxesTierFilterWhenNoMatch() async {
        let configs: [(provider: ModelProvider, baseURL: String)] = [
            (.anthropic, "https://api.anthropic.com")
        ]
        let best = await service.bestCrossProviderModel(
            currentProvider: .ollama,
            currentBaseURL: "http://127.0.0.1:11434/v1",
            currentModel: "llama3.1",
            providerConfigurations: configs,
            tier: .free
        )
        XCTAssertNotNil(best)
    }

    func testBestCrossProviderModelPrefersHistoryOverProviderOrder() async {
        let configs: [(provider: ModelProvider, baseURL: String)] = [
            (.anthropic, "https://api.anthropic.com"),
            (.openai, "https://api.openai.com")
        ]
        await service.record(
            model: "gpt-5",
            provider: .openai,
            baseURL: "https://api.openai.com",
            success: true,
            reason: nil
        )

        let best = await service.bestCrossProviderModel(
            currentProvider: .zai,
            currentBaseURL: "https://api.z.ai/api/paas/v4",
            currentModel: "glm-5",
            providerConfigurations: configs
        )
        XCTAssertEqual(best?.provider, .openai)
        XCTAssertEqual(best?.model, "gpt-5")
    }
}
