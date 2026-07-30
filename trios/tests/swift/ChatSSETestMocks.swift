// Mock implementations for ChatSSEEndToEndTest.swift.
// These fakes replace the network, health-check, and persistence layers so the
// test exercises ChatViewModel + ChatRequestBuilder + UIMessageStreamParser
// end-to-end without a live server.

import Foundation

// Make the in-memory test store usable as a reliability backend so e2e tests
// avoid opening the persistent SQLCipher database.
extension VolatileMemoryStore: ModelReliabilityStoreProtocol {}

/// Records the request body and replays a canned SSE event sequence.
actor MockChatTransport: ChatTransportProtocol {
    private(set) var lastBody: Data?
    private(set) var sendCount = 0
    private(set) var cancelCount = 0

    var events: [SSEEvent] = []
    var nextError: Error?

    func sendMessage(body: Data) async throws -> AsyncStream<SSEEvent> {
        lastBody = body
        sendCount += 1

        if let error = nextError {
            nextError = nil
            throw error
        }

        let eventsToYield = events
        return AsyncStream { continuation in
            for event in eventsToYield {
                continuation.yield(event)
            }
            continuation.finish()
        }
    }

    func cancel() async {
        cancelCount += 1
    }

    func setEvents(_ events: [SSEEvent]) {
        self.events = events
    }

    func setNextError(_ error: Error?) {
        self.nextError = error
    }

    func clear() {
        lastBody = nil
        sendCount = 0
        cancelCount = 0
        events = []
        nextError = nil
    }
}

/// Keeps a stream open until cancellation, then reproduces the real
/// SSETransport behavior of yielding an error while its read task shuts down.
actor CancellationRaceTransport: ChatTransportProtocol {
    private var continuation: AsyncStream<SSEEvent>.Continuation?
    private(set) var hasStarted = false

    func sendMessage(body: Data) async throws -> AsyncStream<SSEEvent> {
        var capturedContinuation: AsyncStream<SSEEvent>.Continuation?
        let stream = AsyncStream<SSEEvent> { streamContinuation in
            capturedContinuation = streamContinuation
        }
        continuation = capturedContinuation
        hasStarted = true
        continuation?.yield(.start(id: "cancel-race"))
        continuation?.yield(
            .textDelta(
                id: "cancel-race",
                delta: "Partial answer before explicit Stop."
            )
        )
        return stream
    }

    func cancel() async {
        continuation?.yield(
            .error(id: "cancel-race", message: "cancelled read")
        )
        continuation?.finish()
        continuation = nil
    }
}

/// Holds a valid assistant stream open until the test explicitly completes it.
actor ControlledCompletionTransport: ChatTransportProtocol {
    private var continuation: AsyncStream<SSEEvent>.Continuation?
    private(set) var hasStarted = false

    func sendMessage(body: Data) async throws -> AsyncStream<SSEEvent> {
        var capturedContinuation: AsyncStream<SSEEvent>.Continuation?
        let stream = AsyncStream<SSEEvent> { streamContinuation in
            capturedContinuation = streamContinuation
        }
        continuation = capturedContinuation
        hasStarted = true
        continuation?.yield(.start(id: "memory-clear-race"))
        continuation?.yield(
            .textDelta(
                id: "memory-clear-race",
                delta: "This result must not be remembered."
            )
        )
        return stream
    }

    func cancel() async {
        continuation?.finish()
        continuation = nil
    }

    func finish() {
        continuation?.yield(.finish(id: "memory-clear-race", reason: nil))
        continuation?.finish()
        continuation = nil
    }
}

