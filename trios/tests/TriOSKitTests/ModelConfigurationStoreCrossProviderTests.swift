import Foundation
import XCTest
@testable import TriOSKit

@MainActor
final class ModelConfigurationStoreCrossProviderTests: XCTestCase {
    private var defaults: UserDefaults!
    private var healthService: StubModelHealthService!
    private var statusService: StubProviderStatusService!
    private var reliabilityStore: VolatileMemoryStore!
    private var reliabilityAdapter: MemoryStoreReliabilityAdapter!
    private var reliabilityService: ModelReliabilityService!
    private var store: ModelConfigurationStore!

    override func setUp() async throws {
        defaults = UserDefaults(suiteName: "trios-cross-provider-tests")
        XCTAssertNotNil(defaults)

        defaults.set(false, forKey: "trios.model.background-health-polling-enabled")
        defaults.removeObject(forKey: "trios.model.provider")
        defaults.removeObject(forKey: "trios.model.cross-provider-failover-enabled")

        healthService = StubModelHealthService()
        statusService = StubProviderStatusService()
        reliabilityStore = VolatileMemoryStore()
        reliabilityAdapter = MemoryStoreReliabilityAdapter(store: reliabilityStore)
        reliabilityService = ModelReliabilityService(store: reliabilityAdapter, historyLimit: 20, emaAlpha: 0.3)

        store = ModelConfigurationStore(
            defaults: defaults,
            environment: [
                "TRIOS_PROVIDER": ModelProvider.anthropic.rawValue,
                "TRIOS_MODEL": "claude-sonnet-4-5",
                "TRIOS_BASE_URL": "https://api.anthropic.com",
                "TRIOS_OPENAI_API_KEY": "test-openai",
                "TRIOS_ANTHROPIC_API_KEY": "test-anthropic"
            ],
            catalogService: ModelCatalogService(),
            statusService: statusService,
            healthService: healthService,
            reliabilityService: reliabilityService
        )
    }

    override func tearDown() async throws {
        store.backgroundPollerForTests?.stop()
        defaults.removeObject(forKey: "trios.model.provider")
        defaults.removeObject(forKey: "trios.model.background-health-polling-enabled")
        for provider in ModelProvider.allCases {
            defaults.removeObject(forKey: "trios.model.\(provider.rawValue).selection")
            defaults.removeObject(forKey: "trios.model.\(provider.rawValue).base-url")
        }
        defaults.removeObject(forKey: "trios.model.predictive-selection-enabled")
        defaults.removeObject(forKey: "trios.model.cross-provider-failover-enabled")

        await StreamingContextLimitLearner.shared.reset(
            model: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com"
        )
    }

    func testEligibleProvidersRespectAPIKeyAvailability() {
        let eligible = store.eligibleProviderConfigurations
        let providers = eligible.map { $0.provider }
        XCTAssertTrue(providers.contains(.ollama), "Ollama requires no API key")
        XCTAssertTrue(providers.contains(.openai), "OpenAI key provided")
        XCTAssertTrue(providers.contains(.anthropic), "Anthropic key provided")
        XCTAssertFalse(providers.contains(.zai), "zai has no key configured")
        XCTAssertFalse(providers.contains(.openrouter), "OpenRouter has no key configured")
    }

    func testSelectFirstHealthyCrossProviderModelSwitchesProvider() async {
        await reliabilityService.record(
            model: "gpt-5",
            provider: .openai,
            baseURL: "https://api.openai.com",
            success: true,
            reason: nil
        )
        await reliabilityService.record(
            model: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            success: false,
            reason: nil
        )

        let candidate = await store.selectFirstHealthyCrossProviderModel()
        XCTAssertNotNil(candidate)
        XCTAssertEqual(candidate?.provider, .openai)
        XCTAssertEqual(candidate?.model, "gpt-5")
        XCTAssertEqual(store.selectedProvider, .openai)
        XCTAssertEqual(store.selectedModel, "gpt-5")
        XCTAssertEqual(store.baseURL, "https://api.openai.com")
        XCTAssertNotNil(store.crossProviderFailoverReason)
        XCTAssertTrue(store.crossProviderFailoverReason?.contains("OpenAI") ?? false)
    }

