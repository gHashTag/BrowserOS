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
    /// Added by the user rather than derived from the agent's work.
    ///
    /// The agent finishing its turn says nothing about a task the user typed,
    /// so `completePlan` must leave these alone. Decoded with a default so
    /// plans persisted before this flag existed still load.
    var isUserAdded: Bool = false

    init(
        id: UUID = UUID(),
        title: String,
        detail: String? = nil,
        state: TODOItemState = .pending,
        order: Int,
        isUserAdded: Bool = false
    ) {
        self.id = id
        self.title = title
        self.detail = detail
        self.state = state
        self.order = order
        self.isUserAdded = isUserAdded
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
    /// Newest plan awaiting a coalesced write.
    private var pendingFlush: TODOPlan?
    private var lastPersistAt: Date?
    private var flushTask: Task<Void, Never>?

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

    /// Opens a plan for a turn.
    ///
    /// Starts with the single step we can honestly claim is happening. Further
    /// steps are appended by `beginStep`/`markToolActivity` as the agent works,
    /// so the list length reflects the real work rather than a fixed template.
    /// A turn that never does anything beyond answering stays at one step, and
    /// the view hides a plan that short.
    func startPlan(conversationId: UUID, goal: String, steps: [String] = []) async {
        let normalizedGoal = normalizedText(goal, fallback: "New request")
        let now = Date()
        var items: [TODOItem] = [
            TODOItem(
                title: TODOPlanDeriver.title(for: .preparing),
                detail: "Preparing request",
                state: .inProgress,
                order: 0
            )
        ]
        // A caller that already knows the shape of the work can seed it.
        for (offset, step) in steps.enumerated() {
            guard let title = normalizedOptionalText(step) else { continue }
            items.append(TODOItem(title: title, state: .pending, order: offset + 1))
        }
        let plan = TODOPlan(
            conversationId: conversationId,
            goal: normalizedGoal,
            items: items,
            createdAt: now,
            updatedAt: now
        )
        activePlan = plan
        await persist(plan)
    }

    /// True when the plan describes enough work to be worth showing.
    /// Single-step turns render as plain chat instead of an empty skeleton.
    var shouldDisplayPlan: Bool {
        guard let plan = activePlan else { return false }
        return PlanDisplayPolicy.shouldDisplay(
            stepCount: plan.items.count,
            isTerminalFailure: plan.state == .failed || plan.state == .cancelled
        )
    }

    func markExecutionStarted(detail: String? = nil) async {
        await mutatePlan { plan in
            guard plan.state == .active else {
                return
            }
            // Advance to whichever item is actually next. The previous version
            // hardcoded order 0 and order 1, which only worked for the fixed
            // three-step plan and silently did nothing once plans became
            // dynamic.
            if let currentIndex = plan.items.indices.first(where: {
                plan.items[$0].state == .inProgress
            }) {
                if let detail, let normalized = self.normalizedOptionalText(detail) {
                    plan.items[currentIndex].detail = normalized
                }
                return
            }
            guard let next = self.firstPendingItemIndex(in: plan) else { return }
            plan.items[next].state = .inProgress
            if let detail, let normalized = self.normalizedOptionalText(detail) {
                plan.items[next].detail = normalized
            }
        }
    }

    /// Records an observed tool call as a plan step.
    ///
    /// Steps are derived from what the agent actually does. Consecutive uses of
    /// the same activity update the current step instead of appending a
    /// duplicate row, so reading six files reads as one "Read files" step.
    func markToolActivity(name: String, arguments: String? = nil) async {
        // Name the actual target when the arguments carry one. A plan of
        // category labels ("Read files") describes nothing the user could not
        // have guessed; "Read ChatPanelView.swift" is the work.
        let generic = TODOPlanDeriver.title(forTool: name)
        let title = PlanStepNaming.title(
            toolName: name,
            argumentsJSON: arguments,
            generic: generic
        )
        await beginStep(title: title, detail: "Using \(normalizedText(name, fallback: "tool"))")
    }

    /// Renames the running step once a tool's arguments have finished streaming.
    ///
    /// A tool call is announced before its arguments arrive, so the step is born
    /// with a category name and earns a specific one a moment later. Only the
    /// still-generic title is replaced: a step the user already saw named after
    /// a concrete target is not renamed again.
    func refineStepTitle(toolName: String, arguments: String?) async {
        let generic = TODOPlanDeriver.title(forTool: toolName)
        let specific = PlanStepNaming.title(
            toolName: toolName,
            argumentsJSON: arguments,
            generic: generic
        )
        guard specific != generic else { return }
        await mutatePlan { plan in
            guard let index = plan.items.indices.first(where: {
                plan.items[$0].state == .inProgress && plan.items[$0].title == generic
            }) else { return }
            plan.items[index].title = specific
        }
    }

    /// Completes the current step and starts a named one, appending it when the
    /// plan has not seen it yet. This is what makes the list grow with the work.
    func beginStep(title: String, detail: String? = nil) async {
        let stepTitle = normalizedText(title, fallback: "Step")
        let stepDetail = detail.flatMap { normalizedOptionalText($0) }
        await mutatePlan { plan in
            guard plan.state == .active else { return }

            // Already the active step: just refresh its detail.
            if let currentIndex = plan.items.indices.first(where: {
                plan.items[$0].state == .inProgress
            }) {
                if plan.items[currentIndex].title == stepTitle {
                    plan.items[currentIndex].detail = stepDetail
                    return
                }
                plan.items[currentIndex].state = .completed
                plan.items[currentIndex].detail = nil
            }

            // Reuse a pending step with this title if the plan predicted it.
            if let pending = plan.items.indices.first(where: {
                plan.items[$0].title == stepTitle && plan.items[$0].state == .pending
            }) {
                plan.items[pending].state = .inProgress
                plan.items[pending].detail = stepDetail
                return
            }

            let nextOrder = (plan.items.map(\.order).max() ?? -1) + 1
            plan.items.append(
                TODOItem(
                    title: stepTitle,
                    detail: stepDetail,
                    state: .inProgress,
                    order: nextOrder
                )
            )
        }
    }

    func completePlan() async {
        await mutatePlan { plan in
            // Complete every step, however many there are. The old version only
            // touched orders 0-2 and left later steps stuck in progress.
            // Complete the agent's own steps, however many there are, but never
            // a task the user typed: the stream finishing is not evidence that
            // the user's follow-up is done.
            for index in plan.items.indices where plan.items[index].state != .cancelled
                && plan.items[index].state != .failed
                && !plan.items[index].isUserAdded {
                plan.items[index].state = .completed
                plan.items[index].detail = nil
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
                    order: nextOrder,
                    isUserAdded: true
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

    /// Upper bound on steps in one plan. Overflow is folded into a counted
    /// summary by `PlanOverflow`, which is unit-tested in SR-00.
    static let maximumSteps = 12

    private func coalesceOverflow(_ plan: inout TODOPlan) {
        let steps = plan.items.map {
            PlanStep(
                id: $0.id,
                title: $0.title,
                detail: $0.detail,
                state: PlanStepState(rawValue: $0.state.rawValue) ?? .pending,
                order: $0.order
            )
        }
        let folded = PlanOverflow.coalesce(steps, maximum: Self.maximumSteps)
        guard folded.count != steps.count else { return }
        plan.items = folded.map { step in
            TODOItem(
                id: step.id,
                title: step.title,
                detail: step.detail,
                state: TODOItemState(rawValue: step.state.rawValue) ?? .pending,
                order: step.order
            )
        }
    }

    private func mutatePlan(_ mutation: (inout TODOPlan) -> Void) async {
        guard var plan = activePlan else {
            return
        }
        mutation(&plan)
        coalesceOverflow(&plan)
        plan.items.sort { lhs, rhs in
            if lhs.order == rhs.order {
                return lhs.id.uuidString < rhs.id.uuidString
            }
            return lhs.order < rhs.order
        }
        plan.updatedAt = Date()
        activePlan = plan

        // The in-memory plan is authoritative for the UI. Persisting every step
        // wrote to the encrypted database once per tool call; flush on terminal
        // states and otherwise no more than once per interval.
        let now = Date()
        let terminal = plan.state != .active
        guard PlanPersistPolicy.shouldWriteNow(
            isTerminal: terminal,
            lastWrite: lastPersistAt,
            now: now
        ) else {
            pendingFlush = plan
            scheduleFlush()
            return
        }
        pendingFlush = nil
        lastPersistAt = now
        await persist(plan)
    }

    private func scheduleFlush() {
        guard flushTask == nil else { return }
        flushTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(PlanPersistPolicy.interval * 1_000_000_000))
            guard let self else { return }
            self.flushTask = nil
            await self.flushPendingPlan()
        }
    }

    /// Writes the newest coalesced plan, if any. Also called on teardown so a
    /// quiet period never loses the last transition.
    func flushPendingPlan() async {
        guard let plan = pendingFlush else { return }
        pendingFlush = nil
        lastPersistAt = Date()
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
