import Foundation

/// Tracks the latest quota/balance snapshot per provider endpoint.
///
/// `ModelHealthService` records snapshots from probe response headers. The
/// warmup service reads them to deprioritize or exclude endpoints with low or
/// depleted quota. The store is in-memory only; probes refresh it on every
/// warmup run.
actor ProviderQuotaService: Sendable {
    private var snapshots: [ProviderEndpointKey: ProviderQuotaStatus] = [:]

    /// Records the latest quota status for a provider endpoint.
    func record(provider: ModelProvider, baseURL: String, quota: ProviderQuotaStatus) {
        let key = ProviderEndpointKey(provider: provider, baseURL: baseURL)
        snapshots[key] = quota
    }

    /// Returns the latest known quota status, or `.unknown` if no snapshot exists.
    func status(for provider: ModelProvider, baseURL: String) -> ProviderQuotaStatus {
        let key = ProviderEndpointKey(provider: provider, baseURL: baseURL)
        return snapshots[key] ?? .unknown
    }

    /// Clears all snapshots, e.g. when the user changes an API key or endpoint.
    func invalidate() {
        snapshots.removeAll()
    }
}
