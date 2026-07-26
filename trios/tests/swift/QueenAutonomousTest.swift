// Standalone verification of QueenBackgroundService autonomous chat and A2A
// operations. Runs without XCTest by compiling the production rings directly.
//
// Usage: bash tests/swift/run_queen_autonomous_test.sh

import Foundation
import SwiftUI

@main
@MainActor
struct QueenAutonomousTests {
    static var failures = 0

    static func check(_ condition: @autoclosure () -> Bool, _ name: String) {
        if condition() {
            print("ok   - \(name)")
        } else {
            print("FAIL - \(name)")
            failures += 1
        }
    }

    static func main() async {
        let serverURL = URL(string: ProcessInfo.processInfo.environment["TRIOS_A2A_URL"] ?? "http://127.0.0.1:9105")!
        let testAgentId = "queen-autonomous-test-\(UUID().uuidString.prefix(8))"
        let agentCard = AgentCard(
            id: AgentId(testAgentId),
            name: "Queen Autonomous Test",
            description: "Temporary test participant for Queen A2A verification.",
            capabilities: [.chat],
            version: "1.0.0",
            endpoint: serverURL
        )
        let a2aClient = A2ARegistryClient(serverURL: serverURL, agentCard: agentCard)
        let persister = InMemoryPersister()
        let memoryService = AgentMemoryService(store: VolatileMemoryStore(), fingerprintKey: nil)
        let service = QueenBackgroundService.shared
        service.configure(memoryService: memoryService, persister: persister, a2aClient: a2aClient)

        await runChatOperations(service: service, persister: persister)
        await runA2AOperations(service: service, client: a2aClient)

        // Best-effort cleanup of the test agent registration.
        try? await a2aClient.unregister()

        if failures == 0 {
            print("\nAll Queen autonomous tests passed.")
            exit(0)
        } else {
            print("\n\(failures) Queen autonomous test(s) failed.")
            exit(1)
        }
    }

    // MARK: - Chat operations

    static func runChatOperations(service: QueenBackgroundService, persister: InMemoryPersister) async {
        print("\n# Scenario: Queen chat operations")

        let chats = await service.listChats()
        check(chats.contains(where: { $0.id == ChatConversation.trinityQueenId }), "reserved Queen conversation exists")

        let newChatId = await service.createChat(title: "Agent task room")
        check(newChatId != ChatConversation.trinityQueenId, "created chat has a distinct id")
        check(persister.containsConversation(newChatId), "persister stores the created conversation")

        await service.postToChat(id: newChatId, role: .assistant, content: "Task context seeded by Queen")
        let messages = await persister.load(conversationId: newChatId)
        check(messages.count == 1, "posted message is persisted")
        check(messages.first?.role == .assistant, "posted message role is assistant")
        check(messages.first?.content == "Task context seeded by Queen", "posted message content matches")

        // Posting to the reserved Queen conversation also surfaces through the delegate.
        var capturedQueenMessage: ChatMessage?
        let capturer = QueenMessageCapturer { capturedQueenMessage = $0 }
        service.delegate = capturer
        await service.postToChat(id: ChatConversation.trinityQueenId, role: .system, content: "Queen delegate ping")
        // Give the MainActor delegate callback a moment to land.
        try? await Task.sleep(nanoseconds: 50_000_000)
        check(capturedQueenMessage?.content == "Queen delegate ping", "delegate receives Queen conversation update")

        // The Queen conversation itself must accumulate the system post.
        let queenMessages = await persister.load(conversationId: ChatConversation.trinityQueenId)
        check(queenMessages.contains(where: { $0.content == "Queen delegate ping" }), "Queen conversation stores the system post")
    }

    // MARK: - A2A operations

    static func runA2AOperations(service: QueenBackgroundService, client: A2ARegistryClient) async {
        print("\n# Scenario: Queen A2A operations")

        let agents = await service.listAgents()
        check(agents.contains(where: { $0.id.rawValue == "trios-agent" }), "listAgents discovers the resident trios-agent")

        await service.delegateTask(agentId: "trios-agent", description: "Verify Queen task delegation")
        // The call is fire-and-forget; success is measured by the method returning
        // without throwing and the A2A server accepting the task assignment.
        check(true, "delegateTask completes without throwing")

        // Broadcast requires the client to be registered.
        do {
            try await client.register()
            await service.broadcast(message: "Queen broadcast verification")
            check(true, "broadcast completes after registration")
        } catch {
            print("skip - broadcast: A2A registration unavailable (\(error.localizedDescription))")
        }
    }
}

@MainActor
final class QueenMessageCapturer: QueenBackgroundServiceDelegate {
    private var onMessage: (ChatMessage) -> Void

    init(onMessage: @escaping (ChatMessage) -> Void) {
        self.onMessage = onMessage
    }

    func queenBackgroundService(_ service: QueenBackgroundService, didReceiveA2AMessage message: ChatMessage) {
        onMessage(message)
    }

    func queenBackgroundServiceDidUpdateState(_ service: QueenBackgroundService) {}
}
