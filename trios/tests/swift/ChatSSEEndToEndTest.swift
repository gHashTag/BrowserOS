// SSE End-to-End integration tests for ChatViewModel.
//
// Run with:
//   bash tests/swift/run_chat_sse_e2e.sh
//
// Exits non-zero on the first failed assertion.

import Foundation
import SwiftUI

@main
@MainActor
struct ChatSSEEndToEndTests {
    static var failures = 0

    static func check(_ condition: @autoclosure () -> Bool, _ name: String) {
        if condition() {
            print("ok   - \(name)")
        } else {
            print("FAIL - \(name)")
            failures += 1
        }
    }

    static func fail(_ name: String) {
        print("FAIL - \(name)")
        failures += 1
    }

    static func main() async {
        await runHappyPathStreaming()
        await runCancellationIsNonError()
        await runDeduplication()

        if failures == 0 {
            print("\nAll ChatSSEEndToEnd tests passed.")
            exit(0)
        } else {
            print("\n\(failures) test(s) failed.")
            exit(1)
        }
    }

    // MARK: - Scenario 1: full streaming loop

    static func runHappyPathStreaming() async {
        print("\n# Scenario: happy streaming path")

        let transport = MockChatTransport()
        let healthCheck = MockHealthCheck()
        let persister = InMemoryPersister()
        let parser = UIMessageStreamParser()
        let stateMachine = ConversationStateMachine()

        let testDefaults = UserDefaults(suiteName: "trios-chat-sse-e2e") ?? .standard
        let modelStore = ModelConfigurationStore(defaults: testDefaults, environment: [:])

        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: healthCheck,
            parser: parser,
            persister: persister,
            stateMachine: stateMachine,
            a2aClient: nil,
            modelStore: modelStore
        )

        // Let the background init Task settle.
        try? await Task.sleep(nanoseconds: 50_000_000)

        await transport.setEvents([
            .start(id: "msg-1"),
            .textDelta(id: "msg-1", delta: "Hi"),
            .textDelta(id: "msg-1", delta: " there"),
            .finish(id: "msg-1")
        ])

        viewModel.inputText = "hello"
        let conversationId = viewModel.conversationId
        await viewModel.sendMessage()

        // UI state assertions
        check(viewModel.messages.count == 2, "messages contains exactly user + assistant")

        let userMessage = viewModel.messages.first
        check(userMessage?.role == .user, "first message is user")
        check(userMessage?.content == "hello", "user content matches input")

        let assistantMessage = viewModel.messages.last
        check(assistantMessage?.role == .assistant, "last message is assistant")
        check(assistantMessage?.content == "Hi there", "assistant content accumulates text deltas")
        check(assistantMessage?.isStreaming == false, "assistant streaming flag cleared after finish")

        let currentState = await stateMachine.currentState()
        check(currentState == .idle, "state machine returned to idle")

        // Request body assertions
        if let body = await transport.lastBody, let json = body.asJSONObject() {
            check(json["message"] as? String == "hello", "request body contains user message")
            check(json["mode"] as? String == "agent", "request body mode is agent")
            check(json["origin"] as? String == "sidepanel", "request body origin is sidepanel")
            check(json["conversationId"] as? String == conversationId.uuidString, "request body conversationId matches")

            if let messages = json["messages"] as? [[String: Any]] {
                let roles = messages.compactMap { $0["role"] as? String }
                check(roles.first == "system", "messages array starts with system prompt")
                check(roles.last == "user", "messages array ends with current user message")
            } else {
                fail("request body messages array missing or malformed")
            }
        } else {
            fail("transport did not capture a valid request body")
        }

        // Persister assertions
        let stored = persister.messages(for: conversationId)
        check(stored.count == 2, "persister stored exactly two messages")
        check(stored.first?.content == "hello", "stored user content matches")
        check(stored.last?.content == "Hi there", "stored assistant content matches")
    }

    // MARK: - Scenario 2: cancellation is not a user-visible error

    static func runCancellationIsNonError() async {
        print("\n# Scenario: cancellation is non-error")

        let transport = MockChatTransport()
        let healthCheck = MockHealthCheck()
        let persister = InMemoryPersister()
        let parser = UIMessageStreamParser()
        let stateMachine = ConversationStateMachine()

        let testDefaults = UserDefaults(suiteName: "trios-chat-sse-cancel") ?? .standard
        let modelStore = ModelConfigurationStore(defaults: testDefaults, environment: [:])

        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: healthCheck,
            parser: parser,
            persister: persister,
            stateMachine: stateMachine,
            a2aClient: nil,
            modelStore: modelStore
        )

        try? await Task.sleep(nanoseconds: 50_000_000)

        await transport.setNextError(URLError(.cancelled))

        viewModel.inputText = "cancel me"
        let conversationId = viewModel.conversationId
        await viewModel.sendMessage()

        let currentState = await stateMachine.currentState()
        check(currentState == .idle, "state is idle after cancellation")

        let hasSystemError = viewModel.messages.contains { $0.role == .system }
        check(!hasSystemError, "no system error message appended for cancellation")

        let userMessage = viewModel.messages.first(where: { $0.role == .user })
        check(userMessage?.content == "cancel me", "user message remains after cancellation")

        let stored = persister.messages(for: conversationId)
        check(stored.first(where: { $0.role == .user })?.content == "cancel me",
              "persister saved user message after cancellation")
    }

    // MARK: - Scenario 3: message deduplication

    static func runDeduplication() async {
        print("\n# Scenario: message deduplication")

        let transport = MockChatTransport()
        let healthCheck = MockHealthCheck()
        let persister = InMemoryPersister()
        let parser = UIMessageStreamParser()
        let stateMachine = ConversationStateMachine()

        let testDefaults = UserDefaults(suiteName: "trios-chat-sse-dedup") ?? .standard
        let modelStore = ModelConfigurationStore(defaults: testDefaults, environment: [:])

        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: healthCheck,
            parser: parser,
            persister: persister,
            stateMachine: stateMachine,
            a2aClient: nil,
            modelStore: modelStore
        )

        try? await Task.sleep(nanoseconds: 50_000_000)

        let duplicateId = UUID()
        viewModel.messages = [
            ChatMessage(id: duplicateId, role: .assistant, content: "first"),
            ChatMessage(id: duplicateId, role: .assistant, content: "second")
        ]
        viewModel.rebuildCache()

        check(viewModel.messages.count == 1, "duplicate UUIDs collapse to a single message")
        check(viewModel.messages.first?.content == "first", "first duplicate survives")
    }
}
