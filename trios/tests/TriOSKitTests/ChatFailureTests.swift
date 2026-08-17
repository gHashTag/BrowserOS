import XCTest
@testable import TriOSKit

final class ChatFailureTests: XCTestCase {
    // MARK: - TransportError classification

    func testBalanceErrorDetectedFrom402() {
        let error = TransportError.serverError(
            statusCode: 402,
            bodySample: "{\"error\":{\"message\":\"Insufficient balance\"}}",
            url: nil
        )
        XCTAssertTrue(error.isBalanceError)
        XCTAssertFalse(error.isAuthError)
        XCTAssertEqual(error.providerErrorMessage, "Insufficient balance")
    }

    func testBalanceBodyFallback() {
        let error = TransportError.serverError(
            statusCode: 400,
            bodySample: "Insufficient balance or no resource package. Please recharge.",
            url: nil
        )
        XCTAssertTrue(error.isBalanceError)
        XCTAssertEqual(error.providerErrorMessage, "Insufficient balance or no resource package. Please recharge.")
    }

    func testAuthErrorDetectedFrom401() {
        let error = TransportError.serverError(
            statusCode: 401,
            bodySample: "Unauthorized",
            url: nil
        )
        XCTAssertTrue(error.isAuthError)
        XCTAssertFalse(error.isBalanceError)
    }

    func testInvalidModelErrorDetected() {
        let error = TransportError.serverError(
            statusCode: 400,
            bodySample: "Model 'claude-opus-4-6' is not available.",
            url: nil
        )
        XCTAssertTrue(error.isInvalidModelError)
        XCTAssertFalse(error.isRetryableServerError)
    }

    func testRateLimitIsRetryable() {
        let error = TransportError.serverError(
            statusCode: 429,
            bodySample: "Rate limit exceeded",
            url: nil
        )
        XCTAssertTrue(error.isRateLimitError)
        XCTAssertTrue(error.isRetryableServerError)
    }

    func testModelUnavailableIsRetryable() {
        let error = TransportError.serverError(
            statusCode: 503,
            bodySample: "Service Unavailable",
            url: nil
        )
        XCTAssertTrue(error.isModelUnavailableError)
        XCTAssertTrue(error.isRetryableServerError)
    }

    func testFatalServerErrorsAreNotRetryable() {
        for status in [400, 401, 402, 403, 404, 422] {
            let error = TransportError.serverError(
                statusCode: status,
                bodySample: "nope",
                url: nil
            )
            XCTAssertFalse(error.isRetryableServerError, "status \(status) should not be retryable")
        }
    }

    func testContextLengthErrorDetectedFrom400Body() {
        let error = TransportError.serverError(
            statusCode: 400,
            bodySample: "{\"error\":{\"type\":\"context_length_exceeded\",\"message\":\"This model's maximum context length is 200000 tokens\"}}",
            url: nil
        )
        XCTAssertTrue(error.isContextLengthError)
        XCTAssertFalse(error.isInvalidModelError, "Context-length should not be classified as invalid model")
        XCTAssertFalse(error.isEligibleForCrossProviderFailover, "Context-length should not failover across providers")
    }

    func testContextLength413Detected() {
        let error = TransportError.serverError(
            statusCode: 413,
            bodySample: "Payload Too Large",
            url: nil
        )
        XCTAssertTrue(error.isContextLengthError)
    }

    func testRetryAfterNumericParsed() {
        let error = TransportError.serverError(
            statusCode: 429,
            bodySample: "Rate limited",
            url: nil,
            retryAfter: 120
        )
        XCTAssertEqual(error.retryAfter, 120)
    }

    func testRetryAfterHTTPDateParsed() {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        let future = Date(timeIntervalSinceNow: 120)
        let header = formatter.string(from: future)
        let parsed = SSETransport.parseRetryAfter(header)
        // A failed XCTAssertNotNil followed by `parsed!` kills the whole
        // process, so every test scheduled after it never runs. Guard
        // instead: one failing test, and the run continues.
        guard let parsedValue = parsed else {
            XCTFail("parsed was nil")
            return
        }
        XCTAssertEqual(parsedValue, 120, accuracy: 1.0)
    }

