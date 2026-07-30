import Foundation

/// A single observed outcome for a model + provider + endpoint tuple.
struct ModelOutcome: Identifiable, Codable, Sendable, Equatable {
    let id: UUID
    let model: String
    let provider: ModelProvider
    let baseURL: String
    let success: Bool
    let reason: String?
    let timestamp: Date
    /// Total request/probe duration in milliseconds, if measured.
    let latencyMs: Int?
    /// Time from request start to first streamed token in milliseconds, if measured.
    let timeToFirstTokenMs: Int?
    /// Observed output-token count for the finished stream, if known.
    let observedOutputTokens: Int?
    /// Observed total-token count (input + output estimate), if known.
    let observedTotalTokens: Int?
    /// Provider `finish_reason` for the stream, e.g. "stop" or "length".
    let finishReason: String?

    init(
        id: UUID = UUID(),
        model: String,
        provider: ModelProvider,
        baseURL: String,
        success: Bool,
        reason: String? = nil,
        timestamp: Date = Date(),
        latencyMs: Int? = nil,
        timeToFirstTokenMs: Int? = nil,
        observedOutputTokens: Int? = nil,
        observedTotalTokens: Int? = nil,
        finishReason: String? = nil
    ) {
        self.id = id
        self.model = model
        self.provider = provider
        self.baseURL = baseURL
        self.success = success
        self.reason = reason
        self.timestamp = timestamp
        self.latencyMs = latencyMs
        self.timeToFirstTokenMs = timeToFirstTokenMs
        self.observedOutputTokens = observedOutputTokens
        self.observedTotalTokens = observedTotalTokens
        self.finishReason = finishReason
    }
}

/// Aggregated reliability signal for one model.
struct ModelReliability: Equatable, Sendable {
    let score: Double
    let totalOutcomes: Int
    let failureStreak: Int

    init(score: Double, totalOutcomes: Int, failureStreak: Int) {
        self.score = max(0, min(1, score))
        self.totalOutcomes = max(0, totalOutcomes)
        self.failureStreak = max(0, failureStreak)
    }

    var isHealthy: Bool { score >= 0.5 && failureStreak < 3 }
}

/// Aggregated latency signal for one model.
struct ModelLatency: Equatable, Sendable {
    /// Primary latency used for ranking: TTFT when available, otherwise total duration.
    let perceivedEmaMs: Double
    let perceivedAvgMs: Double
    let minMs: Int
    let maxMs: Int
    let totalCount: Int
    /// EMA of total request/probe duration, when measured.
    let totalEmaMs: Double?
    /// EMA of time-to-first-token, when measured.
    let ttftEmaMs: Double?

    init(
        perceivedEmaMs: Double,
        perceivedAvgMs: Double,
        minMs: Int,
        maxMs: Int,
        totalCount: Int,
        totalEmaMs: Double? = nil,
        ttftEmaMs: Double? = nil
    ) {
        self.perceivedEmaMs = max(0, perceivedEmaMs)
        self.perceivedAvgMs = max(0, perceivedAvgMs)
        self.minMs = max(0, minMs)
        self.maxMs = max(0, maxMs)
        self.totalCount = max(0, totalCount)
        self.totalEmaMs = totalEmaMs
        self.ttftEmaMs = ttftEmaMs
    }

    var isAvailable: Bool { totalCount > 0 }
}

/// A concrete model choice on a specific provider endpoint.
struct CrossProviderModelCandidate: Equatable, Hashable, Sendable {
    let provider: ModelProvider
    let baseURL: String
    let model: String
}

/// Protocol for storing and retrieving per-model outcomes.
protocol ModelReliabilityStoreProtocol: Sendable {
    func saveOutcome(_ outcome: ModelOutcome) async throws
    func outcomes(
        for model: String,
        provider: ModelProvider,
        baseURL: String,
        limit: Int
    ) async throws -> [ModelOutcome]
    func deleteOutcomes(
        for model: String,
        provider: ModelProvider,
        baseURL: String
    ) async throws
}