    func testSelectFirstHealthyCrossProviderModelExcludesUnhealthyModels() async {
        await reliabilityService.record(
            model: "gpt-5",
            provider: .openai,
            baseURL: "https://api.openai.com",
            success: true,
            reason: nil
        )
        store.markUnhealthy("gpt-5")

        let candidate = await store.selectFirstHealthyCrossProviderModel()
        XCTAssertNotNil(candidate)
        XCTAssertNotEqual(candidate?.model, "gpt-5")
    }

    func testProbeAllEligibleProvidersReturnsConfiguredResults() async {
        await healthService.set(result: ModelHealthResult(health: .healthy, latencyMs: 120), for: "claude-sonnet-4-5", provider: .anthropic, baseURL: "https://api.anthropic.com")
        await healthService.set(result: ModelHealthResult(health: .unavailable(reason: "stub"), latencyMs: nil), for: "gpt-5", provider: .openai, baseURL: "https://api.openai.com")

        let results = await store.probeAllEligibleProviders()
        let anthropic = results.first { $0.provider == .anthropic }
        let openai = results.first { $0.provider == .openai }
        XCTAssertEqual(anthropic?.result.health, .healthy)
        XCTAssertEqual(openai?.result.health, .unavailable(reason: "stub"))
    }

    func testRestoreSelectionRevertsProviderAndClearsReason() async {
        await reliabilityService.record(
            model: "gpt-5",
            provider: .openai,
            baseURL: "https://api.openai.com",
            success: true,
            reason: nil
        )

        _ = await store.selectFirstHealthyCrossProviderModel()
        XCTAssertNotNil(store.crossProviderFailoverReason)

        store.restoreSelection(provider: .anthropic, baseURL: "https://api.anthropic.com", model: "claude-sonnet-4-5")
        XCTAssertEqual(store.selectedProvider, .anthropic)
        XCTAssertEqual(store.selectedModel, "claude-sonnet-4-5")
        XCTAssertEqual(store.baseURL, "https://api.anthropic.com")
        XCTAssertNil(store.crossProviderFailoverReason)
    }

    func testCrossProviderFailoverTogglePersists() {
        XCTAssertFalse(store.isCrossProviderFailoverEnabled)
        store.setCrossProviderFailoverEnabled(true)
        XCTAssertTrue(store.isCrossProviderFailoverEnabled)

        let fresh = ModelConfigurationStore(
            defaults: defaults,
            environment: [:],
            catalogService: ModelCatalogService(),
            statusService: statusService,
            healthService: healthService,
            reliabilityService: reliabilityService
        )
        XCTAssertTrue(fresh.isCrossProviderFailoverEnabled)
    }

    func testResolveContextRoutingDecisionRoutesToLargerCandidate() async {
        store.applySelection(provider: .zai, baseURL: "https://z.ai", model: "glm-5")

        let huge = String(repeating: "word ", count: 30_000)
        let currentMessage = ChatMessage(role: .user, content: huge)
        let candidates = [
            CrossProviderModelCandidate(provider: .openai, baseURL: "https://api.openai.com", model: "gpt-5")
        ]

        let decision = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: [],
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: nil,
            candidates: candidates
        )

