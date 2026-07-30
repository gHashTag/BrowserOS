import Foundation
import XCTest
@testable import TriOSKit

private actor MockHealthService: ModelHealthServiceProtocol {
    var results: [String: ModelHealthResult] = [:]
    private(set) var probeCount = 0

    func setResult(_ result: ModelHealthResult, for key: String) {
        results[key] = result
    }

    func probe(
        model: String,
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> ModelHealthResult {
        probeCount += 1
        let key = "\(provider.rawValue)|\(baseURL)|\(model)"
        return results[key] ?? ModelHealthResult(health: .unknown(error: "no mock"), latencyMs: nil)
    }

    func invalidate() async {
        results.removeAll()
    }
}

final class ModelWarmupServiceTests: XCTestCase {
    private var store: VolatileMemoryStore!
    private var adapter: MemoryStoreReliabilityAdapter!
    private var reliabilityService: ModelReliabilityService!
    private var healthService: MockHealthService!
    private var circuitBreaker: ProviderCircuitBreaker!
    private var warmupService: ModelWarmupService!

    override func setUp() async throws {
        store = VolatileMemoryStore()
        adapter = MemoryStoreReliabilityAdapter(store: store)
        reliabilityService = ModelReliabilityService(store: adapter, historyLimit: 20, emaAlpha: 0.3)
        healthService = MockHealthService()
        circuitBreaker = ProviderCircuitBreaker()
        warmupService = ModelWarmupService(
            healthService: healthService,
            reliabilityService: reliabilityService,
            circuitBreaker: circuitBreaker,
            costService: .shared,
            maxTotalCandidates: 4,
            probeTimeout: 5
        )
    }

    private func current(
        provider: ModelProvider = .anthropic,
        baseURL: String = "https://api.anthropic.com",
        model: String = "claude-sonnet-4-5"
    ) -> CrossProviderModelCandidate {
        CrossProviderModelCandidate(provider: provider, baseURL: baseURL, model: model)
    }

    func testKeepsCurrentWhenItIsHealthyAndBest() async {
        let current = current()
        let key = "anthropic|https://api.anthropic.com|claude-sonnet-4-5"
        await healthService.setResult(
            ModelHealthResult(health: .healthy, latencyMs: 100),
            for: key
        )

        let result = await warmupService.warmup(
            current: current,
            candidates: [],
            apiKeyResolver: { _ in "test-key" },
            tier: .any
        )

        XCTAssertFalse(result.didSwitch)
        XCTAssertEqual(result.selected, current)
        XCTAssertEqual(result.probes.count, 1)
    }

    func testSwitchesWhenAnotherCandidateIsFaster() async {
        let current = current(model: "claude-opus-4-5")
        let slowKey = "anthropic|https://api.anthropic.com|claude-opus-4-5"
        let fastKey = "zai|https://api.z.ai/api/paas/v4|glm-5-turbo"

        await healthService.setResult(
            ModelHealthResult(health: .healthy, latencyMs: 2_000),
            for: slowKey
        )
        await healthService.setResult(
            ModelHealthResult(health: .healthy, latencyMs: 100),
            for: fastKey
        )

        let result = await warmupService.warmup(
            current: current,
            candidates: [
                CrossProviderModelCandidate(provider: .zai, baseURL: "https://api.z.ai/api/paas/v4", model: "glm-5-turbo")
            ],
            apiKeyResolver: { _ in "test-key" },
            tier: .any
        )

        XCTAssertTrue(result.didSwitch)
        XCTAssertEqual(result.selected.provider, .zai)
        XCTAssertEqual(result.selected.model, "glm-5-turbo")
    }

    func testRespectsCircuitBreakerOpenState() async {
        let openKey = ProviderEndpointKey(provider: .openai, baseURL: "https://api.openai.com")
        await circuitBreaker.recordFailure(openKey, kind: .gateway)
        await circuitBreaker.recordFailure(openKey, kind: .gateway)

        let current = current(provider: .anthropic)
        let openCandidate = CrossProviderModelCandidate(
            provider: .openai,
            baseURL: "https://api.openai.com",
            model: "gpt-5"
        )

        let result = await warmupService.warmup(
            current: current,
            candidates: [openCandidate],
            apiKeyResolver: { _ in "test-key" },
            tier: .any
        )

        XCTAssertFalse(result.didSwitch)
        let openProbe = result.probes.first { $0.candidate == openCandidate }
        XCTAssertNotNil(openProbe)
        if let openProbe = openProbe {
            XCTAssertEqual(openProbe.health, .unavailable(reason: "Circuit breaker open"))
        }
    }

    func testRecordsProbeOutcomesInReliabilityService() async {
        let current = current()
        let key = "anthropic|https://api.anthropic.com|claude-sonnet-4-5"
        await healthService.setResult(
            ModelHealthResult(health: .healthy, latencyMs: 100),
            for: key
        )

        _ = await warmupService.warmup(
            current: current,
            candidates: [],
            apiKeyResolver: { _ in "test-key" },
            tier: .any
        )

        let reliability = await reliabilityService.reliability(
            for: current.model,
            provider: current.provider,
            baseURL: current.baseURL
        )
        XCTAssertEqual(reliability.totalOutcomes, 1)
        XCTAssertEqual(reliability.failureStreak, 0)
    }

    func testFiltersByCostTier() async {
        let current = current(model: "claude-opus-4-5") // premium
        let cheapCandidate = CrossProviderModelCandidate(
            provider: .zai,
            baseURL: "https://api.z.ai/api/paas/v4",
            model: "glm-4.7-flash" // cheap
        )

        await healthService.setResult(
            ModelHealthResult(health: .healthy, latencyMs: 100),
            for: "anthropic|https://api.anthropic.com|claude-opus-4-5"
        )
        await healthService.setResult(
            ModelHealthResult(health: .healthy, latencyMs: 100),
            for: "zai|https://api.z.ai/api/paas/v4|glm-4.7-flash"
        )

        let result = await warmupService.warmup(
            current: current,
            candidates: [cheapCandidate],
            apiKeyResolver: { _ in "test-key" },
            tier: .cheap
        )

        XCTAssertTrue(result.didSwitch)
        XCTAssertEqual(result.selected, cheapCandidate)
    }

    func testNoSwitchWhenImprovementIsBelowThreshold() async {
        let current = current(model: "claude-sonnet-4-5")
        let slightlyFaster = CrossProviderModelCandidate(
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            model: "claude-haiku-4-5"
        )

        await healthService.setResult(
            ModelHealthResult(health: .healthy, latencyMs: 100),
            for: "anthropic|https://api.anthropic.com|claude-sonnet-4-5"
        )
        await healthService.setResult(
            ModelHealthResult(health: .healthy, latencyMs: 90),
            for: "anthropic|https://api.anthropic.com|claude-haiku-4-5"
        )

        let result = await warmupService.warmup(
            current: current,
            candidates: [slightlyFaster],
            apiKeyResolver: { _ in "test-key" },
            tier: .any
        )

        XCTAssertFalse(result.didSwitch)
    }

    func testStrictQuotaGatingExcludesDepletedCandidate() async {
        let current = current(
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            model: "claude-sonnet-4-5"
        )
        let depletedCandidate = CrossProviderModelCandidate(
            provider: .zai,
            baseURL: "https://api.z.ai/api/paas/v4",
            model: "glm-5-turbo"
        )

        await healthService.setResult(
            ModelHealthResult(health: .healthy, latencyMs: 100),
            for: "anthropic|https://api.anthropic.com|claude-sonnet-4-5"
        )
        await healthService.setResult(
            ModelHealthResult(health: .healthy, latencyMs: 50),
            for: "zai|https://api.z.ai/api/paas/v4|glm-5-turbo"
        )

        let quotaService = ProviderQuotaService()
        await quotaService.record(
            provider: .zai,
            baseURL: "https://api.z.ai/api/paas/v4",
            quota: .depleted(reason: "Quota exhausted")
        )

        let gatedService = ModelWarmupService(
            healthService: healthService,
            reliabilityService: reliabilityService,
            circuitBreaker: circuitBreaker,
            costService: .shared,
            quotaService: quotaService,
            maxTotalCandidates: 4,
            probeTimeout: 5
        )

        let result = await gatedService.warmup(
            current: current,
            candidates: [depletedCandidate],
            apiKeyResolver: { _ in "test-key" },
            tier: .any,
            strictQuotaGating: true
        )

        XCTAssertFalse(result.didSwitch, "Depleted candidate should be excluded under strict gating")
        XCTAssertEqual(result.selected, current)
    }

    func testLowQuotaDeprioritizesCandidate() async {
        let current = current(
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            model: "claude-sonnet-4-5"
        )
        let lowCandidate = CrossProviderModelCandidate(
            provider: .zai,
            baseURL: "https://api.z.ai/api/paas/v4",
            model: "glm-5-turbo"
        )

        await healthService.setResult(
            ModelHealthResult(health: .healthy, latencyMs: 100),
            for: "anthropic|https://api.anthropic.com|claude-sonnet-4-5"
        )
        await healthService.setResult(
            ModelHealthResult(health: .healthy, latencyMs: 100),
            for: "zai|https://api.z.ai/api/paas/v4|glm-5-turbo"
        )

        // Seed identical reliability history so the only differentiator is quota.
        await reliabilityService.record(
            model: current.model,
            provider: current.provider,
            baseURL: current.baseURL,
            success: true,
            latencyMs: 100
        )
        await reliabilityService.record(
            model: lowCandidate.model,
            provider: lowCandidate.provider,
            baseURL: lowCandidate.baseURL,
            success: true,
            latencyMs: 100
        )

        let quotaService = ProviderQuotaService()
        await quotaService.record(
            provider: .zai,
            baseURL: "https://api.z.ai/api/paas/v4",
            quota: .low(remainingRequests: 2, remainingTokens: nil)
        )

        let gatedService = ModelWarmupService(
            healthService: healthService,
            reliabilityService: reliabilityService,
            circuitBreaker: circuitBreaker,
            costService: .shared,
            quotaService: quotaService,
            maxTotalCandidates: 4,
            probeTimeout: 5
        )

        let result = await gatedService.warmup(
            current: current,
            candidates: [lowCandidate],
            apiKeyResolver: { _ in "test-key" },
            tier: .any,
            strictQuotaGating: false
        )

        XCTAssertFalse(result.didSwitch, "Low-quota candidate should be deprioritized")
    }
}