/// Persists and aggregates per-model reliability scores.
///
/// Uses a bounded history of outcomes per model and an exponential moving
/// average (EMA) to smooth transient blips. The score is independent from the
/// in-memory `unhealthyModels` set: it is a longer-term ranking signal, while
/// `unhealthyModels` remains the fast fail-fast flag.
///
/// Cycle 17 adds latency-aware ranking. Composite score blends the binary
/// success EMA with a latency penalty derived from observed TTFT/total latency,
/// so fast models rise and slow models fall without ever dropping a candidate
/// to zero purely from latency.
actor ModelReliabilityService: Sendable {
    private let store: any ModelReliabilityStoreProtocol
    private let historyLimit: Int
    private let emaAlpha: Double
    private let latencySLOMs: Double

    init(
        store: any ModelReliabilityStoreProtocol,
        historyLimit: Int = 20,
        emaAlpha: Double = 0.3,
        latencySLOMs: Double = 5_000
    ) {
        self.store = store
        self.historyLimit = max(1, historyLimit)
        self.emaAlpha = max(0.01, min(1, emaAlpha))
        self.latencySLOMs = max(100, latencySLOMs)
    }

    /// Records a successful or failed outcome for a model.
    func record(
        model: String,
        provider: ModelProvider,
        baseURL: String,
        success: Bool,
        reason: String? = nil,
        latencyMs: Int? = nil,
        timeToFirstTokenMs: Int? = nil,
        observedOutputTokens: Int? = nil,
        observedTotalTokens: Int? = nil,
        finishReason: String? = nil
    ) async {
        await record(
            outcome: ModelOutcome(
                model: model,
                provider: provider,
                baseURL: baseURL,
                success: success,
                reason: reason,
                latencyMs: latencyMs,
                timeToFirstTokenMs: timeToFirstTokenMs,
                observedOutputTokens: observedOutputTokens,
                observedTotalTokens: observedTotalTokens,
                finishReason: finishReason
            )
        )
    }

    /// Records a pre-built outcome.
    func record(outcome: ModelOutcome) async {
        do {
            try await store.saveOutcome(outcome)
        } catch {
            NSLog("[Reliability] failed to save outcome: %@", error.localizedDescription)
        }
    }

    /// Records the result of a `ModelHealth` probe.
    func recordHealth(
        model: String,
        provider: ModelProvider,
        baseURL: String,
        health: ModelHealth,
        latencyMs: Int? = nil
    ) async {
        switch health {
        case .healthy:
            await record(
                model: model,
                provider: provider,
                baseURL: baseURL,
                success: true,
                latencyMs: latencyMs
            )
        case .unavailable(let reason):
            await record(
                model: model,
                provider: provider,
                baseURL: baseURL,
                success: false,
                reason: reason,
                latencyMs: latencyMs
            )
        case .unknown(let error):
            await record(
                model: model,
                provider: provider,
                baseURL: baseURL,
                success: false,
                reason: error,
                latencyMs: latencyMs
            )
        }
    }

    /// Returns the reliability score for a model.
    func reliability(
        for model: String,
        provider: ModelProvider,
        baseURL: String
    ) async -> ModelReliability {
        do {
            let outcomes = try await store.outcomes(
                for: model,
                provider: provider,
                baseURL: baseURL,
                limit: historyLimit
            )
            return Self.reliability(from: outcomes, alpha: emaAlpha)
        } catch {
            NSLog("[Reliability] failed to load outcomes: %@", error.localizedDescription)
            return ModelReliability(score: 0.5, totalOutcomes: 0, failureStreak: 0)
        }
    }

    /// Returns the aggregate latency signal for a model.
    func latency(
        for model: String,
        provider: ModelProvider,
        baseURL: String
    ) async -> ModelLatency {
        do {
            let outcomes = try await store.outcomes(
                for: model,
                provider: provider,
                baseURL: baseURL,
                limit: historyLimit
            )
            return Self.latency(from: outcomes, alpha: emaAlpha)
        } catch {
            NSLog("[Reliability] failed to load latency: %@", error.localizedDescription)
            return ModelLatency(perceivedEmaMs: 0, perceivedAvgMs: 0, minMs: 0, maxMs: 0, totalCount: 0)
        }
    }

    /// Ranks fallback models by composite reliability × latency score, falling
    /// back to the original provider order for models without observed history.
    func rankedFallbacks(
        excluding currentModel: String,
        from candidates: [String],
        provider: ModelProvider,
        baseURL: String
    ) async -> [String] {
        let others = candidates.filter { $0 != currentModel }
        guard !others.isEmpty else { return [] }

        var scored: [(model: String, score: Double)] = []
        for model in others {
            let reliability = await reliability(for: model, provider: provider, baseURL: baseURL)
            let latency = await latency(for: model, provider: provider, baseURL: baseURL)
            let score = Self.compositeScore(
                reliabilityScore: reliability.score,
                latency: latency,
                sloMs: latencySLOMs
            )
            scored.append((model, score))
        }

        return scored.sorted { left, right in
            if left.score != right.score {
                return left.score > right.score
            }
            // Preserve provider order for ties.
            guard let leftIndex = candidates.firstIndex(of: left.model),
                  let rightIndex = candidates.firstIndex(of: right.model) else {
                return left.model.localizedCaseInsensitiveCompare(right.model) == .orderedAscending
            }
            return leftIndex < rightIndex
        }.map(\.model)
    }

    /// Clears stored outcomes for a provider/endpoint, e.g. when the endpoint changes.
    func reset(
        provider: ModelProvider,
        baseURL: String
    ) async {
        // The protocol currently only supports per-model deletion, so we
        // enumerate a small set of common models. Future cycles can add a
        // provider-wide delete method.
        for model in provider.suggestedModels {
            do {
                try await store.deleteOutcomes(for: model, provider: provider, baseURL: baseURL)
            } catch {
                NSLog("[Reliability] failed to reset outcomes: %@", error.localizedDescription)
            }
        }
    }

    /// Returns the single best model from `candidates` ranked by composite score.
    /// Filters by `tier` when provided (via `costService`) and excludes any
    /// model in `excluding`. If every candidate would be filtered out, the tier
    /// guard is relaxed so prediction never returns nil when candidates exist.
    /// Returns nil only when `candidates` is empty or all scores tie at the
    /// baseline with no observed history.
    func bestModel(
        from candidates: [String],
        provider: ModelProvider,
        baseURL: String,
        tier: ModelCostTier = .any,
        excluding: String? = nil,
        costService: ModelCostService = .shared
    ) async -> String? {
        guard !candidates.isEmpty else { return nil }

        var eligible = candidates
        if let excluding, !excluding.isEmpty {
            eligible.removeAll { $0 == excluding }
        }
        eligible = await costService.filter(candidates: eligible, provider: provider, tier: tier)

        var scored: [(model: String, score: Double, hasHistory: Bool)] = []
        for model in eligible {
            let reliability = await reliability(for: model, provider: provider, baseURL: baseURL)
            let latency = await latency(for: model, provider: provider, baseURL: baseURL)
            let score = Self.compositeScore(
                reliabilityScore: reliability.score,
                latency: latency,
                sloMs: latencySLOMs
            )
            scored.append((model, score, reliability.totalOutcomes > 0 || latency.totalCount > 0))
        }

        let withHistory = scored.filter { $0.hasHistory }
        if withHistory.isEmpty {
            // No learned signal yet; preserve provider order by returning the
            // first eligible candidate.
            return eligible.first
        }

        return withHistory.sorted { left, right in
            if left.score != right.score {
                return left.score > right.score
            }
            guard let leftIndex = candidates.firstIndex(of: left.model),
                  let rightIndex = candidates.firstIndex(of: right.model) else {
                return left.model.localizedCaseInsensitiveCompare(right.model) == .orderedAscending
            }
            return leftIndex < rightIndex
        }.first?.model
    }

    /// Computes an EMA score from a list of outcomes ordered newest first.
    static func reliability(
        from outcomes: [ModelOutcome],
        alpha: Double
    ) -> ModelReliability {
        guard !outcomes.isEmpty else {
            return ModelReliability(score: 0.5, totalOutcomes: 0, failureStreak: 0)
        }

        var score = 0.5
        var failureStreak = 0
        for outcome in outcomes.reversed() {
            let value = outcome.success ? 1.0 : 0.0
            score = alpha * value + (1 - alpha) * score
            failureStreak = outcome.success ? 0 : failureStreak + 1
        }
        return ModelReliability(
            score: score,
            totalOutcomes: outcomes.count,
            failureStreak: failureStreak
        )
    }

    /// Computes EMA and simple-average latency from observed outcomes.
    /// Uses TTFT when available; otherwise falls back to total request/probe
    /// duration. Returns a zeroed aggregate when no latency data exists.
    static func latency(
        from outcomes: [ModelOutcome],
        alpha: Double
    ) -> ModelLatency {
        let perceivedValues = outcomes.compactMap { outcome -> Int? in
            outcome.timeToFirstTokenMs ?? outcome.latencyMs
        }
        guard !perceivedValues.isEmpty else {
            return ModelLatency(
                perceivedEmaMs: 0,
                perceivedAvgMs: 0,
                minMs: 0,
                maxMs: 0,
                totalCount: 0
            )
        }

        var ema = Double(perceivedValues.last!)
        for value in perceivedValues.dropLast().reversed() {
            ema = alpha * Double(value) + (1 - alpha) * ema
        }

        let avg = Double(perceivedValues.reduce(0, +)) / Double(perceivedValues.count)
        let minMs = perceivedValues.min() ?? 0
        let maxMs = perceivedValues.max() ?? 0

        let totalEma = Self.ema(
            values: outcomes.compactMap(\.latencyMs),
            alpha: alpha
        )
        let ttftEma = Self.ema(
            values: outcomes.compactMap(\.timeToFirstTokenMs),
            alpha: alpha
        )

        return ModelLatency(
            perceivedEmaMs: ema,
            perceivedAvgMs: avg,
            minMs: minMs,
            maxMs: maxMs,
            totalCount: perceivedValues.count,
            totalEmaMs: totalEma,
            ttftEmaMs: ttftEma
        )
    }

    /// Blends a reliability score with a latency penalty. Models with no latency
    /// history keep the full reliability score. The penalty is an exponential
    /// decay so extreme outliers are penalised but never zeroed.
    static func compositeScore(
        reliabilityScore: Double,
        latency: ModelLatency,
        sloMs: Double
    ) -> Double {
        guard latency.totalCount > 0, sloMs > 0 else {
            return reliabilityScore
        }
        let latencyScore = exp(-latency.perceivedEmaMs / sloMs)
        return reliabilityScore * max(0.1, latencyScore)
    }

    /// Ranks models across all eligible provider endpoints by the same composite
    /// reliability × latency score used for single-provider ranking.
    func rankedCrossProviderFallbacks(
        currentProvider: ModelProvider,
        currentBaseURL: String,
        currentModel: String,
        providerConfigurations: [(provider: ModelProvider, baseURL: String)],
        excludingModels: Set<String>? = nil
    ) async -> [(candidate: CrossProviderModelCandidate, score: Double)] {
        var scored: [(candidate: CrossProviderModelCandidate, score: Double)] = []

        for config in providerConfigurations {
            let isCurrentTuple = config.provider == currentProvider && config.baseURL == currentBaseURL
            let candidates = config.provider.suggestedModels.filter { model in
                if isCurrentTuple, model == currentModel { return false }
                if let excluding = excludingModels, excluding.contains(model) { return false }
                return true
            }

            for model in candidates {
                let reliability = await reliability(for: model, provider: config.provider, baseURL: config.baseURL)
                let latency = await latency(for: model, provider: config.provider, baseURL: config.baseURL)
                let score = Self.compositeScore(
                    reliabilityScore: reliability.score,
                    latency: latency,
                    sloMs: latencySLOMs
                )
                scored.append((
                    CrossProviderModelCandidate(provider: config.provider, baseURL: config.baseURL, model: model),
                    score
                ))
            }
        }

        return scored.sorted { left, right in
            if left.score != right.score {
                return left.score > right.score
            }
            return Self.providerOrder(
                left: left.candidate,
                right: right.candidate,
                configurations: providerConfigurations
            )
        }
    }

    /// Returns the single best model across all eligible provider endpoints,
    /// filtering by cost tier. If the tier filter would remove every candidate it
    /// is relaxed so the caller always has a fallback when configurations exist.
    func bestCrossProviderModel(
        currentProvider: ModelProvider,
        currentBaseURL: String,
        currentModel: String,
        providerConfigurations: [(provider: ModelProvider, baseURL: String)],
        tier: ModelCostTier = .any,
        excluding: Set<String>? = nil,
        costService: ModelCostService = .shared
    ) async -> CrossProviderModelCandidate? {
        let ranked = await rankedCrossProviderFallbacks(
            currentProvider: currentProvider,
            currentBaseURL: currentBaseURL,
            currentModel: currentModel,
            providerConfigurations: providerConfigurations,
            excludingModels: excluding
        )

        var eligible: [(candidate: CrossProviderModelCandidate, score: Double, hasHistory: Bool)] = []
        for entry in ranked {
            let modelTier = await costService.tier(for: entry.candidate.model, provider: entry.candidate.provider)
            if tier != .any, modelTier != tier { continue }
            let hasHistory = await hasObservedHistory(
                model: entry.candidate.model,
                provider: entry.candidate.provider,
                baseURL: entry.candidate.baseURL
            )
            eligible.append((entry.candidate, entry.score, hasHistory))
        }

        if eligible.isEmpty, tier != .any {
            // Relax the tier filter before giving up.
            return await bestCrossProviderModel(
                currentProvider: currentProvider,
                currentBaseURL: currentBaseURL,
                currentModel: currentModel,
                providerConfigurations: providerConfigurations,
                tier: .any,
                excluding: excluding,
                costService: costService
            )
        }

        let withHistory = eligible.filter { $0.hasHistory }
        if !withHistory.isEmpty {
            return withHistory.sorted { left, right in
                if left.score != right.score { return left.score > right.score }
                return Self.providerOrder(left: left.candidate, right: right.candidate, configurations: providerConfigurations)
            }.first?.candidate
        }

        // No learned signal yet: preserve provider order rather than switching
        // providers blindly.
        return eligible.first?.candidate
    }

    private func hasObservedHistory(
        model: String,
        provider: ModelProvider,
        baseURL: String
    ) async -> Bool {
        let reliability = await reliability(for: model, provider: provider, baseURL: baseURL)
        let latency = await latency(for: model, provider: provider, baseURL: baseURL)
        return reliability.totalOutcomes > 0 || latency.totalCount > 0
    }

    private static func providerOrder(
        left: CrossProviderModelCandidate,
        right: CrossProviderModelCandidate,
        configurations: [(provider: ModelProvider, baseURL: String)]
    ) -> Bool {
        guard let leftIndex = configurations.firstIndex(where: { $0.provider == left.provider && $0.baseURL == left.baseURL }),
              let rightIndex = configurations.firstIndex(where: { $0.provider == right.provider && $0.baseURL == right.baseURL }) else {
            return left.model.localizedCaseInsensitiveCompare(right.model) == .orderedAscending
        }
        if leftIndex != rightIndex { return leftIndex < rightIndex }
        let leftModelIndex = left.provider.suggestedModels.firstIndex(of: left.model) ?? Int.max
        let rightModelIndex = right.provider.suggestedModels.firstIndex(of: right.model) ?? Int.max
        return leftModelIndex < rightModelIndex
    }

    private static func ema(values: [Int], alpha: Double) -> Double? {
        guard !values.isEmpty else { return nil }
        var ema = Double(values.last!)
        for value in values.dropLast().reversed() {
            ema = alpha * Double(value) + (1 - alpha) * ema
        }
        return ema
    }
}