    func testAuth403NotTreatedAsBalance() {
        let error = TransportError.serverError(
            statusCode: 403,
            bodySample: "Incorrect API key provided",
            url: nil
        )
        XCTAssertTrue(error.isAuthError)
        XCTAssertFalse(error.isBalanceError)
    }

    // MARK: - Model fallback helpers

    // ModelConfigurationStore is @MainActor; every other test that touches it
    // is annotated and these two were not, which is the whole of their five
    // isolation errors. The assertions are untouched.
    @MainActor
    func testFallbackModelsExcludeCurrent() async {
        let defaults = UserDefaults(suiteName: "test-fallback")!
        defer { defaults.removePersistentDomain(forName: "test-fallback") }
        let store = ModelConfigurationStore(defaults: defaults)
        store.selectProvider(.anthropic)
        store.selectModel("claude-sonnet-4-5")

        let fallbacks = await store.fallbackModels
        XCTAssertTrue(fallbacks.contains("claude-opus-4-5"))
        XCTAssertFalse(fallbacks.contains("claude-sonnet-4-5"))
        XCTAssertFalse(store.fallbackSuggestion.isEmpty)
    }

    @MainActor
    func testSelectNextModelAdvancesList() async {
        let defaults = UserDefaults(suiteName: "test-next-model")!
        defer { defaults.removePersistentDomain(forName: "test-next-model") }
        let store = ModelConfigurationStore(defaults: defaults)
        store.selectProvider(.anthropic)
        store.selectModel("claude-sonnet-4-5")

        let next = await store.selectNextModel()
        XCTAssertNotNil(next)
        XCTAssertNotEqual(next, "claude-sonnet-4-5")
        XCTAssertEqual(store.selectedModel, next)
    }

    // MARK: - Provider-native status integration

    @MainActor
    func testProviderStatusSkipsMissingModelProbe() async {
        let defaults = UserDefaults(suiteName: "test-status-missing")!
        defer { defaults.removePersistentDomain(forName: "test-status-missing") }

        let status = MockProviderStatusService()
        await status.setStatus(.missing, for: "claude-opus-4-5")

        let health = MockModelHealthService()
        let store = ModelConfigurationStore(
            defaults: defaults,
            statusService: status,
            healthService: health
        )
        store.selectProvider(.anthropic)
        store.selectModel("claude-sonnet-4-5")

        _ = await store.healthStatus(for: "claude-opus-4-5")

        let probeCount = await health.probeCount
        XCTAssertEqual(probeCount, 0, "Missing catalog status should skip paid probe")
    }

    @MainActor
    func testProviderStatusDisablesModelProbe() async {
        let defaults = UserDefaults(suiteName: "test-status-disabled")!
        defer { defaults.removePersistentDomain(forName: "test-status-disabled") }

        let status = MockProviderStatusService()
        await status.setStatus(.disabled, for: "claude-opus-4-5")

        let health = MockModelHealthService()
        let store = ModelConfigurationStore(
            defaults: defaults,
            statusService: status,
            healthService: health
        )
        store.selectProvider(.anthropic)
        store.selectModel("claude-sonnet-4-5")

        // ModelHealthResult stopped being the enum and became a struct that
        // carries one (plus latency and quota), so the case lives on `.health`.
        // Same case, same reason, same failure message.
        let healthStatus = await store.healthStatus(for: "claude-opus-4-5")
        if case .unavailable(let reason) = healthStatus.health {
            XCTAssertTrue(reason.contains("disabled"))
        } else {
            XCTFail("Expected unavailable due to disabled catalog status, got \(healthStatus)")
        }

        let probeCount = await health.probeCount
        XCTAssertEqual(probeCount, 0, "Disabled catalog status should skip paid probe")
    }

