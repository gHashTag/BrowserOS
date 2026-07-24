// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: AGENT-MEMORY-TODO-001 requires a persisted per-conversation plan.
// Follow-up: seal against .trinity/specs/agent-memory-todo-planner.md.

import Combine
import Foundation

enum TODOPlanState: String, Codable, Sendable, Equatable {
    case active
    case completed
    case cancelled
    case failed
}

enum TODOItemState: String, Codable, Sendable, Equatable {
    case pending
    case inProgress
    case completed
    case cancelled
    case failed
}

struct TODOItem: Identifiable, Codable, Sendable, Equatable {
    let id: UUID
    var title: String
    var detail: String?
    var state: TODOItemState
    var order: Int

    init(
        id: UUID = UUID(),
        title: String,
        detail: String? = nil,
        state: TODOItemState = .pending,
        order: Int
    ) {
        self.id = id
        self.title = title
        self.detail = detail
        self.state = state
        self.order = order
    }
}

struct TODOPlan: Identifiable, Codable, Sendable, Equatable {
    let id: UUID
    let conversationId: UUID
    var goal: String
    var state: TODOPlanState
    var items: [TODOItem]
    let createdAt: Date
    var updatedAt: Date

    init(
        id: UUID = UUID(),
        conversationId: UUID,
        goal: String,
        state: TODOPlanState = .active,
        items: [TODOItem],
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.conversationId = conversationId
        self.goal = goal
        self.state = state
        self.items = items
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    var progress: Double {
        guard !items.isEmpty else {
            return state == .completed ? 1 : 0
        }
        let completedCount = items.lazy.filter { $0.state == .completed }.count
        return Double(completedCount) / Double(items.count)
    }
}

@MainActor
final class TODOPlanner: ObservableObject {
    @Published private(set) var activePlan: TODOPlan?
    @Published private(set) var persistenceWarning: String?
    @Published var isCollapsed: Bool {
        didSet {
            preferences.set(isCollapsed, forKey: Self.collapsedPreferenceKey)
        }
    }

    private static let collapsedPreferenceKey = "trios.todoPlanner.isCollapsed"

    private let store: AgentMemoryStoreProtocol
    private let preferences: UserDefaults

    init(store: AgentMemoryStoreProtocol, preferences: UserDefaults) {
        self.store = store
        self.preferences = preferences
        self.isCollapsed = preferences.bool(forKey: Self.collapsedPreferenceKey)
    }

    func load(conversationId: UUID) async {
        do {
            var plan = try await store.loadPlan(conversationId: conversationId)
            plan?.items.sort { lhs, rhs in
                if lhs.order == rhs.order {
                    return lhs.id.uuidString < rhs.id.uuidString
                }
                return lhs.order < rhs.order
            }
            activePlan = plan
            persistenceWarning = nil
        } catch {
            activePlan = nil
            reportPersistenceFailure(error)
        }
    }

    func startPlan(conversationId: UUID, goal: String) async {
        let normalizedGoal = normalizedText(goal, fallback: "New request")
        let now = Date()
        let plan = TODOPlan(
            conversationId: conversationId,
            goal: normalizedGoal,
            items: [
                TODOItem(
                    title: "Understand request",
                    detail: "Preparing request",
                    state: .inProgress,
                    order: 0
                ),
                TODOItem(
                    title: "Execute task",
                    state: .pending,
                    order: 1
                ),
                TODOItem(
                    title: "Verify result",
                    state: .pending,
                    order: 2
                )
            ],
            createdAt: now,
            updatedAt: now
        )
        activePlan = plan
        await persist(plan)
    }

    func markExecutionStarted(detail: String? = nil) async {
        await mutatePlan { plan in
            guard plan.state == .active else {
                return
            }
            if !plan.items.isEmpty {
                plan.items[0].state = .completed
            }
            guard let index = plan.items.indices.first(where: {
                plan.items[$0].order == 1
            }) else {
                return
            }
            plan.items[index].state = .inProgress
            if let detail {
                let normalized = self.normalizedOptionalText(detail)
                if normalized != nil {
                    plan.items[index].detail = normalized
                }
            }
        }
    }

    func markToolActivity(name: String) async {
        let toolName = normalizedText(name, fallback: "tool")
        await markExecutionStarted(detail: "Using \(toolName)")
    }

    func completePlan() async {
        await mutatePlan { plan in
            for index in plan.items.indices
            where plan.items[index].order <= 2 {
                plan.items[index].state = .completed
            }
            self.finishIfComplete(&plan)
        }
    }

    func cancelPlan() async {
        await mutatePlan { plan in
            guard plan.state == .active else {
                return
            }
            if let index = self.currentItemIndex(in: plan) {
                plan.items[index].state = .cancelled
                plan.items[index].detail = "Cancelled"
            }
            plan.state = .cancelled
        }
    }

