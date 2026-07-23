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
