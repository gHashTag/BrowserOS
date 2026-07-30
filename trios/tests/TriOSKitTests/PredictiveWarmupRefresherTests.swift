import Foundation
import XCTest
@testable import TriOSKit

private actor SlowMockHealthService: ModelHealthServiceProtocol {
    private(set) var probeCount = 0
    private let delay: Duration

    init(delay: Duration = .milliseconds(100)) {
        self.delay = delay
    }

    func probe(
        model: String,
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> ModelHealthResult {
        probeCount += 1
        try? await Task.sleep(for: delay)
        return ModelHealthResult(health: .healthy, latencyMs: 10)
    }

    func invalidate() async {
        probeCount = 0
    }

    func callCount() -> Int { probeCount }
}

// @MainActor for the same reason as the scheduler suite: setUp builds a
// ModelConfigurationStore, which is main-actor isolated, and so are the setters
// the tests use to arrange each case.
@MainActor
final class PredictiveWarmupRefresherTests: XCTestCase {
    private var defaults: UserDefaults!
    private var healthService: SlowMockHealthService!
    private var store: ModelConfigurationStore!

    override func setUp() {
        defaults = UserDefaults(suiteName: "PredictiveWarmupRefresherTests-\(UUID().uuidString)")
        healthService = SlowMockHealthService()
        store = ModelConfigurationStore(
            defaults: defaults,
            environment: [
                "TRIOS_PROVIDER": ModelProvider.ollama.rawValue,
                "TRIOS_MODEL": "llama3.1",
                "TRIOS_BASE_URL": "http://localhost:11434"
            ],
            catalogService: ModelCatalogService(),
            statusService: ProviderStatusService(),
            healthService: healthService,
            reliabilityService: nil,
            costService: .shared,
            circuitBreaker: nil,
            quotaService: nil,
            warmupCache: PredictiveWarmupCache(defaultTTL: 10)
        )
        store.setAdaptiveProviderWarmupEnabled(true)
        store.setPredictiveWarmupEnabled(true)
    }

    override func tearDown() async throws {
        store.setPredictiveWarmupEnabled(false)
        await store.stopPredictiveWarmup()
        store.stopBackgroundHealthChecks()
    }

    func testRefreshCoalescesConcurrentRequests() async throws {
        let refresher = await store.warmupRefresherForTests

        async let first: Void = refresher.refresh()
        async let second: Void = refresher.refresh()
        async let third: Void = refresher.refresh()

        let observed1 = await refresher.isRefreshing

        XCTAssertTrue(observed1)

        _ = await (first, second, third)
        try await Task.sleep(nanoseconds: 50_000_000)

        let observed2 = await refresher.isRefreshing

        XCTAssertFalse(observed2)
        let count = await healthService.callCount()
        XCTAssertGreaterThan(count, 0)
    }

    func testSequentialRefreshStartsNewTask() async throws {
        let refresher = await store.warmupRefresherForTests

        await refresher.refresh()
        try await Task.sleep(nanoseconds: 50_000_000)

        let before = await healthService.callCount()

        await refresher.refresh()
        try await Task.sleep(nanoseconds: 50_000_000)

        let after = await healthService.callCount()
        XCTAssertGreaterThan(after, before)
    }

    func testRefreshUpdatesCache() async throws {
        let refresher = await store.warmupRefresherForTests

        let cachedBefore = await store.warmupCacheForTests.winner(tier: .any, strictQuotaGating: false)
        XCTAssertNil(cachedBefore)

        await refresher.refresh()
        try await Task.sleep(nanoseconds: 50_000_000)

        let cachedAfter = await store.warmupCacheForTests.winner(tier: .any, strictQuotaGating: false)
        XCTAssertNotNil(cachedAfter)
        XCTAssertNotNil(store.lastPredictiveWarmupAt)
    }

    func testStoreBackgroundRefreshIsCoalesced() async throws {
        store.refreshWarmupCacheInBackground()
        store.refreshWarmupCacheInBackground()
        store.refreshWarmupCacheInBackground()

        let observed3 = await store.isWarmupCacheRefreshing

        XCTAssertTrue(observed3)

        while await store.isWarmupCacheRefreshing {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        try await Task.sleep(nanoseconds: 50_000_000)

        let count = await healthService.callCount()
        XCTAssertGreaterThan(count, 0)
    }
}