        guard case .routeTo(let candidate) = decision else {
            XCTFail("Expected routeTo, got \(decision)")
            return
        }
        XCTAssertEqual(candidate.provider, .openai)
        XCTAssertEqual(candidate.model, "gpt-5")
    }

    func testResolveContextRoutingDecisionTrimsWhenNoLargerCandidateFits() async {
        store.applySelection(provider: .zai, baseURL: "https://z.ai", model: "glm-5")

        let history = [
            ChatMessage(role: .user, content: String(repeating: "old ", count: 20_000)),
            ChatMessage(role: .assistant, content: "ok")
        ]
        let currentMessage = ChatMessage(role: .user, content: String(repeating: "word ", count: 10_000))
        let candidates: [CrossProviderModelCandidate] = []

        let decision = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: history,
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: nil,
            candidates: candidates
        )

        guard case .trimHistory(let policy) = decision else {
            XCTFail("Expected trimHistory, got \(decision)")
            return
        }
        XCTAssertTrue(policy.droppedMessageCount > 0)
    }

    func testResolveContextRoutingDecisionRoutesForOutputBudgetWhenContextFits() async {
        store.applySelection(provider: .zai, baseURL: "https://z.ai", model: "glm-5")

        let history = [ChatMessage(role: .user, content: "hello")]
        let currentMessage = ChatMessage(role: .user, content: "expand")
        let candidates = [
            CrossProviderModelCandidate(provider: .openai, baseURL: "https://api.openai.com", model: "gpt-5")
        ]

        let decision = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: history,
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: 8_192,
            candidates: candidates
        )

        guard case .routeTo(let candidate) = decision else {
            XCTFail("Expected routeTo for output budget, got \(decision)")
            return
        }
        XCTAssertEqual(candidate.provider, .openai)
        XCTAssertEqual(candidate.model, "gpt-5")
        XCTAssertEqual(store.selectedProvider, .openai)
        XCTAssertEqual(store.selectedModel, "gpt-5")
        XCTAssertEqual(store.baseURL, "https://api.openai.com")
        XCTAssertNotNil(store.lastContextRoutingReason)
        XCTAssertTrue(store.lastContextRoutingReason?.contains("output budget") ?? false)
    }

    func testResolveContextRoutingDecisionStaysCurrentWhenNoCandidateSatisfiesOutputBudget() async {
        store.applySelection(provider: .zai, baseURL: "https://z.ai", model: "glm-5")

        let history = [ChatMessage(role: .user, content: "hello")]
        let currentMessage = ChatMessage(role: .user, content: "expand")
        let candidates: [CrossProviderModelCandidate] = []

        let decision = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: history,
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: 8_192,
            candidates: candidates
        )

        guard case .useCurrent = decision else {
            XCTFail("Expected useCurrent when no candidate satisfies output budget, got \(decision)")
            return
        }
        XCTAssertEqual(store.selectedProvider, .zai)
        XCTAssertEqual(store.selectedModel, "glm-5")
        XCTAssertNil(store.lastContextRoutingReason)
    }

    func testLearnedContextLimitTriggersTrimming() async {
        let model = "claude-sonnet-4-5"
        let provider = ModelProvider.anthropic
        let baseURL = "https://api.anthropic.com"
        await StreamingContextLimitLearner.shared.reset(
            model: model,
            provider: provider,
            baseURL: baseURL
        )

        store.applySelection(provider: provider, baseURL: baseURL, model: model)

        let history = [ChatMessage(role: .user, content: String(repeating: "word ", count: 65_000))]
        let currentMessage = ChatMessage(role: .user, content: "continue")
        let candidates: [CrossProviderModelCandidate] = []

        let baseline = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: history,
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: nil,
            candidates: candidates
        )
        guard case .useCurrent = baseline else {
            XCTFail("Expected useCurrent before learned context limit, got \(baseline)")
            return
        }

        for _ in 0..<3 {
            await store.recordSendOutcome(
                model: model,
                provider: provider,
                baseURL: baseURL,
                success: false,
                reason: "context limit",
                observedTotalTokens: 80_000,
                finishReason: nil
            )
        }

        let learned = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: history,
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: nil,
            candidates: candidates
        )
        guard case .trimHistory(let policy) = learned else {
            XCTFail("Expected trimHistory after learned context limit, got \(learned)")
            return
        }
        XCTAssertTrue(policy.droppedMessageCount > 0, "Learned context ceiling should force history trimming")
    }
}

// MARK: - Test doubles

private actor StubModelHealthService: ModelHealthServiceProtocol {
    private var results: [String: ModelHealthResult] = [:]

    func set(result: ModelHealthResult, for model: String, provider: ModelProvider, baseURL: String) {
        results[key(provider: provider, baseURL: baseURL, model: model)] = result
    }

    func probe(model: String, provider: ModelProvider, baseURL: String, apiKey: String?) async -> ModelHealthResult {
        results[key(provider: provider, baseURL: baseURL, model: model)]
            ?? ModelHealthResult(health: .unknown(error: "not stubbed"), latencyMs: nil)
    }

    func invalidate() async {
        results.removeAll()
    }

    private func key(provider: ModelProvider, baseURL: String, model: String) -> String {
        "\(provider.rawValue)|\(baseURL)|\(model)"
    }
}

private actor StubProviderStatusService: ProviderStatusServiceProtocol {
    func status(for model: String, provider: ModelProvider, baseURL: String, apiKey: String?) async -> ProviderModelStatus {
        .present
    }

    func invalidate() async {}
}
