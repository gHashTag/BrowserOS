import Foundation

/// Tracks how often cached warmup winners succeed or fail on real sends and
/// recommends shorter or longer cache TTL / refresh interval values.
///
/// The tracker keeps a bounded ring of recent outcomes per endpoint so a flaky
/// provider landscape shrinks the cache lifetime and refresh cadence, while a
/// stable landscape lets both relax toward the configured maximums.
actor WarmupVolatilityTracker: Sendable {
    /// Outcome of applying a cached warmup winner to a real chat send.
    /// Failures carry a classified kind so the tracker can weight severe
    /// failures (auth, balance, context-length) differently from transient ones.
    enum Outcome: Sendable {
        case success
        case failure(kind: ProviderCircuitBreakerFailureKind)
    }

    private struct Window: Sendable {
        var successes = 0
        var failures = 0
        /// Failure counts keyed by classified kind. The sum of values must equal
        /// `failures` after any mutation.
        var failureKinds: [ProviderCircuitBreakerFailureKind: Int] = [:]

        var total: Int { successes + failures }

        var failureRate: Double {
            guard total > 0 else { return 0 }
            return Double(failures) / Double(total)
        }

        func failureRate(for kind: ProviderCircuitBreakerFailureKind) -> Double {
            guard failures > 0 else { return 0 }
            return Double(failureKinds[kind, default: 0]) / Double(failures)
        }

        mutating func record(_ outcome: Outcome) {
            switch outcome {
            case .success:
                successes += 1
            case .failure(let kind):
                failures += 1
                failureKinds[kind, default: 0] += 1
            }
        }

        /// Decrements the oldest bucket to keep the window bounded. Failure kind
        /// counts are trimmed by removing from the most common kind first so the
        /// approximate mix is preserved.
        mutating func trim(to windowSize: Int) {
            while total > windowSize {
                if successes > 0 {
                    successes -= 1
                } else if failures > 0 {
                    failures -= 1
                    if let key = failureKinds.max(by: { $0.value < $1.value })?.key,
                       failureKinds[key, default: 0] > 0 {
                        failureKinds[key, default: 0] -= 1
                        if failureKinds[key] == 0 {
                            failureKinds.removeValue(forKey: key)
                        }
                    }
                } else {
                    break
                }
            }
        }

        /// Average `volatilityWeight` across recorded failures. Severe kinds
        /// drive this value toward 0, transient kinds toward higher values.
        var averageFailureSeverity: Double {
            guard failures > 0 else { return 1.0 }
            let weighted = failureKinds.reduce(0.0) { sum, entry in
                sum + Double(entry.value) * entry.key.volatilityWeight
            }
            return max(0.0, min(1.0, weighted / Double(failures)))
        }
    }

    private var windows: [CrossProviderModelCandidate: Window] = [:]
    private let windowSize: Int
    private let minTTL: TimeInterval
    private let maxTTL: TimeInterval
    private let minInterval: TimeInterval
    private let maxInterval: TimeInterval
    private let historyStore: VolatilityHistoryStore?
    private var historyLoaded = false

    init(
        windowSize: Int = 10,
        minTTL: TimeInterval = 15,
        maxTTL: TimeInterval = 300,
        minInterval: TimeInterval = 15,
        maxInterval: TimeInterval = 600,
        historyStore: VolatilityHistoryStore? = nil
    ) {
        self.windowSize = max(1, windowSize)
        self.minTTL = max(1, minTTL)
        self.maxTTL = max(minTTL, maxTTL)
        self.minInterval = max(1, minInterval)
        self.maxInterval = max(minInterval, maxInterval)
        self.historyStore = historyStore
    }

    /// Loads any persisted windows from the backing store. Safe to call multiple
    /// times; subsequent calls are no-ops.
    func loadHistory() async {
        guard let historyStore, !historyLoaded else { return }
        historyLoaded = true

        guard let records = await historyStore.load() else { return }
        for (key, record) in records {
            guard record.version == WarmupVolatilityRecord.currentVersion,
                  record.windowSize == windowSize else { continue }
            guard let candidate = CrossProviderModelCandidate(stableKey: key) else { continue }

            let successCount = record.successes ?? record.outcomes?.filter({ $0 }).count ?? 0
            let failureCount = record.failures ?? record.outcomes?.filter({ !$0 }).count ?? 0
            var kinds = record.failureKinds?.reduce(into: [ProviderCircuitBreakerFailureKind: Int]()) { result, entry in
                guard let kind = ProviderCircuitBreakerFailureKind(rawValue: entry.key) else { return }
                result[kind] = entry.value
            } ?? [:]
            let recordedFailureTotal = kinds.values.reduce(0, +)
            if recordedFailureTotal < failureCount {
                kinds[.unknown, default: 0] += failureCount - recordedFailureTotal
            }

            guard successCount > 0 || failureCount > 0 else { continue }
            windows[candidate] = Window(
                successes: successCount,
                failures: failureCount,
                failureKinds: kinds
            )
        }
    }

    /// Records that the cached winner for `candidate` succeeded or failed and
    /// persists the updated window to the backing store, if any.
    func record(_ outcome: Outcome, for candidate: CrossProviderModelCandidate) async {
        apply(outcome, for: candidate)
        await persist()
    }

    /// Convenience for callers that only know success/failure.
    /// Unknown failures are recorded as `.unknown` so they still contribute to
    /// the overall failure rate but do not trigger severe-kind shrinking.
    func record(success: Bool, for candidate: CrossProviderModelCandidate) async {
        let outcome: Outcome = success ? .success : .failure(kind: .unknown)
        await record(outcome, for: candidate)
    }

    /// Returns the recent failure rate for a candidate, or 0 when unknown.
    func failureRate(for candidate: CrossProviderModelCandidate) -> Double {
        windows[candidate]?.failureRate ?? 0
    }

    /// Returns the fraction of recent failures for `candidate` that belong to a
    /// specific classified kind.
    func failureRate(for kind: ProviderCircuitBreakerFailureKind, candidate: CrossProviderModelCandidate) -> Double {
        windows[candidate]?.failureRate(for: kind) ?? 0
    }

    /// The dominant failure kind for `candidate`, if any failures have been
    /// recorded. Used by UI status badges and kind-aware cooldowns.
    func dominantFailureKind(for candidate: CrossProviderModelCandidate) -> ProviderCircuitBreakerFailureKind? {
        guard let window = windows[candidate], window.failures > 0 else { return nil }
        return window.failureKinds.max(by: { $0.value < $1.value })?.key
    }

    /// Recommends a TTL shorter than `baseTTL` when the recent failure rate is
    /// high or failures are severe, capped between `minTTL` and `maxTTL`.
    /// Severe kinds (auth, balance, context-length) shrink TTL aggressively.
    func recommendedTTL(baseTTL: TimeInterval, for candidate: CrossProviderModelCandidate) -> TimeInterval {
        let boundedBase = max(minTTL, min(maxTTL, baseTTL))
        let rate = failureRate(for: candidate)
        let severity = windows[candidate]?.averageFailureSeverity ?? 1.0
        // Combine failure rate and severity: severe failures shrink the TTL even
        // when they are a minority of the window.
        let scale = (1.0 - rate) * severity
        let scaled = minTTL + (boundedBase - minTTL) * scale
        return max(minTTL, min(maxTTL, scaled))
    }

    /// Recommends a refresh interval shorter than `baseInterval` when the recent
    /// failure rate is high, capped between `minInterval` and `maxInterval`.
    /// Severe kinds push the interval close to the minimum quickly.
    func recommendedInterval(baseInterval: TimeInterval, for candidate: CrossProviderModelCandidate) -> TimeInterval {
        let boundedBase = max(minInterval, min(maxInterval, baseInterval))
        let rate = failureRate(for: candidate)
        let severity = windows[candidate]?.averageFailureSeverity ?? 1.0
        // Square the COMPLEMENT, not the rate.
        //
        // `(1.0 - rate * rate)` makes the complement larger, so for every rate
        // in (0,1) this scale exceeded the TTL scale above - and with equal
        // bases and equal floors that means the refresh interval was always at
        // or beyond the TTL. The doc comment one line up says the opposite, and
        // it is the doc comment that is right: severe kinds must push the
        // interval DOWN quickly.
        //
        // The consequence was backwards where it matters most. The store feeds
        // both formulas from defaults that are equal (predictiveWarmupTTL and
        // predictiveWarmupInterval are both 60), so the warmed entry expired at
        // or before the next scheduled refresh - and when a provider went
        // flaky, precisely when warmup earns its keep, the scheduler backed off
        // instead of tightening and the send path paid a synchronous probe.
        let complement = 1.0 - rate
        let scale = complement * complement * severity
        let scaled = minInterval + (boundedBase - minInterval) * scale
        return max(minInterval, min(maxInterval, scaled))
    }

    /// Recommends a smaller staleness ceiling than `baseMaxStaleness` when there
    /// are any severe failures. If a failure is auth/balance/context-length the
    /// cache should essentially not be served stale.
    func recommendedMaxStaleness(baseMaxStaleness: TimeInterval, for candidate: CrossProviderModelCandidate) -> TimeInterval {
        let boundedBase = max(0, baseMaxStaleness)
        let rate = failureRate(for: candidate)
        let severity = windows[candidate]?.averageFailureSeverity ?? 1.0
        let scale = (1.0 - rate) * severity
        let scaled = boundedBase * scale
        return max(0, min(boundedBase, scaled))
    }

    /// Clears all tracked outcomes, e.g. after the user changes API keys.
    func reset() async {
        windows.removeAll()
        await historyStore?.reset()
    }

    /// The number of candidates with a learned history window.
    var learnedCandidateCount: Int { windows.count }

    /// Whether any persisted or in-memory history has been loaded.
    var hasHistory: Bool { !windows.isEmpty }

    private func apply(_ outcome: Outcome, for candidate: CrossProviderModelCandidate) {
        var window = windows[candidate, default: Window()]
        window.record(outcome)
        window.trim(to: windowSize)
        windows[candidate] = window
    }

    private func persist() async {
        guard let historyStore else { return }
        var records: [String: WarmupVolatilityRecord] = [:]
        let now = Date()
        for (candidate, window) in windows where window.total > 0 {
            let record = WarmupVolatilityRecord(
                successes: window.successes,
                failures: window.failures,
                failureKinds: window.failureKinds,
                windowSize: windowSize,
                updatedAt: now
            )
            records[candidate.stableKey] = record
        }
        await historyStore.save(records)
    }
}

extension CrossProviderModelCandidate {
    /// A stable ASCII key suitable for persistence dictionaries.
    var stableKey: String {
        "\(provider.rawValue)|\(baseURL)|\(model)"
    }

    /// Reconstructs a candidate from a `stableKey`. Returns `nil` if the key
    /// is malformed or the provider value is unknown.
    init?(stableKey: String) {
        let parts = stableKey.split(separator: "|", maxSplits: 2).map(String.init)
        guard parts.count == 3,
              let provider = ModelProvider(rawValue: parts[0]) else { return nil }
        self.init(provider: provider, baseURL: parts[1], model: parts[2])
    }
}