actor ControlledSaveMemoryStore: AgentMemoryStoreProtocol {
    private let base = VolatileMemoryStore()
    private var saveStarted = false
    private var saveReleased = false
    private var saveGate: CheckedContinuation<Void, Never>?
    private var deletionStarted = false

    func saveMemory(_ record: AgentMemoryRecord) async throws {
        saveStarted = true
        if !saveReleased {
            await withCheckedContinuation { continuation in
                if saveReleased {
                    continuation.resume()
                } else {
                    saveGate = continuation
                }
            }
        }
        try await base.saveMemory(record)
    }

    func hasStartedSave() -> Bool {
        saveStarted
    }

    func hasStartedDeletion() -> Bool {
        deletionStarted
    }

    func releaseSave() {
        saveReleased = true
        saveGate?.resume()
        saveGate = nil
    }

    func memoryCandidates(
        for query: String,
        limit: Int
    ) async throws -> [AgentMemoryRecord] {
        try await base.memoryCandidates(for: query, limit: limit)
    }

    func recentMemories(limit: Int) async throws -> [AgentMemoryRecord] {
        try await base.recentMemories(limit: limit)
    }

    func deleteMemory(id: UUID) async throws -> Bool {
        try await base.deleteMemory(id: id)
    }

    func deleteMemories(conversationId: UUID) async throws -> Int {
        deletionStarted = true
        return try await base.deleteMemories(
            conversationId: conversationId
        )
    }

    func savePlan(_ plan: TODOPlan) async throws {
        try await base.savePlan(plan)
    }

    func loadPlan(conversationId: UUID) async throws -> TODOPlan? {
        try await base.loadPlan(conversationId: conversationId)
    }

    func deletePlan(conversationId: UUID) async throws {
        try await base.deletePlan(conversationId: conversationId)
    }

    func deleteConversationData(conversationId: UUID) async throws {
        deletionStarted = true
        try await base.deleteConversationData(conversationId: conversationId)
    }

    func saveOutcome(_ outcome: ModelOutcome) async throws {
        try await base.saveOutcome(outcome)
    }

    func outcomes(
        for model: String,
        provider: ModelProvider,
        baseURL: String,
        limit: Int
    ) async throws -> [ModelOutcome] {
        try await base.outcomes(
            for: model,
            provider: provider,
            baseURL: baseURL,
            limit: limit
        )
    }

    func deleteOutcomes(
        for model: String,
        provider: ModelProvider,
        baseURL: String
    ) async throws {
        try await base.deleteOutcomes(
            for: model,
            provider: provider,
            baseURL: baseURL
        )
    }
}

actor DelayedMemoryStore: AgentMemoryStoreProtocol {
    private let base = VolatileMemoryStore()
    private let recallDelayNanoseconds: UInt64
    private let deletionDelayNanoseconds: UInt64
    private let waitsForExplicitRecallRelease: Bool
    private var recallStarted = false
    private var recallReleased = false
    private var recallGate: CheckedContinuation<Void, Never>?

    init(
        recallDelayNanoseconds: UInt64,
        deletionDelayNanoseconds: UInt64 = 0,
        waitsForExplicitRecallRelease: Bool = false
    ) {
        self.recallDelayNanoseconds = recallDelayNanoseconds
        self.deletionDelayNanoseconds = deletionDelayNanoseconds
        self.waitsForExplicitRecallRelease = waitsForExplicitRecallRelease
    }

    func saveMemory(_ record: AgentMemoryRecord) async throws {
        try await base.saveMemory(record)
    }

    func memoryCandidates(
        for query: String,
        limit: Int
    ) async throws -> [AgentMemoryRecord] {
        recallStarted = true
        if waitsForExplicitRecallRelease {
            if !recallReleased {
                await withCheckedContinuation { continuation in
                    if recallReleased {
                        continuation.resume()
                    } else {
                        recallGate = continuation
                    }
                }
            }
        } else if recallDelayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: recallDelayNanoseconds)
        }
        return try await base.memoryCandidates(for: query, limit: limit)
    }

    func recentMemories(limit: Int) async throws -> [AgentMemoryRecord] {
        try await base.recentMemories(limit: limit)
    }

    func deleteMemory(id: UUID) async throws -> Bool {
        try await base.deleteMemory(id: id)
    }

    func deleteMemories(conversationId: UUID) async throws -> Int {
        if deletionDelayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: deletionDelayNanoseconds)
        }
        return try await base.deleteMemories(
            conversationId: conversationId
        )
    }

    func hasStartedRecall() -> Bool {
        recallStarted
    }

    func releaseRecall() {
        recallReleased = true
        recallGate?.resume()
        recallGate = nil
    }

    func savePlan(_ plan: TODOPlan) async throws {
        try await base.savePlan(plan)
    }

    func loadPlan(conversationId: UUID) async throws -> TODOPlan? {
        try await base.loadPlan(conversationId: conversationId)
    }

    func deletePlan(conversationId: UUID) async throws {
        try await base.deletePlan(conversationId: conversationId)
    }

    func deleteConversationData(conversationId: UUID) async throws {
        if deletionDelayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: deletionDelayNanoseconds)
        }
        try await base.deleteConversationData(conversationId: conversationId)
    }

    func saveOutcome(_ outcome: ModelOutcome) async throws {
        try await base.saveOutcome(outcome)
    }

    func outcomes(
        for model: String,
        provider: ModelProvider,
        baseURL: String,
        limit: Int
    ) async throws -> [ModelOutcome] {
        try await base.outcomes(
            for: model,
            provider: provider,
            baseURL: baseURL,
            limit: limit
        )
    }

    func deleteOutcomes(
        for model: String,
        provider: ModelProvider,
        baseURL: String
    ) async throws {
        try await base.deleteOutcomes(
            for: model,
            provider: provider,
            baseURL: baseURL
        )
    }
}

