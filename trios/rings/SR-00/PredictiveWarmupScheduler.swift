import Foundation

/// Background scheduler that keeps the predictive warmup cache fresh.
///
/// Runs adaptive warmup on a fixed interval via `ModelConfigurationStore`,
/// which records the winning candidate in `PredictiveWarmupCache`. Work is skipped
/// when the device is in low-power mode; when the network is unreachable the
/// warmup probes fail fast on their own and update the circuit breaker.
actor PredictiveWarmupScheduler: Sendable {
    private let store: ModelConfigurationStore
    private var interval: TimeInterval
    private let isLowPowerModeEnabled: () -> Bool
    private var task: Task<Void, Never>?
    private var isRunning = false

    init(
        store: ModelConfigurationStore,
        interval: TimeInterval = 60,
        isLowPowerModeEnabled: @escaping () -> Bool = { ProcessInfo.processInfo.isLowPowerModeEnabled }
    ) {
        self.store = store
        self.interval = max(10, interval)
        self.isLowPowerModeEnabled = isLowPowerModeEnabled
    }

    /// Starts periodic background warmup. Safe to call multiple times.
    func start() {
        guard task == nil || task?.isCancelled == true else { return }
        isRunning = true
        task = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await self.runSingleRefresh()
                try? await Task.sleep(nanoseconds: UInt64(self.interval * 1_000_000_000))
            }
        }
    }

    /// Stops the background loop. Safe to call multiple times.
    func stop() {
        task?.cancel()
        task = nil
        isRunning = false
    }

    /// Stops and immediately restarts the loop with a new interval.
    func restart(interval: TimeInterval) {
        stop()
        self.interval = max(10, interval)
        start()
    }

    /// Runs one refresh immediately and returns when done.
    func forceRefresh() async {
        await runSingleRefresh()
    }

    /// True while the scheduler loop is active.
    var running: Bool { isRunning }

    private func runSingleRefresh() async {
        guard !isLowPowerModeEnabled() else { return }
        let adaptiveEnabled = await store.isAdaptiveProviderWarmupEnabled
        let predictiveEnabled = await store.isPredictiveWarmupEnabled
        guard adaptiveEnabled else { return }
        guard predictiveEnabled else { return }

        _ = await store.runAdaptiveWarmup()
    }

    deinit {
        task?.cancel()
    }
}
