import Foundation

/// Autonomous background poller that keeps the model catalog health state
/// up to date without waiting for the user to send a message or tap the
/// Health button.
///
/// Owned by `ModelConfigurationStore` so it survives ViewModel lifecycle. It
/// probes every known model in parallel on a fixed interval, applies the
/// same two-failure threshold used by `ModelHealthService`, and publishes a
/// fresh `unhealthyModels` snapshot plus a `lastCheckAt` timestamp.
@MainActor
final class BackgroundHealthPoller: ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var lastCheckAt: Date?

    private let store: ModelConfigurationStore
    private let interval: TimeInterval
    private var task: Task<Void, Never>?
    private var checkCount: UInt64 = 0

    init(
        store: ModelConfigurationStore,
        interval: TimeInterval = 60
    ) {
        self.store = store
        self.interval = max(10, interval)
    }

    /// Start periodic health checks. Safe to call multiple times.
    func start() {
        guard task == nil || task?.isCancelled == true else { return }
        isRunning = true
        task = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await self.runSingleCheck()
                try? await Task.sleep(nanoseconds: UInt64(self.interval * 1_000_000_000))
            }
        }
    }

    /// Stop the background loop. Safe to call multiple times.
    func stop() {
        task?.cancel()
        task = nil
        isRunning = false
    }

    /// Run one check immediately and return when done. Useful for the
    /// manual Health button and for the first check on app launch.
    func forceRefresh() async {
        await runSingleCheck()
    }

    private func runSingleCheck() async {
        checkCount &+= 1
        let currentCount = checkCount
        await store.refreshHealth()
        guard currentCount == checkCount, !Task.isCancelled else { return }
        lastCheckAt = Date()
    }

    deinit {
        task?.cancel()
    }
}
