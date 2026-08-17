import Foundation
import XCTest
@testable import TriOSKit

@MainActor
final class ModelConfigurationStoreCrossProviderTests: XCTestCase {
    private var defaults: UserDefaults!
    private var healthService: StubModelHealthService!
    private var statusService: StubProviderStatusService!
    private var reliabilityStore: VolatileMemoryStore!
    private var reliabilityAdapter: MemoryStoreReliabilityAdapter!
    private var reliabilityService: ModelReliabilityService!
    private var store: ModelConfigurationStore!

    /// The tuple the store actually probes for OpenAI. #1273: credentials and
    /// probe endpoints must come from the same constants the store uses, not
    /// from hand-written URLs that drift away from them.
    private var openaiEndpoint: String { ModelProvider.openai.defaultBaseURL }

    // #1273 — defined credential environment.
    //
    // `resolvedAPIKey` consults three ambient sources before it ever looks at
    // the injected `environment` dictionary, so the suite used to answer
    // questions like "is zai eligible?" with whatever happened to be on the
    // machine:
    //
    //   1. the macOS Keychain (release variant; `ModelCredentialStore.list`
    //      queries it through `SecItemCopyMatching` with no disable gate),
    //   2. `~/.trios-dev/secrets/` (dev variant file store),
    //   3. `~/.trios/config.json` (resolved from the real `HOME`).
    //
    // All three are resolved through `ProcessInfo` (or the variant switch)
    // at call time, so the test class defines them itself instead of trusting
    // the runner to remember incantations: the keychain gate mirrors
    // `TRIOS_E2E_DISABLE_KEYCHAIN=1`, the variant is pinned to `dev` so
    // credential reads go to the file store, and `HOME` points at an empty
    // sandbox so that store — and `~/.trios/config.json` — are provably empty.
    // With keys present or absent on the machine, the answers are identical.
    private var environmentSandbox: URL?
    private var originalHome: String?
    private var originalVariant: String?
    private var originalKeychainGate: String?