private enum TestMemoryStoreFailure: LocalizedError {
    case unavailable

    var errorDescription: String? {
        "test store unavailable"
    }
}

actor AlwaysFailingMemoryStore: AgentMemoryStoreProtocol {
    func saveMemory(_ record: AgentMemoryRecord) async throws {
        throw TestMemoryStoreFailure.unavailable
    }

    func memoryCandidates(
        for query: String,
        limit: Int
    ) async throws -> [AgentMemoryRecord] {
        throw TestMemoryStoreFailure.unavailable
    }

    func recentMemories(limit: Int) async throws -> [AgentMemoryRecord] {
        throw TestMemoryStoreFailure.unavailable
    }

    func deleteMemory(id: UUID) async throws -> Bool {
        throw TestMemoryStoreFailure.unavailable
    }

    func deleteMemories(conversationId: UUID) async throws -> Int {
        throw TestMemoryStoreFailure.unavailable
    }

    func savePlan(_ plan: TODOPlan) async throws {
        throw TestMemoryStoreFailure.unavailable
    }

    func loadPlan(conversationId: UUID) async throws -> TODOPlan? {
        throw TestMemoryStoreFailure.unavailable
    }

    func deletePlan(conversationId: UUID) async throws {
        throw TestMemoryStoreFailure.unavailable
    }

    func deleteConversationData(conversationId: UUID) async throws {
        throw TestMemoryStoreFailure.unavailable
    }

    func saveOutcome(_ outcome: ModelOutcome) async throws {
        throw TestMemoryStoreFailure.unavailable
    }

    func outcomes(
        for model: String,
        provider: ModelProvider,
        baseURL: String,
        limit: Int
    ) async throws -> [ModelOutcome] {
        throw TestMemoryStoreFailure.unavailable
    }

    func deleteOutcomes(
        for model: String,
        provider: ModelProvider,
        baseURL: String
    ) async throws {
        throw TestMemoryStoreFailure.unavailable
    }
}

actor DeleteFailingMemoryStore: AgentMemoryStoreProtocol {
    private let base = VolatileMemoryStore()

    func saveMemory(_ record: AgentMemoryRecord) async throws {
        try await base.saveMemory(record)
    }

    func memoryCandidates(
        for query: String,
        limit: Int
    ) async throws -> [AgentMemoryRecord] {
        try await base.memoryCandidates(for: query, limit: limit)
    }

    func recentMemories(limit: Int) async throws -> [AgentMemoryRecord] {
        try await base.recentMemories(limit: limit)
    }

    func deleteMemory(id: UUID) async throws -> Bool {
        try await base.deleteMemory(id: id)
    }

    func deleteMemories(conversationId: UUID) async throws -> Int {
        try await base.deleteMemories(conversationId: conversationId)
    }

    func savePlan(_ plan: TODOPlan) async throws {
        try await base.savePlan(plan)
    }

    func loadPlan(conversationId: UUID) async throws -> TODOPlan? {
        try await base.loadPlan(conversationId: conversationId)
    }

    func deletePlan(conversationId: UUID) async throws {
        try await base.deletePlan(conversationId: conversationId)
    }

    func deleteConversationData(conversationId: UUID) async throws {
        throw TestMemoryStoreFailure.unavailable
    }

    func saveOutcome(_ outcome: ModelOutcome) async throws {
        try await base.saveOutcome(outcome)
    }

    func outcomes(
        for model: String,
        provider: ModelProvider,
        baseURL: String,
        limit: Int
    ) async throws -> [ModelOutcome] {
        try await base.outcomes(
            for: model,
            provider: provider,
            baseURL: baseURL,
            limit: limit
        )
    }

    func deleteOutcomes(
        for model: String,
        provider: ModelProvider,
        baseURL: String
    ) async throws {
        try await base.deleteOutcomes(
            for: model,
            provider: provider,
            baseURL: baseURL
        )
    }
}

