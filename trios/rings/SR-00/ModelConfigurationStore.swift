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

/// One stored API key for a provider.
///
/// The secret itself never leaves the Keychain; this record carries only the
/// identity and a masked preview so the UI can list, label, and delete keys
/// individually.
struct ModelKeyEntry: Identifiable, Equatable, Sendable {
    let id: String
    let provider: ModelProvider
    let label: String
    let maskedValue: String
    let createdAt: Date?

    /// Legacy entries were stored before multi-key support, under an account
    /// name equal to the bare provider identifier.
    var isLegacy: Bool { id == ModelCredentialStore.legacyEntryID }
}

enum ModelCredentialStore {
    private static let service = "com.browseros.trios.model-keys"
    private static let accountSeparator = "#"
    /// Identifier reserved for the pre-multi-key entry.
    static let legacyEntryID = "legacy"
    private static let activeKeyDefaultsPrefix = "trios.activeModelKey."

    // MARK: - Account encoding

    /// Maps a KeychainSecretsError back to the OSStatus that
    /// ModelCredentialError.keychain expects, so routing through
    /// KeychainSecrets does not change the error callers see.
    private static func mapKeychainError(_ error: KeychainSecretsError) -> OSStatus {
        switch error {
        case .itemNotFound: return errSecItemNotFound
        case .invalidItemType: return errSecIO
        case .osStatus(let status): return status
        }
    }

    private static func account(for provider: ModelProvider, entryID: String) -> String {
        entryID == legacyEntryID
            ? provider.rawValue
            : "\(provider.rawValue)\(accountSeparator)\(entryID)"
    }

    /// Splits a stored account name back into provider and entry id. Returns nil
    /// for accounts belonging to a different provider.
    static func entryID(fromAccount account: String, provider: ModelProvider) -> String? {
        if account == provider.rawValue { return legacyEntryID }
        // The dev variant stores secrets as files and sanitises the account into
        // a file name, which turns the "#" separator into "_". Accepting both
        // spellings keeps the account round-trip lossless; without this the dev
        // build listed no keys at all and every request went out unauthenticated.
        for separator in [accountSeparator, "_"] {
            let prefix = "\(provider.rawValue)\(separator)"
            guard account.hasPrefix(prefix) else { continue }
            let id = String(account.dropFirst(prefix.count))
            if !id.isEmpty { return id }
        }
        return nil
    }

    // MARK: - Listing

    /// All keys stored for a provider, oldest first. Legacy entries sort first so
    /// the previously active key stays at the top of the list after upgrading.
    static func list(for provider: ModelProvider) -> [ModelKeyEntry] {
        if ProjectPaths.isDevVariant {
            return DevSecretStore.accounts(service: service).compactMap { item in
                guard let id = entryID(fromAccount: item.account, provider: provider) else { return nil }
                let secret = DevSecretStore.read(service: service, account: item.account)
                    .flatMap { String(data: $0, encoding: .utf8) } ?? ""
                return ModelKeyEntry(
                    id: id,
                    provider: provider,
                    label: defaultLabel(for: id),
                    maskedValue: mask(secret),
                    createdAt: item.created
                )
            }.sorted { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }
        }
        // Deliberately no kSecReturnData. Asking for the secret forces macOS to
        // unlock every stored item just to draw a list, which produced one
        // "enter your login keychain password" dialog per key. The masked
        // preview is written to kSecAttrDescription at save time, so listing
        // reads metadata only and never prompts.
        //
        // Routed through KeychainSecrets so the global gate — launch check,
        // bounded wait, cooldown — covers this listing path too.
        let items = KeychainSecrets.readAllAttributes(service: service)
        guard !items.isEmpty else {
            return []
        }

        var entries: [ModelKeyEntry] = []
        for item in items {
            guard let account = item[kSecAttrAccount as String] as? String,
                  let id = entryID(fromAccount: account, provider: provider) else {
                continue
            }
            let label = item[kSecAttrLabel as String] as? String
            // Masked preview stored as metadata; never the secret itself.
            let masked = item[kSecAttrDescription as String] as? String
            entries.append(
                ModelKeyEntry(
                    id: id,
                    provider: provider,
                    label: label?.isEmpty == false ? label! : defaultLabel(for: id),
                    maskedValue: masked?.isEmpty == false ? masked! : "****",
                    createdAt: item[kSecAttrCreationDate as String] as? Date
                )
            )
        }
        return entries.sorted { lhs, rhs in
            if lhs.isLegacy != rhs.isLegacy { return lhs.isLegacy }
            switch (lhs.createdAt, rhs.createdAt) {
            case let (l?, r?): return l < r
            case (nil, _): return false
            case (_, nil): return true
            }
        }
    }

    private static func defaultLabel(for entryID: String) -> String {
        entryID == legacyEntryID ? "Imported key" : "Key \(entryID.prefix(4))"
    }

    /// Masks a secret for display: first four and last four characters only.
    static func mask(_ secret: String) -> String {
        guard secret.count > 8 else { return String(repeating: "*", count: max(secret.count, 3)) }
        return "\(secret.prefix(4))...\(secret.suffix(4))"
    }

    // MARK: - Active selection

    private static func activeDefaultsKey(for provider: ModelProvider) -> String {
        "\(activeKeyDefaultsPrefix)\(provider.rawValue)"
    }

    /// Entry id currently used for requests. Falls back to the first stored key
    /// when the recorded selection has been deleted.
    static func activeEntryID(for provider: ModelProvider) -> String? {
        let stored = UserDefaults.standard.string(forKey: activeDefaultsKey(for: provider))
        let entries = list(for: provider)
        if let stored, entries.contains(where: { $0.id == stored }) {
            return stored
        }
        return entries.first?.id
    }