    func failPlan(message: String) async {
        let failureMessage = normalizedText(message, fallback: "Execution failed")
        await mutatePlan { plan in
            guard plan.state == .active else {
                return
            }
            if let index = self.currentItemIndex(in: plan) {
                plan.items[index].state = .failed
                plan.items[index].detail = failureMessage
            }
            plan.state = .failed
        }
    }

    func addTask(title: String) async {
        let taskTitle = normalizedText(title, fallback: "New task")
        await mutatePlan { plan in
            let nextOrder = (plan.items.map(\.order).max() ?? -1) + 1
            let hasCurrentItem = plan.items.contains { $0.state == .inProgress }
            plan.items.append(
                TODOItem(
                    title: taskTitle,
                    state: hasCurrentItem ? .pending : .inProgress,
                    order: nextOrder
                )
            )
            plan.state = .active
        }
    }

    func toggleTask(id: UUID) async {
        await mutatePlan { plan in
            guard let index = plan.items.firstIndex(where: { $0.id == id }) else {
                return
            }

            if plan.items[index].state == .completed {
                plan.items[index].state = .pending
                plan.state = .active
                return
            }

            let wasCurrent = plan.items[index].state == .inProgress
            plan.items[index].state = .completed
            plan.items[index].detail = nil

            if wasCurrent,
               let next = self.firstPendingItemIndex(in: plan) {
                plan.items[next].state = .inProgress
            }
            self.finishIfComplete(&plan)
        }
    }

    func completeCurrentTask() async {
        await mutatePlan { plan in
            guard let index = self.currentItemIndex(in: plan) else {
                self.finishIfComplete(&plan)
                return
            }
            plan.items[index].state = .completed
            plan.items[index].detail = nil

            if let next = self.firstPendingItemIndex(in: plan) {
                plan.items[next].state = .inProgress
            }
            self.finishIfComplete(&plan)
        }
    }

    func retryCurrentTask() async {
        await mutatePlan { plan in
            let retryable = plan.items.indices
                .filter {
                    plan.items[$0].state == .failed
                        || plan.items[$0].state == .cancelled
                }
                .sorted {
                    plan.items[$0].order < plan.items[$1].order
                }
                .first
            guard let index = retryable else {
                return
            }

            for activeIndex in plan.items.indices
            where plan.items[activeIndex].state == .inProgress {
                plan.items[activeIndex].state = .pending
            }
            plan.items[index].state = .inProgress
            plan.items[index].detail = "Retrying"
            plan.state = .active
        }
    }

    func clearPlan() async {
        guard let conversationId = activePlan?.conversationId else {
            return
        }
        do {
            try await store.deletePlan(conversationId: conversationId)
            activePlan = nil
            persistenceWarning = nil
        } catch {
            reportPersistenceFailure(error)
        }
    }

    func deleteConversationData(conversationId: UUID) async throws {
        do {
            try await store.deleteConversationData(
                conversationId: conversationId
            )
            if activePlan?.conversationId == conversationId {
                activePlan = nil
            }
            persistenceWarning = nil
        } catch {
            reportPersistenceFailure(error)
            throw error
        }
    }

    private func mutatePlan(_ mutation: (inout TODOPlan) -> Void) async {
        guard var plan = activePlan else {
            return
        }
        mutation(&plan)
        plan.items.sort { lhs, rhs in
            if lhs.order == rhs.order {
                return lhs.id.uuidString < rhs.id.uuidString
            }
            return lhs.order < rhs.order
        }
        plan.updatedAt = Date()
        activePlan = plan
        await persist(plan)
    }

    private func persist(_ plan: TODOPlan) async {
        do {
            try await store.savePlan(plan)
            persistenceWarning = nil
        } catch {
            reportPersistenceFailure(error)
        }
    }

    private func currentItemIndex(in plan: TODOPlan) -> Int? {
        if let current = plan.items.indices.first(where: {
            plan.items[$0].state == .inProgress
        }) {
            return current
        }
        return firstPendingItemIndex(in: plan)
    }

    private func firstPendingItemIndex(in plan: TODOPlan) -> Int? {
        plan.items.indices
            .filter { plan.items[$0].state == .pending }
            .min { plan.items[$0].order < plan.items[$1].order }
    }

    private func finishIfComplete(_ plan: inout TODOPlan) {
        if plan.items.allSatisfy({ $0.state == .completed }) {
            plan.state = .completed
        } else if plan.state == .completed {
            plan.state = .active
        }
    }

    private func reportPersistenceFailure(_ error: Error) {
        persistenceWarning = "Planner storage unavailable: \(error.localizedDescription)"
        NSLog("[TODOPlanner] %@", persistenceWarning ?? "storage unavailable")
    }

    private func normalizedText(_ value: String, fallback: String) -> String {
        normalizedOptionalText(value) ?? fallback
    }

    private func normalizedOptionalText(_ value: String) -> String? {
        let normalized = value
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return normalized.isEmpty ? nil : String(normalized.prefix(240))
    }
}
