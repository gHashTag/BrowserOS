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
    @Published private(set) var lastContextRoutingReason: String?
    @Published private(set) var lastContextRoutedAt: Date?
    @Published private(set) var lastContextEstimatedInputTokens: Int?
    @Published private(set) var lastContextRequestedOutputTokens: Int?
    /// User-configured per-send output-token budget. Persisted and clamped to the
    /// effective (advertised or learned) output ceiling at request time.
    @Published var requestedOutputTokens: Int? = nil

    /// Per-(provider, baseURL, model) unhealthy flags used by ranking logic.
    /// A conservative `unhealthyModels` string set is kept for the UI.
    @Published private(set) var unhealthyTuples: Set<ModelEndpointTuple> = []

    private let defaults: UserDefaults
    private let environment: [String: String]
    private let catalogService: ModelCatalogService
    private let healthService: any ModelHealthServiceProtocol
    private let statusService: any ProviderStatusServiceProtocol
    private let reliabilityService: ModelReliabilityService
    private let costService: ModelCostService
    private let circuitBreaker: ProviderCircuitBreaker
    private let quotaService: ProviderQuotaService
    private let warmupService: ModelWarmupService
    private let warmupCache: PredictiveWarmupCache
    private let volatilityTracker: WarmupVolatilityTracker
    private lazy var warmupRefresher: PredictiveWarmupRefresher = PredictiveWarmupRefresher(store: self)
    private let contextService: ModelContextService
    private let contextLimitLearner: StreamingContextLimitLearner
    private let requestSizer: ChatRequestSizer
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
    func selectFirstHealthyCrossProviderModel() async -> CrossProviderModelCandidate? {
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
    func warmupCandidates() -> [CrossProviderModelCandidate] {
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
    func runAdaptiveWarmup() async -> ModelWarmupResult {
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
        var newUnhealthy: Set<ModelEndpointTuple> = []
        var newHealthy: Set<ModelEndpointTuple> = []
        await withTaskGroup(of: (ModelEndpointTuple, ModelHealthResult).self) { group in
            for model in models {
                let tuple = ModelEndpointTuple(provider: selectedProvider, baseURL: baseURL, model: model)
                group.addTask {
                    let result = await self.healthStatus(for: model)
                    return (tuple, result)
                }
            }
            for await (tuple, result) in group {
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

    /// Returns the user-requested output budget clamped to the effective output
    /// ceiling for the given model tuple. `nil` means "use the default budget".
    func effectiveRequestedOutputTokens(
        for model: String,
        provider: ModelProvider,
        baseURL: String? = nil
    ) async -> Int? {
        guard let requested = requestedOutputTokens else { return nil }
        let ceiling = await effectiveMaxOutputTokens(for: model, provider: provider, baseURL: baseURL)
        return min(requested, ceiling)
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

    private static var contextWindowMarginKey: String {
        "trios.model.context-window-margin"
    }

    private static var streamingContextWatchdogKey: String {
        "trios.model.streaming-context-watchdog"
    }

    private static var requestedOutputTokensKey: String {
        "trios.model.requested-output-tokens"
    }

    // MARK: - Context-length-aware routing

    /// Loads the persisted context-window margin, clamped to the allowed range.
    private func loadContextWindowMargin() {
        let stored = defaults.object(forKey: Self.contextWindowMarginKey) as? Double ?? 0.85
        contextWindowMargin = max(0.50, min(0.95, stored))
    }

    /// Updates the safety margin and persists it.
    func setContextWindowMargin(_ margin: Double) {
        contextWindowMargin = max(0.50, min(0.95, margin))
        defaults.set(contextWindowMargin, forKey: Self.contextWindowMarginKey)
    }

    /// Loads the persisted streaming context watchdog preference.
    private func loadStreamingContextWatchdogPreference() {
        isStreamingContextWatchdogEnabled = defaults.object(forKey: Self.streamingContextWatchdogKey) as? Bool ?? true
    }

    /// Updates the streaming context watchdog preference and persists it.
    func setStreamingContextWatchdogEnabled(_ enabled: Bool) {
        isStreamingContextWatchdogEnabled = enabled
        defaults.set(enabled, forKey: Self.streamingContextWatchdogKey)
    }

    /// Loads the persisted per-send output-token budget preference.
    private func loadRequestedOutputTokens() {
        let stored = defaults.object(forKey: Self.requestedOutputTokensKey) as? Int
        requestedOutputTokens = stored.map { max(0, $0) }
    }

    /// Updates the per-send output-token budget and persists it.
    func setRequestedOutputTokens(_ tokens: Int?) {
        requestedOutputTokens = tokens.map { max(0, $0) }
        if let tokens {
            defaults.set(tokens, forKey: Self.requestedOutputTokensKey)
        } else {
            defaults.removeObject(forKey: Self.requestedOutputTokensKey)
        }
    }

    /// Clears the user-defined per-send output-token budget, returning to the
    /// default (clamped) output budget.
    func clearRequestedOutputTokens() {
        setRequestedOutputTokens(nil)
    }

    /// Returns the effective output ceiling for a model tuple, blending the
    /// advertised catalog with learned per-endpoint limits.
    func effectiveMaxOutputTokens(
        for model: String,
        provider: ModelProvider,
        baseURL: String? = nil
    ) async -> Int {
        let profile = await contextService.profile(
            for: model,
            provider: provider,
            baseURL: baseURL ?? self.baseURL
        )
        return profile.maxOutputTokens
    }

    /// Switches the active selection to a context-routed candidate and records
    /// the reason for UI and logs.
    func applyContextRoutedSelection(candidate: CrossProviderModelCandidate, reason: String) {
        applySelection(
            provider: candidate.provider,
            baseURL: candidate.baseURL,
            model: candidate.model
        )
        lastContextRoutingReason = reason
        lastContextRoutedAt = Date()
    }

    /// Decides whether to use the current model, route to a larger-context
    /// healthy candidate, trim history, or refuse the request before any provider
    /// call is made.
    func resolveContextRoutingDecision(
        conversationId: UUID?,
        messages: [ChatMessage],
        currentMessage: ChatMessage,
        systemPrompt: String?,
        requestedOutputTokens: Int?,
        candidates: [CrossProviderModelCandidate]
    ) async -> ContextRoutingDecision {
        let currentProfile = await contextService.profile(
            for: selectedModel,
            provider: selectedProvider,
            baseURL: baseURL
        )
        let currentSize = await requestSizer.size(
            messages: messages,
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            modelProfile: currentProfile,
            requestedOutputTokens: requestedOutputTokens,
            margin: contextWindowMargin
        )
        lastContextEstimatedInputTokens = currentSize.estimatedInputTokens
        lastContextRequestedOutputTokens = currentSize.requestedOutputTokens

        let current = CrossProviderModelCandidate(
            provider: selectedProvider,
            baseURL: baseURL,
            model: selectedModel
        )

        // If the current model fits the context window but cannot honor the full
        // requested output budget, try to route to a model with a larger effective
        // output ceiling before giving up and clamping the budget locally.
        if currentSize.fitsCurrentModel,
           let rawRequested = requestedOutputTokens,
           rawRequested > currentProfile.maxOutputTokens {
            let outputCandidates = await contextService.largerOutputCandidates(
                estimatedInput: currentSize.estimatedInputTokens,
                outputTokens: rawRequested,
                current: current,
                candidates: candidates,
                margin: contextWindowMargin
            )
            for candidate in outputCandidates {
                guard await isCandidateAllowed(candidate) else { continue }
                let routedProfile = await contextService.profile(
                    for: candidate.model,
                    provider: candidate.provider,
                    baseURL: candidate.baseURL
                )
                let routedSize = await requestSizer.size(
                    messages: messages,
                    currentMessage: currentMessage,
                    systemPrompt: systemPrompt,
                    modelProfile: routedProfile,
                    requestedOutputTokens: requestedOutputTokens,
                    margin: contextWindowMargin
                )
                guard routedSize.fitsCurrentModel else { continue }
                lastContextEstimatedInputTokens = routedSize.estimatedInputTokens
                lastContextRequestedOutputTokens = routedSize.requestedOutputTokens
                lastContextRoutingReason = "routed to \(candidate.model) for output budget (\(routedProfile.maxOutputTokens) tokens)"
                return .routeTo(candidate)
            }
            return .useCurrent
        }

        if currentSize.fitsCurrentModel {
            return .useCurrent
        }

        let largerCandidates = await contextService.largerModelCandidates(
            estimatedInput: currentSize.estimatedInputTokens,
            outputTokens: currentSize.requestedOutputTokens,
            current: current,
            candidates: candidates,
            margin: contextWindowMargin
        )
        for candidate in largerCandidates {
            if await isCandidateAllowed(candidate) {
                let routedProfile = await contextService.profile(
                    for: candidate.model,
                    provider: candidate.provider,
                    baseURL: candidate.baseURL
                )
                let routedSize = await requestSizer.size(
                    messages: messages,
                    currentMessage: currentMessage,
                    systemPrompt: systemPrompt,
                    modelProfile: routedProfile,
                    requestedOutputTokens: requestedOutputTokens,
                    margin: contextWindowMargin
                )
                lastContextEstimatedInputTokens = routedSize.estimatedInputTokens
                lastContextRequestedOutputTokens = routedSize.requestedOutputTokens
                lastContextRoutingReason = "routed to \(candidate.model) for context window (\(routedProfile.maxContextTokens) tokens)"
                return .routeTo(candidate)
            }
        }

        let trimPolicy = await requestSizer.trim(
            messages: messages,
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            modelProfile: currentProfile,
            requestedOutputTokens: requestedOutputTokens,
            margin: contextWindowMargin,
            minRetainedTurns: 2
        )
        let trimmedMessages = await requestSizer.trimmedMessages(from: messages, policy: trimPolicy)
        let trimmedSize = await requestSizer.size(
            messages: trimmedMessages,
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            modelProfile: currentProfile,
            requestedOutputTokens: requestedOutputTokens,
            margin: contextWindowMargin
        )
        if trimmedSize.fitsCurrentModel {
            lastContextEstimatedInputTokens = trimmedSize.estimatedInputTokens
            lastContextRequestedOutputTokens = trimmedSize.requestedOutputTokens
            return .trimHistory(trimPolicy)
        }

        let largestWindow = await maxAvailableWindow(
            candidates: candidates,
            current: current,
            currentProfile: currentProfile
        )
        let largestProfile = ModelContextProfile(
            maxContextTokens: largestWindow,
            maxOutputTokens: currentProfile.maxOutputTokens
        )
        let singleMessageSize = await requestSizer.size(
            messages: [],
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            modelProfile: largestProfile,
            requestedOutputTokens: requestedOutputTokens,
            margin: contextWindowMargin
        )
        if !singleMessageSize.fitsCurrentModel {
            return .tooLargeEvenEmpty
        }

        // The request is larger than preferred but the current message alone
        // fits the largest available window, so trim as aggressively as needed.
        return .trimHistory(trimPolicy)
    }

    /// True when a candidate is healthy, its endpoint breaker allows traffic, and
    /// quota is not depleted.
    private func isCandidateAllowed(_ candidate: CrossProviderModelCandidate) async -> Bool {
        guard !isUnhealthy(
            provider: candidate.provider,
            baseURL: candidate.baseURL,
            model: candidate.model
        ) else { return false }
        let key = ProviderEndpointKey(provider: candidate.provider, baseURL: candidate.baseURL)
        guard await circuitBreaker.canSend(to: key) else { return false }
        let quota = await quotaService.status(for: candidate.provider, baseURL: candidate.baseURL)
        return !quota.isDepleted
    }

    /// Largest advertised context window among the current model and all healthy,
    /// allowed candidates. Used for the final "too large even empty" check.
    private func maxAvailableWindow(
        candidates: [CrossProviderModelCandidate],
        current: CrossProviderModelCandidate,
        currentProfile: ModelContextProfile
    ) async -> Int {
        var maxWindow = currentProfile.maxContextTokens
        for candidate in candidates {
            guard candidate != current else { continue }
            guard await isCandidateAllowed(candidate) else { continue }
            let profile = await contextService.profile(
                for: candidate.model,
                provider: candidate.provider,
                baseURL: candidate.baseURL
            )
            if profile.maxContextTokens > maxWindow {
                maxWindow = profile.maxContextTokens
            }
        }
        return maxWindow
    }

    /// Returns the estimated utilization of a model's usable context window
    /// (accounting for the configured safety margin). Used by the Models tab
    /// badge and the composer status indicator.
    /// Returns the learned context/output limits for a model tuple, if any.
    func learnedLimits(
        for model: String,
        provider: ModelProvider,
        baseURL: String? = nil
    ) async -> StreamingContextLearnedLimits {
        await contextLimitLearner.learnedLimits(
            for: model,
            provider: provider,
            baseURL: baseURL ?? self.baseURL
        )
    }

    func contextWindowUtilizationPercent(
        for model: String,
        provider: ModelProvider,
        baseURL: String? = nil
    ) async -> Double? {
        guard let input = lastContextEstimatedInputTokens, input >= 0 else {
            return nil
        }
        let output = lastContextRequestedOutputTokens ?? 0
        let resolvedBaseURL = baseURL ?? self.baseURL
        let profile = await contextService.profile(
            for: model,
            provider: provider,
            baseURL: resolvedBaseURL
        )
        guard profile.maxContextTokens > 0 else { return nil }
        let usable = Double(profile.maxContextTokens) * contextWindowMargin
        guard usable > 0 else { return nil }
        return Double(input + output) / usable * 100.0
    }

    /// Returns the healthiest candidate with a larger context window or output
    /// limit than the current selection, if any. Used by the streaming context
    /// watchdog when the user chooses to continue a paused stream on a larger
    /// model.
    func selectLargerModelCandidate(estimatedInput: Int, outputTokens: Int = 1024) async -> CrossProviderModelCandidate? {
        let current = CrossProviderModelCandidate(
            provider: selectedProvider,
            baseURL: baseURL,
            model: selectedModel
        )
        let candidates = warmupCandidates()
        var allowed: [CrossProviderModelCandidate] = []
        for candidate in candidates {
            if await isCandidateAllowed(candidate) {
                allowed.append(candidate)
            }
        }
        return await contextService.largerModelCandidates(
            estimatedInput: estimatedInput,
            outputTokens: outputTokens,
            current: current,
            candidates: allowed,
            margin: contextWindowMargin
        ).first
    }
}