    override func setUp() async throws {
        let fileManager = FileManager.default
        originalHome = ProcessInfo.processInfo.environment["HOME"]
        originalVariant = ProcessInfo.processInfo.environment["TRIOS_VARIANT"]
        originalKeychainGate = ProcessInfo.processInfo.environment["TRIOS_E2E_DISABLE_KEYCHAIN"]

        let sandbox = fileManager.temporaryDirectory
            .appendingPathComponent("trios-cross-provider-env-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: sandbox, withIntermediateDirectories: true)
        environmentSandbox = sandbox

        setenv("TRIOS_E2E_DISABLE_KEYCHAIN", "1", 1)
        setenv("TRIOS_VARIANT", "dev", 1)
        setenv("HOME", sandbox.path, 1)

        defaults = UserDefaults(suiteName: "trios-cross-provider-tests")
        XCTAssertNotNil(defaults)

        defaults.set(false, forKey: "trios.model.background-health-polling-enabled")
        defaults.removeObject(forKey: "trios.model.provider")
        defaults.removeObject(forKey: "trios.model.cross-provider-failover-enabled")

        healthService = StubModelHealthService()
        statusService = StubProviderStatusService()
        reliabilityStore = VolatileMemoryStore()
        reliabilityAdapter = MemoryStoreReliabilityAdapter(store: reliabilityStore)
        reliabilityService = ModelReliabilityService(store: reliabilityAdapter, historyLimit: 20, emaAlpha: 0.3)

        store = ModelConfigurationStore(
            defaults: defaults,
            environment: [
                "TRIOS_PROVIDER": ModelProvider.anthropic.rawValue,
                "TRIOS_MODEL": "claude-sonnet-4-5",
                "TRIOS_BASE_URL": "https://api.anthropic.com",
                "TRIOS_OPENAI_API_KEY": "test-openai",
                "TRIOS_ANTHROPIC_API_KEY": "test-anthropic"
            ],
            catalogService: ModelCatalogService(),
            statusService: statusService,
            healthService: healthService,
            reliabilityService: reliabilityService
        )
    }

    override func tearDown() async throws {
        // Restore the process to the environment it had before this class
        // defined its own (#1273). The contract runner already sets these
        // values, so for it the restore is a no-op.
        if let home = originalHome {
            setenv("HOME", home, 1)
        }
        if let variant = originalVariant {
            setenv("TRIOS_VARIANT", variant, 1)
        } else {
            unsetenv("TRIOS_VARIANT")
        }
        if let gate = originalKeychainGate {
            setenv("TRIOS_E2E_DISABLE_KEYCHAIN", gate, 1)
        } else {
            unsetenv("TRIOS_E2E_DISABLE_KEYCHAIN")
        }
        if let sandbox = environmentSandbox {
            try? FileManager.default.removeItem(at: sandbox)
        }

        store.backgroundPollerForTests?.stop()
        defaults.removeObject(forKey: "trios.model.provider")
        defaults.removeObject(forKey: "trios.model.background-health-polling-enabled")
        for provider in ModelProvider.allCases {
            defaults.removeObject(forKey: "trios.model.\(provider.rawValue).selection")
            defaults.removeObject(forKey: "trios.model.\(provider.rawValue).base-url")
        }
        defaults.removeObject(forKey: "trios.model.predictive-selection-enabled")
        defaults.removeObject(forKey: "trios.model.cross-provider-failover-enabled")

        await StreamingContextLimitLearner.shared.reset(
            model: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com"
        )
    }

    func testEligibleProvidersRespectAPIKeyAvailability() {
        let eligible = store.eligibleProviderConfigurations
        let providers = eligible.map { $0.provider }
        XCTAssertTrue(providers.contains(.ollama), "Ollama requires no API key")
        XCTAssertTrue(providers.contains(.openai), "OpenAI key provided")
        XCTAssertTrue(providers.contains(.anthropic), "Anthropic key provided")
        XCTAssertFalse(providers.contains(.zai), "zai has no key configured")
        XCTAssertFalse(providers.contains(.openrouter), "OpenRouter has no key configured")
    }

    func testSelectFirstHealthyCrossProviderModelSwitchesProvider() async {
        // #1273: rank and stub the tuple the store really probes — the openai
        // endpoint is `ModelProvider.openai.defaultBaseURL`, which carries the
        // /v1 suffix. Records and stubs under any other base URL never meet
        // the probe, and the failover read as "no candidate" on every machine.
        await reliabilityService.record(
            model: "gpt-5",
            provider: .openai,
            baseURL: openaiEndpoint,
            success: true,
            reason: nil
        )
        await healthService.set(
            result: ModelHealthResult(health: .healthy, latencyMs: 80),
            for: "gpt-5",
            provider: .openai,
            baseURL: openaiEndpoint
        )
        await reliabilityService.record(
            model: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            success: false,
            reason: nil
        )

        let candidate = await store.selectFirstHealthyCrossProviderModel()
        XCTAssertNotNil(candidate)
        XCTAssertEqual(candidate?.provider, .openai)
        XCTAssertEqual(candidate?.model, "gpt-5")
        XCTAssertEqual(store.selectedProvider, .openai)
        XCTAssertEqual(store.selectedModel, "gpt-5")
        // The applied base URL is the provider default the failover candidate
        // carries. The old literal "https://api.openai.com" predated the /v1
        // shape and was simply stale, so it is corrected rather than removed.
        //
        // Deliberately NOT `ModelProvider.openai.defaultBaseURL`: the value
        // under test is derived from that constant, so comparing the two is a
        // tautology that holds however the constant changes. A check that
        // cannot fail is not a check, and swapping a stale literal for one is
        // how a red test is quietly retired instead of fixed (#1273).
        XCTAssertEqual(store.baseURL, "https://api.openai.com/v1")
        XCTAssertNotNil(store.crossProviderFailoverReason)
        XCTAssertTrue(store.crossProviderFailoverReason?.contains("OpenAI") ?? false)
    }

    func testSelectFirstHealthyCrossProviderModelExcludesUnhealthyModels() async {
        // #1273: rank and stub the tuples the store really probes (provider
        // default base URL, /v1 included). gpt-5 ranks first through the
        // recorded success; gpt-5.2 is the healthy runner-up that must be
        // selectable once gpt-5 is marked unhealthy.
        await reliabilityService.record(
            model: "gpt-5",
            provider: .openai,
            baseURL: openaiEndpoint,
            success: true,
            reason: nil
        )
        await healthService.set(
            result: ModelHealthResult(health: .healthy, latencyMs: 80),
            for: "gpt-5",
            provider: .openai,
            baseURL: openaiEndpoint
        )
        await healthService.set(
            result: ModelHealthResult(health: .healthy, latencyMs: 90),
            for: ModelProvider.openai.defaultModel,
            provider: .openai,
            baseURL: openaiEndpoint
        )
        // #1273: `markUnhealthy(_ model:)` marks the CURRENT provider's tuple.
        // The failover filter is tuple-scoped (`isUnhealthy(provider:baseURL:model:)`),
        // so excluding the openai candidate means marking the openai tuple —
        // the single-argument convenience was written against a model-name-
        // scoped contract that does not exist.
        store.markUnhealthy(provider: .openai, baseURL: openaiEndpoint, model: "gpt-5")

        let candidate = await store.selectFirstHealthyCrossProviderModel()
        XCTAssertNotNil(candidate)
        XCTAssertNotEqual(candidate?.model, "gpt-5")
    }

    func testProbeAllEligibleProvidersReturnsConfiguredResults() async {
        // #1273: `probeAllEligibleProviders` probes each provider's
        // `defaultModel` at its `defaultBaseURL`. Registering the stub under
        // those exact tuples — rather than hand-written no-/v1 URLs — is what
        // makes the configured answers come back; the assertions compare the
        // same health values as before.
        await healthService.set(
            result: ModelHealthResult(health: .healthy, latencyMs: 120),
            for: ModelProvider.anthropic.defaultModel,
            provider: .anthropic,
            baseURL: ModelProvider.anthropic.defaultBaseURL
        )
        await healthService.set(
            result: ModelHealthResult(health: .unavailable(reason: "stub"), latencyMs: nil),
            for: ModelProvider.openai.defaultModel,
            provider: .openai,
            baseURL: openaiEndpoint
        )

        let results = await store.probeAllEligibleProviders()
        let anthropic = results.first { $0.provider == .anthropic }
        let openai = results.first { $0.provider == .openai }
        XCTAssertEqual(anthropic?.result.health, .healthy)
        XCTAssertEqual(openai?.result.health, .unavailable(reason: "stub"))
    }

    func testRestoreSelectionRevertsProviderAndClearsReason() async {
        // #1273: same tuple alignment — the failover probe runs at the openai
        // provider default base URL, so the stub must answer there.
        await reliabilityService.record(
            model: "gpt-5",
            provider: .openai,
            baseURL: openaiEndpoint,
            success: true,
            reason: nil
        )
        await healthService.set(
            result: ModelHealthResult(health: .healthy, latencyMs: 80),
            for: "gpt-5",
            provider: .openai,
            baseURL: openaiEndpoint
        )

        _ = await store.selectFirstHealthyCrossProviderModel()
        XCTAssertNotNil(store.crossProviderFailoverReason)

        store.restoreSelection(provider: .anthropic, baseURL: "https://api.anthropic.com", model: "claude-sonnet-4-5")
        XCTAssertEqual(store.selectedProvider, .anthropic)
        XCTAssertEqual(store.selectedModel, "claude-sonnet-4-5")
        XCTAssertEqual(store.baseURL, "https://api.anthropic.com")
        XCTAssertNil(store.crossProviderFailoverReason)
    }

    func testCrossProviderFailoverTogglePersists() {
        XCTAssertFalse(store.isCrossProviderFailoverEnabled)
        store.setCrossProviderFailoverEnabled(true)
        XCTAssertTrue(store.isCrossProviderFailoverEnabled)

        let fresh = ModelConfigurationStore(
            defaults: defaults,
            environment: [:],
            catalogService: ModelCatalogService(),
            statusService: statusService,
            healthService: healthService,
            reliabilityService: reliabilityService
        )
        XCTAssertTrue(fresh.isCrossProviderFailoverEnabled)
    }

    func testResolveContextRoutingDecisionRoutesToLargerCandidate() async {
        store.applySelection(provider: .zai, baseURL: "https://z.ai", model: "glm-5")

        let huge = String(repeating: "word ", count: 30_000)
        let currentMessage = ChatMessage(role: .user, content: huge)
        let candidates = [
            CrossProviderModelCandidate(provider: .openai, baseURL: "https://api.openai.com", model: "gpt-5")
        ]

        let decision = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: [],
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: nil,
            candidates: candidates
        )

        guard case .routeTo(let candidate) = decision else {
            XCTFail("Expected routeTo, got \(decision)")
            return
        }
        XCTAssertEqual(candidate.provider, .openai)
        XCTAssertEqual(candidate.model, "gpt-5")
    }

