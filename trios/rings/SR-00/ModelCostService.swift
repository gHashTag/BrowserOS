import Foundation

/// Cost tier for predictive model selection. `any` disables tier filtering.
enum ModelCostTier: String, CaseIterable, Identifiable, Codable, Sendable {
    case any
    case free
    case cheap
    case premium

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .any: return "Any"
        case .free: return "Free"
        case .cheap: return "Cheap"
        case .premium: return "Premium"
        }
    }
}

/// Per-model pricing snapshot. Prices are USD per 1 million tokens.
struct ModelCost: Equatable, Sendable {
    let inputPricePer1M: Double
    let outputPricePer1M: Double
    let tier: ModelCostTier

    init(inputPricePer1M: Double, outputPricePer1M: Double) {
        self.inputPricePer1M = inputPricePer1M
        self.outputPricePer1M = outputPricePer1M
        if inputPricePer1M == 0 && outputPricePer1M == 0 {
            self.tier = .free
        } else if inputPricePer1M <= 1.50 && outputPricePer1M <= 4.50 {
            self.tier = .cheap
        } else {
            self.tier = .premium
        }
    }

    init(tier: ModelCostTier) {
        self.inputPricePer1M = 0
        self.outputPricePer1M = 0
        self.tier = tier
    }
}

/// Static cost catalog for known models. Prices are approximate and used only
/// for tier classification; TriOS does not do real-time billing.
actor ModelCostService: Sendable {
    static let shared = ModelCostService()

    func cost(for model: String, provider: ModelProvider) -> ModelCost? {
        let key = normalize(model: model, provider: provider)
        if let cost = staticCatalog[key] {
            return cost
        }
        // Ollama is always free regardless of model name.
        if provider == .ollama {
            return ModelCost(tier: .free)
        }
        return nil
    }

    func tier(for model: String, provider: ModelProvider) -> ModelCostTier {
        cost(for: model, provider: provider)?.tier ?? .premium
    }

    func isWithinTier(model: String, provider: ModelProvider, tier: ModelCostTier) -> Bool {
        guard tier != .any else { return true }
        let modelTier = self.tier(for: model, provider: provider)
        return modelTier == tier
    }

    /// Returns candidates filtered to the requested tier. If the filter would
    /// eliminate every candidate, returns the full list so prediction never
    /// leaves the user without a model.
    func filter(
        candidates: [String],
        provider: ModelProvider,
        tier: ModelCostTier
    ) -> [String] {
        guard tier != .any else { return candidates }
        let filtered = candidates.filter { isWithinTier(model: $0, provider: provider, tier: tier) }
        return filtered.isEmpty ? candidates : filtered
    }

    private func normalize(model: String, provider: ModelProvider) -> String {
        let lowercased = model.lowercased()
        switch provider {
        case .openrouter:
            // Strip the provider namespace for common slugs we catalog.
            let suffix = lowercased.split(separator: "/").last.map(String.init) ?? lowercased
            return "openrouter/\(suffix)"
        default:
            return "\(provider.rawValue)/\(lowercased)"
        }
    }

    private var staticCatalog: [String: ModelCost] {
        [
            // Ollama — free local inference.
            "ollama/llama3.1": .init(tier: .free),
            "ollama/qwen3": .init(tier: .free),
            "ollama/gemma3": .init(tier: .free),

            // OpenAI.
            "openai/gpt-5.2": .init(inputPricePer1M: 2.50, outputPricePer1M: 10.00),
            "openai/gpt-5": .init(inputPricePer1M: 1.25, outputPricePer1M: 5.00),
            "openai/gpt-4.1": .init(inputPricePer1M: 2.00, outputPricePer1M: 8.00),

            // Anthropic.
            "anthropic/claude-sonnet-4-5": .init(inputPricePer1M: 3.00, outputPricePer1M: 15.00),
            "anthropic/claude-opus-4-5": .init(inputPricePer1M: 15.00, outputPricePer1M: 75.00),
            "anthropic/claude-haiku-4-5": .init(inputPricePer1M: 0.25, outputPricePer1M: 1.25),

            // OpenRouter slugs.
            "openrouter/gpt-5.2": .init(inputPricePer1M: 2.50, outputPricePer1M: 10.00),
            "openrouter/gpt-5": .init(inputPricePer1M: 1.25, outputPricePer1M: 5.00),
            "openrouter/claude-sonnet-4.5": .init(inputPricePer1M: 3.00, outputPricePer1M: 15.00),
            "openrouter/gemini-2.5-pro": .init(inputPricePer1M: 1.25, outputPricePer1M: 10.00),
            "openrouter/gemini-2.5-flash": .init(inputPricePer1M: 0.15, outputPricePer1M: 0.60),

            // Z.AI.
            "zai/glm-5.1": .init(inputPricePer1M: 1.00, outputPricePer1M: 2.00),
            "zai/glm-5-turbo": .init(inputPricePer1M: 0.50, outputPricePer1M: 1.00),
            "zai/glm-5": .init(inputPricePer1M: 1.00, outputPricePer1M: 2.00),
            "zai/glm-4.7": .init(inputPricePer1M: 0.50, outputPricePer1M: 1.00),
            "zai/glm-4.7-flash": .init(inputPricePer1M: 0.10, outputPricePer1M: 0.20),
            "zai/glm-4.6": .init(inputPricePer1M: 0.25, outputPricePer1M: 0.50),
        ]
    }
}
