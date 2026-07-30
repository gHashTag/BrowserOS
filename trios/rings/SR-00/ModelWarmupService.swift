import Foundation

/// Result of a single adaptive warmup probe.
struct ModelWarmupProbeResult: Equatable, Sendable {
    let candidate: CrossProviderModelCandidate
    let health: ModelHealth
    /// Total probe duration in milliseconds, if measured.
    let latencyMs: Int?
}

/// Result of an adaptive provider warmup run.
struct ModelWarmupResult: Equatable, Sendable {
    /// The candidate chosen after the warmup race. Equal to `original` when no
    /// better live option was found.
    let selected: CrossProviderModelCandidate
    /// The originally selected candidate passed into the warmup.
    let original: CrossProviderModelCandidate
    /// Whether the warmup chose a different provider or model.
    let didSwitch: Bool
    /// Every probe that was attempted, successful or not.
    let probes: [ModelWarmupProbeResult]
    /// Total warmup duration in milliseconds.
    let durationMs: Int
    /// Human-readable reason for the selection or non-switch.
    let reason: String
}

/// Adaptive parallel provider warmup.
///
/// Before a real chat request is sent, this service races lightweight
/// `max_tokens: 1` probes across a small set of eligible provider/model
/// candidates. It scores the live results by reliability × latency, records
/// outcomes into the persistent scorecard and circuit breaker, and returns
/// the best candidate. If the current selection is already the best live
/// option, no switch is recommended.
///
/// Cycle 20 introduces this service to reduce the chance that the user burns a
/// full request on a slow or recently-failed provider when a faster one is
/// available.
actor ModelWarmupService: Sendable {
    private let healthService: any ModelHealthServiceProtocol
    private let reliabilityService: ModelReliabilityService
    private let circuitBreaker: ProviderCircuitBreaker
    private let costService: ModelCostService
    private let quotaService: ProviderQuotaService
    private let maxCandidatesPerProvider: Int
    private let maxTotalCandidates: Int
    private let probeTimeout: TimeInterval
    private let switchThreshold: Double

    init(
        healthService: any ModelHealthServiceProtocol,
        reliabilityService: ModelReliabilityService,
        circuitBreaker: ProviderCircuitBreaker,
        costService: ModelCostService = .shared,
        quotaService: ProviderQuotaService = ProviderQuotaService(),
        maxCandidatesPerProvider: Int = 2,
        maxTotalCandidates: Int = 4,
        probeTimeout: TimeInterval = 15,
        switchThreshold: Double = 0.05
    ) {
        self.healthService = healthService
        self.reliabilityService = reliabilityService
        self.circuitBreaker = circuitBreaker
        self.costService = costService
        self.quotaService = quotaService
        self.maxCandidatesPerProvider = max(1, maxCandidatesPerProvider)
        self.maxTotalCandidates = max(1, maxTotalCandidates)
        self.probeTimeout = max(5, probeTimeout)
        self.switchThreshold = max(0, switchThreshold)
    }

    /// Runs adaptive warmup and returns the best live candidate.
    ///
    /// - Parameters:
    ///   - current: The currently active provider/baseURL/model.
    ///   - candidates: Other provider configurations to consider. The caller
    ///     (usually `ModelConfigurationStore`) supplies these from eligible
    ///     providers and their suggested models.
    ///   - apiKeyResolver: Closure returning an API key for a provider.
    ///   - tier: Cost tier filter applied before probing.
    ///   - strictQuotaGating: When true, candidates whose endpoint reports
    ///     depleted quota are excluded entirely. When false, they score zero but
    ///     remain selectable as a last resort.
    func warmup(
        current: CrossProviderModelCandidate,
        candidates: [CrossProviderModelCandidate],
        apiKeyResolver: @escaping @Sendable (ModelProvider) async -> String,
        tier: ModelCostTier = .any,
        strictQuotaGating: Bool = false
    ) async -> ModelWarmupResult {
        let start = Date()
        let allCandidates = uniqueCandidates(prepend: current, to: candidates)
        let eligible = await filteredAndRankedCandidates(
            allCandidates,
            current: current,
            tier: tier
        )

        guard !eligible.isEmpty else {
            return noSwitchResult(
                current: current,
                reason: "No eligible warmup candidates",
                durationMs: durationMs(from: start)
            )
        }

        // Race probes with a per-candidate timeout so a stuck provider cannot
        // block the whole warmup.
        let probeResults = await withTaskGroup(of: ModelWarmupProbeResult.self) { group in
            for candidate in eligible {
                group.addTask {
                    await self.probe(
                        candidate: candidate,
                        apiKey: await apiKeyResolver(candidate.provider)
                    )
                }
            }

            var results: [ModelWarmupProbeResult] = []
            for await result in group {
                results.append(result)
            }
            return results
        }

        let healthyProbes = probeResults.filter { $0.health == .healthy }
        let scored = await scoreCandidates(healthyProbes, current: current, strictQuotaGating: strictQuotaGating)

        guard let best = scored.first else {
            return noSwitchResult(
                current: current,
                probes: probeResults,
                reason: "No healthy candidates found during warmup",
                durationMs: durationMs(from: start)
            )
        }

        let currentScore = scored.first(where: { $0.candidate == current })?.score ?? 0
        let bestScore = best.score
        let shouldSwitch = best.candidate != current
            && bestScore > currentScore + switchThreshold

        let selected = shouldSwitch ? best.candidate : current
        let reason: String
        if shouldSwitch {
            reason = "Warmup: switched to \(selected.provider.displayName)/\(selected.model) (score \(String(format: "%.2f", bestScore)) vs \(String(format: "%.2f", currentScore)))"
        } else {
            reason = "Warmup: keeping \(current.provider.displayName)/\(current.model) (best score \(String(format: "%.2f", bestScore)))"
        }

        return ModelWarmupResult(
            selected: selected,
            original: current,
            didSwitch: shouldSwitch,
            probes: probeResults,
            durationMs: durationMs(from: start),
            reason: reason
        )
    }

    // MARK: - Private helpers

    private func uniqueCandidates(
        prepend current: CrossProviderModelCandidate,
        to candidates: [CrossProviderModelCandidate]
    ) -> [CrossProviderModelCandidate] {
        var seen: Set<CrossProviderModelCandidate> = []
        var result: [CrossProviderModelCandidate] = []
        for candidate in [current] + candidates {
            guard seen.insert(candidate).inserted else { continue }
            result.append(candidate)
        }
        return result
    }

    private func filteredAndRankedCandidates(
        _ candidates: [CrossProviderModelCandidate],
        current: CrossProviderModelCandidate,
        tier: ModelCostTier
    ) async -> [CrossProviderModelCandidate] {
        // Apply cost tier filter.
        var tierFiltered: [CrossProviderModelCandidate] = []
        for candidate in candidates {
            let modelTier = await costService.tier(for: candidate.model, provider: candidate.provider)
            if tier != .any, modelTier != tier { continue }
            tierFiltered.append(candidate)
        }

        // Rank by observed reliability×latency score so the most promising
        // candidates are probed first and the probe budget is spent wisely.
        var scored: [(candidate: CrossProviderModelCandidate, score: Double)] = []
        for candidate in tierFiltered {
            let reliability = await reliabilityService.reliability(
                for: candidate.model,
                provider: candidate.provider,
                baseURL: candidate.baseURL
            )
            let latency = await reliabilityService.latency(
                for: candidate.model,
                provider: candidate.provider,
                baseURL: candidate.baseURL
            )
            let score = ModelReliabilityService.compositeScore(
                reliabilityScore: reliability.score,
                latency: latency,
                sloMs: 5_000
            )
            scored.append((candidate, score))
        }

        scored.sort { left, right in
            if left.score != right.score { return left.score > right.score }
            return providerOrder(left: left.candidate, right: right.candidate, preferred: current)
        }

        // Cap total probes to control cost; keep the current candidate at the
        // front so it is always probed (cache hit when preflight just ran).
        let withCurrentFirst = scored.sorted { left, right in
            if left.candidate == current { return true }
            if right.candidate == current { return false }
            if left.score != right.score { return left.score > right.score }
            return providerOrder(left: left.candidate, right: right.candidate, preferred: current)
        }

        let limited = Array(withCurrentFirst.prefix(maxTotalCandidates))
        return limited.map { $0.candidate }
    }

    private func providerOrder(
        left: CrossProviderModelCandidate,
        right: CrossProviderModelCandidate,
        preferred: CrossProviderModelCandidate
    ) -> Bool {
        if left == preferred { return true }
        if right == preferred { return false }
        if left.provider == preferred.provider, right.provider != preferred.provider { return true }
        if right.provider == preferred.provider, left.provider != preferred.provider { return false }
        let leftIndex = left.provider.suggestedModels.firstIndex(of: left.model) ?? Int.max
        let rightIndex = right.provider.suggestedModels.firstIndex(of: right.model) ?? Int.max
        return leftIndex < rightIndex
    }

    private func probe(
        candidate: CrossProviderModelCandidate,
        apiKey: String
    ) async -> ModelWarmupProbeResult {
        let key = ProviderEndpointKey(provider: candidate.provider, baseURL: candidate.baseURL)

        // Respect the circuit breaker. Closed endpoints are allowed; half-open
        // endpoints require acquiring the single-probe lock; open endpoints are
        // skipped.
        let canSend = await circuitBreaker.canSend(to: key)
        guard canSend else {
            return ModelWarmupProbeResult(
                candidate: candidate,
                health: .unavailable(reason: "Circuit breaker open"),
                latencyMs: nil
            )
        }

        let state = await circuitBreaker.state(for: key)
        let isHalfOpen = state == .halfOpen
        let beganProbe = isHalfOpen ? await circuitBreaker.beginProbe(key) : false

        // Run the probe with a timeout so a stuck endpoint cannot hang warmup.
        let healthResult: ModelHealthResult = await withTimeout(
            seconds: probeTimeout,
            operation: {
                await self.healthService.probe(
                    model: candidate.model,
                    provider: candidate.provider,
                    baseURL: candidate.baseURL,
                    apiKey: apiKey.isEmpty ? nil : apiKey
                )
            },
            fallback: {
                ModelHealthResult(
                    health: .unavailable(reason: "Warmup probe timed out"),
                    latencyMs: nil,
                    failureKind: .timeout,
                    retryAfter: nil
                )
            }
        )

        // Record into the persistent reliability scorecard regardless of breaker
        // state, so history is kept up to date.
        await reliabilityService.recordHealth(
            model: candidate.model,
            provider: candidate.provider,
            baseURL: candidate.baseURL,
            health: healthResult.health,
            latencyMs: healthResult.latencyMs
        )

        // Keep the quota service up to date with the latest probe signal.
        await quotaService.record(
            provider: candidate.provider,
            baseURL: candidate.baseURL,
            quota: healthResult.quota
        )

        // If this was a half-open recovery probe, close or re-trip the breaker.
        if isHalfOpen, beganProbe {
            await circuitBreaker.endProbe(key, success: healthResult.health == .healthy)
        }

        // For closed endpoints, only record breaker failures; successes are
        // left to the real request so the breaker is not constantly nudged by
        // cheap probes.
        if healthResult.health != .healthy {
            let kind = healthResult.failureKind ?? healthResult.health.circuitBreakerFailureKind
            await circuitBreaker.recordFailure(
                key,
                kind: kind,
                retryAfter: healthResult.retryAfter
            )
        }

        return ModelWarmupProbeResult(
            candidate: candidate,
            health: healthResult.health,
            latencyMs: healthResult.latencyMs
        )
    }

    private func scoreCandidates(
        _ probes: [ModelWarmupProbeResult],
        current: CrossProviderModelCandidate,
        strictQuotaGating: Bool
    ) async -> [(candidate: CrossProviderModelCandidate, score: Double)] {
        var scored: [(candidate: CrossProviderModelCandidate, score: Double)] = []
        for probe in probes {
            let quota = await quotaService.status(for: probe.candidate.provider, baseURL: probe.candidate.baseURL)

            // Strict gating: exclude depleted endpoints unless they are the only
            // remaining option (handled by not excluding the current candidate).
            if strictQuotaGating, quota.isDepleted, probe.candidate != current {
                continue
            }

            let reliability = await reliabilityService.reliability(
                for: probe.candidate.model,
                provider: probe.candidate.provider,
                baseURL: probe.candidate.baseURL
            )
            let latency = await reliabilityService.latency(
                for: probe.candidate.model,
                provider: probe.candidate.provider,
                baseURL: probe.candidate.baseURL
            )
            let baseScore = ModelReliabilityService.compositeScore(
                reliabilityScore: reliability.score,
                latency: latency,
                sloMs: 5_000
            )
            let score = applyQuotaMultiplier(baseScore, quota: quota)
            scored.append((probe.candidate, score))
        }
        return scored.sorted { left, right in
            if left.score != right.score { return left.score > right.score }
            if left.candidate == current { return true }
            if right.candidate == current { return false }
            return providerOrder(left: left.candidate, right: right.candidate, preferred: current)
        }
    }

    private func applyQuotaMultiplier(_ score: Double, quota: ProviderQuotaStatus) -> Double {
        switch quota {
        case .unknown:
            return score * 0.9
        case .healthy:
            return score
        case .low:
            return score * 0.5
        case .depleted:
            return 0
        }
    }

    private func noSwitchResult(
        current: CrossProviderModelCandidate,
        probes: [ModelWarmupProbeResult] = [],
        reason: String,
        durationMs: Int
    ) -> ModelWarmupResult {
        ModelWarmupResult(
            selected: current,
            original: current,
            didSwitch: false,
            probes: probes,
            durationMs: durationMs,
            reason: reason
        )
    }

    private func durationMs(from start: Date) -> Int {
        Int(max(0, Date().timeIntervalSince(start) * 1000))
    }
}

