import Foundation
import XCTest
@testable import TriOSKit

private actor MockHealthService: ModelHealthServiceProtocol {
    private(set) var probeCount = 0

    func probe(
        model: String,
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> ModelHealthResult {
        probeCount += 1
        return ModelHealthResult(health: .healthy, latencyMs: 10)
    }

    func invalidate() async {
        probeCount = 0
    }

    func callCount() -> Int { probeCount }
}

final class PredictiveWarmupSchedulerTests: XCTestCase {
    private var defaults: UserDefaults!
    private var healthService: MockHealthService!
    private var store: ModelConfigurationStore!

    override func setUp() {
        defaults = UserDefaults(suiteName: "PredictiveWarmupSchedulerTests-\(UUID().uuidString)")
        healthService = MockHealthService()
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

    func testForceRefreshRunsWarmup() async {
        let scheduler = PredictiveWarmupScheduler(store: store, interval: 1)
        await scheduler.forceRefresh()

        let count = await healthService.callCount()
        XCTAssertGreaterThan(count, 0)
        let cached = await store.warmupCacheForTests.winner(tier: .any, strictQuotaGating: false)
        XCTAssertNotNil(cached)
    }

    func testStartTriggersPeriodicRefresh() async throws {
        let scheduler = PredictiveWarmupScheduler(store: store, interval: 0.5)
        await scheduler.start()
        defer { await scheduler.stop() }

        try await Task.sleep(nanoseconds: 600_000_000)

        let count = await healthService.callCount()
        XCTAssertGreaterThanOrEqual(count, 1)
    }

    func testLowPowerModeSkipsRefresh() async throws {
        var lowPower = true
        let scheduler = PredictiveWarmupScheduler(
            store: store,
            interval: 0.2,
            isLowPowerModeEnabled: { lowPower }
        )
        await scheduler.start()
        defer { await scheduler.stop() }

        try await Task.sleep(nanoseconds: 400_000_000)

        let count = await healthService.callCount()
        XCTAssertEqual(count, 0)

        lowPower = false
        await scheduler.forceRefresh()

        let countAfter = await healthService.callCount()
        XCTAssertGreaterThan(countAfter, 0)
    }

    func testDisabledPredictiveWarmupSkipsRefresh() async throws {
        store.setPredictiveWarmupEnabled(false)

        let scheduler = PredictiveWarmupScheduler(store: store, interval: 0.2)
        await scheduler.start()
        defer { await scheduler.stop() }

        try await Task.sleep(nanoseconds: 400_000_000)

        let count = await healthService.callCount()
        XCTAssertEqual(count, 0)
    }

    func testStopCancelsScheduledWork() async throws {
        let scheduler = PredictiveWarmupScheduler(store: store, interval: 0.1)
        await scheduler.start()
        try await Task.sleep(nanoseconds: 50_000_000)
        await scheduler.stop()

        let countAfterStop = await healthService.callCount()
        try await Task.sleep(nanoseconds: 400_000_000)
        let countLater = await healthService.callCount()

        XCTAssertEqual(countAfterStop, countLater)
    }

    func testRestartChangesIntervalAndKeepsRunning() async throws {
        let scheduler = PredictiveWarmupScheduler(store: store, interval: 2)
        await scheduler.start()
        defer { await scheduler.stop() }

        await scheduler.restart(interval: 0.2)
        let before = await healthService.callCount()
        try await Task.sleep(nanoseconds: 700_000_000)
        let after = await healthService.callCount()

        XCTAssertGreaterThan(after, before)
    }
}
