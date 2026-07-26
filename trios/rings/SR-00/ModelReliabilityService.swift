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

    init(
        id: UUID = UUID(),
        model: String,
        provider: ModelProvider,
        baseURL: String,
        success: Bool,
        reason: String? = nil,
        timestamp: Date = Date()
    ) {
        self.id = id
        self.model = model
        self.provider = provider
        self.baseURL = baseURL
        self.success = success
        self.reason = reason
        self.timestamp = timestamp
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
actor ModelReliabilityService: Sendable {
    private let store: any ModelReliabilityStoreProtocol
    private let historyLimit: Int
    private let emaAlpha: Double

    init(
        store: any ModelReliabilityStoreProtocol,
        historyLimit: Int = 20,
        emaAlpha: Double = 0.3
    ) {
        self.store = store
        self.historyLimit = max(1, historyLimit)
        self.emaAlpha = max(0.01, min(1, emaAlpha))
    }

    /// Records a successful or failed outcome for a model.
    func record(
        model: String,
        provider: ModelProvider,
        baseURL: String,
        success: Bool,
        reason: String? = nil
    ) async {
        do {
            try await store.saveOutcome(
                ModelOutcome(
                    model: model,
                    provider: provider,
                    baseURL: baseURL,
                    success: success,
                    reason: reason
                )
            )
        } catch {
            NSLog("[Reliability] failed to save outcome: %@", error.localizedDescription)
        }
    }

    /// Records the result of a `ModelHealth` probe.
    func recordHealth(
        model: String,
        provider: ModelProvider,
        baseURL: String,
        health: ModelHealth
    ) async {
        switch health {
        case .healthy:
            await record(model: model, provider: provider, baseURL: baseURL, success: true)
        case .unavailable(let reason):
            await record(model: model, provider: provider, baseURL: baseURL, success: false, reason: reason)
        case .unknown(let error):
            await record(model: model, provider: provider, baseURL: baseURL, success: false, reason: error)
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

    /// Ranks fallback models by reliability score, falling back to the
    /// original provider order for models without observed history.
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
            scored.append((model, reliability.score))
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

    /// Returns the single best model from `candidates` ranked by reliability.
    /// Filters by `tier` when provided (via `costService`) and excludes any
    /// model in `excluding`. If every candidate would be filtered out, the tier
    /// guard is relaxed so prediction never returns nil when candidates exist.
    /// Returns nil only when `candidates` is empty or all scores tie at 0.5 with
    /// no observed history.
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
            scored.append((model, reliability.score, reliability.totalOutcomes > 0))
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
}
