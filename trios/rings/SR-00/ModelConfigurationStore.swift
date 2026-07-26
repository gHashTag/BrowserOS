import Combine
import Foundation
import Security

enum ModelCredentialError: LocalizedError {
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .keychain(let status):
            return "macOS Keychain error \(status)"
        }
    }
}

enum ModelCredentialStore {
    private static let service = "com.browseros.trios.model-keys"

    static func read(for provider: ModelProvider) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider.rawValue,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ key: String, for provider: ModelProvider) throws {
        try delete(for: provider, ignoresMissing: true)
        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider.rawValue,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: Data(key.utf8)
        ]
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw ModelCredentialError.keychain(status)
        }
    }

    static func delete(for provider: ModelProvider, ignoresMissing: Bool = false) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider.rawValue
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || (ignoresMissing && status == errSecItemNotFound) else {
            throw ModelCredentialError.keychain(status)
        }
    }
}

@MainActor
final class ModelConfigurationStore: ObservableObject {
    static let shared = ModelConfigurationStore()

    @Published private(set) var selectedProvider: ModelProvider
    @Published private(set) var selectedModel: String
    @Published private(set) var baseURL: String
    @Published private(set) var discoveredModels: [String] = []
    @Published private(set) var isDiscovering = false
    @Published private(set) var discoveryError: String?
    @Published private(set) var credentialRevision = 0
    @Published private(set) var modelsTabRequest = 0

    private let defaults: UserDefaults
    private let environment: [String: String]
    private let catalogService = ModelCatalogService()

    init(
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.defaults = defaults
        self.environment = environment

        let providerValue = defaults.string(forKey: "trios.model.provider")
            ?? environment["TRIOS_PROVIDER"]
            ?? ModelProvider.ollama.rawValue
        let provider = ModelProvider(rawValue: providerValue) ?? .ollama
        selectedProvider = provider
        selectedModel = defaults.string(forKey: Self.modelKey(provider))
            ?? environment["TRIOS_MODEL"]
            ?? provider.defaultModel
        baseURL = defaults.string(forKey: Self.baseURLKey(provider))
            ?? environment["TRIOS_BASE_URL"]
            ?? provider.defaultBaseURL
    }

    var availableModels: [String] {
        var values = discoveredModels.isEmpty ? selectedProvider.suggestedModels : discoveredModels
        values.append(selectedModel)
        return Array(Set(values.filter { !$0.isEmpty })).sorted { left, right in
            if left == selectedModel { return true }
            if right == selectedModel { return false }
            return left.localizedCaseInsensitiveCompare(right) == .orderedAscending
        }
    }

    /// Models that can be tried when the current selection fails, ordered by
    /// provider preference. The current model is excluded.
    var fallbackModels: [String] {
        selectedProvider.suggestedModels.filter { $0 != selectedModel }
    }

    /// Switches to the next suggested model in the provider's list, returning the
    /// new selection. Returns `nil` if no alternative exists.
    @discardableResult
    func selectNextModel() -> String? {
        guard let next = fallbackModels.first else { return nil }
        selectModel(next)
        return next
    }

    /// A short user-facing hint naming a concrete fallback model, or empty.
    var fallbackSuggestion: String {
        guard let first = fallbackModels.first else { return "" }
        return "Suggested fallback: \(first)"
    }

    var hasAPIKey: Bool {
        !resolvedAPIKey.isEmpty
    }

    var credentialStatus: String {
        if ModelCredentialStore.read(for: selectedProvider) != nil {
            return "Stored in macOS Keychain"
        }
        return selectedProvider.requiresAPIKey ? "API key required" : "No API key required"
    }

    var runtimeConfiguration: ModelRuntimeConfiguration {
        ModelRuntimeConfiguration(
            provider: selectedProvider,
            model: selectedModel,
            baseURL: baseURL,
            apiKey: resolvedAPIKey.isEmpty ? nil : resolvedAPIKey
        )
    }

    func selectProvider(_ provider: ModelProvider) {
        guard provider != selectedProvider else { return }
        selectedProvider = provider
        defaults.set(provider.rawValue, forKey: "trios.model.provider")
        selectedModel = defaults.string(forKey: Self.modelKey(provider)) ?? provider.defaultModel
        baseURL = defaults.string(forKey: Self.baseURLKey(provider)) ?? provider.defaultBaseURL
        discoveredModels = []
        discoveryError = nil
        credentialRevision += 1
    }

    func selectModel(_ model: String) {
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        selectedModel = trimmed
        defaults.set(trimmed, forKey: Self.modelKey(selectedProvider))
    }

    func updateBaseURL(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        baseURL = trimmed
        defaults.set(trimmed, forKey: Self.baseURLKey(selectedProvider))
    }

    func resetBaseURL() {
        baseURL = selectedProvider.defaultBaseURL
        defaults.removeObject(forKey: Self.baseURLKey(selectedProvider))
    }

    func saveAPIKey(_ value: String) throws {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        try ModelCredentialStore.save(trimmed, for: selectedProvider)
        credentialRevision += 1
    }

    func deleteAPIKey() throws {
        try ModelCredentialStore.delete(for: selectedProvider, ignoresMissing: true)
        credentialRevision += 1
    }

    func refreshModels() async {
        isDiscovering = true
        discoveryError = nil
        defer { isDiscovering = false }
        do {
            discoveredModels = try await catalogService.fetchModels(
                provider: selectedProvider,
                baseURL: baseURL,
                apiKey: resolvedAPIKey.isEmpty ? nil : resolvedAPIKey
            )
        } catch {
            discoveredModels = []
            discoveryError = error.localizedDescription
        }
    }

    func requestModelsTab() {
        modelsTabRequest += 1
    }

    /// Returns the API key from macOS Keychain, the `~/.trios/config.json` file,
    /// or an environment fallback, in that order. The file fallback lets the app
    /// work across rebuilds without prompting for keychain access.
    private var resolvedAPIKey: String {
        if let keychain = ModelCredentialStore.read(for: selectedProvider), !keychain.isEmpty {
            return keychain
        }
        if let fileKey = Self.apiKeyFromConfigFile(for: selectedProvider), !fileKey.isEmpty {
            return fileKey
        }
        let envVar = Self.providerEnvironmentKey(selectedProvider)
        return environment[envVar] ?? ""
    }

    private static func triosConfigURL() -> URL {
        let home = ProcessInfo.processInfo.environment["HOME"] ?? "/Users/playra"
        return URL(fileURLWithPath: home).appendingPathComponent(".trios/config.json")
    }

    private static func apiKeyFromConfigFile(for provider: ModelProvider) -> String? {
        let url = triosConfigURL()
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
            return nil
        }
        return json[providerEnvironmentKey(provider)]
    }

    private static func providerEnvironmentKey(_ provider: ModelProvider) -> String {
        switch provider {
        case .openai: return "TRIOS_OPENAI_API_KEY"
        case .anthropic: return "TRIOS_ANTHROPIC_API_KEY"
        case .openrouter: return "TRIOS_OPENROUTER_API_KEY"
        case .zai: return "TRIOS_ZAI_API_KEY"
        case .ollama: return "TRIOS_OLLAMA_API_KEY"
        }
    }

    private static func modelKey(_ provider: ModelProvider) -> String {
        "trios.model.\(provider.rawValue).selection"
    }

    private static func baseURLKey(_ provider: ModelProvider) -> String {
        "trios.model.\(provider.rawValue).base-url"
    }
}