    static func setActiveEntryID(_ entryID: String?, for provider: ModelProvider) {
        let key = activeDefaultsKey(for: provider)
        if let entryID {
            UserDefaults.standard.set(entryID, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    // MARK: - Read

    /// Secret for the active key. Preserves the original single-key contract so
    /// every existing call site keeps working unchanged.
    static func read(for provider: ModelProvider) -> String? {
        guard let entryID = activeEntryID(for: provider) else { return nil }
        return read(entryID: entryID, for: provider)
    }

    /// In-process cache of resolved secrets.
    ///
    /// The app resolves the active key on nearly every send, health probe, and
    /// settings render. Each of those was a fresh Keychain read, and because the
    /// app is ad-hoc signed a rebuilt binary is a different identity to macOS -
    /// so every read could raise another "enter your login keychain password"
    /// dialog. Caching turns that into at most one prompt per key per launch.
    /// Cleared whenever credentials change, so a deleted key cannot linger.
    private static let cacheLock = NSLock()
    private static var secretCache: [String: String] = [:]

    static func read(entryID: String, for provider: ModelProvider) -> String? {
        let cacheKey = account(for: provider, entryID: entryID)
        if ProjectPaths.isDevVariant {
            return DevSecretStore.read(service: service, account: cacheKey)
                .flatMap { String(data: $0, encoding: .utf8) }
        }
        // Headless runs must never touch the Keychain. The
        // `allowsInteraction: false` flag passed to KeychainSecrets below is
        // not enough: these items live in the legacy file keychain, so the read
        // lands in SecKeychainItemCopyContent and blocks on securityd waiting
        // for an ACL prompt that no one can answer. That hung the chat e2e for
        // as long as the harness was allowed to run.
        if ProcessInfo.processInfo.environment["TRIOS_E2E_DISABLE_KEYCHAIN"] == "1" {
            return nil
        }

        cacheLock.lock()
        let cached = secretCache[cacheKey]
        cacheLock.unlock()
        if let cached { return cached }

        // Routed through KeychainSecrets so the global gate — bounded wait,
        // background dispatch, cooldown after a stall — covers this read.
        guard let data = try? KeychainSecrets.readData(
            service: service,
            account: cacheKey,
            allowsInteraction: false
        ),
        let secret = String(data: data, encoding: .utf8) else {
            return nil
        }

        cacheLock.lock()
        secretCache[cacheKey] = secret
        cacheLock.unlock()
        return secret
    }

    /// Drops cached secrets. Called after any mutation so the cache cannot serve
    /// a key that no longer exists.
    static func invalidateSecretCache() {
        cacheLock.lock()
        secretCache.removeAll()
        cacheLock.unlock()
    }

    // MARK: - Write

    /// Replaces every stored key for a provider with a single one. Retained for
    /// callers that still model credentials as one-per-provider.
    static func save(_ key: String, for provider: ModelProvider) throws {
        try deleteAll(for: provider, ignoresMissing: true)
        _ = try add(key, label: "Default key", for: provider)
    }

    /// Stores an additional key alongside any existing ones and makes it active.
    @discardableResult
    static func add(
        _ key: String,
        label: String,
        for provider: ModelProvider,
        entryID: String = UUID().uuidString
    ) throws -> ModelKeyEntry {
        let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedLabel = trimmedLabel.isEmpty ? defaultLabel(for: entryID) : trimmedLabel
        // Routed through KeychainSecrets so the global gate — launch check,
        // bounded wait, background dispatch — covers this write.
        do {
            try KeychainSecrets.addEntry(
                service: service,
                account: account(for: provider, entryID: entryID),
                label: resolvedLabel,
                description: mask(key),
                data: Data(key.utf8)
            )
        } catch let error as KeychainSecretsError {
            throw ModelCredentialError.keychain(mapKeychainError(error))
        }
        setActiveEntryID(entryID, for: provider)
        invalidateSecretCache()
        return ModelKeyEntry(
            id: entryID,
            provider: provider,
            label: resolvedLabel,
            maskedValue: mask(key),
            createdAt: Date()
        )
    }

    /// Renames a stored key without touching the secret.
    static func rename(entryID: String, to label: String, for provider: ModelProvider) throws {
        // Routed through KeychainSecrets so the global gate — launch check,
        // bounded wait, background dispatch — covers this write.
        do {
            try KeychainSecrets.updateLabel(
                service: service,
                account: account(for: provider, entryID: entryID),
                label: label
            )
        } catch let error as KeychainSecretsError {
            throw ModelCredentialError.keychain(mapKeychainError(error))
        }
    }

    // MARK: - Delete

    /// Removes one key. If it was the active one, the next remaining key takes
    /// over so the provider does not silently lose its credentials.
    static func delete(entryID: String, for provider: ModelProvider) throws {
        // Routed through KeychainSecrets so the dev-variant and error-handling
        // paths are shared with every other keychain operation.
        do {
            try KeychainSecrets.delete(
                service: service,
                account: account(for: provider, entryID: entryID)
            )
        } catch let error as KeychainSecretsError {
            throw ModelCredentialError.keychain(mapKeychainError(error))
        }
        invalidateSecretCache()
        if UserDefaults.standard.string(forKey: activeDefaultsKey(for: provider)) == entryID {
            setActiveEntryID(list(for: provider).first?.id, for: provider)
        }
    }

    /// Removes every key for a provider.
    static func deleteAll(for provider: ModelProvider, ignoresMissing: Bool = false) throws {
        let entries = list(for: provider)
        guard !entries.isEmpty else {
            guard ignoresMissing else {
                throw ModelCredentialError.keychain(errSecItemNotFound)
            }
            setActiveEntryID(nil, for: provider)
            return
        }
        for entry in entries {
            try delete(entryID: entry.id, for: provider)
        }
        setActiveEntryID(nil, for: provider)
    }

    /// Legacy single-key delete, preserved for existing call sites.
    static func delete(for provider: ModelProvider, ignoresMissing: Bool = false) throws {
        try deleteAll(for: provider, ignoresMissing: ignoresMissing)
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

    /// Entry id served by the last rotation, so a failure is attributed to the
    /// key that actually made the request rather than the currently active one.
    var lastRotatedEntryID: [ModelProvider: String] = [:]
    @Published private(set) var modelsTabRequest = 0
    @Published private(set) var unhealthyModels: Set<String> = []
    @Published private(set) var isCheckingHealth = false
    @Published private(set) var lastHealthCheckAt: Date?
    @Published var isBackgroundHealthPollingEnabled = true
    @Published private(set) var providerStatuses: [String: ProviderModelStatus] = [:]
    @Published var isPredictiveSelectionEnabled: Bool = false
    @Published var preferredCostTier: ModelCostTier = .any
    @Published private(set) var predictiveSelectionReason: String?
    @Published var isCrossProviderFailoverEnabled: Bool = false
    @Published private(set) var crossProviderFailoverReason: String?
    @Published var isAdaptiveProviderWarmupEnabled: Bool = false
    @Published private(set) var lastAdaptiveWarmupAt: Date?
    @Published private(set) var lastAdaptiveWarmupReason: String?
    @Published var isStrictQuotaGatingEnabled: Bool = false
    @Published private(set) var lastQuotaGatingReason: String?
    @Published var isPredictiveWarmupEnabled: Bool = false
    @Published var predictiveWarmupTTL: TimeInterval = 60
    @Published var predictiveWarmupInterval: TimeInterval = 60
    @Published var predictiveWarmupMaxStaleness: TimeInterval = 120
    @Published private(set) var lastPredictiveWarmupReason: String?
    @Published private(set) var lastPredictiveWarmupAt: Date?

    @Published var contextWindowMargin: Double = 0.85
    @Published var isStreamingContextWatchdogEnabled: Bool = true
    @Published var lastContextRoutingReason: String?
    @Published var lastContextRoutedAt: Date?
    @Published var lastContextEstimatedInputTokens: Int?
    @Published var lastContextRequestedOutputTokens: Int?
    /// User-configured per-send output-token budget. Persisted and clamped to the
    /// effective (advertised or learned) output ceiling at request time.
    @Published var requestedOutputTokens: Int? = nil

    /// Per-(provider, baseURL, model) unhealthy flags used by ranking logic.
    /// A conservative `unhealthyModels` string set is kept for the UI.
    @Published private(set) var unhealthyTuples: Set<ModelEndpointTuple> = []

    let defaults: UserDefaults
    private let environment: [String: String]
    private let catalogService: ModelCatalogService
    private let healthService: any ModelHealthServiceProtocol
    private let statusService: any ProviderStatusServiceProtocol
    private let reliabilityService: ModelReliabilityService
    private let costService: ModelCostService
    let circuitBreaker: ProviderCircuitBreaker
    let quotaService: ProviderQuotaService
    private let warmupService: ModelWarmupService
    private let warmupCache: PredictiveWarmupCache
    private let volatilityTracker: WarmupVolatilityTracker
    private lazy var warmupRefresher: PredictiveWarmupRefresher = PredictiveWarmupRefresher(store: self)
    let contextService: ModelContextService
    let contextLimitLearner: StreamingContextLimitLearner
    let requestSizer: ChatRequestSizer
    private var backgroundPoller: BackgroundHealthPoller?
    private var predictiveScheduler: PredictiveWarmupScheduler?

    /// Exposed for tests only.
    var backgroundPollerForTests: BackgroundHealthPoller? { backgroundPoller }
    var reliabilityServiceForTests: ModelReliabilityService { reliabilityService }
    var warmupCacheForTests: PredictiveWarmupCache { warmupCache }
    var volatilityTrackerForTests: WarmupVolatilityTracker { volatilityTracker }
    var warmupRefresherForTests: PredictiveWarmupRefresher { warmupRefresher }

    init(
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        catalogService: ModelCatalogService = ModelCatalogService(),
        statusService: any ProviderStatusServiceProtocol = ProviderStatusService(),
        healthService: (any ModelHealthServiceProtocol)? = nil,
        reliabilityService: ModelReliabilityService? = nil,
        costService: ModelCostService = .shared,
        circuitBreaker: ProviderCircuitBreaker? = nil,
        quotaService: ProviderQuotaService? = nil,
        warmupCache: PredictiveWarmupCache? = nil,
        volatilityTracker: WarmupVolatilityTracker? = nil,
        volatilityHistoryStore: VolatilityHistoryStore? = nil,
        contextService: ModelContextService? = nil,
        contextLimitLearner: StreamingContextLimitLearner? = nil,
        requestSizer: ChatRequestSizer? = nil
    ) {
        self.catalogService = catalogService
        self.statusService = statusService
        self.healthService = healthService ?? ModelHealthService(statusService: statusService)
        self.reliabilityService = reliabilityService ?? ModelReliabilityService(
            store: MemoryStoreReliabilityAdapter()
        )
        self.costService = costService
        self.circuitBreaker = circuitBreaker ?? ProviderCircuitBreaker()
        self.quotaService = quotaService ?? ProviderQuotaService()
        self.warmupCache = warmupCache ?? PredictiveWarmupCache()
        self.volatilityTracker = volatilityTracker ?? WarmupVolatilityTracker(
            historyStore: volatilityHistoryStore ?? VolatilityHistoryStore()
        )
        self.warmupService = ModelWarmupService(
            healthService: self.healthService,
            reliabilityService: self.reliabilityService,
            circuitBreaker: self.circuitBreaker,
            costService: costService,
            quotaService: self.quotaService
        )
        self.contextService = contextService ?? ModelContextService.shared
        self.contextLimitLearner = contextLimitLearner ?? StreamingContextLimitLearner.shared
        self.requestSizer = requestSizer ?? ChatRequestSizer.shared
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
        isPredictiveSelectionEnabled = defaults.object(forKey: Self.predictiveSelectionEnabledKey) as? Bool ?? false
        preferredCostTier = ModelCostTier(
            rawValue: defaults.string(forKey: Self.preferredCostTierKey) ?? ""
        ) ?? .any
        isCrossProviderFailoverEnabled = defaults.object(forKey: Self.crossProviderFailoverEnabledKey) as? Bool ?? false
        isAdaptiveProviderWarmupEnabled = defaults.object(forKey: Self.adaptiveProviderWarmupEnabledKey) as? Bool ?? false
        isStrictQuotaGatingEnabled = defaults.object(forKey: Self.strictQuotaGatingEnabledKey) as? Bool ?? false
        isPredictiveWarmupEnabled = defaults.object(forKey: Self.predictiveWarmupEnabledKey) as? Bool ?? false
        predictiveWarmupTTL = defaults.object(forKey: Self.predictiveWarmupTTLKey) as? TimeInterval ?? 60
        predictiveWarmupInterval = defaults.object(forKey: Self.predictiveWarmupIntervalKey) as? TimeInterval ?? 60
        predictiveWarmupMaxStaleness = defaults.object(forKey: Self.predictiveWarmupMaxStalenessKey) as? TimeInterval ?? 120
        predictiveSelectionReason = nil
        crossProviderFailoverReason = nil
        lastAdaptiveWarmupReason = nil
        lastQuotaGatingReason = nil
        lastPredictiveWarmupReason = nil
        lastContextRoutingReason = nil
        loadContextWindowMargin()
        loadStreamingContextWatchdogPreference()
        loadRequestedOutputTokens()

        loadBackgroundHealthPollingPreference()
        startBackgroundHealthChecks()
        Task { [weak self] in
            await self?.volatilityTracker.loadHistory()
        }
        Task { [weak self] in
            await self?.startPredictiveWarmup()
        }

        if isPredictiveSelectionEnabled {
            Task { [weak self] in
                await self?.applyPredictiveSelection(reason: "Enabled at launch")
            }
        }
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
        guard let next = candidates.first(where: { !isUnhealthy(provider: selectedProvider, baseURL: baseURL, model: $0) }) else { return nil }
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

    /// Resolves the API key for a provider from Keychain, `~/.trios/config.json`,
    /// or an environment variable, in that order.
    func resolvedAPIKey(for provider: ModelProvider) -> String {
        if let keychain = ModelCredentialStore.read(for: provider), !keychain.isEmpty {
            return keychain
        }
        if let fileKey = Self.apiKeyFromConfigFile(for: provider), !fileKey.isEmpty {
            return fileKey
        }
        let envVar = Self.providerEnvironmentKey(provider)
        return environment[envVar] ?? ""
    }

    /// A provider can be used for cross-provider failover if it needs no key
    /// (Ollama) or a non-empty key is available.
    func isProviderEligible(_ provider: ModelProvider) -> Bool {
        if !provider.requiresAPIKey { return true }
        return !resolvedAPIKey(for: provider).isEmpty
    }

    /// The persisted or default base URL for a provider.
    func baseURLForProvider(_ provider: ModelProvider) -> String {
        defaults.string(forKey: Self.baseURLKey(provider)) ?? provider.defaultBaseURL
    }

    /// All providers that have credentials (or need none) with their base URLs.
    var eligibleProviderConfigurations: [(provider: ModelProvider, baseURL: String)] {
        ModelProvider.allCases.filter { isProviderEligible($0) }.map { ($0, baseURLForProvider($0)) }
    }

    /// Switches to the healthiest model on a different eligible provider. Excludes
    /// models currently marked unhealthy and the active (provider, baseURL, model)
    /// tuple. Returns the chosen candidate or `nil` if no eligible provider is
    /// available. The selection is applied immediately and persisted.
    @discardableResult
    /// Cross-provider failover honours a conversation pin: a user who fixed a
    /// conversation to one model must not be moved to another provider behind
    /// their back.
    func selectFirstHealthyCrossProviderModel(
        constrainedTo constraint: ConversationModelConstraint? = nil
    ) async -> CrossProviderModelCandidate? {
        if let constraint { return constraint.candidate }
        var allowedConfigs: [(provider: ModelProvider, baseURL: String)] = []
        for config in eligibleProviderConfigurations {
            let key = ProviderEndpointKey(provider: config.provider, baseURL: config.baseURL)
            if await circuitBreaker.canSend(to: key) {
                allowedConfigs.append(config)
            }
        }
        guard !allowedConfigs.isEmpty else { return nil }

        let originalProvider = selectedProvider
        let ranked = await reliabilityService.rankedCrossProviderFallbacks(
            currentProvider: selectedProvider,
            currentBaseURL: baseURL,
            currentModel: selectedModel,
            providerConfigurations: allowedConfigs
        )
        // Exclude per-tuple unhealthy flags and re-check breaker state (a provider
        // may have tripped between the initial filter and this loop).
        var healthyRanked: [(candidate: CrossProviderModelCandidate, score: Double)] = []
        for entry in ranked {
            let key = ProviderEndpointKey(provider: entry.candidate.provider, baseURL: entry.candidate.baseURL)
            guard await circuitBreaker.canSend(to: key) else { continue }
            guard !isUnhealthy(
                provider: entry.candidate.provider,
                baseURL: entry.candidate.baseURL,
                model: entry.candidate.model
            ) else { continue }
            healthyRanked.append(entry)
        }

        // Live-probe the top candidates in order until one is actually healthy.
        for entry in healthyRanked {
            let candidate = entry.candidate
            let apiKey = resolvedAPIKey(for: candidate.provider)
            let probe = await healthService.probe(
                model: candidate.model,
                provider: candidate.provider,
                baseURL: candidate.baseURL,
                apiKey: apiKey.isEmpty ? nil : apiKey
            )
            switch probe.health {
            case .healthy:
                applySelection(provider: candidate.provider, baseURL: candidate.baseURL, model: candidate.model)
                crossProviderFailoverReason = "Failover: switched from \(originalProvider.displayName) to \(candidate.provider.displayName) / \(candidate.model)"
                return candidate
            case .unavailable, .unknown:
                await circuitBreaker.recordFailure(
                    ProviderEndpointKey(provider: candidate.provider, baseURL: candidate.baseURL),
                    kind: .gateway
                )
                continue
            }
        }
        return nil
    }

    /// Restores the active provider/model/baseURL without resetting reliability
    /// history, used when a cross-provider retry fails and we want to revert.
    func restoreSelection(provider: ModelProvider, baseURL: String, model: String) {
        applySelection(provider: provider, baseURL: baseURL, model: model)
        crossProviderFailoverReason = nil
    }

    /// Low-level selection setter that updates published properties and persists
    /// them without clearing health caches or reliability history. Used for
    /// automatic failover, restore, and predictive cache reuse.
    func applySelection(provider: ModelProvider, baseURL: String, model: String) {
        let providerChanged = provider != selectedProvider
        selectedProvider = provider
        defaults.set(provider.rawValue, forKey: "trios.model.provider")
        selectedModel = model
        defaults.set(model, forKey: Self.modelKey(provider))
        self.baseURL = baseURL
        defaults.set(baseURL, forKey: Self.baseURLKey(provider))
        if providerChanged {
            credentialRevision += 1
        }
        restartBackgroundHealthChecks()
    }

    /// Probes the default model of every eligible provider and returns the raw
    /// health result. Useful for the "Probe all providers" button.
    func probeAllEligibleProviders() async -> [(provider: ModelProvider, baseURL: String, result: ModelHealthResult)] {
        let configs = eligibleProviderConfigurations
        var apiKeysByProvider: [ModelProvider: String] = [:]
        for config in configs {
            apiKeysByProvider[config.provider] = resolvedAPIKey(for: config.provider)
        }
        let healthService = self.healthService
        return await withTaskGroup(of: (provider: ModelProvider, baseURL: String, ModelHealthResult).self) { group in
            for config in configs {
                let apiKey = apiKeysByProvider[config.provider] ?? ""
                group.addTask {
                    let result = await healthService.probe(
                        model: config.provider.defaultModel,
                        provider: config.provider,
                        baseURL: config.baseURL,
                        apiKey: apiKey.isEmpty ? nil : apiKey
                    )
                    return (config.provider, config.baseURL, result)
                }
            }
            var results: [(provider: ModelProvider, baseURL: String, result: ModelHealthResult)] = []
            for await entry in group {
                results.append(entry)
            }
            return results
        }
    }

    /// Toggles cross-provider failover and persists the choice.
    func setCrossProviderFailoverEnabled(_ enabled: Bool) {
        isCrossProviderFailoverEnabled = enabled
        defaults.set(enabled, forKey: Self.crossProviderFailoverEnabledKey)
        if !enabled {
            crossProviderFailoverReason = nil
        }
    }

    /// Toggles adaptive provider warmup and persists the choice.
    func setAdaptiveProviderWarmupEnabled(_ enabled: Bool) {
        isAdaptiveProviderWarmupEnabled = enabled
        defaults.set(enabled, forKey: Self.adaptiveProviderWarmupEnabledKey)
        if !enabled {
            lastAdaptiveWarmupReason = nil
        }
    }

    /// Toggles strict quota gating for adaptive warmup and persists the choice.
    func setStrictQuotaGatingEnabled(_ enabled: Bool) {
        isStrictQuotaGatingEnabled = enabled
        defaults.set(enabled, forKey: Self.strictQuotaGatingEnabledKey)
        lastQuotaGatingReason = enabled ? "Strict quota gating on" : "Strict quota gating off"
    }

    /// Generates the candidate list for adaptive warmup from all eligible
    /// provider endpoints. The current selection is always included by the
    /// warmup service itself.
    /// Candidates eligible for warmup.
    ///
    /// A conversation pin narrows the set to the pinned tuple: warmup must not
    /// switch a conversation the user deliberately fixed to one model.
    func warmupCandidates(
        constrainedTo constraint: ConversationModelConstraint? = nil
    ) -> [CrossProviderModelCandidate] {
        if let constraint {
            return [constraint.candidate]
        }
        var candidates: [CrossProviderModelCandidate] = []
        for config in eligibleProviderConfigurations {
            let models = Array(config.provider.suggestedModels.prefix(2))
            for model in models {
                candidates.append(CrossProviderModelCandidate(
                    provider: config.provider,
                    baseURL: config.baseURL,
                    model: model
                ))
            }
        }
        return candidates
    }

    /// Runs adaptive provider warmup and, if a better live candidate is found,
    /// applies the new selection. Returns the warmup result so callers can show
    /// a banner or log timing.
    @discardableResult
    func runAdaptiveWarmup(
        constrainedTo constraint: ConversationModelConstraint? = nil
    ) async -> ModelWarmupResult {
        let current = CrossProviderModelCandidate(
            provider: selectedProvider,
            baseURL: baseURL,
            model: selectedModel
        )
        let result = await warmupService.warmup(
            current: current,
            candidates: warmupCandidates(),
            apiKeyResolver: { [weak self] provider in
                await self?.resolvedAPIKey(for: provider) ?? ""
            },
            tier: preferredCostTier,
            strictQuotaGating: isStrictQuotaGatingEnabled
        )
        lastAdaptiveWarmupAt = Date()
        lastAdaptiveWarmupReason = result.reason
        let effectiveTTL = await volatilityTracker.recommendedTTL(
            baseTTL: predictiveWarmupTTL,
            for: result.selected
        )
        await warmupCache.record(
            result,
            tier: preferredCostTier,
            strictQuotaGating: isStrictQuotaGatingEnabled,
            ttl: effectiveTTL
        )
        if result.didSwitch, result.selected != current {
            applySelection(
                provider: result.selected.provider,
                baseURL: result.selected.baseURL,
                model: result.selected.model
            )
            crossProviderFailoverReason = result.reason
        }
        return result
    }

    /// Returns the freshest cached warmup winner if it is still valid and the
    /// endpoint is allowed to receive traffic. Returns `nil` when there is no
    /// cache, the cache is stale, the breaker is open, or quota gating rejects
    /// the cached endpoint.
    func cachedWarmupWinner(
        tier: ModelCostTier = .any,
        strictQuotaGating: Bool = false
    ) async -> CachedWarmupWinner? {
        await cachedOrStaleWarmupWinner(
            tier: tier,
            strictQuotaGating: strictQuotaGating,
            maxStaleness: 0
        )?.winner
    }

    /// Returns a fresh cached winner if available, otherwise a stale winner that
    /// is still within the configured `maxStaleness` window and passes breaker +
    /// quota checks. Returns `nil` when no usable cache exists. The `isStale`
    /// flag tells the caller whether a background refresh is needed.
    func cachedOrStaleWarmupWinner(
        tier: ModelCostTier = .any,
        strictQuotaGating: Bool = false,
        maxStaleness: TimeInterval
    ) async -> (winner: CachedWarmupWinner, isStale: Bool)? {
        let baseMaxStaleness = max(0, min(600, maxStaleness))
        guard let selection = await warmupCache.winnerOrStale(
            tier: tier,
            strictQuotaGating: strictQuotaGating,
            maxStaleness: baseMaxStaleness
        ) else {
            return nil
        }

        // If the cache is stale, let volatility learning shrink or zero the
        // allowed staleness window. Severe recent failures (auth, balance,
        // context-length) disable stale-while-revalidate for this candidate.
        if selection.isStale {
            let allowed = await volatilityTracker.recommendedMaxStaleness(
                baseMaxStaleness: baseMaxStaleness,
                for: selection.winner.selected
            )
            guard selection.winner.staleness() <= allowed else { return nil }
        }

        let key = ProviderEndpointKey(provider: selection.winner.selected.provider, baseURL: selection.winner.selected.baseURL)
        guard await circuitBreaker.canSend(to: key) else { return nil }
        if strictQuotaGating {
            let quota = await quotaService.status(for: selection.winner.selected.provider, baseURL: selection.winner.selected.baseURL)
            guard !quota.isDepleted else { return nil }
        }
        return selection
    }

    /// Returns the remaining TTL of the cached winner for the active preferences,
    /// or `nil` when there is no fresh cache.
    func cachedWarmupRemainingTTL(
        tier: ModelCostTier = .any,
        strictQuotaGating: Bool = false
    ) async -> TimeInterval? {
        await warmupCache.remainingTTL(
            tier: tier,
            strictQuotaGating: strictQuotaGating
        )
    }

    /// Records whether a cached warmup winner succeeded or failed on a real send.
    /// The volatility tracker uses this to shrink or relax TTL/interval.
    /// `kind` drives kind-aware learning; when omitted, failures are treated as
    /// `.unknown` (shrink by rate only, not severity).
    func recordCachedWinnerOutcome(
        success: Bool,
        candidate: CrossProviderModelCandidate,
        kind: ProviderCircuitBreakerFailureKind? = nil
    ) async {
        let outcome: WarmupVolatilityTracker.Outcome
        if success {
            outcome = .success
        } else if let kind {
            outcome = .failure(kind: kind)
        } else {
            outcome = .failure(kind: .unknown)
        }
        await volatilityTracker.record(outcome, for: candidate)

        // Severe failures shrink the predictive refresh interval at runtime so the
        // scheduler does not keep using a long fixed interval when conditions have
        // degraded. This is intentionally a soft restart: if the interval did not
        // actually change the loop keeps its current wake time.
        if !success, let kind, kind.volatilityWeight == 0.0 {
            await restartPredictiveWarmupIfIntervalChanged()
        }
    }

    /// Restarts the predictive warmup loop only if the recommended interval for
    /// the current selection has become meaningfully shorter than the running
    /// loop's interval. Avoids churn when nothing has changed.
    private func restartPredictiveWarmupIfIntervalChanged() async {
        let current = CrossProviderModelCandidate(
            provider: selectedProvider,
            baseURL: baseURL,
            model: selectedModel
        )
        let recommended = await volatilityTracker.recommendedInterval(
            baseInterval: predictiveWarmupInterval,
            for: current
        )
        // Restart when the recommended interval is at least 10 seconds shorter
        // than the current loop interval, indicating volatility has increased.
        let running = await effectivePredictiveWarmupInterval(base: predictiveWarmupInterval)
        guard running - recommended >= 10 else { return }
        await restartPredictiveWarmup(interval: recommended)
    }

    /// Returns the recent failure rate for the current cached winner, if any.
    func cachedWinnerFailureRate(
        tier: ModelCostTier = .any,
        strictQuotaGating: Bool = false
    ) async -> Double {
        guard let winner = await warmupCache.winner(
            tier: tier,
            strictQuotaGating: strictQuotaGating
        ) else {
            return 0
        }
        return await volatilityTracker.failureRate(for: winner.selected)
    }

    /// Returns true when a cached winner exists but is no longer fresh, i.e. it
    /// would only be served via stale-while-revalidate.
    func isCachedWarmupWinnerStale(
        tier: ModelCostTier = .any,
        strictQuotaGating: Bool = false
    ) async -> Bool {
        guard let selection = await warmupCache.winnerOrStale(
            tier: tier,
            strictQuotaGating: strictQuotaGating,
            maxStaleness: predictiveWarmupMaxStaleness
        ) else {
            return false
        }
        return selection.isStale
    }

    /// True when the volatility tracker has learned any persisted or in-memory
    /// history for at least one candidate.
    var hasWarmupVolatilityHistory: Bool {
        get async {
            await volatilityTracker.hasHistory
        }
    }

    /// Number of candidates with learned volatility history.
    var warmupVolatilityHistoryCount: Int {
        get async {
            await volatilityTracker.learnedCandidateCount
        }
    }

    /// Clears all learned volatility history from memory and from disk.
    func resetWarmupVolatilityHistory() async {
        await volatilityTracker.reset()
    }

    /// Records a health-probe outcome into the reliability scorecard.
    func recordHealthOutcome(model: String, result: ModelHealthResult) async {
        await reliabilityService.recordHealth(
            model: model,
            provider: selectedProvider,
            baseURL: baseURL,
            health: result.health,
            latencyMs: result.latencyMs
        )
    }

    /// Records a manual send outcome into the reliability scorecard.
    func recordSendOutcome(
        model: String,
        success: Bool,
        reason: String? = nil,
        latencyMs: Int? = nil,
        timeToFirstTokenMs: Int? = nil,
        observedOutputTokens: Int? = nil,
        observedTotalTokens: Int? = nil,
        finishReason: String? = nil
    ) async {
        let outcome = ModelOutcome(
            model: model,
            provider: selectedProvider,
            baseURL: baseURL,
            success: success,
            reason: reason,
            latencyMs: latencyMs,
            timeToFirstTokenMs: timeToFirstTokenMs,
            observedOutputTokens: observedOutputTokens,
            observedTotalTokens: observedTotalTokens,
            finishReason: finishReason
        )
        await reliabilityService.record(outcome: outcome)
        await contextLimitLearner.recordOutcome(outcome)
    }

    /// Records a manual send outcome for an arbitrary provider endpoint.
    func recordSendOutcome(
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
        let outcome = ModelOutcome(
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
        await reliabilityService.record(outcome: outcome)
        await contextLimitLearner.recordOutcome(outcome)
    }

    /// Marks a model as unavailable on the current provider endpoint.
    func markUnhealthy(_ model: String) {
        markUnhealthy(provider: selectedProvider, baseURL: baseURL, model: model)
    }

    /// Marks a model as unavailable on a specific provider endpoint.
    func markUnhealthy(provider: ModelProvider, baseURL: String, model: String) {
        unhealthyTuples.insert(ModelEndpointTuple(provider: provider, baseURL: baseURL, model: model))
        unhealthyModels.insert(model)
    }

    /// Clears the unhealthy flag for a model on the current provider endpoint.
    func markHealthy(_ model: String) {
        markHealthy(provider: selectedProvider, baseURL: baseURL, model: model)
    }

    /// Clears the unhealthy flag for a model on a specific provider endpoint.
    func markHealthy(provider: ModelProvider, baseURL: String, model: String) {
        unhealthyTuples.remove(ModelEndpointTuple(provider: provider, baseURL: baseURL, model: model))
        // Keep the string set conservative: only remove the name when no tuple
        // with this model remains unhealthy.
        if !unhealthyTuples.contains(where: { $0.model == model }) {
            unhealthyModels.remove(model)
        }
    }

    /// Returns true if the given (provider, baseURL, model) is marked unhealthy.
    func isUnhealthy(provider: ModelProvider, baseURL: String, model: String) -> Bool {
        unhealthyTuples.contains(ModelEndpointTuple(provider: provider, baseURL: baseURL, model: model))
    }

    /// Returns the cached/in-memory health status and probe latency for a model.
    func healthStatus(for model: String) async -> ModelHealthResult {
        await healthService.probe(
            model: model,
            provider: selectedProvider,
            baseURL: baseURL,
            apiKey: resolvedAPIKey.isEmpty ? nil : resolvedAPIKey
        )
    }

    /// Returns the aggregate latency signal for a model.
    func latency(for model: String) async -> ModelLatency {
        await reliabilityService.latency(
            for: model,
            provider: selectedProvider,
            baseURL: baseURL
        )
    }

    /// Re-probes every known model in parallel, updates `unhealthyModels`, and
    /// records each outcome in the persistent reliability scorecard.
    func refreshHealth() async {
        isCheckingHealth = true
        defer { isCheckingHealth = false }
        let models = availableModels
        let provider = selectedProvider
        let url = baseURL
        let environment = self.environment
        let healthService = self.healthService
        var newUnhealthy: Set<ModelEndpointTuple> = []
        var newHealthy: Set<ModelEndpointTuple> = []
        // Walk the models on a background queue so per-model credential
        // reads never block the main actor. Hop back only to publish.
        // Read the cheap main-actor-bound values up front so the
        // keychain-backed read is the only credential access left
        // inside the detached task.
        let configKey = Self.apiKeyFromConfigFile(for: provider)
        let envVar = Self.providerEnvironmentKey(provider)
        let outcomes = await Task.detached {
            let resolvedKey: String = {
                if let keychain = ModelCredentialStore.read(for: provider), !keychain.isEmpty {
                    return keychain
                }
                if let fileKey = configKey, !fileKey.isEmpty {
                    return fileKey
                }
                return environment[envVar] ?? ""
            }()
            let apiKey: String? = resolvedKey.isEmpty ? nil : resolvedKey
            return await withTaskGroup(of: (ModelEndpointTuple, ModelHealthResult).self) { group in
                for model in models {
                    let tuple = ModelEndpointTuple(provider: provider, baseURL: url, model: model)
                    group.addTask {
                        let result = await healthService.probe(
                            model: model,
                            provider: provider,
                            baseURL: url,
                            apiKey: apiKey
                        )
                        return (tuple, result)
                    }
                }
                var collected: [(ModelEndpointTuple, ModelHealthResult)] = []
                for await item in group {
                    collected.append(item)
                }
                return collected
            }
        }.value
        for (tuple, result) in outcomes {
            await recordHealthOutcome(model: tuple.model, result: result)
            switch result.health {
            case .unavailable:
                newUnhealthy.insert(tuple)
            case .healthy:
                newHealthy.insert(tuple)
            case .unknown:
                break
            }
        }
        // Remove healthy tuples from the unhealthy set so recovery is detected.
        unhealthyTuples.formUnion(newUnhealthy)
        unhealthyTuples.subtract(newHealthy)
        // Rebuild the conservative UI-facing string set from the tuple set.
        unhealthyModels = Set(unhealthyTuples.map { $0.model })
        lastHealthCheckAt = Date()
    }

    /// Clears health cache and unhealthy flags, e.g. when endpoint/key changes.
    func invalidateHealth() {
        unhealthyTuples.removeAll()
        unhealthyModels.removeAll()
        lastHealthCheckAt = nil
        Task { await healthService.invalidate() }
        Task { await statusService.invalidate() }
        Task { await quotaService.invalidate() }
    }

    /// Returns the latest quota status for a provider endpoint.
    func quotaStatus(for provider: ModelProvider, baseURL: String) async -> ProviderQuotaStatus {
        await quotaService.status(for: provider, baseURL: baseURL)
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

    // MARK: - Circuit breaker helpers

    /// Records a transport failure against the current provider endpoint.
    func recordCircuitBreakerFailure(_ error: TransportError) async {
        let key = ProviderEndpointKey(provider: selectedProvider, baseURL: baseURL)
        await circuitBreaker.recordFailure(
            key,
            kind: error.circuitBreakerFailureKind,
            retryAfter: error.retryAfter
        )
    }

    /// Records a transport failure against an arbitrary provider endpoint.
    func recordCircuitBreakerFailure(provider: ModelProvider, baseURL: String, model: String, transportError error: TransportError) async {
        let key = ProviderEndpointKey(provider: provider, baseURL: baseURL)
        await circuitBreaker.recordFailure(
            key,
            kind: error.circuitBreakerFailureKind,
            retryAfter: error.retryAfter
        )
    }

    /// Records a successful outcome for the current provider endpoint, allowing
    /// a half-open breaker to close.
    func recordCircuitBreakerSuccess() async {
        let key = ProviderEndpointKey(provider: selectedProvider, baseURL: baseURL)
        await circuitBreaker.recordSuccess(key)
    }

    /// Records a successful outcome for an arbitrary provider endpoint.
    func recordCircuitBreakerSuccess(provider: ModelProvider, baseURL: String) async {
        let key = ProviderEndpointKey(provider: provider, baseURL: baseURL)
        await circuitBreaker.recordSuccess(key)
    }

    /// Returns the circuit-breaker state for a provider endpoint.
    func circuitBreakerState(for provider: ModelProvider, baseURL: String) async -> ProviderCircuitBreakerState {
        await circuitBreaker.state(for: ProviderEndpointKey(provider: provider, baseURL: baseURL))
    }

    /// Returns the next retry time for an open provider endpoint, if any.
    func circuitBreakerNextRetryAt(for provider: ModelProvider, baseURL: String) async -> Date? {
        await circuitBreaker.nextRetryAt(for: ProviderEndpointKey(provider: provider, baseURL: baseURL))
    }

    /// Returns the last failure kind recorded for a provider endpoint.
    func circuitBreakerLastFailureKind(for provider: ModelProvider, baseURL: String) async -> ProviderCircuitBreakerFailureKind? {
        await circuitBreaker.lastFailureKind(for: ProviderEndpointKey(provider: provider, baseURL: baseURL))
    }

    /// Returns true when a provider endpoint is currently allowed to receive traffic.
    func circuitBreakerCanSend(to provider: ModelProvider, baseURL: String) async -> Bool {
        await circuitBreaker.canSend(to: ProviderEndpointKey(provider: provider, baseURL: baseURL))
    }

    /// Resets the circuit breaker for the current provider endpoint, e.g. after
    /// the user updates the API key.
    func resetCircuitBreakerForCurrentProvider() async {
        await circuitBreaker.reset(ProviderEndpointKey(provider: selectedProvider, baseURL: baseURL))
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

    /// Starts the predictive warmup scheduler. Safe to call repeatedly.
    func startPredictiveWarmup(interval: TimeInterval = 60) async {
        guard isPredictiveWarmupEnabled else { return }
        if predictiveScheduler == nil {
            predictiveScheduler = PredictiveWarmupScheduler(store: self, interval: interval)
        }
        await predictiveScheduler?.start()
    }

    /// Stops the predictive warmup scheduler.
    func stopPredictiveWarmup() async {
        await predictiveScheduler?.stop()
    }

    /// Restarts the scheduler with the latest enabled flag and adaptive interval.
    func restartPredictiveWarmup(interval: TimeInterval? = nil) async {
        let base = interval ?? predictiveWarmupInterval
        let effective = await effectivePredictiveWarmupInterval(base: base)
        await predictiveScheduler?.restart(interval: effective)
    }

    /// Computes the effective scheduler interval by shrinking it when the most
    /// recent cached winner has a high failure rate.
    private func effectivePredictiveWarmupInterval(base: TimeInterval) async -> TimeInterval {
        guard let winner = await warmupCache.winner(
            tier: preferredCostTier,
            strictQuotaGating: isStrictQuotaGatingEnabled
        ) else {
            return base
        }
        return await volatilityTracker.recommendedInterval(
            baseInterval: base,
            for: winner.selected
        )
    }

    /// Toggles predictive background warmup on/off and persists the preference.
    func setPredictiveWarmupEnabled(_ enabled: Bool) {
        isPredictiveWarmupEnabled = enabled
        defaults.set(enabled, forKey: Self.predictiveWarmupEnabledKey)
        Task { [weak self] in
            if enabled {
                await self?.restartPredictiveWarmup()
            } else {
                await self?.stopPredictiveWarmup()
                await MainActor.run {
                    self?.lastPredictiveWarmupReason = nil
                    self?.lastPredictiveWarmupAt = nil
                }
            }
        }
    }

    /// Sets the predictive warmup cache TTL and persists it.
    func setPredictiveWarmupTTL(_ ttl: TimeInterval) {
        predictiveWarmupTTL = max(15, min(300, ttl))
        defaults.set(predictiveWarmupTTL, forKey: Self.predictiveWarmupTTLKey)
    }

    /// Sets the predictive warmup scheduler interval and persists it.
    func setPredictiveWarmupInterval(_ interval: TimeInterval) {
        predictiveWarmupInterval = max(15, min(600, interval))
        defaults.set(predictiveWarmupInterval, forKey: Self.predictiveWarmupIntervalKey)
        Task { [weak self] in
            await self?.restartPredictiveWarmup()
        }
    }

    /// Sets the maximum staleness allowed for stale-while-revalidate service and
    /// persists it. A value of zero disables stale service.
    func setPredictiveWarmupMaxStaleness(_ maxStaleness: TimeInterval) {
        predictiveWarmupMaxStaleness = max(0, min(600, maxStaleness))
        defaults.set(predictiveWarmupMaxStaleness, forKey: Self.predictiveWarmupMaxStalenessKey)
    }

    /// Triggers a coalesced background refresh of the predictive warmup cache.
    /// Safe to call from the send path: overlapping requests attach to the
    /// single in-flight refresh task.
    func refreshWarmupCacheInBackground() {
        Task { [weak self] in
            guard let self else { return }
            await self.warmupRefresher.refresh()
        }
    }

    /// Returns true when a stale-while-revalidate background refresh is in flight.
    var isWarmupCacheRefreshing: Bool {
        get async {
            await warmupRefresher.isRefreshing
        }
    }

    /// Manually triggers one predictive warmup cycle and updates the cache.
    @discardableResult
    func forcePredictiveWarmupRefresh() async -> ModelWarmupResult {
        let result = await runAdaptiveWarmup()
        lastPredictiveWarmupAt = Date()
        lastPredictiveWarmupReason = result.reason
        return result
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
            let effectiveOutput = await effectiveRequestedOutputTokens(
                for: selectedModel,
                provider: selectedProvider,
                baseURL: baseURL
            )
            return ModelRuntimeConfiguration(
                provider: selectedProvider,
                model: selectedModel,
                baseURL: baseURL,
                apiKey: resolvedAPIKey.isEmpty ? nil : resolvedAPIKey,
                fallbackModels: await fallbackModels,
                maxOutputTokens: effectiveOutput
            )
        }
    }

    /// Synchronous runtime configuration for callers that cannot await.
    /// Uses the static fallback order. The output budget is passed through
    /// without async clamping; callers should clamp via `effectiveMaxOutputTokens`.
    var runtimeConfigurationSync: ModelRuntimeConfiguration {
        ModelRuntimeConfiguration(
            provider: selectedProvider,
            model: selectedModel,
            baseURL: baseURL,
            apiKey: resolvedAPIKey.isEmpty ? nil : resolvedAPIKey,
            fallbackModels: fallbackModelsSync,
            maxOutputTokens: requestedOutputTokens
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
        predictiveSelectionReason = nil
        crossProviderFailoverReason = nil
        Task { await reliabilityService.reset(provider: selectedProvider, baseURL: baseURL) }
        invalidateHealth()
        restartBackgroundHealthChecks()
        if isPredictiveSelectionEnabled {
            Task { [weak self] in
                await self?.applyPredictiveSelection(reason: "Provider switched to \(provider.displayName)")
            }
        }
    }

    func updateBaseURL(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        baseURL = trimmed
        defaults.set(trimmed, forKey: Self.baseURLKey(selectedProvider))
        predictiveSelectionReason = nil
        Task { await reliabilityService.reset(provider: selectedProvider, baseURL: baseURL) }
        invalidateHealth()
        restartBackgroundHealthChecks()
        if isPredictiveSelectionEnabled {
            Task { [weak self] in
                await self?.applyPredictiveSelection(reason: "Endpoint updated")
            }
        }
    }

    func selectModel(_ model: String) {
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        selectedModel = trimmed
        defaults.set(trimmed, forKey: Self.modelKey(selectedProvider))
        crossProviderFailoverReason = nil
    }

    func resetBaseURL() {
        baseURL = selectedProvider.defaultBaseURL
        defaults.removeObject(forKey: Self.baseURLKey(selectedProvider))
        predictiveSelectionReason = nil
        Task { await reliabilityService.reset(provider: selectedProvider, baseURL: baseURL) }
        invalidateHealth()
        restartBackgroundHealthChecks()
        if isPredictiveSelectionEnabled {
            Task { [weak self] in
                await self?.applyPredictiveSelection(reason: "Endpoint reset to default")
            }
        }
    }

    func saveAPIKey(_ value: String) throws {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        try ModelCredentialStore.save(trimmed, for: selectedProvider)
        credentialRevision += 1
        predictiveSelectionReason = nil
        Task { await reliabilityService.reset(provider: selectedProvider, baseURL: baseURL) }
        invalidateHealth()
        restartBackgroundHealthChecks()
        if isPredictiveSelectionEnabled {
            Task { [weak self] in
                await self?.applyPredictiveSelection(reason: "API key updated")
            }
        }
    }

    func deleteAPIKey() throws {
        try ModelCredentialStore.delete(for: selectedProvider, ignoresMissing: true)
        credentialRevision += 1
        predictiveSelectionReason = nil
        Task { await reliabilityService.reset(provider: selectedProvider, baseURL: baseURL) }
        invalidateHealth()
        restartBackgroundHealthChecks()
        if isPredictiveSelectionEnabled {
            Task { [weak self] in
                await self?.applyPredictiveSelection(reason: "API key removed")
            }
        }
    }


    /// Lightweight API-key validity/balance probe.
    /// - Parameters:
    ///   - key: The API key to test (drafted or stored).
    ///   - provider: The provider to probe.
    ///   - baseURL: The endpoint URL to probe.
    /// - Returns: Detailed validation result including HTTP status, response body,
    ///   and a chronological log the UI can display.
    func testAPIKey(
        key: String,
        provider: ModelProvider,
        baseURL: String
    ) async -> APIKeyValidationResult {
        let result = await healthService.validateKey(
            provider: provider,
            baseURL: baseURL,
            apiKey: key
        )
        await quotaService.record(provider: provider, baseURL: baseURL, quota: result.quota)
        return result
    }

    // MARK: - Multi-key management

    /// Main-actor accessor for the active key, for callers that cannot await.
    func resolvedAPIKeySync(for provider: ModelProvider) -> String {
        resolvedAPIKey(for: provider)
    }

    /// Every key stored for the selected provider. Reading is cheap enough to do
    /// on demand; `credentialRevision` drives SwiftUI refreshes.
    var storedKeys: [ModelKeyEntry] {
        ModelCredentialStore.list(for: selectedProvider)
    }

    var activeKeyID: String? {
        ModelCredentialStore.activeEntryID(for: selectedProvider)
    }

    /// Adds a key without disturbing the ones already stored.
    func addAPIKey(_ value: String, label: String) throws {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let entry = try ModelCredentialStore.add(trimmed, label: label, for: selectedProvider)
        TriosLogBus.shared.info(
            .models,
            "models.key.added",
            "Stored a new API key",
            [
                "provider": selectedProvider.rawValue,
                "label": entry.label,
                "masked": entry.maskedValue
            ]
        )
        afterCredentialChange(reason: "API key added")
    }

    /// Switches which stored key signs outgoing requests.
    func activateAPIKey(entryID: String) {
        ModelCredentialStore.setActiveEntryID(entryID, for: selectedProvider)
        TriosLogBus.shared.info(
            .models,
            "models.key.activated",
            "Switched active API key",
            ["provider": selectedProvider.rawValue, "entry": entryID]
        )
        afterCredentialChange(reason: "Active API key changed")
    }

    func renameAPIKey(entryID: String, label: String) throws {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        try ModelCredentialStore.rename(entryID: entryID, to: trimmed, for: selectedProvider)
        credentialRevision += 1
    }

    /// Shared bookkeeping after any credential mutation: refresh dependent
    /// state so stale reliability history cannot outlive the key that produced it.
    private func afterCredentialChange(reason: String) {
        credentialRevision += 1
        predictiveSelectionReason = nil
        Task { await reliabilityService.reset(provider: selectedProvider, baseURL: baseURL) }
        invalidateHealth()
        restartBackgroundHealthChecks()
        if isPredictiveSelectionEnabled {
            Task { [weak self] in
                await self?.applyPredictiveSelection(reason: reason)
            }
        }
    }

    /// Deletes exactly one key, leaving the others in place.
    func deleteAPIKey(entryID: String) throws {
        try ModelCredentialStore.delete(entryID: entryID, for: selectedProvider)
        TriosLogBus.shared.info(
            .models,
            "models.key.deleted",
            "Deleted an API key",
            ["provider": selectedProvider.rawValue, "entry": entryID]
        )
        afterCredentialChange(reason: "API key removed")
    }


    /// Enables or disables predictive model selection and persists the choice.
    func setPredictiveSelectionEnabled(_ enabled: Bool) {
        isPredictiveSelectionEnabled = enabled
        defaults.set(enabled, forKey: Self.predictiveSelectionEnabledKey)
        if enabled {
            Task { [weak self] in
                await self?.applyPredictiveSelection(reason: "Smart selection turned on")
            }
        } else {
            predictiveSelectionReason = nil
        }
    }

    /// Sets the preferred cost tier and re-runs predictive selection if enabled.
    func setPreferredCostTier(_ tier: ModelCostTier) {
        preferredCostTier = tier
        defaults.set(tier.rawValue, forKey: Self.preferredCostTierKey)
        if isPredictiveSelectionEnabled {
            Task { [weak self] in
                await self?.applyPredictiveSelection(
                    reason: "Cost preference set to \(tier.displayName)"
                )
            }
        }
    }

    /// Manually triggers one predictive selection cycle.
    @discardableResult
    func selectBestModel() async -> String? {
        guard isPredictiveSelectionEnabled else { return nil }
        return await applyPredictiveSelection(reason: "Manual smart pick")
    }

    /// Picks the best eligible model using reliability history and the preferred
    /// cost tier, then updates the active selection and records the reason. When
    /// cross-provider failover is enabled and the current provider has no strong
    /// learned signal, this can switch providers.
    @discardableResult
    private func applyPredictiveSelection(reason: String) async -> String? {
        let candidates = discoveredModels.isEmpty
            ? selectedProvider.suggestedModels
            : discoveredModels
        let inProviderBest = await reliabilityService.bestModel(
            from: candidates,
            provider: selectedProvider,
            baseURL: baseURL,
            tier: preferredCostTier,
            excluding: selectedModel,
            costService: costService
        )

        var chosenModel = inProviderBest
        var chosenProvider = selectedProvider
        var chosenBaseURL = baseURL
        var crossProviderSwitch = false

        if isCrossProviderFailoverEnabled, let inProvider = inProviderBest {
            let inReliability = await reliabilityService.reliability(
                for: inProvider,
                provider: selectedProvider,
                baseURL: baseURL
            )
            let currentKey = ProviderEndpointKey(provider: selectedProvider, baseURL: baseURL)
            let currentOpen = await circuitBreaker.state(for: currentKey) == .open
            if currentOpen || inReliability.totalOutcomes == 0 || inReliability.score < 0.5 {
                var crossConfigs: [(provider: ModelProvider, baseURL: String)] = []
                for config in eligibleProviderConfigurations {
                    guard !(config.provider == selectedProvider && config.baseURL == baseURL) else { continue }
                    let key = ProviderEndpointKey(provider: config.provider, baseURL: config.baseURL)
                    if await circuitBreaker.canSend(to: key) {
                        crossConfigs.append(config)
                    }
                }
                if let cross = await reliabilityService.bestCrossProviderModel(
                    currentProvider: selectedProvider,
                    currentBaseURL: baseURL,
                    currentModel: selectedModel,
                    providerConfigurations: crossConfigs,
                    tier: preferredCostTier,
                    excluding: [selectedModel],
                    costService: costService
                ) {
                    let crossReliability = await reliabilityService.reliability(
                        for: cross.model,
                        provider: cross.provider,
                        baseURL: cross.baseURL
                    )
                    if crossReliability.totalOutcomes > 0 && crossReliability.score >= 0.5 {
                        chosenModel = cross.model
                        chosenProvider = cross.provider
                        chosenBaseURL = cross.baseURL
                        crossProviderSwitch = true
                    }
                }
            }
        }

        guard let best = chosenModel else {
            predictiveSelectionReason = nil
            return nil
        }
        guard best != selectedModel || chosenProvider != selectedProvider || chosenBaseURL != baseURL else {
            predictiveSelectionReason = "Already using the best match: \(best)"
            return best
        }
        await MainActor.run {
            if crossProviderSwitch {
                applySelection(provider: chosenProvider, baseURL: chosenBaseURL, model: best)
                predictiveSelectionReason = reason + " → \(chosenProvider.displayName)/\(best)"
                crossProviderFailoverReason = nil
            } else {
                selectModel(best)
                predictiveSelectionReason = reason + " → \(best)"
            }
        }
        return best
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

    /// Returns the API key for the active provider from macOS Keychain, the
    /// `~/.trios/config.json` file, or an environment fallback, in that order.
    private var resolvedAPIKey: String {
        resolvedAPIKey(for: selectedProvider)
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

    private static var predictiveSelectionEnabledKey: String {
        "trios.model.predictive-selection-enabled"
    }

    private static var preferredCostTierKey: String {
        "trios.model.preferred-cost-tier"
    }

    private static var crossProviderFailoverEnabledKey: String {
        "trios.model.cross-provider-failover-enabled"
    }

    private static var adaptiveProviderWarmupEnabledKey: String {
        "trios.model.adaptive-provider-warmup-enabled"
    }

    private static var strictQuotaGatingEnabledKey: String {
        "trios.model.strict-quota-gating-enabled"
    }

    private static var predictiveWarmupEnabledKey: String {
        "trios.model.predictive-warmup-enabled"
    }

    private static var predictiveWarmupTTLKey: String {
        "trios.model.predictive-warmup-ttl"
    }

    private static var predictiveWarmupIntervalKey: String {
        "trios.model.predictive-warmup-interval"
    }

    private static var predictiveWarmupMaxStalenessKey: String {
        "trios.model.predictive-warmup-max-staleness"
    }




    // MARK: - Context-length-aware routing















}


// MARK: - KeychainSecrets listing extension

extension KeychainSecrets {
    /// Stores a generic-password item with label, masked-preview description,
    /// and secret data. Dispatched on a background queue with a bounded wait
    /// so a stalled keychain cannot block the caller.
    ///
    /// Mirrors the bounded-wait pattern in ``writeData``: ~2 s timeout,
    /// reports failure on expiry.
    static func addEntry(
        service: String,
        account: String,
        label: String,
        description: String,
        data: Data
    ) throws {
        if ProjectPaths.isDevVariant {
            guard DevSecretStore.write(service: service, account: account, data: data) else {
                throw KeychainSecretsError.invalidItemType
            }
            return
        }

        if isLaunching {
            throw KeychainSecretsError.osStatus(OSStatus(-4093))
        }

        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrLabel as String: label,
            kSecAttrDescription as String: description,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data
        ]

        let semaphore = DispatchSemaphore(value: 0)
        var status: OSStatus = errSecSuccess

        DispatchQueue.global(qos: .utility).async {
            status = SecItemAdd(attributes as CFDictionary, nil)
            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + 2.0) == .success {
            guard status == errSecSuccess else {
                throw KeychainSecretsError.osStatus(status)
            }
            return
        }

        throw KeychainSecretsError.osStatus(OSStatus(-4093))
    }

    /// Updates a keychain item's label without touching the secret.
    /// Dispatched on a background queue with a bounded wait so a stalled
    /// keychain cannot block the caller.
    static func updateLabel(service: String, account: String, label: String) throws {
        if isLaunching {
            throw KeychainSecretsError.osStatus(OSStatus(-4093))
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let updates: [String: Any] = [kSecAttrLabel as String: label]

        let semaphore = DispatchSemaphore(value: 0)
        var status: OSStatus = errSecSuccess

        DispatchQueue.global(qos: .utility).async {
            status = SecItemUpdate(query as CFDictionary, updates as CFDictionary)
            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + 2.0) == .success {
            guard status == errSecSuccess else {
                throw KeychainSecretsError.osStatus(status)
            }
            return
        }

        throw KeychainSecretsError.osStatus(OSStatus(-4093))
    }
}
