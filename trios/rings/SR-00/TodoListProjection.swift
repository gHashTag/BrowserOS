import Foundation

/// Projects the live TODO list from the conversation's real planner state.
///
/// The single source of truth for tasks is the `AgentTask` carried on each
/// `ChatMessage`; those tasks originate from the A2A planner and are persisted
/// with the conversation. This projection derives the checklist purely from that
/// state so the UI never renders hardcoded or demo fixtures.
enum TodoListProjection {
    /// Ordered, de-duplicated tasks drawn from message planner state.
    ///
    /// Ordering keeps actionable work first: unfinished tasks (by descending
    /// priority) precede finished ones, with most-recent updates breaking ties.
    static func tasks(from messages: [ChatMessage]) -> [AgentTask] {
        var seen = Set<UUID>()
        var collected: [AgentTask] = []
        for message in messages {
            guard let task = message.task, !seen.contains(task.id) else { continue }
            seen.insert(task.id)
            collected.append(task)
        }

        return collected.sorted { lhs, rhs in
            if lhs.isFinished != rhs.isFinished {
                return !lhs.isFinished
            }
            if lhs.priority != rhs.priority {
                return lhs.priority > rhs.priority
            }
            return lhs.updatedAt > rhs.updatedAt
        }
    }

    /// Count of tasks that still require attention.
    static func openCount(from messages: [ChatMessage]) -> Int {
        tasks(from: messages).filter { !$0.isFinished }.count
    }
}

extension AgentTask {
    /// A task is finished once it reaches a terminal state and no longer belongs
    /// in the actionable portion of the checklist.
    var isFinished: Bool {
        switch state {
        case .completed, .failed, .cancelled:
            return true
        case .pending, .assigned, .inProgress:
            return false
        }
    }
}