    @MainActor
    func testOpenRouterCatalogParsing() async throws {
        let json = [
            "data": [
                ["id": "openai/gpt-5.2", "disabled": false],
                ["id": "anthropic/claude-sonnet-4.5", "disabled": true]
            ]
        ] as [String: Any]
        let data = try JSONSerialization.data(withJSONObject: json)

        // The fixture above was built and then dropped on the floor: the
        // service was constructed with the default URLSession.shared, so this
        // "catalog parsing" test issued two live GETs to openrouter.ai and
        // asserted .present/.disabled against whatever the internet answered.
        // The unused-`data` warning was the only trace of it. Serving the
        // fixture through MockURLProtocol is what makes the two assertions
        // below statements about parseCatalog instead of about the network.
        MockURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://openrouter.ai/api/v1/models")
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, data)
        }
        defer { MockURLProtocol.requestHandler = nil }

        let status = ProviderStatusService(
            ttl: 0,
            session: URLSession(configuration: .mockProtocolConfiguration())
        )
        let resultPresent = await status.status(
            for: "openai/gpt-5.2",
            provider: .openrouter,
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: nil
        )
        let resultDisabled = await status.status(
            for: "anthropic/claude-sonnet-4.5",
            provider: .openrouter,
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: nil
        )
        XCTAssertEqual(resultPresent, .present)
        XCTAssertEqual(resultDisabled, .disabled)
    }

    @MainActor
    func testStatusInvalidationResetsProviderCache() async {
        let defaults = UserDefaults(suiteName: "test-status-invalidate")!
        defer { defaults.removePersistentDomain(forName: "test-status-invalidate") }

        let status = MockProviderStatusService()
        await status.setStatus(.missing, for: "claude-opus-4-5")

        let store = ModelConfigurationStore(
            defaults: defaults,
            statusService: status
        )
        store.selectProvider(.anthropic)
        store.selectModel("claude-sonnet-4-5")

        let before = await store.providerStatus(for: "claude-opus-4-5")
        XCTAssertEqual(before, .missing)

        await status.setStatus(.present, for: "claude-opus-4-5")
        store.invalidateProviderStatus()
        let after = await store.providerStatus(for: "claude-opus-4-5")
        XCTAssertEqual(after, .present)
    }

    // MARK: - Queen command parsing

    func testDoctorWithoutModel() {
        let cmd = QueenCommandParser.parse("/doctor")
        if case .doctor(let model) = cmd {
            XCTAssertNil(model)
        } else {
            XCTFail("Expected .doctor(nil), got \(cmd)")
        }
    }

    func testDoctorWithModelFlag() {
        let cmd = QueenCommandParser.parse("/doctor --model claude-sonnet-4-6")
        if case .doctor(let model) = cmd {
            XCTAssertEqual(model, "claude-sonnet-4-6")
        } else {
            XCTFail("Expected .doctor with model, got \(cmd)")
        }
    }

    func testDoctorWithModelFlagRejectedWhenEmpty() {
        let cmd = QueenCommandParser.parse("/doctor --model")
        XCTAssertEqual(cmd, .unknown("/doctor --model"))
    }

    // MARK: - Background health poller

    @MainActor
    func testBackgroundPollerUpdatesUnhealthyModels() async {
        let defaults = UserDefaults(suiteName: "test-poller")!
        defer { defaults.removePersistentDomain(forName: "test-poller") }

        let health = MockModelHealthService()
        await health.setHealth(.unavailable(reason: "probe failed"), for: "claude-opus-4-5")
        await health.setHealth(.healthy, for: "claude-sonnet-4-5")

        let store = ModelConfigurationStore(defaults: defaults, healthService: health)
        store.selectProvider(.anthropic)
        store.selectModel("claude-sonnet-4-5")
        store.setBackgroundHealthPollingEnabled(false)

        let poller = BackgroundHealthPoller(store: store, interval: 0.1)
        poller.start()
        // Wait enough for at least one 0.1s interval to fire and refresh.
        try? await Task.sleep(nanoseconds: 250_000_000)
        await poller.forceRefresh()
        poller.stop()

        XCTAssertTrue(store.unhealthyModels.contains("claude-opus-4-5"))
        XCTAssertFalse(store.unhealthyModels.contains("claude-sonnet-4-5"))
        XCTAssertNotNil(store.lastHealthCheckAt)
    }

    @MainActor
    func testBackgroundPollerStopsAndResumes() async {
        let defaults = UserDefaults(suiteName: "test-poller-toggle")!
        defer { defaults.removePersistentDomain(forName: "test-poller-toggle") }

        let store = ModelConfigurationStore(defaults: defaults)
        store.setBackgroundHealthPollingEnabled(false)
        XCTAssertNil(store.backgroundPollerForTests)

        store.setBackgroundHealthPollingEnabled(true)
        XCTAssertNotNil(store.backgroundPollerForTests)
        XCTAssertTrue(store.backgroundPollerForTests?.isRunning == true)

        store.setBackgroundHealthPollingEnabled(false)
        XCTAssertTrue(store.backgroundPollerForTests?.isRunning == false)
    }

    @MainActor
    func testHealthyModelRecoversFromUnhealthy() async {
        let defaults = UserDefaults(suiteName: "test-poller-recovery")!
        defer { defaults.removePersistentDomain(forName: "test-poller-recovery") }

        let health = MockModelHealthService()
        await health.setHealth(.unavailable(reason: "probe failed"), for: "claude-opus-4-5")

        let store = ModelConfigurationStore(defaults: defaults, healthService: health)
        store.selectProvider(.anthropic)
        store.selectModel("claude-sonnet-4-5")
        store.markUnhealthy("claude-opus-4-5")

        await health.setHealth(.healthy, for: "claude-opus-4-5")
        await store.refreshHealth()

        XCTAssertFalse(store.unhealthyModels.contains("claude-opus-4-5"))
    }

    // MARK: - Automatic model failover

    @MainActor
    func testAutoFailoverOnModelUnavailable() async {
        let defaults = UserDefaults(suiteName: "test-failover-auto")!
        defer { defaults.removePersistentDomain(forName: "test-failover-auto") }

        let transport = MockFailingTransport(
            firstError: TransportError.serverError(
                statusCode: 503,
                bodySample: "Service Unavailable",
                url: nil
            ),
            successEvents: [
                .start(id: "msg-1"),
                .textDelta(id: "msg-1", delta: "Fallback response"),
                .finish(id: "msg-1", reason: nil)
            ]
        )
        let viewModel = makeChatViewModel(
            transport: transport,
            defaults: defaults
        )
        viewModel.inputText = "Hello"
        await viewModel.sendMessage()

        let sendCount = await transport.sendCount
        XCTAssertEqual(sendCount, 2, "Expected initial attempt plus one failover retry")
        XCTAssertEqual(viewModel.modelStore.selectedModel, "claude-opus-4-5")
        let banner = viewModel.messages.first { $0.content.contains("retrying with") }
        XCTAssertNotNil(banner)
        let assistant = viewModel.messages.first { $0.role == .assistant }
        XCTAssertEqual(assistant?.content, "Fallback response")
    }

    @MainActor
    func testBalanceErrorDoesNotFailover() async {
        let defaults = UserDefaults(suiteName: "test-failover-balance")!
        defer { defaults.removePersistentDomain(forName: "test-failover-balance") }

        let transport = MockFailingTransport(
            firstError: TransportError.serverError(
                statusCode: 402,
                bodySample: "Insufficient balance",
                url: nil
            )
        )
        let viewModel = makeChatViewModel(
            transport: transport,
            defaults: defaults
        )
        viewModel.inputText = "Hello"
        await viewModel.sendMessage()

        let sendCount = await transport.sendCount
        XCTAssertEqual(sendCount, 1, "Balance errors must not trigger failover")
        XCTAssertEqual(viewModel.modelStore.selectedModel, "claude-sonnet-4-5")
        let errorMessage = viewModel.messages.first { $0.role == .system && $0.content.contains("balance") }
        XCTAssertNotNil(errorMessage)
    }

    // MARK: - Preflight health checks

    @MainActor
    func testPreflightSwitchesAwayFromUnavailableModel() async {
        let defaults = UserDefaults(suiteName: "test-preflight-switch")!
        defer { defaults.removePersistentDomain(forName: "test-preflight-switch") }

        let health = MockModelHealthService()
        await health.setHealth(.unavailable(reason: "probe failed"), for: "claude-sonnet-4-5")
        await health.setHealth(.healthy, for: "claude-opus-4-5")

        let transport = MockFailingTransport(
            successEvents: [
                .start(id: "msg-1"),
                .textDelta(id: "msg-1", delta: "Healthy response"),
                .finish(id: "msg-1", reason: nil)
            ]
        )
        let viewModel = makeChatViewModel(
            transport: transport,
            defaults: defaults,
            healthService: health
        )
        viewModel.inputText = "Hello"
        await viewModel.sendMessage()

        let sendCount = await transport.sendCount
        XCTAssertEqual(sendCount, 1, "Preflight should avoid a failing first request")
        XCTAssertEqual(viewModel.modelStore.selectedModel, "claude-opus-4-5")
        let banner = viewModel.messages.first { $0.content.contains("unavailable") && $0.content.contains("switching") }
        XCTAssertNotNil(banner)
        let assistant = viewModel.messages.first { $0.role == .assistant }
        XCTAssertEqual(assistant?.content, "Healthy response")
    }

    @MainActor
    func testTransportErrorMarksModelUnhealthy() async {
        let defaults = UserDefaults(suiteName: "test-preflight-mark")!
        defer { defaults.removePersistentDomain(forName: "test-preflight-mark") }

        let health = MockModelHealthService()
        await health.setHealth(.healthy, for: "claude-sonnet-4-5")

        let transport = MockFailingTransport(
            firstError: TransportError.serverError(
                statusCode: 503,
                bodySample: "Service Unavailable",
                url: nil
            )
        )
        let viewModel = makeChatViewModel(
            transport: transport,
            defaults: defaults,
            healthService: health
        )
        let originalModel = viewModel.modelStore.selectedModel
        viewModel.inputText = "Hello"
        await viewModel.sendMessage()

        XCTAssertTrue(viewModel.modelStore.unhealthyModels.contains(originalModel))
        let sendCount = await transport.sendCount
        XCTAssertEqual(sendCount, 2, "Model-unavailable error should trigger one failover attempt")
    }

    @MainActor
    func testHealthyModelDoesNotSwitch() async {
        let defaults = UserDefaults(suiteName: "test-preflight-healthy")!
        defer { defaults.removePersistentDomain(forName: "test-preflight-healthy") }

        let health = MockModelHealthService()
        await health.setHealth(.healthy, for: "claude-sonnet-4-5")

        let transport = MockFailingTransport(
            successEvents: [
                .start(id: "msg-1"),
                .textDelta(id: "msg-1", delta: "Original response"),
                .finish(id: "msg-1", reason: nil)
            ]
        )
        let viewModel = makeChatViewModel(
            transport: transport,
            defaults: defaults,
            healthService: health
        )
        viewModel.inputText = "Hello"
        await viewModel.sendMessage()

        let sendCount = await transport.sendCount
        XCTAssertEqual(sendCount, 1)
        XCTAssertEqual(viewModel.modelStore.selectedModel, "claude-sonnet-4-5")
        let banner = viewModel.messages.first { $0.content.contains("unavailable") }
        XCTAssertNil(banner)
        let assistant = viewModel.messages.first { $0.role == .assistant }
        XCTAssertEqual(assistant?.content, "Original response")
    }
}

