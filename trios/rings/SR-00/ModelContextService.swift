import Foundation

/// Public context-window specification for a model. Estimates are approximate
/// and intentionally conservative for unknown models so the router errs on the
/// side of switching or trimming.
struct ModelContextProfile: Equatable, Sendable {
    let maxContextTokens: Int
    let maxOutputTokens: Int
}

/// Catalog of known context windows and proactive fit checks.
///
/// The catalog is intentionally static for Cycle 27. Future cycles can add a
/// provider-native fetch path while keeping the conservative unknown default.
actor ModelContextService: Sendable {
    static let shared = ModelContextService()

    private let knownProfiles: [ModelProvider: [String: ModelContextProfile]]
    private let commonSlugs: [String: ModelContextProfile]
    private let contextLimitLearner: StreamingContextLimitLearner

    init(contextLimitLearner: StreamingContextLimitLearner? = nil) {
        self.contextLimitLearner = contextLimitLearner ?? StreamingContextLimitLearner.shared
        let openAIProfile = ModelContextProfile(maxContextTokens: 128_000, maxOutputTokens: 16_384)
        let gpt41Profile = ModelContextProfile(maxContextTokens: 1_000_000, maxOutputTokens: 32_768)
        let claudeProfile = ModelContextProfile(maxContextTokens: 200_000, maxOutputTokens: 8_192)
        let glm128kProfile = ModelContextProfile(maxContextTokens: 128_000, maxOutputTokens: 4_096)
        let glm32kProfile = ModelContextProfile(maxContextTokens: 32_000, maxOutputTokens: 4_096)

        self.knownProfiles = [
            .openai: [
                "gpt-5.2": openAIProfile,
                "gpt-5": openAIProfile,
                "gpt-4.1": gpt41Profile
            ],
            .anthropic: [
                "claude-sonnet-4-5": claudeProfile,
                "claude-opus-4-5": claudeProfile,
                "claude-haiku-4-5": claudeProfile
            ],
            .zai: [
                // Conservative: same window as glm-5.1 until the learned
                // per-endpoint limits observe the real ceiling.
                "glm-5.2": glm128kProfile,
                "glm-5.1": glm128kProfile,
                "glm-5-turbo": glm128kProfile,
                "glm-5": glm32kProfile,
                "glm-4.7": glm128kProfile,
                "glm-4.7-flash": glm128kProfile,
                "glm-4.6": glm128kProfile
            ]
        ]

        self.commonSlugs = [
            "gpt-5.2": openAIProfile,
            "gpt-5": openAIProfile,
            "gpt-4.1": gpt41Profile,
            "claude-sonnet-4-5": claudeProfile,
            "claude-opus-4-5": claudeProfile,
            "claude-haiku-4-5": claudeProfile,
            "glm-5.2": glm128kProfile,
            "glm-5.1": glm128kProfile,
            "glm-5-turbo": glm128kProfile,
            "glm-5": glm32kProfile,
            "glm-4.7": glm128kProfile,
            "glm-4.7-flash": glm128kProfile,
            "glm-4.6": glm128kProfile
        ]
    }

    /// Returns the context profile for a concrete model, blending the static
    /// catalog with learned per-endpoint limits when enough observations exist.
    /// Unknown models receive a conservative 4096-token window so the engine
    /// routes or trims aggressively rather than over-trusting an un-cataloged
    /// provider response.
    func profile(
        for model: String,
        provider: ModelProvider,
        baseURL: String
    ) async -> ModelContextProfile {
        let advertised = advertisedProfile(for: model, provider: provider)
        return await contextLimitLearner.learnedProfile(
            for: model,
            provider: provider,
            baseURL: baseURL,
            advertised: advertised
        )
    }

    /// Returns the advertised (non-learned) context/output profile for a model.
    /// Public so the composer can compute a cheap synchronous draft-utilization
    /// indicator without blocking on the learned-limit learner.
    /// Nonisolated because it only reads immutable `let` catalog state.
    nonisolated func advertisedProfile(for model: String, provider: ModelProvider) -> ModelContextProfile {
        switch provider {
        case .openai, .anthropic, .zai:
            return knownProfiles[provider]?[model] ?? ModelContextProfile(
                maxContextTokens: 4_096,
                maxOutputTokens: 1_024
            )
        case .ollama:
            return knownProfiles[provider]?[model] ?? ModelContextProfile(
                maxContextTokens: 128_000,
                maxOutputTokens: 4_096
            )
        case .openrouter:
            let stripped = model.split(separator: "/").dropFirst().joined(separator: "/")
            return commonSlugs[stripped] ?? ModelContextProfile(
                maxContextTokens: 128_000,
                maxOutputTokens: 8_192
            )
        }
    }

    /// True when `estimatedInput + outputTokens` fits inside the usable window
    /// (`maxContextTokens * margin`). Margin is clamped to [0, 1].
    func fits(_ estimatedInput: Int, profile: ModelContextProfile, outputTokens: Int, margin: Double) -> Bool {
        let clampedMargin = max(0.0, min(1.0, margin))
        let usableWindow = Double(profile.maxContextTokens) * clampedMargin
        let total = max(0, estimatedInput) + max(0, outputTokens)
        return Double(total) <= usableWindow
    }

    /// Returns candidates whose usable window is larger than the current model
    /// and fits the estimated request, sorted by context-window descending and
    /// then by stable provider/model ordering.
    ///
    /// Health, quota, and circuit-breaker checks are intentionally left to the
    /// caller (`ModelConfigurationStore`) so this helper stays a pure window
    /// comparator.
    func largerContextCandidates(
        estimatedInput: Int,
        outputTokens: Int,
        current: CrossProviderModelCandidate,
        candidates: [CrossProviderModelCandidate],
        margin: Double
    ) async -> [CrossProviderModelCandidate] {
        let currentProfile = await profile(
            for: current.model,
            provider: current.provider,
            baseURL: current.baseURL
        )
        let currentWindow = currentProfile.maxContextTokens

        var candidateProfiles: [(CrossProviderModelCandidate, ModelContextProfile)] = []
        for candidate in candidates {
            let profile = await profile(
                for: candidate.model,
                provider: candidate.provider,
                baseURL: candidate.baseURL
            )
            candidateProfiles.append((candidate, profile))
        }

        let filtered = candidateProfiles.filter { candidate, profile in
            guard candidate != current else { return false }
            guard profile.maxContextTokens > currentWindow else { return false }
            return fits(estimatedInput, profile: profile, outputTokens: outputTokens, margin: margin)
        }

        return filtered.sorted { lhs, rhs in
            if lhs.1.maxContextTokens != rhs.1.maxContextTokens {
                return lhs.1.maxContextTokens > rhs.1.maxContextTokens
            }
            return stableOrder(lhs: lhs.0, rhs: rhs.0)
        }.map(\.0)
    }

    /// Returns candidates that have a strictly larger context window or output
    /// limit than the current selection and still fit the estimated request.
    func largerModelCandidates(
        estimatedInput: Int,
        outputTokens: Int,
        current: CrossProviderModelCandidate,
        candidates: [CrossProviderModelCandidate],
        margin: Double
    ) async -> [CrossProviderModelCandidate] {
        let currentProfile = await profile(
            for: current.model,
            provider: current.provider,
            baseURL: current.baseURL
        )
        let currentWindow = currentProfile.maxContextTokens
        let currentOutput = currentProfile.maxOutputTokens

        var candidateProfiles: [(CrossProviderModelCandidate, ModelContextProfile)] = []
        for candidate in candidates {
            let profile = await profile(
                for: candidate.model,
                provider: candidate.provider,
                baseURL: candidate.baseURL
            )
            candidateProfiles.append((candidate, profile))
        }

        let filtered = candidateProfiles.filter { candidate, profile in
            guard candidate != current else { return false }
            guard profile.maxContextTokens > currentWindow
                || profile.maxOutputTokens > currentOutput else { return false }
            return fits(estimatedInput, profile: profile, outputTokens: outputTokens, margin: margin)
        }

        return filtered.sorted { lhs, rhs in
            if lhs.1.maxContextTokens != rhs.1.maxContextTokens {
                return lhs.1.maxContextTokens > rhs.1.maxContextTokens
            }
            if lhs.1.maxOutputTokens != rhs.1.maxOutputTokens {
                return lhs.1.maxOutputTokens > rhs.1.maxOutputTokens
            }
            return stableOrder(lhs: lhs.0, rhs: rhs.0)
        }.map(\.0)
    }

    /// Returns candidates whose effective output ceiling can honor the given
    /// output budget while still fitting the estimated input within the safety
    /// margin. Sorted by output ceiling descending, then context window
    /// descending, then stable provider/model order.
    func largerOutputCandidates(
        estimatedInput: Int,
        outputTokens: Int,
        current: CrossProviderModelCandidate,
        candidates: [CrossProviderModelCandidate],
        margin: Double
    ) async -> [CrossProviderModelCandidate] {
        let currentProfile = await profile(
            for: current.model,
            provider: current.provider,
            baseURL: current.baseURL
        )
        let currentOutput = currentProfile.maxOutputTokens

        var candidateProfiles: [(CrossProviderModelCandidate, ModelContextProfile)] = []
        for candidate in candidates {
            let profile = await profile(
                for: candidate.model,
                provider: candidate.provider,
                baseURL: candidate.baseURL
            )
            candidateProfiles.append((candidate, profile))
        }

        let filtered = candidateProfiles.filter { candidate, profile in
            guard candidate != current else { return false }
            guard profile.maxOutputTokens > currentOutput else { return false }
            guard profile.maxOutputTokens >= outputTokens else { return false }
            return fits(estimatedInput, profile: profile, outputTokens: outputTokens, margin: margin)
        }

        return filtered.sorted { lhs, rhs in
            if lhs.1.maxOutputTokens != rhs.1.maxOutputTokens {
                return lhs.1.maxOutputTokens > rhs.1.maxOutputTokens
            }
            if lhs.1.maxContextTokens != rhs.1.maxContextTokens {
                return lhs.1.maxContextTokens > rhs.1.maxContextTokens
            }
            return stableOrder(lhs: lhs.0, rhs: rhs.0)
        }.map(\.0)
    }

    private func stableOrder(lhs: CrossProviderModelCandidate, rhs: CrossProviderModelCandidate) -> Bool {
        let lhsProviderIndex = ModelProvider.allCases.firstIndex(of: lhs.provider) ?? Int.max
        let rhsProviderIndex = ModelProvider.allCases.firstIndex(of: rhs.provider) ?? Int.max
        if lhsProviderIndex != rhsProviderIndex {
            return lhsProviderIndex < rhsProviderIndex
        }
        let lhsModelIndex = lhs.provider.suggestedModels.firstIndex(of: lhs.model) ?? Int.max
        let rhsModelIndex = rhs.provider.suggestedModels.firstIndex(of: rhs.model) ?? Int.max
        if lhsModelIndex != rhsModelIndex {
            return lhsModelIndex < rhsModelIndex
        }
        return lhs.model.localizedCaseInsensitiveCompare(rhs.model) == .orderedAscending
    }
}
