import Foundation

enum ModelProvider: String, CaseIterable, Codable, Identifiable {
    case ollama
    case openai
    case anthropic
    case openrouter
    case zai

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .ollama: return "Ollama"
        case .openai: return "OpenAI"
        case .anthropic: return "Anthropic"
        case .openrouter: return "OpenRouter"
        case .zai: return "Z.AI"
        }
    }

    var requiresAPIKey: Bool {
        self != .ollama
    }

    /// Providers that expose a free public catalog endpoint listing available models.
    var hasProviderCatalog: Bool {
        switch self {
        case .ollama, .zai:
            return false
        case .openai, .anthropic, .openrouter:
            return true
        }
    }

    var defaultBaseURL: String {
        switch self {
        case .ollama: return "http://127.0.0.1:11434/v1"
        case .openai: return "https://api.openai.com/v1"
        case .anthropic: return "https://api.anthropic.com/v1"
        case .openrouter: return "https://openrouter.ai/api/v1"
        // Coding Plan endpoint. The pay-as-you-go host (/api/paas/v4) answers
        // every request with business code 1113 "Insufficient balance" for a
        // subscription key, which made live Coding Plan keys look expired.
        case .zai: return "https://api.z.ai/api/coding/paas/v4"
        }
    }

    var defaultModel: String {
        suggestedModels[0]
    }

    var suggestedModels: [String] {
        switch self {
        case .ollama:
            return ["llama3.1", "qwen3", "gemma3"]
        case .openai:
            return ["gpt-5.2", "gpt-5", "gpt-4.1"]
        case .anthropic:
            return ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"]
        case .openrouter:
            return [
                "openai/gpt-5.2",
                "anthropic/claude-sonnet-4.5",
                "google/gemini-2.5-pro",
                "google/gemini-2.5-flash"
            ]
        case .zai:
            return ["glm-5.2", "glm-5.1", "glm-5-turbo", "glm-5", "glm-4.7", "glm-4.7-flash", "glm-4.6"]
        }
    }

    /// Ordered fallback chain for automatic failover. The current model is
    /// excluded, and a cheap/reliable floor model is placed last for OpenRouter.
    func fallbackModels(excluding currentModel: String) -> [String] {
        var candidates = suggestedModels.filter { $0 != currentModel }
        if self == .openrouter, let floorIndex = candidates.firstIndex(of: "google/gemini-2.5-flash") {
            let floor = candidates.remove(at: floorIndex)
            candidates.append(floor)
        }
        return candidates
    }
}

struct ModelRuntimeConfiguration: Equatable {
    let provider: ModelProvider
    let model: String
    let baseURL: String
    let apiKey: String?
    let fallbackModels: [String]?
    /// Per-send output-token budget forwarded to the model endpoint.
    /// When present, the value has already been clamped to the effective
    /// (advertised or learned) output ceiling.
    let maxOutputTokens: Int?

    init(
        provider: ModelProvider,
        model: String,
        baseURL: String,
        apiKey: String?,
        fallbackModels: [String]? = nil,
        maxOutputTokens: Int? = nil
    ) {
        self.provider = provider
        self.model = model
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.fallbackModels = fallbackModels
        self.maxOutputTokens = maxOutputTokens
    }

    func apply(to body: inout [String: Any]) {
        body["provider"] = provider.rawValue
        body["model"] = model
        body["baseUrl"] = baseURL
        if let apiKey, !apiKey.isEmpty {
            body["apiKey"] = apiKey
        }
        if let maxOutputTokens, maxOutputTokens > 0 {
            body["max_tokens"] = maxOutputTokens
        }
        // OpenRouter supports an ordered `models` array for provider-side failover.
        if provider == .openrouter,
           let fallbacks = fallbackModels,
           !fallbacks.isEmpty {
            var models = [model]
            models.append(contentsOf: fallbacks.filter { $0 != model })
            body["models"] = models
        }
    }

    /// Returns a runtime configuration derived from non-secret environment
    /// overrides only. API keys are intentionally excluded; they must come from
    /// macOS Keychain via `ModelCredentialStore`.
    static func environmentFallback(
        _ environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> ModelRuntimeConfiguration {
        let provider = ModelProvider(rawValue: environment["TRIOS_PROVIDER"] ?? "") ?? .ollama
        let model = environment["TRIOS_MODEL"] ?? provider.defaultModel
        return ModelRuntimeConfiguration(
            provider: provider,
            model: model,
            baseURL: environment["TRIOS_BASE_URL"] ?? provider.defaultBaseURL,
            apiKey: nil,
            fallbackModels: provider.fallbackModels(excluding: model),
            maxOutputTokens: nil
        )
    }
}