    func testResolveContextRoutingDecisionTrimsWhenNoLargerCandidateFits() async {
        store.applySelection(provider: .zai, baseURL: "https://z.ai", model: "glm-5")

        let history = [
            ChatMessage(role: .user, content: String(repeating: "old ", count: 20_000)),
            ChatMessage(role: .assistant, content: "ok")
        ]
        let currentMessage = ChatMessage(role: .user, content: String(repeating: "word ", count: 10_000))
        let candidates: [CrossProviderModelCandidate] = []

        let decision = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: history,
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: nil,
            candidates: candidates
        )

        guard case .trimHistory(let policy) = decision else {
            XCTFail("Expected trimHistory, got \(decision)")
            return
        }
        XCTAssertTrue(policy.droppedMessageCount > 0)
    }

    func testResolveContextRoutingDecisionRoutesForOutputBudgetWhenContextFits() async {
        store.applySelection(provider: .zai, baseURL: "https://z.ai", model: "glm-5")

        let history = [ChatMessage(role: .user, content: "hello")]
        let currentMessage = ChatMessage(role: .user, content: "expand")
        let candidates = [
            CrossProviderModelCandidate(provider: .openai, baseURL: "https://api.openai.com", model: "gpt-5")
        ]

        let decision = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: history,
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: 8_192,
            candidates: candidates
        )

        guard case .routeTo(let candidate) = decision else {
            XCTFail("Expected routeTo for output budget, got \(decision)")
            return
        }
        XCTAssertEqual(candidate.provider, .openai)
        XCTAssertEqual(candidate.model, "gpt-5")
        XCTAssertEqual(store.selectedProvider, .openai)
        XCTAssertEqual(store.selectedModel, "gpt-5")
        XCTAssertEqual(store.baseURL, "https://api.openai.com")
        XCTAssertNotNil(store.lastContextRoutingReason)
        XCTAssertTrue(store.lastContextRoutingReason?.contains("output budget") ?? false)
    }

    func testResolveContextRoutingDecisionStaysCurrentWhenNoCandidateSatisfiesOutputBudget() async {
        store.applySelection(provider: .zai, baseURL: "https://z.ai", model: "glm-5")

        let history = [ChatMessage(role: .user, content: "hello")]
        let currentMessage = ChatMessage(role: .user, content: "expand")
        let candidates: [CrossProviderModelCandidate] = []

        let decision = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: history,
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: 8_192,
            candidates: candidates
        )

        guard case .useCurrent = decision else {
            XCTFail("Expected useCurrent when no candidate satisfies output budget, got \(decision)")
            return
        }
        XCTAssertEqual(store.selectedProvider, .zai)
        XCTAssertEqual(store.selectedModel, "glm-5")
        XCTAssertNil(store.lastContextRoutingReason)
    }

    func testResolveContextRoutingDecisionHonorsPerConversationMargin() async {
        store.applySelection(provider: .zai, baseURL: "https://z.ai", model: "glm-5")
        store.contextWindowMargin = 0.95

        let currentMessage = ChatMessage(role: .user, content: String(repeating: "word ", count: 20_000))
        let candidates: [CrossProviderModelCandidate] = []

        let generousDecision = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: [],
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: nil,
            candidates: candidates,
            margin: 0.95
        )

        let conservativeDecision = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: [],
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: nil,
            candidates: candidates,
            margin: 0.50
        )

        XCTAssertEqual(generousDecision, .useCurrent, "Generous margin should allow the request to fit")
        if case .trimHistory = conservativeDecision {
            // expected
        } else {
            XCTFail("Conservative margin should trigger trimming, got \(conservativeDecision)")
        }
    }

    func testResolveContextRoutingDecisionFallsBackToGlobalMargin() async {
        store.applySelection(provider: .zai, baseURL: "https://z.ai", model: "glm-5")
        store.contextWindowMargin = 0.95

        let currentMessage = ChatMessage(role: .user, content: String(repeating: "word ", count: 20_000))
        let candidates: [CrossProviderModelCandidate] = []

        let decision = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: [],
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: nil,
            candidates: candidates,
            margin: nil
        )

        XCTAssertEqual(decision, .useCurrent, "Nil margin should fall back to the global margin")
    }

    func testLearnedContextLimitTriggersTrimming() async {
        let model = "claude-sonnet-4-5"
        let provider = ModelProvider.anthropic
        let baseURL = "https://api.anthropic.com"
        await StreamingContextLimitLearner.shared.reset(
            model: model,
            provider: provider,
            baseURL: baseURL
        )

        store.applySelection(provider: provider, baseURL: baseURL, model: model)

        let history = [ChatMessage(role: .user, content: String(repeating: "word ", count: 65_000))]
        let currentMessage = ChatMessage(role: .user, content: "continue")
        let candidates: [CrossProviderModelCandidate] = []

        let baseline = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: history,
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: nil,
            candidates: candidates
        )
        guard case .useCurrent = baseline else {
            XCTFail("Expected useCurrent before learned context limit, got \(baseline)")
            return
        }

        for _ in 0..<3 {
            await store.recordSendOutcome(
                model: model,
                provider: provider,
                baseURL: baseURL,
                success: false,
                reason: "context limit",
                observedTotalTokens: 80_000,
                finishReason: nil
            )
        }

        let learned = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: history,
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: nil,
            candidates: candidates
        )
        guard case .trimHistory(let policy) = learned else {
            XCTFail("Expected trimHistory after learned context limit, got \(learned)")
            return
        }
        XCTAssertTrue(policy.droppedMessageCount > 0, "Learned context ceiling should force history trimming")
    }

    func testWarmupCandidatesConstrainedToPinnedTuple() {
        let constraint = ConversationModelConstraint(
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            model: "claude-sonnet-4-5"
        )
        let candidates = store.warmupCandidates(constrainedTo: constraint)
        XCTAssertEqual(candidates.count, 1)
        XCTAssertEqual(candidates.first?.provider, .anthropic)
        XCTAssertEqual(candidates.first?.model, "claude-sonnet-4-5")
    }

    func testRunAdaptiveWarmupConstrainedDoesNotSwitch() async {
        let constraint = ConversationModelConstraint(
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            model: "claude-sonnet-4-5"
        )
        let result = await store.runAdaptiveWarmup(constrainedTo: constraint)
        XCTAssertFalse(result.didSwitch)
        XCTAssertEqual(result.selected.provider, .anthropic)
        XCTAssertEqual(result.selected.model, "claude-sonnet-4-5")
        XCTAssertTrue(result.reason.contains("constrained"), "Reason should mention the conversation pin constraint")
    }

    func testSelectFirstHealthyCrossProviderModelConstrainedReturnsNil() async {
        await reliabilityService.record(
            model: "gpt-5",
            provider: .openai,
            baseURL: "https://api.openai.com",
            success: true,
            reason: nil
        )

        let constraint = ConversationModelConstraint(
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            model: "claude-sonnet-4-5"
        )
        let candidate = await store.selectFirstHealthyCrossProviderModel(constrainedTo: constraint)
        XCTAssertNil(candidate, "Cross-provider failover must be blocked when a conversation pin is active")
        XCTAssertEqual(store.selectedProvider, .anthropic, "Selection must not change when constrained")
    }

    func testSelectLargerModelCandidateConstrainedDoesNotEscape() async {
        store.applySelection(provider: .zai, baseURL: "https://z.ai", model: "glm-5")

        let constraint = ConversationModelConstraint(
            provider: .zai,
            baseURL: "https://z.ai",
            model: "glm-5"
        )
        let larger = await store.selectLargerModelCandidate(
            estimatedInput: 50_000,
            outputTokens: 1024,
            constrainedTo: constraint
        )
        XCTAssertNil(larger, "A pinned small-context model must not be replaced by a larger candidate")
    }

    func testResolveContextRoutingDecisionConstrainedDoesNotRoute() async {
        store.applySelection(provider: .zai, baseURL: "https://z.ai", model: "glm-5")

        let huge = String(repeating: "word ", count: 30_000)
        let currentMessage = ChatMessage(role: .user, content: huge)
        let candidates = [
            CrossProviderModelCandidate(provider: .openai, baseURL: "https://api.openai.com", model: "gpt-5")
        ]
        let constraint = ConversationModelConstraint(
            provider: .zai,
            baseURL: "https://z.ai",
            model: "glm-5"
        )

        let decision = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: [],
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: nil,
            candidates: candidates,
            constrainedTo: constraint
        )

        if case .routeTo = decision {
            XCTFail("Routing must not escape the pinned tuple when constrained")
        }
        XCTAssertEqual(store.selectedProvider, .zai)
        XCTAssertEqual(store.selectedModel, "glm-5")
    }
}

// MARK: - Test doubles

private actor StubModelHealthService: ModelHealthServiceProtocol {
    private var results: [String: ModelHealthResult] = [:]

    func set(result: ModelHealthResult, for model: String, provider: ModelProvider, baseURL: String) {
        results[key(provider: provider, baseURL: baseURL, model: model)] = result
    }

    func probe(model: String, provider: ModelProvider, baseURL: String, apiKey: String?) async -> ModelHealthResult {
        results[key(provider: provider, baseURL: baseURL, model: model)]
            ?? ModelHealthResult(health: .unknown(error: "not stubbed"), latencyMs: nil)
    }

    func invalidate() async {
        results.removeAll()
    }

    private func key(provider: ModelProvider, baseURL: String, model: String) -> String {
        "\(provider.rawValue)|\(baseURL)|\(model)"
    }
}

private actor StubProviderStatusService: ProviderStatusServiceProtocol {
    func status(for model: String, provider: ModelProvider, baseURL: String, apiKey: String?) async -> ProviderModelStatus {
        .present
    }

    func invalidate() async {}
}
