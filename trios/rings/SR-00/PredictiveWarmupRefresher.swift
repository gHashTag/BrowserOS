import Foundation

/// Coalesced background refresher for the predictive warmup cache.
///
/// When the chat send path discovers a stale cached winner, it can trigger a
/// background refresh. This actor guarantees that at most one refresh is in
/// flight at a time; overlapping requests attach to the existing refresh instead
/// of spawning duplicate probe races.
actor PredictiveWarmupRefresher: Sendable {
    private let store: ModelConfigurationStore
    private var refreshTask: Task<Void, Never>?

    init(store: ModelConfigurationStore) {
        self.store = store
    }

    /// True while a background refresh is running.
    var isRefreshing: Bool {
        guard let task = refreshTask else { return false }
        return !task.isCancelled
    }

    /// Triggers one background adaptive warmup refresh. If a refresh is already
    /// in flight, this call awaits the existing refresh so callers never pay for
    /// two concurrent probe races.
    func refresh() async {
        if let existing = refreshTask, !existing.isCancelled {
            await existing.value
            return
        }
        let task = Task { [weak self] in
            guard let self else { return }
            await self.performRefresh()
        }
        refreshTask = task
        await task.value
    }

    /// Performs the actual refresh and clears the in-flight task marker.
    private func performRefresh() async {
        _ = await store.forcePredictiveWarmupRefresh()
        refreshTask = nil
    }
}
