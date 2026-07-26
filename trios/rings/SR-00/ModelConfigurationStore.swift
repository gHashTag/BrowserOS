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
    @Published private(set) var unhealthyModels: Set<String> = []
    @Published private(set) var isCheckingHealth = false
    @Published private(set) var lastHealthCheckAt: Date?
    @Published var isBackgroundHealthPollingEnabled = true
    @Published private(set) var providerStatuses: [String: ProviderModelStatus] = [:]

    private let defaults: UserDefaults
    private let environment: [String: String]
    private let catalogService: ModelCatalogService
    private let healthService: any ModelHealthServiceProtocol
    private let statusService: any ProviderStatusServiceProtocol
    private let reliabilityService: ModelReliabilityService
    private var backgroundPoller: BackgroundHealthPoller?

    /// Exposed for tests only.
    var backgroundPollerForTests: BackgroundHealthPoller? { backgroundPoller }
    var reliabilityServiceForTests: ModelReliabilityService { reliabilityService }

    init(
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        catalogService: ModelCatalogService = ModelCatalogService(),
        statusService: any ProviderStatusServiceProtocol = ProviderStatusService(),
        healthService: (any ModelHealthServiceProtocol)? = nil,
        reliabilityService: ModelReliabilityService? = nil
    ) {
        self.catalogService = catalogService
        self.statusService = statusService
        self.healthService = healthService ?? ModelHealthService(statusService: statusService)
        self.reliabilityService = reliabilityService ?? ModelReliabilityService(
            store: MemoryStoreReliabilityAdapter()
        )
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

        loadBackgroundHealthPollingPreference()
        startBackgroundHealthChecks()
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
    /// Models that can be tried when the current selection fails. The current
    /// model is excluded and the list is ranked by observed reliability score,
    /// falling back to provider preference for models without history.
    var fallbackModels: [String] {
        get async {
            let candidates = selectedProvider.fallbackModels(excluding: selectedModel)
            return await reliabilityService.rankedFallbacks(
                excluding: selectedModel,
                from: candidates,
                provider: selectedProvider,
                baseURL: baseURL
            )
        }
    }

    /// Synchronous fallback order for callers that cannot await. Prefers the
    /// reliability-ranked order when available, otherwise falls back to the
    /// provider's static suggestion list.
    var fallbackModelsSync: [String] {
        selectedProvider.fallbackModels(excluding: selectedModel)
    }

    /// Switches to the next suggested model in the provider's list, returning the
    /// new selection. Returns `nil` if no alternative exists.
    @discardableResult
    func selectNextModel() async -> String? {
        guard let next = await fallbackModels.first else { return nil }
        selectModel(next)
        return next
    }

    /// Switches to the first model that is not known to be unavailable. If no
    /// healthy model is found, falls back to the provider's default model so the
    /// user is never left with an empty selection. Models are ranked by observed
    /// reliability score.
    @discardableResult
    func selectFirstHealthyModel() async -> String? {
        let candidates = await fallbackModels + [selectedProvider.defaultModel]
        guard let next = candidates.first(where: { !unhealthyModels.contains($0) }) else { return nil }
        selectModel(next)
        return next
    }

    /// A short user-facing hint naming a concrete fallback model, or empty.
    var fallbackSuggestion: String {
        // Synchronous hint uses the static order to avoid async in SwiftUI accessors.
        guard let first = fallbackModelsSync.first else { return "" }
        return "Suggested fallback: \(first)"
    }

    /// Returns the persisted reliability score for a model.
    func reliability(for model: String) async -> ModelReliability {
        await reliabilityService.reliability(
            for: model,
            provider: selectedProvider,
            baseURL: baseURL
        )
    }

    /// Records a health-probe outcome into the reliability scorecard.
    func recordHealthOutcome(model: String, health: ModelHealth) async {
        await reliabilityService.recordHealth(
            model: model,
            provider: selectedProvider,
            baseURL: baseURL,
            health: health
        )
    }

    /// Records a manual send outcome into the reliability scorecard.
    func recordSendOutcome(model: String, success: Bool, reason: String? = nil) async {
        await reliabilityService.record(
            model: model,
            provider: selectedProvider,
            baseURL: baseURL,
            success: success,
            reason: reason
        )
    }

    /// Marks a model as unavailable (e.g. after a transport error or failed probe).
    func markUnhealthy(_ model: String) {
        unhealthyModels.insert(model)
    }

    /// Clears the unhealthy flag for a model.
    func markHealthy(_ model: String) {
        unhealthyModels.remove(model)
    }

    /// Returns the cached/in-memory health status for a model by probing it.
    func healthStatus(for model: String) async -> ModelHealth {
        await healthService.probe(
            model: model,
            provider: selectedProvider,
            baseURL: baseURL,
            apiKey: resolvedAPIKey.isEmpty ? nil : resolvedAPIKey
        )
    }

    /// Re-probes every known model in parallel, updates `unhealthyModels`, and
    /// records each outcome in the persistent reliability scorecard.
    func refreshHealth() async {
        isCheckingHealth = true
        defer { isCheckingHealth = false }
        let models = availableModels
        var newUnhealthy: Set<String> = []
        var newHealthy: Set<String> = []
        await withTaskGroup(of: (String, ModelHealth).self) { group in
            for model in models {
                group.addTask {
                    let health = await self.healthStatus(for: model)
                    return (model, health)
                }
            }
            for await (model, health) in group {
                await recordHealthOutcome(model: model, health: health)
                switch health {
                case .unavailable:
                    newUnhealthy.insert(model)
                case .healthy:
                    newHealthy.insert(model)
                case .unknown:
                    break
                }
            }
        }
        // Remove healthy models from the unhealthy set so recovery is detected.
        unhealthyModels.formUnion(newUnhealthy)
        unhealthyModels.subtract(newHealthy)
        lastHealthCheckAt = Date()
    }

    /// Clears health cache and unhealthy flags, e.g. when endpoint/key changes.
    func invalidateHealth() {
        unhealthyModels.removeAll()
        lastHealthCheckAt = nil
        Task { await healthService.invalidate() }
        Task { await statusService.invalidate() }
    }

    /// Returns the provider-native catalog status for a model.
    func providerStatus(for model: String) async -> ProviderModelStatus {
        await statusService.status(
            for: model,
            provider: selectedProvider,
            baseURL: baseURL,
            apiKey: resolvedAPIKey.isEmpty ? nil : resolvedAPIKey
        )
    }

    /// Clears the provider-native status cache, e.g. after model refresh.
    func invalidateProviderStatus() {
        Task { await statusService.invalidate() }
    }


    /// Starts the background health poller. Safe to call repeatedly.
    func startBackgroundHealthChecks(interval: TimeInterval = 60) {
        guard isBackgroundHealthPollingEnabled else { return }
        if backgroundPoller == nil {
            backgroundPoller = BackgroundHealthPoller(store: self, interval: interval)
        }
        backgroundPoller?.start()
    }

    /// Stops the background health poller.
    func stopBackgroundHealthChecks() {
        backgroundPoller?.stop()
    }

    /// Restarts the poller with the latest enabled flag and interval.
    func restartBackgroundHealthChecks(interval: TimeInterval = 60) {
        stopBackgroundHealthChecks()
        startBackgroundHealthChecks(interval: interval)
    }

    /// Toggles background polling on/off and persists the preference.
    func setBackgroundHealthPollingEnabled(_ enabled: Bool) {
        isBackgroundHealthPollingEnabled = enabled
        defaults.set(enabled, forKey: "trios.model.background-health-polling-enabled")
        if enabled {
            startBackgroundHealthChecks()
        } else {
            stopBackgroundHealthChecks()
        }
    }

    /// Loads the persisted background polling preference.
    private func loadBackgroundHealthPollingPreference() {
        isBackgroundHealthPollingEnabled = defaults.object(forKey: "trios.model.background-health-polling-enabled") as? Bool ?? true
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
        get async {
            ModelRuntimeConfiguration(
                provider: selectedProvider,
                model: selectedModel,
                baseURL: baseURL,
                apiKey: resolvedAPIKey.isEmpty ? nil : resolvedAPIKey,
                fallbackModels: await fallbackModels
            )
        }
    }

    /// Synchronous runtime configuration for callers that cannot await.
    /// Uses the static fallback order.
    var runtimeConfigurationSync: ModelRuntimeConfiguration {
        ModelRuntimeConfiguration(
            provider: selectedProvider,
            model: selectedModel,
            baseURL: baseURL,
            apiKey: resolvedAPIKey.isEmpty ? nil : resolvedAPIKey,
            fallbackModels: fallbackModelsSync
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
        Task { await reliabilityService.reset(provider: selectedProvider, baseURL: baseURL) }
        invalidateHealth()
        restartBackgroundHealthChecks()
    }

    func updateBaseURL(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        baseURL = trimmed
        defaults.set(trimmed, forKey: Self.baseURLKey(selectedProvider))
        Task { await reliabilityService.reset(provider: selectedProvider, baseURL: baseURL) }
        invalidateHealth()
        restartBackgroundHealthChecks()
    }

    func selectModel(_ model: String) {
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        selectedModel = trimmed
        defaults.set(trimmed, forKey: Self.modelKey(selectedProvider))
    }

    func resetBaseURL() {
        baseURL = selectedProvider.defaultBaseURL
        defaults.removeObject(forKey: Self.baseURLKey(selectedProvider))
        Task { await reliabilityService.reset(provider: selectedProvider, baseURL: baseURL) }
        invalidateHealth()
        restartBackgroundHealthChecks()
    }

    func saveAPIKey(_ value: String) throws {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        try ModelCredentialStore.save(trimmed, for: selectedProvider)
        credentialRevision += 1
        Task { await reliabilityService.reset(provider: selectedProvider, baseURL: baseURL) }
        invalidateHealth()
        restartBackgroundHealthChecks()
    }

    func deleteAPIKey() throws {
        try ModelCredentialStore.delete(for: selectedProvider, ignoresMissing: true)
        credentialRevision += 1
        Task { await reliabilityService.reset(provider: selectedProvider, baseURL: baseURL) }
        invalidateHealth()
        restartBackgroundHealthChecks()
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
