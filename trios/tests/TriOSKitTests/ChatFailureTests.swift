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

    // MARK: - Model fallback helpers

    func testFallbackModelsExcludeCurrent() {
        let defaults = UserDefaults(suiteName: "test-fallback")!
        defer { defaults.removePersistentDomain(forName: "test-fallback") }
        let store = ModelConfigurationStore(defaults: defaults)
        store.selectProvider(.anthropic)
        store.selectModel("claude-sonnet-4-5")

        XCTAssertTrue(store.fallbackModels.contains("claude-opus-4-5"))
        XCTAssertFalse(store.fallbackModels.contains("claude-sonnet-4-5"))
        XCTAssertFalse(store.fallbackSuggestion.isEmpty)
    }

    func testSelectNextModelAdvancesList() {
        let defaults = UserDefaults(suiteName: "test-next-model")!
        defer { defaults.removePersistentDomain(forName: "test-next-model") }
        let store = ModelConfigurationStore(defaults: defaults)
        store.selectProvider(.anthropic)
        store.selectModel("claude-sonnet-4-5")

        let next = store.selectNextModel()
        XCTAssertNotNil(next)
        XCTAssertNotEqual(next, "claude-sonnet-4-5")
        XCTAssertEqual(store.selectedModel, next)
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

    // MARK: - Automatic model failover

    @MainActor
    func testAutoFailoverOnModelUnavailable() async {
        let defaults = UserDefaults(suiteName: "test-failover-auto")!
        defer { defaults.removePersistentDomain(forName: "test-failover-auto") }
        let store = ModelConfigurationStore(defaults: defaults)
        store.selectProvider(.anthropic)
        store.selectModel("claude-sonnet-4-5")

        let transport = MockFailingTransport(
            firstError: TransportError.serverError(
                statusCode: 503,
                bodySample: "Service Unavailable",
                url: nil
            ),
            successEvents: [
                .start(id: "msg-1"),
                .textDelta(id: "msg-1", delta: "Fallback response"),
                .finish(id: "msg-1")
            ]
        )
        let viewModel = makeChatViewModel(
            transport: transport,
            modelStore: store,
            defaults: defaults
        )
        viewModel.inputText = "Hello"
        await viewModel.sendMessage()

        let sendCount = await transport.sendCount
        XCTAssertEqual(sendCount, 2, "Expected initial attempt plus one failover retry")
        XCTAssertEqual(store.selectedModel, "claude-opus-4-5")
        let banner = viewModel.messages.first { $0.content.contains("retrying with") }
        XCTAssertNotNil(banner)
        let assistant = viewModel.messages.first { $0.role == .assistant }
        XCTAssertEqual(assistant?.content, "Fallback response")
    }

    @MainActor
    func testBalanceErrorDoesNotFailover() async {
        let defaults = UserDefaults(suiteName: "test-failover-balance")!
        defer { defaults.removePersistentDomain(forName: "test-failover-balance") }
        let store = ModelConfigurationStore(defaults: defaults)
        store.selectProvider(.anthropic)
        store.selectModel("claude-sonnet-4-5")

        let transport = MockFailingTransport(
            firstError: TransportError.serverError(
                statusCode: 402,
                bodySample: "Insufficient balance",
                url: nil
            )
        )
        let viewModel = makeChatViewModel(
            transport: transport,
            modelStore: store,
            defaults: defaults
        )
        viewModel.inputText = "Hello"
        await viewModel.sendMessage()

        let sendCount = await transport.sendCount
        XCTAssertEqual(sendCount, 1, "Balance errors must not trigger failover")
        XCTAssertEqual(store.selectedModel, "claude-sonnet-4-5")
        let errorMessage = viewModel.messages.first { $0.role == .system && $0.content.contains("balance") }
        XCTAssertNotNil(errorMessage)
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

private actor MockPersister: ChatPersisterProtocol {
    private var storage: [UUID: [ChatMessage]] = [:]
    private var currentId: UUID = UUID()

    func save(messages: [ChatMessage], conversationId: UUID) async {
        storage[conversationId] = messages
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
}

@MainActor
private func makeChatViewModel(
    transport: ChatTransportProtocol,
    modelStore: ModelConfigurationStore,
    defaults: UserDefaults
) -> ChatViewModel {
    let store = MockAgentMemoryStore()
    let memoryService = AgentMemoryService(store: store)
    let todoPlanner = TODOPlanner(store: store, preferences: defaults)
    return ChatViewModel(
        transport: transport,
        healthCheck: MockHealthCheck(),
        parser: UIMessageStreamParser(),
        persister: MockPersister(),
        stateMachine: ConversationStateMachine(),
        modelStore: modelStore,
        memoryService: memoryService,
        todoPlanner: todoPlanner
    )
}
