import Foundation

/// Cached result of a predictive background warmup run.
struct CachedWarmupWinner: Equatable, Sendable {
    let selected: CrossProviderModelCandidate
    let computedAt: Date
    let expiresAt: Date
    let reason: String

    /// True when the cache entry is still within its TTL.
    func isFresh(relativeTo now: Date = Date()) -> Bool {
        now < expiresAt
    }

    /// How long the entry has been stale (past its TTL). Zero when still fresh.
    func staleness(relativeTo now: Date = Date()) -> TimeInterval {
        max(0, now.timeIntervalSince(expiresAt))
    }
}

/// In-memory cache for the most recent adaptive warmup winner.
///
/// The chat path can read a fresh winner without blocking on probes, while a
/// background scheduler refreshes the cache periodically. Entries are keyed by
/// the cost tier and strict-quota-gating flag used during the warmup so a
/// change in either produces independent results.
actor PredictiveWarmupCache: Sendable {
    private var entries: [CacheKey: CachedWarmupWinner] = [:]
    private let defaultTTL: TimeInterval

    init(defaultTTL: TimeInterval = 45) {
        self.defaultTTL = max(1, defaultTTL)
    }

    /// Stores the result of a warmup run. The previous entry for the same
    /// (tier, strict gating) combination is replaced.
    /// Records a warmup result. When `ttl` is nil the cache uses its default
    /// TTL; otherwise the per-record value is clamped to at least 1 second.
    func record(
        _ winner: ModelWarmupResult,
        tier: ModelCostTier,
        strictQuotaGating: Bool,
        ttl: TimeInterval? = nil
    ) {
        let key = CacheKey(tier: tier, strictQuotaGating: strictQuotaGating)
        let now = Date()
        let effectiveTTL = ttl.map { max(1, $0) } ?? defaultTTL
        entries[key] = CachedWarmupWinner(
            selected: winner.selected,
            computedAt: now,
            expiresAt: now.addingTimeInterval(effectiveTTL),
            reason: winner.reason
        )
    }

    /// Returns the remaining TTL of the cached winner for the given key, if any.
    func remainingTTL(
        tier: ModelCostTier,
        strictQuotaGating: Bool,
        relativeTo now: Date = Date()
    ) -> TimeInterval? {
        let key = CacheKey(tier: tier, strictQuotaGating: strictQuotaGating)
        guard let entry = entries[key], entry.isFresh(relativeTo: now) else {
            return nil
        }
        return entry.expiresAt.timeIntervalSince(now)
    }

    /// Returns the cached winner if it is still fresh.
    func winner(
        tier: ModelCostTier,
        strictQuotaGating: Bool,
        relativeTo now: Date = Date()
    ) -> CachedWarmupWinner? {
        let key = CacheKey(tier: tier, strictQuotaGating: strictQuotaGating)
        guard let entry = entries[key], entry.isFresh(relativeTo: now) else {
            return nil
        }
        return entry
    }

    /// Returns the cached winner if it is fresh, otherwise a stale entry that is
    /// still within `maxStaleness` seconds of its expiration. This implements
    /// stale-while-revalidate behavior: the send path can serve a recently-valid
    /// winner immediately while the cache refreshes asynchronously in the
    /// background. A negative or zero `maxStaleness` disables stale service.
    func winnerOrStale(
        tier: ModelCostTier,
        strictQuotaGating: Bool,
        maxStaleness: TimeInterval = 0,
        relativeTo now: Date = Date()
    ) -> (winner: CachedWarmupWinner, isStale: Bool)? {
        let key = CacheKey(tier: tier, strictQuotaGating: strictQuotaGating)
        guard let entry = entries[key] else { return nil }
        if entry.isFresh(relativeTo: now) {
            return (entry, false)
        }
        guard maxStaleness > 0,
              now <= entry.expiresAt.addingTimeInterval(maxStaleness) else {
            return nil
        }
        return (entry, true)
    }

    /// Clears every cached entry, e.g. when the user changes API key or endpoint.
    func invalidate() {
        entries.removeAll()
    }

    /// Clears entries that involve a specific provider endpoint.
    func invalidate(provider: ModelProvider, baseURL: String) {
        entries = entries.filter { key, entry in
            !(entry.selected.provider == provider && entry.selected.baseURL == baseURL)
        }
    }

    private struct CacheKey: Hashable, Sendable {
        let tier: ModelCostTier
        let strictQuotaGating: Bool
    }
}
