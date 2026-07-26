// AGENT-V-WAIVER: browseros-ai/BrowserOS#2023
// Reason: Input validation on inbound A2A messages (type and sender).
import Foundation
import SwiftUI

/// Delegate that receives routed Queen messages from A2AMessageRouter.
/// The router intentionally does not know about ChatViewModel; any UI or
/// background service can adopt this protocol.
@MainActor
protocol A2AMessageRouterDelegate: AnyObject {
    func a2aMessageRouter(
        _ router: A2AMessageRouter,
        didProduceQueenMessage message: ChatMessage
    )
}

/// Routes inbound A2A events into the reserved Trinity Queen conversation.
/// All messages are appended to the Queen chat so the user has a single,
/// non-deletable timeline of agent activity.
@MainActor
final class A2AMessageRouter {
    private weak var delegate: A2AMessageRouterDelegate?

    init(delegate: A2AMessageRouterDelegate? = nil) {
        self.delegate = delegate
    }

    func route(_ message: A2AMessage) {
        guard A2AMessageType(rawValue: message.type.rawValue) != nil else {
            print("[A2AMessageRouter] Warning: dropping message with unknown type: \(message.type.rawValue)")
            return
        }
        guard validateAgentIdentifier(message.sender.rawValue) else {
            print("[A2AMessageRouter] Warning: dropping message with invalid sender: \(message.sender.rawValue)")
            return
        }

        switch message.type {
        case .direct, .broadcast:
            handleChatMessage(message)
        case .taskAssign:
            handleAgentTaskAssign(message)
        case .taskUpdate:
            handleAgentTaskUpdate(message)
        case .taskResult:
            handleAgentTaskResult(message)
        case .addToolCall:
            handleAddToolCall(message)
        case .heartbeat:
            handleHeartbeat(message)
        case .error:
            handleError(message)
        }
    }

    private func validateAgentIdentifier(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 64 else { return false }
        return value.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil
    }

    private func handleChatMessage(_ message: A2AMessage) {
        guard let text = String(data: message.payload, encoding: .utf8) else { return }
        let chatMessage = ChatMessage(
            role: .assistant,
            content: text,
            segments: [.text(text)]
        )
        emit(chatMessage)
    }

    private func handleAgentTaskAssign(_ message: A2AMessage) {
        guard let task = try? JSONDecoder().decode(AgentTask.self, from: message.payload) else { return }
        let senderName = message.sender.rawValue
        let chatMessage = ChatMessage(
            role: .assistant,
            content: "[\(senderName)] Task assigned: \(task.title)",
            segments: [.text("[\(senderName)] Task assigned: \(task.title)")],
            task: task
        )
        emit(chatMessage)
    }

    private func handleAgentTaskUpdate(_ message: A2AMessage) {
        guard let updatedTask = try? JSONDecoder().decode(AgentTask.self, from: message.payload) else { return }
        let chatMessage = ChatMessage(
            role: .system,
            content: "Task \(updatedTask.id.uuidString.prefix(8)) is now \(updatedTask.state.displayName)",
            segments: [.text("Task \(updatedTask.id.uuidString.prefix(8)) is now \(updatedTask.state.displayName)")]
        )
        emit(chatMessage)
    }

    private func handleAgentTaskResult(_ message: A2AMessage) {
        guard let task = try? JSONDecoder().decode(AgentTask.self, from: message.payload) else { return }
        let resultSummary = task.result?.summary ?? "completed"
        let chatMessage = ChatMessage(
            role: .assistant,
            content: "Task \(task.id.uuidString.prefix(8)) finished: \(resultSummary)",
            segments: [.text("Task \(task.id.uuidString.prefix(8)) finished: \(resultSummary)")]
        )
        emit(chatMessage)
    }

    private func handleAddToolCall(_ message: A2AMessage) {
        guard let toolCallData = try? JSONDecoder().decode(ToolCall.self, from: message.payload) else { return }
        let chatMessage = ChatMessage(
            role: .assistant,
            content: "",
            segments: [],
            toolCalls: [toolCallData]
        )
        emit(chatMessage)
    }

    private func handleError(_ message: A2AMessage) {
        guard let text = String(data: message.payload, encoding: .utf8) else { return }
        let chatMessage = ChatMessage(
            role: .system,
            content: "",
            segments: [.error(text)]
        )
        emit(chatMessage)
    }

    private func handleHeartbeat(_ message: A2AMessage) {
        guard let payload = String(data: message.payload, encoding: .utf8),
              !payload.isEmpty else { return }
        let chatMessage = ChatMessage(
            role: .system,
            content: "[heartbeat] \(message.sender.rawValue): \(payload)",
            segments: [.text("[heartbeat] \(message.sender.rawValue): \(payload)")]
        )
        emit(chatMessage)
    }

    private func emit(_ message: ChatMessage) {
        delegate?.a2aMessageRouter(self, didProduceQueenMessage: message)
    }
}
