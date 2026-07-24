import Foundation

@main
struct TodoListProjectionTest {
    static func main() {
        emptyWhenNoTaskState()
        derivesOnlyFromMessageTasks()
        deduplicatesByTaskId()
        ordersOpenBeforeFinished()
        countsOpenTasks()
        print("All TodoListProjection tests passed.")
    }

    // The checklist must never invent demo/static tasks: a conversation with no
    // planner task state yields an empty list.
    static func emptyWhenNoTaskState() {
        let messages = [
            ChatMessage(role: .user, content: "hello"),
            ChatMessage(role: .assistant, content: "hi there")
        ]
        expect(TodoListProjection.tasks(from: messages).isEmpty, "no fixtures without task state")
        expect(TodoListProjection.openCount(from: messages) == 0, "no open tasks without state")
    }

    static func derivesOnlyFromMessageTasks() {
        let taskA = makeTask(title: "Search web", state: .pending, priority: .medium)
        let messages = [
            ChatMessage(role: .user, content: "go"),
            message(with: taskA)
        ]
        let result = TodoListProjection.tasks(from: messages)
        expect(result.count == 1, "one task derived")
        expect(result.first?.title == "Search web", "task comes from planner state")
    }

    static func deduplicatesByTaskId() {
        let id = UUID()
        let first = makeTask(id: id, title: "v1", state: .pending, priority: .low)
        let updated = makeTask(id: id, title: "v2", state: .inProgress, priority: .low)
        let messages = [message(with: first), message(with: updated)]
        let result = TodoListProjection.tasks(from: messages)
        expect(result.count == 1, "same task id de-duplicated")
        expect(result.first?.title == "v1", "first occurrence retained")
    }

    static func ordersOpenBeforeFinished() {
        let done = makeTask(title: "done", state: .completed, priority: .critical)
        let open = makeTask(title: "open", state: .inProgress, priority: .low)
        let messages = [message(with: done), message(with: open)]
        let result = TodoListProjection.tasks(from: messages)
        expect(result.first?.title == "open", "open tasks precede finished ones")
        expect(result.last?.title == "done", "finished task sinks to the bottom")
    }

    static func countsOpenTasks() {
        let messages = [
            message(with: makeTask(title: "a", state: .pending, priority: .medium)),
            message(with: makeTask(title: "b", state: .completed, priority: .medium)),
            message(with: makeTask(title: "c", state: .inProgress, priority: .high))
        ]
        expect(TodoListProjection.openCount(from: messages) == 2, "two tasks remain open")
    }

    // MARK: - Helpers

    static func makeTask(
        id: UUID = UUID(),
        title: String,
        state: AgentTaskState,
        priority: AgentTaskPriority
    ) -> AgentTask {
        AgentTask(
            id: id,
            title: title,
            description: "desc",
            state: state,
            priority: priority,
            assignee: AgentId("trios-agent"),
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z"
        )
    }

    static func message(with task: AgentTask) -> ChatMessage {
        ChatMessage(role: .assistant, content: task.title, task: task)
    }

    static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