extension ModelHealth {
    /// Maps a health-probe outcome to a circuit-breaker failure kind.
    /// Health probes intentionally return `.unknown` for auth/balance issues
    /// (not a model problem), so those do not trip the breaker.
    var circuitBreakerFailureKind: ProviderCircuitBreakerFailureKind {
        switch self {
        case .healthy:
            return .unknown
        case .unavailable(let reason):
            let lower = reason.lowercased()
            if lower.contains("rate") || lower.contains("429") { return .rateLimit }
            if lower.contains("auth") || lower.contains("401") || lower.contains("403") { return .auth }
            if lower.contains("balance") || lower.contains("402") { return .balance }
            if lower.contains("not found") || lower.contains("404") || lower.contains("422") { return .modelUnavailable }
            if lower.contains("gateway") || lower.contains("502") || lower.contains("503") || lower.contains("504") {
                return .gateway
            }
            if lower.contains("time") || lower.contains("network") { return .connection }
            return .gateway
        case .unknown:
            return .unknown
        }
    }
}

/// Runs an async operation with a timeout, returning the fallback if the
/// deadline is exceeded. This is a lightweight alternative to `withThrowingTaskGroup`
/// for simple timeouts.
private func withTimeout<T: Sendable>(
    seconds: TimeInterval,
    operation: @escaping @Sendable () async -> T,
    fallback: @escaping @Sendable () -> T
) async -> T {
    await withTaskGroup(of: T.self) { group in
        group.addTask {
            await operation()
        }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            return fallback()
        }
        guard let result = await group.next() else {
            return fallback()
        }
        group.cancelAll()
        return result
    }
}
