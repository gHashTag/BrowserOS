import XCTest
@testable import TriOSKit

final class StreamingContextWatchdogIntegrationTests: XCTestCase {

    // MARK: - Mid-stream pause surfacing

    @MainActor
    func testPauseSurfacesAfterOutputLimitReached() async {
        let defaults = UserDefaults(suiteName: "test-watchdog-pause")!
        defer { defaults.removePersistentDomain(forName: "test-watchdog-pause") }

        // Use an unknown model so the conservative maxOutputTokens=1024 profile is
        // active; pause fires at 95% = ~972 estimated tokens.
        let delta = String(repeating: "a", count: 300 * 4) // 300 tokens per delta
        let events: [SSEEvent] = [
            .start(id: "msg-1"),
            .textDelta(id: "msg-1", delta: delta),
            .textDelta(id: "msg-1", delta: delta),
            .textDelta(id: "msg-1", delta: delta),
            .textDelta(id: "msg-1", delta: delta)
        ]
        let transport = MockPausingTransport(events: events)
        let viewModel = makeWatchdogTestViewModel(
            transport: transport,
            defaults: defaults,
            selectedModel: "test-unknown-model"
        )
        viewModel.inputText = "Hello"
        await viewModel.sendMessage()

        XCTAssertTrue(viewModel.isStreamPausedForContext, "UI must enter paused state")
        XCTAssertNotNil(viewModel.streamingContextDecision)
        if case .limitReached(let partial, _) = viewModel.streamingContextDecision {
            XCTAssertFalse(partial.isEmpty, "Partial text must be captured")
        } else {
            XCTFail("Expected .limitReached decision")
        }
        XCTAssertNotNil(viewModel.streamingContextPauseLabel)
        let assistant = viewModel.messages.last { $0.role == .assistant }
        XCTAssertNotNil(assistant)
        XCTAssertEqual(assistant?.content, delta + delta + delta + delta)
    }

    // MARK: - Final delta preserved

    @MainActor
    func testLimitReachedPreservesFinalDelta() async {
        let defaults = UserDefaults(suiteName: "test-watchdog-delta")!
        defer { defaults.removePersistentDomain(forName: "test-watchdog-delta") }

        let first = String(repeating: "x", count: 200 * 4)
        let last = "final-delta-token-bucket"
        let events: [SSEEvent] = [
            .start(id: "msg-1"),
            .textDelta(id: "msg-1", delta: first),
            .textDelta(id: "msg-1", delta: last)
        ]
        let transport = MockPausingTransport(events: events)
        let viewModel = makeWatchdogTestViewModel(
            transport: transport,
            defaults: defaults,
            selectedModel: "test-unknown-model"
        )
        viewModel.inputText = "Hello"
        await viewModel.sendMessage()

        let assistant = viewModel.messages.last { $0.role == .assistant }
        XCTAssertEqual(assistant?.content, first + last)
        XCTAssertTrue(viewModel.isStreamPausedForContext)
    }

    // MARK: - Continuation includes partial assistant response

    @MainActor
    func testContinueOnLargerModelIncludesPartialAssistant() async {
        let defaults = UserDefaults(suiteName: "test-watchdog-continue")!
        defer { defaults.removePersistentDomain(forName: "test-watchdog-continue") }

        let partial = String(repeating: "p", count: 350 * 4)
        let firstEvents: [SSEEvent] = [
            .start(id: "msg-1"),
            .textDelta(id: "msg-1", delta: partial)
        ]
        let continued = " continued"
        let continuationEvents: [SSEEvent] = [
            .start(id: "msg-2"),
            .textDelta(id: "msg-2", delta: continued),
            .finish(id: "msg-2", reason: nil)
        ]
        let transport = MockPausingTransport(
            events: firstEvents,
            continuationEvents: continuationEvents
        )
        let viewModel = makeWatchdogTestViewModel(
            transport: transport,
            defaults: defaults,
            selectedModel: "test-unknown-model"
        )
        // Force a larger-model candidate to exist by selecting a tiny model first
        // and making the continuation target a known larger one.
        viewModel.inputText = "Hello"
        await viewModel.sendMessage()
        XCTAssertTrue(viewModel.isStreamPausedForContext)

        // Manually choose a larger model since the test store has no real candidates.
        let larger = CrossProviderModelCandidate(
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            model: "claude-opus-4-5"
        )
        await viewModel.continueStreamOnLargerModel(larger)

        XCTAssertFalse(viewModel.isStreamPausedForContext)
        let sends = await transport.sendCount
        XCTAssertEqual(sends, 2, "Continuation must issue a second request")

        // The second request must include both the original user message and the
        // partial assistant message (INV-9).
        let history = await transport.lastHistory
        XCTAssertTrue(history.contains { $0.role == .user && $0.content == "Hello" })
        XCTAssertTrue(history.contains { $0.role == .assistant && $0.content == partial })
        XCTAssertEqual(history.filter { $0.role == .user }.count, 1, "User message must not be duplicated")
    }

    // MARK: - Transient warning is not persisted

