// Mock implementations for ChatSSEEndToEndTest.swift.
// These fakes replace the network, health-check, and persistence layers so the
// test exercises ChatViewModel + ChatRequestBuilder + UIMessageStreamParser
// end-to-end without a live server.

import Foundation

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
    private var currentId: UUID = UUID()

    func save(messages: [ChatMessage], conversationId: UUID) async {
        lock.withLock { storage[conversationId] = messages }
    }

    func load(conversationId: UUID) async -> [ChatMessage] {
        lock.withLock { storage[conversationId] ?? [] }
    }

    func clear(conversationId: UUID) async {
        lock.withLock { storage[conversationId] = nil }
    }

    func currentConversationId() -> UUID {
        lock.withLock { currentId }
    }

    func setCurrentConversationId(_ id: UUID) {
        lock.withLock { currentId = id }
    }

    func listAllConversations() async -> [ChatConversation] {
        lock.withLock {
            storage.map { (id, messages) in
                let title = messages.first(where: { $0.role == .user })?.content ?? "New task"
                let updatedAt = messages.last?.timestamp ?? Date()
                return ChatConversation(id: id, title: title, updatedAt: updatedAt)
            }.sorted { $0.updatedAt > $1.updatedAt }
        }
    }

    // MARK: - Test helpers

    func messages(for conversationId: UUID) -> [ChatMessage] {
        lock.withLock { storage[conversationId] ?? [] }
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