actor DelayedInitializationPersister: ChatPersisterProtocol {
    private var storage: [UUID: [ChatMessage]]
    private var currentId: UUID
    private var settingsStorage: [UUID: ConversationSettings] = [:]
    private let initializationDelayNanoseconds: UInt64

    init(
        currentId: UUID,
        messages: [ChatMessage],
        initializationDelayNanoseconds: UInt64
    ) {
        self.currentId = currentId
        self.storage = [currentId: messages]
        self.initializationDelayNanoseconds = initializationDelayNanoseconds
    }

    func saveSettings(_ settings: ConversationSettings, conversationId: UUID) async {
        settingsStorage[conversationId] = settings
    }

    func loadSettings(conversationId: UUID) async -> ConversationSettings {
        settingsStorage[conversationId] ?? .default
    }

    func save(messages: [ChatMessage], conversationId: UUID) async {
        storage[conversationId] = messages
    }

    func load(conversationId: UUID) async -> [ChatMessage] {
        storage[conversationId] ?? []
    }

    func clear(conversationId: UUID) async {
        storage.removeValue(forKey: conversationId)
    }

    func renameConversation(id: UUID, title: String) async {}

    func currentConversationId() async -> UUID {
        // Capture the persisted value before suspension. Returning mutable
        // state after the delay would hide a late-initialization overwrite:
        // a broken new-conversation path could update currentId while this
        // call sleeps and make the race test pass accidentally.
        let persistedIdAtReadStart = currentId
        try? await Task.sleep(nanoseconds: initializationDelayNanoseconds)
        return persistedIdAtReadStart
    }

    func setCurrentConversationId(_ id: UUID) async {
        currentId = id
    }

    func listAllConversations() async -> [ChatConversation] {
        storage.map { id, messages in
            ChatConversation(
                id: id,
                title: messages.first(where: { $0.role == .user })?.content
                    ?? "New task",
                updatedAt: messages.last?.timestamp ?? Date()
            )
        }
    }

    func peekCurrentConversationId() -> UUID {
        currentId
    }
}

/// Always-healthy transport for the view model init path.
actor MockHealthCheck: ChatHealthCheckProtocol {
    var reachable = true

    func check() async -> Bool {
        reachable
    }
}

/// In-memory persister with synchronous read/write for stable tests.
final class InMemoryPersister: ChatPersisterProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [UUID: [ChatMessage]] = [:]
    private var titles: [UUID: String] = [:]
    private var settings: [UUID: ConversationSettings] = [:]
    private var currentId: UUID = UUID()

    func saveSettings(_ settings: ConversationSettings, conversationId: UUID) async {
        lock.withLock { self.settings[conversationId] = settings }
    }

    func loadSettings(conversationId: UUID) async -> ConversationSettings {
        lock.withLock { settings[conversationId] ?? .default }
    }

    func save(messages: [ChatMessage], conversationId: UUID) async {
        lock.withLock { storage[conversationId] = messages }
    }

    func load(conversationId: UUID) async -> [ChatMessage] {
        lock.withLock { storage[conversationId] ?? [] }
    }

    func clear(conversationId: UUID) async {
        lock.withLock {
            storage[conversationId] = nil
            titles[conversationId] = nil
        }
    }

    func renameConversation(id: UUID, title: String) async {
        lock.withLock {
            titles[id] = ConversationTitlePolicy.normalized(title)
        }
    }

    func currentConversationId() async -> UUID {
        lock.withLock { currentId }
    }

    func setCurrentConversationId(_ id: UUID) async {
        lock.withLock { currentId = id }
    }

    func listAllConversations() async -> [ChatConversation] {
        lock.withLock {
            storage.map { (id, messages) in
                let title = titles[id]
                    ?? messages.first(where: { $0.role == .user })?.content
                    ?? "New task"
                let updatedAt = messages.last?.timestamp ?? Date()
                return ChatConversation(id: id, title: title, updatedAt: updatedAt)
            }.sorted { $0.updatedAt > $1.updatedAt }
        }
    }

    // MARK: - Test helpers

    func messages(for conversationId: UUID) -> [ChatMessage] {
        lock.withLock { storage[conversationId] ?? [] }
    }

    func containsConversation(_ conversationId: UUID) -> Bool {
        lock.withLock { storage[conversationId] != nil }
    }

    func setCurrentConversationIdSync(_ id: UUID) {
        lock.withLock { currentId = id }
    }
}

// MARK: - JSON inspection helpers

extension Data {
    func asJSONObject() -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: self)) as? [String: Any]
    }
}