// MARK: - ChatViewModel failover stubs

private actor MockFailingTransport: ChatTransportProtocol {
    private var firstError: Error?
    private var successEvents: [SSEEvent]
    private(set) var sendCount = 0

    init(firstError: Error? = nil, successEvents: [SSEEvent] = []) {
        self.firstError = firstError
        self.successEvents = successEvents
    }

    func sendMessage(body: Data) async throws -> AsyncStream<SSEEvent> {
        sendCount += 1
        if sendCount == 1, let firstError = firstError {
            throw firstError
        }
        let events = successEvents
        return AsyncStream { continuation in
            for event in events {
                continuation.yield(event)
            }
            continuation.finish()
        }
    }

    func cancel() async {}
}

private struct MockHealthCheck: ChatHealthCheckProtocol {
    func check() async -> Bool { true }
}

private actor MockModelHealthService: ModelHealthServiceProtocol {
    private var results: [String: ModelHealth] = [:]
    private(set) var probeCount = 0

    func probe(
        model: String,
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> ModelHealthResult {
        probeCount += 1
        // `probe` now returns ModelHealthResult (health + latency + quota).
        // The stubbed health is unchanged; latency is nil because this double
        // performs no request, and inventing a number would feed the
        // latency-aware ranking a measurement nobody took.
        return ModelHealthResult(
            health: results[model] ?? .unknown(error: "not configured"),
            latencyMs: nil
        )
    }

    func invalidate() async {}

    func setHealth(_ health: ModelHealth, for model: String) {
        results[model] = health
    }
}

private actor MockProviderStatusService: ProviderStatusServiceProtocol {
    private var results: [String: ProviderModelStatus] = [:]

    func status(
        for model: String,
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> ProviderModelStatus {
        results[model] ?? .unknown(error: "not configured")
    }

    func invalidate() async {
        results.removeAll()
    }

    func setStatus(_ status: ProviderModelStatus, for model: String) {
        results[model] = status
    }
}

private actor MockPersister: ChatPersisterProtocol {
    private var storage: [UUID: [ChatMessage]] = [:]
    private var settings: [UUID: ConversationSettings] = [:]
    private var currentId: UUID = UUID()

    func save(messages: [ChatMessage], conversationId: UUID) async {
        storage[conversationId] = messages
    }

    // ChatPersisterProtocol grew per-conversation settings (the Cycle 34 output
    // budget / pinned model overrides) and this double was never extended, so
    // it stopped conforming. It round-trips them the way it already round-trips
    // messages: a double that swallowed a pin the code under test just wrote
    // would hide exactly the failover bug these tests exist to catch.
    func saveSettings(_ settings: ConversationSettings, conversationId: UUID) async {
        self.settings[conversationId] = settings
    }

    func loadSettings(conversationId: UUID) async -> ConversationSettings {
        settings[conversationId] ?? .default
    }

    func load(conversationId: UUID) async -> [ChatMessage] {
        storage[conversationId] ?? []
    }

    func clear(conversationId: UUID) async {
        storage[conversationId] = nil
    }

    func renameConversation(id: UUID, title: String) async {}

    func currentConversationId() async -> UUID { currentId }

    func setCurrentConversationId(_ id: UUID) async { currentId = id }

    func listAllConversations() async -> [ChatConversation] { [] }
}

private actor MockAgentMemoryStore: AgentMemoryStoreProtocol {
    func saveMemory(_ record: AgentMemoryRecord) async throws {}
    func memoryCandidates(for query: String, limit: Int) async throws -> [AgentMemoryRecord] { [] }
    func recentMemories(limit: Int) async throws -> [AgentMemoryRecord] { [] }
    func deleteMemory(id: UUID) async throws -> Bool { false }
    func deleteMemories(conversationId: UUID) async throws -> Int { 0 }
    func savePlan(_ plan: TODOPlan) async throws {}
    func loadPlan(conversationId: UUID) async throws -> TODOPlan? { nil }
    func deletePlan(conversationId: UUID) async throws {}
    func deleteConversationData(conversationId: UUID) async throws {}
    // Outcome recording (the Cycle 15 reliability scorecard) was added to
    // AgentMemoryStoreProtocol after this double was written. Inert, matching
    // the rest of it and MockWatchdogMemoryStore: these tests assert failover
    // behaviour, not persistence, and returning canned outcomes would feed the
    // ranker fixtures no test asked for.
    func saveOutcome(_ outcome: ModelOutcome) async throws {}
    func outcomes(
        for model: String,
        provider: ModelProvider,
        baseURL: String,
        limit: Int
    ) async throws -> [ModelOutcome] { [] }
    func deleteOutcomes(for model: String, provider: ModelProvider, baseURL: String) async throws {}
}

@MainActor
private func makeChatViewModel(
    transport: ChatTransportProtocol,
    defaults: UserDefaults,
    provider: ModelProvider = .anthropic,
    selectedModel: String = "claude-sonnet-4-5",
    healthService: any ModelHealthServiceProtocol = ModelHealthService()
) -> ChatViewModel {
    let store = ModelConfigurationStore(defaults: defaults, healthService: healthService as (any ModelHealthServiceProtocol)?)
    store.selectProvider(provider)
    store.selectModel(selectedModel)
    let memoryStore = MockAgentMemoryStore()
    let memoryService = AgentMemoryService(store: memoryStore)
    let todoPlanner = TODOPlanner(store: memoryStore, preferences: defaults)
    return ChatViewModel(
        transport: transport,
        healthCheck: MockHealthCheck(),
        parser: UIMessageStreamParser(),
        persister: MockPersister(),
        stateMachine: ConversationStateMachine(),
        modelStore: store,
        memoryService: memoryService,
        todoPlanner: todoPlanner
    )
}
