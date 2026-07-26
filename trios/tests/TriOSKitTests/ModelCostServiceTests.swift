import Foundation
import XCTest
@testable import TriOSKit

final class ModelCostServiceTests: XCTestCase {
    private var service: ModelCostService!

    override func setUp() async throws {
        service = ModelCostService()
    }

    func testOllamaIsAlwaysFree() async {
        let cost = await service.cost(for: "any-model", provider: .ollama)
        XCTAssertEqual(cost?.tier, .free)
    }

    func testKnownOpenAIModelTiers() async {
        let gpt4o = await service.cost(for: "gpt-4o", provider: .openai)
        XCTAssertEqual(gpt4o?.tier, .premium)

        let gpt4oMini = await service.cost(for: "gpt-4o-mini", provider: .openai)
        XCTAssertEqual(gpt4oMini?.tier, .cheap)
    }

    func testUnknownPaidProviderDefaultsToPremium() async {
        let cost = await service.cost(for: "unknown-model", provider: .openrouter)
        XCTAssertEqual(cost?.tier, .premium)
    }

    func testTierFilterKeepsMatches() async {
        let candidates = ["gpt-4o", "gpt-4o-mini"]
        let filtered = await service.filter(candidates: candidates, provider: .openai, tier: .cheap)
        XCTAssertEqual(filtered, ["gpt-4o-mini"])
    }

    func testTierFilterReturnsAllWhenNoMatches() async {
        let candidates = ["gpt-4o"]
        let filtered = await service.filter(candidates: candidates, provider: .openai, tier: .free)
        XCTAssertEqual(filtered, ["gpt-4o"])
    }

    func testTierAnyKeepsAll() async {
        let candidates = ["gpt-4o", "gpt-4o-mini"]
        let filtered = await service.filter(candidates: candidates, provider: .openai, tier: .any)
        XCTAssertEqual(filtered, candidates)
    }

    func testCostTierComputedFromPrices() {
        let free = ModelCost(inputPricePer1M: 0, outputPricePer1M: 0)
        XCTAssertEqual(free.tier, .free)

        let cheap = ModelCost(inputPricePer1M: 1.0, outputPricePer1M: 3.0)
        XCTAssertEqual(cheap.tier, .cheap)

        let premium = ModelCost(inputPricePer1M: 5.0, outputPricePer1M: 15.0)
        XCTAssertEqual(premium.tier, .premium)
    }

    func testCostTierConvenienceInit() {
        let free = ModelCost(tier: .free)
        XCTAssertEqual(free.tier, .free)
        XCTAssertEqual(free.inputPricePer1M, 0)
        XCTAssertEqual(free.outputPricePer1M, 0)
    }
}