    @MainActor
    func testApproachingLimitWarningIsTransient() async {
        let defaults = UserDefaults(suiteName: "test-watchdog-warning")!
        defer { defaults.removePersistentDomain(forName: "test-watchdog-warning") }

        // 80% of 1024 = ~819 tokens; 700 tokens keeps us below pause but above warning.
        let delta = String(repeating: "w", count: 850 * 4)
        let events: [SSEEvent] = [
            .start(id: "msg-1"),
            .textDelta(id: "msg-1", delta: delta)
        ]
        let transport = MockPausingTransport(events: events)
        let viewModel = makeWatchdogTestViewModel(
            transport: transport,
            defaults: defaults,
            selectedModel: "test-unknown-model"
        )
        viewModel.inputText = "Hello"
        await viewModel.sendMessage()

        // With a single 850-token delta on a 1024-token output limit we are above
        // the warning threshold (80%) but below the pause threshold (95%), so the
        // stream should finish normally and only the transient warning is visible.
        XCTAssertFalse(viewModel.isStreamPausedForContext)
        XCTAssertNotNil(viewModel.streamingContextWarning)
        let persistedWarning = viewModel.messages.first {
            $0.role == .system && $0.content.contains("approaching")
        }
        XCTAssertNil(persistedWarning, "Approaching-limit warning must not be persisted as a system message")
    }

    // MARK: - Pause state resets on new conversation

    @MainActor
    func testPauseStateResetsOnNewConversation() async {
        let defaults = UserDefaults(suiteName: "test-watchdog-reset")!
        defer { defaults.removePersistentDomain(forName: "test-watchdog-reset") }

        let delta = String(repeating: "a", count: 300 * 4)
        let events: [SSEEvent] = [
            .start(id: "msg-1"),
            .textDelta(id: "msg-1", delta: delta),
            .textDelta(id: "msg-1", delta: delta),
            .textDelta(id: "msg-1", delta: delta),
            .textDelta(id: "msg-1", delta: delta)
        ]
        let transport = MockPausingTransport(events: events)
        let viewModel = makeWatchdogTestViewModel(
            transport: transport,
            defaults: defaults,
            selectedModel: "test-unknown-model"
        )
        viewModel.inputText = "Hello"
        await viewModel.sendMessage()
        XCTAssertTrue(viewModel.isStreamPausedForContext)

        viewModel.newConversation()
        // Wait for the async conversation reset inside newConversation.
        try? await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertFalse(viewModel.isStreamPausedForContext)
        XCTAssertNil(viewModel.streamingContextDecision)
        XCTAssertNil(viewModel.streamingContextWarning)
        XCTAssertNil(viewModel.streamingContextPauseLabel)
    }

    // MARK: - Outcome records context-limit pause as failure

    @MainActor
    func testContextLimitPauseRecordsFailureOutcome() async {
        let defaults = UserDefaults(suiteName: "test-watchdog-outcome")!
        defer { defaults.removePersistentDomain(forName: "test-watchdog-outcome") }

        let delta = String(repeating: "a", count: 300 * 4)
        let events: [SSEEvent] = [
            .start(id: "msg-1"),
            .textDelta(id: "msg-1", delta: delta),
            .textDelta(id: "msg-1", delta: delta),
            .textDelta(id: "msg-1", delta: delta),
            .textDelta(id: "msg-1", delta: delta)
        ]
        let transport = MockPausingTransport(events: events)
        let viewModel = makeWatchdogTestViewModel(
            transport: transport,
            defaults: defaults,
            selectedModel: "test-unknown-model"
        )
        viewModel.inputText = "Hello"
        await viewModel.sendMessage()

        let reliability = await viewModel.modelStore.reliability(for: "test-unknown-model")
        if case .known(let score, let samples, let lastReason) = reliability {
            XCTAssertEqual(samples, 1)
            XCTAssertEqual(lastReason, "context limit")
            XCTAssertLessThan(score, 1.0, "Context-limit pause must not be scored as success")
        } else {
            XCTFail("Expected known reliability after one sample")
        }
    }
}

    // MARK: - Live budget progress status

    @MainActor
    func testStreamingBudgetStatusIsNilBeforeStream() async {
        let defaults = UserDefaults(suiteName: "test-budget-idle")!
        defer { defaults.removePersistentDomain(forName: "test-budget-idle") }

        let transport = MockPausingTransport(events: [])
        let viewModel = makeWatchdogTestViewModel(
            transport: transport,
            defaults: defaults,
            selectedModel: "test-unknown-model"
        )
        XCTAssertNil(viewModel.streamingBudgetStatus)
    }

    @MainActor
    func testStreamingBudgetStatusPublishedDuringStream() async {
        let defaults = UserDefaults(suiteName: "test-budget-stream")!
        defer { defaults.removePersistentDomain(forName: "test-budget-stream") }

        // ~850 output tokens on a 1024-token ceiling -> warning band.
        let delta = String(repeating: "w", count: 850 * 4)
        let events: [SSEEvent] = [
            .start(id: "msg-1"),
            .textDelta(id: "msg-1", delta: delta)
        ]
        let transport = MockPausingTransport(events: events)
        let viewModel = makeWatchdogTestViewModel(
            transport: transport,
            defaults: defaults,
            selectedModel: "test-unknown-model"
        )
        viewModel.inputText = "Hello"
        await viewModel.sendMessage()

        XCTAssertFalse(viewModel.isStreamPausedForContext)
        XCTAssertNotNil(viewModel.streamingBudgetStatus)
        guard let status = viewModel.streamingBudgetStatus else { return }
        XCTAssertEqual(status.outputCeiling, 1024)
        XCTAssertEqual(status.limitKind, .outputTokens)
        XCTAssertEqual(status.kind, .warning)
        XCTAssertGreaterThanOrEqual(status.outputUsed, 800)
        XCTAssertLessThanOrEqual(status.outputUsed, 900)
    }

    @MainActor
    func testStreamingBudgetStatusResetsOnNewConversation() async {
        let defaults = UserDefaults(suiteName: "test-budget-reset")!
        defer { defaults.removePersistentDomain(forName: "test-budget-reset") }

        let delta = String(repeating: "a", count: 300 * 4)
        let events: [SSEEvent] = [
            .start(id: "msg-1"),
            .textDelta(id: "msg-1", delta: delta),
            .textDelta(id: "msg-1", delta: delta),
            .textDelta(id: "msg-1", delta: delta),
            .textDelta(id: "msg-1", delta: delta)
        ]
        let transport = MockPausingTransport(events: events)
        let viewModel = makeWatchdogTestViewModel(
            transport: transport,
            defaults: defaults,
            selectedModel: "test-unknown-model"
        )
        viewModel.inputText = "Hello"
        await viewModel.sendMessage()
        XCTAssertNotNil(viewModel.streamingBudgetStatus)

        viewModel.newConversation()
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertNil(viewModel.streamingBudgetStatus)
    }

