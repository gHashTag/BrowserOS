import Foundation

enum SessionRecoverySnapshotFactory {
    static func conversation(
        id: UUID,
        title: String,
        updatedAt: Date,
        messages: [ChatMessage]
    ) -> SessionRecoveryConversation {
        SessionRecoveryConversation(
            id: id,
            title: title,
            updatedAt: updatedAt,
            messages: messages.map(message)
        )
    }

    static func chatMessage(from recovery: SessionRecoveryConversation) -> [ChatMessage] {
        recovery.messages.map(chatMessage)
    }

    static func chatMessage(from recovery: SessionRecoveryMessage) -> ChatMessage {
        ChatMessage(
            id: recovery.id,
            role: chatRole(from: recovery.role),
            content: recovery.content,
            segments: recovery.segments.compactMap(chatSegment),
            timestamp: recovery.timestamp,
            isStreaming: recovery.isStreaming,
            toolCalls: recovery.toolCalls.map(chatToolCall),
            task: recovery.task.map(chatTask)
        )
    }

    static func chatRole(from role: String) -> ChatRole {
        switch role.lowercased() {
        case "user": return .user
        case "assistant": return .assistant
        case "system": return .system
        case "tool": return .tool
        default: return .system
        }
    }

    static func chatToolCall(from recovery: SessionRecoveryToolCall) -> ToolCall {
        ToolCall(
            id: recovery.id,
            name: recovery.name,
            arguments: recovery.arguments,
            output: recovery.output,
            isComplete: recovery.isComplete
        )
    }

    static func chatTask(from recovery: SessionRecoveryTask) -> AgentTask {
        AgentTask(
            id: recovery.id,
            title: recovery.title,
            description: recovery.description,
            state: AgentTaskState(rawValue: recovery.state) ?? .pending,
            priority: AgentTaskPriority(rawValue: recovery.priority) ?? .medium,
            assignee: AgentId(recovery.assignee),
            createdAt: recovery.createdAt,
            updatedAt: recovery.updatedAt,
            result: nil
        )
    }

    static func message(_ message: ChatMessage) -> SessionRecoveryMessage {
        SessionRecoveryMessage(
            id: message.id,
            role: message.role.rawValue,
            content: message.content,
            timestamp: message.timestamp,
            isStreaming: message.isStreaming,
            segments: message.segments.map(segment),
            toolCalls: message.toolCalls.map { toolCall in
                SessionRecoveryToolCall(
                    id: toolCall.id,
                    name: toolCall.name,
                    arguments: toolCall.arguments,
                    output: toolCall.output,
                    isComplete: toolCall.isComplete
                )
            },
            task: message.task.map(task)
        )
    }

    static func chatSegment(from recovery: SessionRecoverySegment) -> MessageSegment? {
        switch recovery.kind {
        case "text":
            return .text(recovery.text ?? "")
        case "reasoning":
            return .reasoning(recovery.text ?? "")
        case "toolCall":
            return .toolCall(id: recovery.toolCallID ?? "")
        case "toolInput":
            return .toolInput(
                name: recovery.name ?? "",
                arguments: recovery.arguments ?? ""
            )
        case "toolOutput":
            return .toolOutput(
                name: recovery.name ?? "",
                result: recovery.result ?? ""
            )
        case "error":
            return .error(recovery.text ?? "")
        default:
            return nil
        }
    }

    private static func segment(_ segment: MessageSegment) -> SessionRecoverySegment {
        switch segment {
        case .text(let text):
            return SessionRecoverySegment(kind: "text", text: text)
        case .reasoning(let text):
            return SessionRecoverySegment(kind: "reasoning", text: text)
        case .toolCall(let id):
            return SessionRecoverySegment(kind: "toolCall", toolCallID: id)
        case .toolInput(let name, let arguments):
            return SessionRecoverySegment(
                kind: "toolInput",
                name: name,
                arguments: arguments
            )
        case .toolOutput(let name, let result):
            return SessionRecoverySegment(
                kind: "toolOutput",
                name: name,
                result: result
            )
        case .error(let text):
            return SessionRecoverySegment(kind: "error", text: text)
        }
    }

    private static func task(_ task: AgentTask) -> SessionRecoveryTask {
        SessionRecoveryTask(
            id: task.id,
            title: task.title,
            description: task.description,
            state: task.state.rawValue,
            priority: task.priority.rawValue,
            assignee: task.assignee.rawValue,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt
        )
    }
}