// MARK: - Stubs

private actor MockPausingTransport: ChatTransportProtocol {
    private let events: [SSEEvent]
    private let continuationEvents: [SSEEvent]
    private(set) var sendCount = 0
    private(set) var lastHistory: [ChatMessage] = []

    init(events: [SSEEvent], continuationEvents: [SSEEvent] = []) {
        self.events = events
        self.continuationEvents = continuationEvents
    }

    func sendMessage(body: Data) async throws -> AsyncStream<SSEEvent> {
        sendCount += 1
        let eventsToSend = sendCount == 1 ? events : continuationEvents
        // Capture the previousConversation sent in the request body for assertions.
        if let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
           let history = json["previousConversation"] as? [[String: Any]] {
            lastHistory = history.compactMap { dict in
                guard let role = dict["role"] as? String,
                      let content = dict["content"] as? String,
                      let chatRole = ChatRole(rawValue: role) else { return nil }
                return ChatMessage(role: chatRole, content: content)
            }
        }
        return AsyncStream { continuation in
            for event in eventsToSend {
                continuation.yield(event)
            }
            continuation.finish()
        }
    }

    func cancel() async {}
}

private struct MockWatchdogHealthCheck: ChatHealthCheckProtocol {
    func check() async -> Bool { true }
}

private actor MockWatchdogPersister: ChatPersisterProtocol {
    func save(messages: [ChatMessage], conversationId: UUID) async {}
    func load(conversationId: UUID) async -> [ChatMessage] { [] }
    func clear(conversationId: UUID) async {}
    func renameConversation(id: UUID, title: String) async {}
    func currentConversationId() async -> UUID { UUID() }
    func setCurrentConversationId(_ id: UUID) async {}
    func listAllConversations() async -> [ChatConversation] { [] }
}

private actor MockWatchdogMemoryStore: AgentMemoryStoreProtocol {
    func saveMemory(_ record: AgentMemoryRecord) async throws {}
    func memoryCandidates(for query: String, limit: Int) async throws -> [AgentMemoryRecord] { [] }
    func recentMemories(limit: Int) async throws -> [AgentMemoryRecord] { [] }
    func deleteMemory(id: UUID) async throws -> Bool { false }
    func deleteMemories(conversationId: UUID) async throws -> Int { 0 }
    func savePlan(_ plan: TODOPlan) async throws {}
    func loadPlan(conversationId: UUID) async throws -> TODOPlan? { nil }
    func deletePlan(conversationId: UUID) async throws {}
    func deleteConversationData(conversationId: UUID) async throws {}
}

@MainActor
private func makeWatchdogTestViewModel(
    transport: ChatTransportProtocol,
    defaults: UserDefaults,
    selectedModel: String
) -> ChatViewModel {
    let store = ModelConfigurationStore(defaults: defaults)
    store.selectProvider(.anthropic)
    store.selectModel(selectedModel)
    let memoryStore = MockWatchdogMemoryStore()
    let memoryService = AgentMemoryService(store: memoryStore)
    let todoPlanner = TODOPlanner(store: memoryStore, preferences: defaults)
    return ChatViewModel(
        transport: transport,
        healthCheck: MockWatchdogHealthCheck(),
        parser: UIMessageStreamParser(),
        persister: MockWatchdogPersister(),
        stateMachine: ConversationStateMachine(),
        modelStore: store,
        memoryService: memoryService,
        todoPlanner: todoPlanner
    )
}
