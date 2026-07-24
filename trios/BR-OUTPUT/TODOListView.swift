// AGENT-V-WAIVER: AGENT-MEMORY-TODO-001
// Reason: Spec-controlled planner presentation for the primary chat surface.
// Follow-up: seal against .trinity/specs/agent-memory-todo-planner.md.
import SwiftUI

@MainActor
struct TODOListView: View {
    @ObservedObject private var planner: TODOPlanner
    let conversationId: UUID
    let memoryControlRevision: UInt64
    let isExpanded: Bool
    let recalledMemories: [AgentMemoryMatch]
    let onSearchMemory: (String) async -> [AgentMemoryMatch]
    let onLoadRecentMemory: (Int) async throws -> [AgentMemoryMatch]
    let onForgetMemory: (UUID) async throws -> Bool
    let onClearConversationMemory: (UUID) async throws -> Int

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focusTarget: PlannerFocusTarget?

    @State private var isCollapsed: Bool
    @State private var showsMemoryDrawer = false
    @State private var taskDraft = ""
    @State private var memoryQuery = ""
    @State private var memoryResults: [AgentMemoryMatch] = []
    @State private var didSearchMemory = false
    @State private var didLoadRecentMemory = false
    @State private var isSearchingMemory = false
    @State private var isLoadingRecentMemory = false
    @State private var isMutatingMemory = false
    @State private var memoryActionError: String?
    @State private var memoryActionReceipt: String?
    @State private var pendingMemoryConfirmation: MemoryConfirmation?
    @State private var memorySearchGeneration = UUID()
    @State private var memoryMutationGeneration = UUID()

    init(
        planner: TODOPlanner,
        conversationId: UUID,
        memoryControlRevision: UInt64,
        isExpanded: Bool,
        recalledMemories: [AgentMemoryMatch],
        onSearchMemory: @escaping (String) async -> [AgentMemoryMatch],
        onLoadRecentMemory: @escaping (Int) async throws -> [AgentMemoryMatch],
        onForgetMemory: @escaping (UUID) async throws -> Bool,
        onClearConversationMemory: @escaping (UUID) async throws -> Int
    ) {
        self.planner = planner
        self.conversationId = conversationId
        self.memoryControlRevision = memoryControlRevision
        self.isExpanded = isExpanded
        self.recalledMemories = recalledMemories
        self.onSearchMemory = onSearchMemory
        self.onLoadRecentMemory = onLoadRecentMemory
        self.onForgetMemory = onForgetMemory
        self.onClearConversationMemory = onClearConversationMemory
        _isCollapsed = State(initialValue: planner.isCollapsed)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            progressBar

            if !isCollapsed {
                expandedContent
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(
                    focusTarget == nil
                        ? Color.clear
                        : Color.white.opacity(0.72),
                    lineWidth: 1.5
                )
        }
        .todoActiveGlow(isActive: planner.activePlan?.state == .active)
        .shadow(color: .triosGlassShadow, radius: 18, y: 8)
        .focusable()
        .focused($focusTarget, equals: .card)
        .focusEffectDisabled()
        .onKeyPress("t", phases: .down, action: handleAddTaskShortcut)
        .onKeyPress(.return, phases: .down, action: handleCompleteShortcut)
        .onChange(of: conversationId) {
            handleConversationChange()
        }
        .onChange(of: memoryControlRevision) {
            handleMemoryControlRevisionChange()
        }
        .confirmationDialog(
            memoryConfirmationTitle,
            isPresented: memoryConfirmationIsPresented,
            titleVisibility: .visible,
            presenting: pendingMemoryConfirmation
        ) { confirmation in
            Button(confirmation.actionTitle, role: .destructive) {
                performMemoryConfirmation(confirmation)
            }
            Button("Cancel", role: .cancel) {
                pendingMemoryConfirmation = nil
            }
        } message: { confirmation in
            Text(confirmation.message)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Execution planner")
        .accessibilityValue(cardAccessibilityValue)
        .accessibilityHint(
            "Focus this card to use Command T for a new task or Command Return to complete the current task."
        )
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button(action: toggleCollapsed) {
                Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundColor(.grokMuted)
            .accessibilityLabel(isCollapsed ? "Expand execution planner" : "Collapse execution planner")
            .accessibilityValue(isCollapsed ? "Collapsed" : "Expanded")

            Image(systemName: planStatus.icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(planStatus.color)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(goalText)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.grokText)
                    .lineLimit(1)

                HStack(spacing: 5) {
                    Text(planStatus.label)
                        .foregroundColor(planStatus.color)
                    Text("|\(completedCount)/\(totalCount) done")
                        .foregroundColor(.grokDim)
                }
                .font(.system(size: 10, weight: .medium))
            }

            Spacer(minLength: 8)

            Text("\(progressPercent)%")
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundColor(.grokText)
                .accessibilityLabel("Plan progress")
                .accessibilityValue("\(progressPercent) percent")

            Button {
                let willShowMemoryDrawer = !showsMemoryDrawer
                withOptionalMotion {
                    showsMemoryDrawer = willShowMemoryDrawer
                    if willShowMemoryDrawer {
                        isCollapsed = false
                        planner.isCollapsed = false
                    }
                }
                if willShowMemoryDrawer {
                    loadRecentMemory()
                }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "memorychip")
                    Text("\(recalledMemories.count)")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                }
                .padding(.horizontal, 8)
                .frame(height: 24)
                .background(Color.black.opacity(0.34))
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .foregroundColor(showsMemoryDrawer ? .grokText : .grokMuted)
            .accessibilityLabel(showsMemoryDrawer ? "Hide memory drawer" : "Show memory drawer")
            .accessibilityValue("\(recalledMemories.count) recalled memories")
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 10)
    }

    private var progressBar: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.white.opacity(0.08))

                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [Color.white.opacity(0.78), Color.white.opacity(0.42)],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(width: geometry.size.width * planProgress)
            }
        }
        .frame(height: 3)
        .todoProgressAnimation(value: planProgress)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Plan progress")
        .accessibilityValue("\(progressPercent) percent, \(completedCount) of \(totalCount) tasks complete")
    }

    private var expandedContent: some View {
        VStack(spacing: 10) {
            if let warning = planner.persistenceWarning {
                Label(warning, systemImage: "externaldrive.badge.exclamationmark")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Planner storage warning")
                    .accessibilityValue(warning)
            }

            if let plan = planner.activePlan {
                taskList(plan.items)
                taskEntry
                actionBar(plan: plan)
            } else {
                emptyPlan
            }

            if showsMemoryDrawer {
                Divider()
                    .overlay(Color.grokDivider)
                memoryDrawer
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(12)
    }

    private func taskList(_ items: [TODOItem]) -> some View {
        VStack(spacing: 6) {
            ForEach(items.sorted(by: taskSort)) { item in
                taskRow(item)
                    .id(item.id)
                    .todoInsertionEffect()
                    .todoCompletionEffect(isComplete: item.state == .completed)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Plan tasks")
    }

    private func taskRow(_ item: TODOItem) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Button {
                Task {
                    await planner.toggleTask(id: item.id)
                }
            } label: {
                Image(systemName: itemStatus(item.state).icon)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(itemStatus(item.state).color)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Toggle task \(item.title)")
            .accessibilityValue(itemStatus(item.state).label)
            .accessibilityHint("Marks this task complete or pending")

            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(item.title)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(item.state == .completed ? .grokMuted : .grokText)
                        .strikethrough(item.state == .completed, color: .grokMuted)
                        .lineLimit(2)

                    Spacer(minLength: 6)

                    Text(itemStatus(item.state).label)
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(itemStatus(item.state).color)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(itemStatus(item.state).color.opacity(0.10))
                        .clipShape(Capsule())
                }

                if let detail = item.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: 10))
                        .foregroundColor(.grokDim)
                        .lineLimit(2)
                }
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .background(Color.black.opacity(item.state == .inProgress ? 0.34 : 0.22))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(
                    item.state == .inProgress
                        ? Color.white.opacity(0.15)
                        : Color.white.opacity(0.06),
                    lineWidth: 1
                )
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Task \(item.order + 1), \(item.title)")
        .accessibilityValue(itemStatus(item.state).label)
    }

    private var taskEntry: some View {
        HStack(spacing: 8) {
            Image(systemName: "plus")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(.grokMuted)
                .accessibilityHidden(true)

            TextField("Add a task", text: $taskDraft)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .foregroundColor(.grokText)
                .focused($focusTarget, equals: .taskEntry)
                .onSubmit(addTask)
                .onKeyPress("t", phases: .down, action: handleAddTaskShortcut)
                .onKeyPress(.return, phases: .down, action: handleCompleteShortcut)
                .accessibilityLabel("New task title")
                .accessibilityHint("Press Return to add the task")

            Button(action: addTask) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 10, weight: .bold))
                    .frame(width: 24, height: 24)
                    .background(Color.white.opacity(canAddTask ? 0.90 : 0.08))
                    .foregroundColor(canAddTask ? .black : .grokDim)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canAddTask)
            .accessibilityLabel("Add task")
            .accessibilityValue(canAddTask ? "Ready" : "Task title is empty")
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .background(Color.black.opacity(0.28))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        }
    }

    private func actionBar(plan: TODOPlan) -> some View {
        HStack(spacing: 7) {
            Button {
                Task {
                    await planner.completeCurrentTask()
                }
            } label: {
                TODOActionLabel(icon: "checkmark", title: "Complete")
            }
            .buttonStyle(.plain)
            .disabled(plan.state != .active || currentCompletableItem(in: plan) == nil)
            .opacity(plan.state == .active && currentCompletableItem(in: plan) != nil ? 1 : 0.42)
            .accessibilityLabel("Complete current task")
            .accessibilityValue(currentCompletableItem(in: plan)?.title ?? "No current task")

            if canRetry(plan) {
                Button {
                    Task {
                        await planner.retryCurrentTask()
                    }
                } label: {
                    TODOActionLabel(icon: "arrow.clockwise", title: "Retry")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Retry current task")
                .accessibilityValue("Available")
            }

            Spacer()

            Button {
                Task {
                    await planner.clearPlan()
                }
            } label: {
                TODOActionLabel(icon: "trash", title: "Clear", isDestructive: true)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Clear execution plan")
            .accessibilityValue("Current plan and its tasks will be removed")
            .accessibilityHint("Removes the current plan and its tasks")
        }
    }

    private var emptyPlan: some View {
        HStack(spacing: 9) {
            Image(systemName: "list.bullet.clipboard")
                .foregroundColor(.grokMuted)
            VStack(alignment: .leading, spacing: 2) {
                Text("No active plan")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.grokText)
                Text("A plan appears before the next request starts.")
                    .font(.system(size: 10))
                    .foregroundColor(.grokDim)
            }
            Spacer()
        }
        .padding(10)
        .background(Color.black.opacity(0.22))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("No active plan. A plan appears before the next request starts.")
    }

    private var memoryDrawer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "memorychip")
                    .foregroundColor(.grokMuted)
                Text("Memory")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.grokText)
                Spacer()
                Text("\(displayedMemories.count) shown")
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundColor(.grokDim)

                Button {
                    pendingMemoryConfirmation = .clearConversation
                } label: {
                    Label("Clear task", systemImage: "trash")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(.red.opacity(0.84))
                        .padding(.horizontal, 7)
                        .frame(height: 23)
                        .background(Color.black.opacity(0.26))
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(isMutatingMemory)
                .opacity(isMutatingMemory ? 0.42 : 1)
                .accessibilityLabel("Clear memory for this task")
                .accessibilityHint("Requires confirmation and keeps the task messages and execution plan")
            }

            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11))
                    .foregroundColor(.grokMuted)
                    .accessibilityHidden(true)

                TextField("Search saved memory", text: $memoryQuery)
                    .textFieldStyle(.plain)
                    .font(.system(size: 11))
                    .foregroundColor(.grokText)
                    .focused($focusTarget, equals: .memoryQuery)
                    .onSubmit(searchMemory)
                    .onKeyPress("t", phases: .down, action: handleAddTaskShortcut)
                    .onKeyPress(.return, phases: .down, action: handleCompleteShortcut)
                    .accessibilityLabel("Memory search query")
                    .accessibilityHint("Press Return to search saved memory")

                if isSearchingMemory {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Searching saved memory")
                } else {
                    Button(action: searchMemory) {
                        Text("Search")
                            .font(.system(size: 10, weight: .semibold))
                            .padding(.horizontal, 8)
                            .frame(height: 24)
                            .background(Color.white.opacity(canSearchMemory ? 0.88 : 0.08))
                            .foregroundColor(canSearchMemory ? .black : .grokDim)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSearchMemory)
                    .accessibilityLabel("Search saved memory")
                    .accessibilityValue(canSearchMemory ? "Ready" : "Query is empty")
                }
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .background(Color.black.opacity(0.28))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

            if let memoryActionError {
                Label(memoryActionError, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.red.opacity(0.88))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Memory action failed")
                    .accessibilityValue(memoryActionError)
            } else if let memoryActionReceipt {
                Label(memoryActionReceipt, systemImage: "checkmark.circle.fill")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.green.opacity(0.88))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Memory action completed")
                    .accessibilityValue(memoryActionReceipt)
            }

            if isLoadingRecentMemory {
                HStack(spacing: 7) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading saved memory...")
                        .font(.system(size: 10))
                        .foregroundColor(.grokDim)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Loading saved memory")
            } else if displayedMemories.isEmpty {
                Text(memoryEmptyMessage)
                    .font(.system(size: 10))
                    .foregroundColor(.grokDim)
                    .padding(.vertical, 4)
                    .accessibilityLabel(memoryEmptyMessage)
            } else {
                ScrollView {
                    LazyVStack(spacing: 5) {
                        ForEach(Array(displayedMemories.prefix(32))) { match in
                            memoryResult(match)
                        }
                    }
                }
                .frame(maxHeight: isExpanded ? 280 : 180)
                .accessibilityLabel("Saved memories")
            }
        }
    }

    private func memoryResult(_ match: AgentMemoryMatch) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(match.record.displayBody)
                    .font(.system(size: 10))
                    .foregroundColor(.grokText.opacity(0.90))
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)

                HStack {
                    Text(match.record.createdAt, style: .relative)
                        .accessibilityLabel(
                            "Saved \(match.record.createdAt.formatted(date: .abbreviated, time: .shortened))"
                        )
                    Spacer()
                    if didSearchMemory {
                        Text("\(memoryScorePercent(match))% match")
                    } else {
                        Text("Saved")
                    }
                }
                .font(.system(size: 8, weight: .medium, design: .monospaced))
                .foregroundColor(.grokDim)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Saved memory: \(match.record.displayBody)")
            .accessibilityValue(memoryResultAccessibilityValue(match))

            Button {
                pendingMemoryConfirmation = .forget(match)
            } label: {
                Label("Forget", systemImage: "trash")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(.red.opacity(0.82))
                    .padding(.horizontal, 7)
                    .frame(height: 23)
                    .background(Color.black.opacity(0.26))
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(isMutatingMemory)
            .opacity(isMutatingMemory ? 0.42 : 1)
            .accessibilityLabel("Forget saved memory")
            .accessibilityValue(match.record.displayBody)
            .accessibilityHint("Requires confirmation before this memory is removed")
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .background(Color.black.opacity(0.22))
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private var cardBackground: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(.ultraThinMaterial)
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.grokSurface)
            LinearGradient(
                colors: [Color.white.opacity(0.035), .clear, Color.black.opacity(0.12)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }

    private var goalText: String {
        guard let goal = planner.activePlan?.goal, !goal.isEmpty else {
            return "Execution plan"
        }
        return goal
    }

    private var completedCount: Int {
        planner.activePlan?.items.filter { $0.state == .completed }.count ?? 0
    }

    private var totalCount: Int {
        planner.activePlan?.items.count ?? 0
    }

    private var planProgress: Double {
        max(0, min(planner.activePlan?.progress ?? 0, 1))
    }

    private var progressPercent: Int {
        Int((planProgress * 100).rounded())
    }

    private var planStatus: PlannerStatusPresentation {
        guard let state = planner.activePlan?.state else {
            return PlannerStatusPresentation(label: "Idle", icon: "circle.dashed", color: .grokMuted)
        }
        switch state {
        case .active:
            return PlannerStatusPresentation(label: "Active", icon: "bolt.horizontal.circle", color: .white)
        case .completed:
            return PlannerStatusPresentation(label: "Completed", icon: "checkmark.circle.fill", color: .green)
        case .cancelled:
            return PlannerStatusPresentation(label: "Cancelled", icon: "xmark.circle.fill", color: .orange)
        case .failed:
            return PlannerStatusPresentation(
                label: "Failed",
                icon: "exclamationmark.triangle.fill",
                color: .red
            )
        }
    }

    private func itemStatus(_ state: TODOItemState) -> PlannerStatusPresentation {
        switch state {
        case .pending:
            return PlannerStatusPresentation(label: "Pending", icon: "circle", color: .grokMuted)
        case .inProgress:
            return PlannerStatusPresentation(label: "In progress", icon: "circle.dotted", color: .white)
        case .completed:
            return PlannerStatusPresentation(label: "Done", icon: "checkmark.circle.fill", color: .green)
        case .cancelled:
            return PlannerStatusPresentation(label: "Cancelled", icon: "xmark.circle.fill", color: .orange)
        case .failed:
            return PlannerStatusPresentation(
                label: "Failed",
                icon: "exclamationmark.triangle.fill",
                color: .red
            )
        }
    }

    private var displayedMemories: [AgentMemoryMatch] {
        if didSearchMemory || didLoadRecentMemory {
            return memoryResults
        }
        return recalledMemories
    }

    private var memoryEmptyMessage: String {
        if didSearchMemory {
            return "No matching memories."
        }
        if didLoadRecentMemory {
            return "No saved memories yet."
        }
        return "No recalled memories for this request."
    }

    private var memoryConfirmationIsPresented: Binding<Bool> {
        Binding(
            get: { pendingMemoryConfirmation != nil },
            set: { isPresented in
                if !isPresented {
                    pendingMemoryConfirmation = nil
                }
            }
        )
    }

    private var memoryConfirmationTitle: String {
        pendingMemoryConfirmation?.title ?? "Confirm memory action"
    }

    private var canAddTask: Bool {
        !taskDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canSearchMemory: Bool {
        !memoryQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isSearchingMemory
            && !isLoadingRecentMemory
            && !isMutatingMemory
    }

    private var cardAccessibilityValue: String {
        "\(planStatus.label), \(completedCount) of \(totalCount) tasks complete, \(progressPercent) percent"
    }

    private func taskSort(_ lhs: TODOItem, _ rhs: TODOItem) -> Bool {
        if lhs.order == rhs.order {
            return lhs.id.uuidString < rhs.id.uuidString
        }
        return lhs.order < rhs.order
    }

    private func currentCompletableItem(in plan: TODOPlan) -> TODOItem? {
        plan.items
            .sorted(by: taskSort)
            .first { $0.state == .inProgress || $0.state == .pending }
    }

    private func canRetry(_ plan: TODOPlan) -> Bool {
        plan.state == .failed
            || plan.state == .cancelled
            || plan.items.contains { $0.state == .failed || $0.state == .cancelled }
    }

    private func toggleCollapsed() {
        withOptionalMotion {
            isCollapsed.toggle()
            planner.isCollapsed = isCollapsed
            if !isCollapsed {
                focusTarget = .card
            }
        }
    }

    private func addTask() {
        let title = taskDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, planner.activePlan != nil else { return }
        taskDraft = ""
        Task {
            await planner.addTask(title: title)
            focusTarget = .taskEntry
        }
    }

    private func searchMemory() {
        let query = memoryQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, canSearchMemory else { return }

        let generation = UUID()
        let requestedConversationId = conversationId
        memorySearchGeneration = generation
        isSearchingMemory = true
        isLoadingRecentMemory = false
        didSearchMemory = true
        didLoadRecentMemory = false
        memoryActionError = nil
        memoryActionReceipt = nil

        Task {
            let matches = await onSearchMemory(query)
            guard memorySearchGeneration == generation,
                  conversationId == requestedConversationId else {
                return
            }
            memoryResults = matches
            isSearchingMemory = false
            focusTarget = .memoryQuery
        }
    }

    private func loadRecentMemory() {
        let generation = UUID()
        let requestedConversationId = conversationId
        memorySearchGeneration = generation
        memoryQuery = ""
        memoryResults = []
        didSearchMemory = false
        didLoadRecentMemory = false
        isSearchingMemory = false
        isLoadingRecentMemory = true
        memoryActionError = nil
        memoryActionReceipt = nil

        Task {
            do {
                let matches = try await onLoadRecentMemory(32)
                guard memorySearchGeneration == generation,
                      conversationId == requestedConversationId else {
                    return
                }
                memoryResults = matches
                didLoadRecentMemory = true
                isLoadingRecentMemory = false
            } catch {
                guard memorySearchGeneration == generation,
                      conversationId == requestedConversationId else {
                    return
                }
                isLoadingRecentMemory = false
                memoryActionError = memoryErrorMessage(error)
            }
        }
    }

    private func performMemoryConfirmation(_ confirmation: MemoryConfirmation) {
        pendingMemoryConfirmation = nil
        switch confirmation {
        case .forget(let match):
            forgetMemory(match)
        case .clearConversation:
            clearConversationMemory()
        }
    }

    private func forgetMemory(_ match: AgentMemoryMatch) {
        let generation = beginMemoryMutation()
        let requestedConversationId = conversationId

        Task {
            do {
                let removed = try await onForgetMemory(match.id)
                guard memoryMutationGeneration == generation,
                      conversationId == requestedConversationId else {
                    return
                }
                memoryResults.removeAll { $0.id == match.id }
                isMutatingMemory = false
                memoryActionReceipt = removed
                    ? "Memory forgotten."
                    : "Memory was already absent."
            } catch {
                guard memoryMutationGeneration == generation,
                      conversationId == requestedConversationId else {
                    return
                }
                isMutatingMemory = false
                memoryActionError = memoryErrorMessage(error)
            }
        }
    }

    private func clearConversationMemory() {
        let generation = beginMemoryMutation()
        let requestedConversationId = conversationId

        Task {
            do {
                let removedCount = try await onClearConversationMemory(
                    requestedConversationId
                )
                guard memoryMutationGeneration == generation,
                      conversationId == requestedConversationId else {
                    return
                }
                memoryResults.removeAll {
                    $0.record.conversationId == requestedConversationId
                }
                isMutatingMemory = false
                memoryActionReceipt = removedCount == 1
                    ? "Cleared 1 memory. Messages and plan remain."
                    : "Cleared \(removedCount) memories. Messages and plan remain."
            } catch {
                guard memoryMutationGeneration == generation,
                      conversationId == requestedConversationId else {
                    return
                }
                isMutatingMemory = false
                memoryActionError = memoryErrorMessage(error)
            }
        }
    }

    private func beginMemoryMutation() -> UUID {
        let generation = UUID()
        memorySearchGeneration = generation
        memoryMutationGeneration = generation
        isSearchingMemory = false
        isLoadingRecentMemory = false
        isMutatingMemory = true
        memoryActionError = nil
        memoryActionReceipt = nil
        return generation
    }

    private func handleConversationChange() {
        memorySearchGeneration = UUID()
        memoryMutationGeneration = UUID()
        memoryQuery = ""
        memoryResults = []
        didSearchMemory = false
        didLoadRecentMemory = false
        isSearchingMemory = false
        isLoadingRecentMemory = false
        isMutatingMemory = false
        memoryActionError = nil
        memoryActionReceipt = nil
        pendingMemoryConfirmation = nil

        if showsMemoryDrawer {
            loadRecentMemory()
        }
    }

    private func handleMemoryControlRevisionChange() {
        memorySearchGeneration = UUID()
        memoryResults = []
        didSearchMemory = false
        didLoadRecentMemory = false
        isSearchingMemory = false
        isLoadingRecentMemory = false
        memoryActionError = nil

        if showsMemoryDrawer {
            loadRecentMemory()
        }
    }

    private func memoryScorePercent(_ match: AgentMemoryMatch) -> Int {
        Int((max(0, min(match.score, 1)) * 100).rounded())
    }

    private func memoryResultAccessibilityValue(_ match: AgentMemoryMatch) -> String {
        if didSearchMemory {
            return "\(memoryScorePercent(match)) percent match"
        }
        return "Saved memory"
    }

    private func memoryErrorMessage(_ error: Error) -> String {
        if let localizedError = error as? LocalizedError,
           let description = localizedError.errorDescription,
           !description.isEmpty {
            return description
        }
        return error.localizedDescription
    }

    private func handleAddTaskShortcut(_ keyPress: KeyPress) -> KeyPress.Result {
        guard keyPress.modifiers.contains(.command), focusTarget != nil else {
            return .ignored
        }
        guard planner.activePlan != nil else {
            return .ignored
        }

        if isCollapsed {
            isCollapsed = false
            planner.isCollapsed = false
        }
        focusTarget = .taskEntry
        return .handled
    }

    private func handleCompleteShortcut(_ keyPress: KeyPress) -> KeyPress.Result {
        guard keyPress.modifiers.contains(.command), focusTarget != nil else {
            return .ignored
        }
        guard let plan = planner.activePlan, currentCompletableItem(in: plan) != nil else {
            return .ignored
        }

        Task {
            await planner.completeCurrentTask()
        }
        return .handled
    }

    private func withOptionalMotion(_ changes: () -> Void) {
        if reduceMotion {
            changes()
        } else {
            withAnimation(.easeInOut(duration: 0.20), changes)
        }
    }
}

private enum PlannerFocusTarget: Hashable {
    case card
    case taskEntry
    case memoryQuery
}

private enum MemoryConfirmation {
    case forget(AgentMemoryMatch)
    case clearConversation

    var title: String {
        switch self {
        case .forget:
            return "Forget this memory?"
        case .clearConversation:
            return "Clear memory for this task?"
        }
    }

    var actionTitle: String {
        switch self {
        case .forget:
            return "Forget memory"
        case .clearConversation:
            return "Clear task memory"
        }
    }

    var message: String {
        switch self {
        case .forget:
            return "This saved memory will be removed. Task messages and the execution plan remain."
        case .clearConversation:
            return "All saved memory for this task will be removed. Task messages and the execution plan remain."
        }
    }
}

private struct PlannerStatusPresentation {
    let label: String
    let icon: String
    let color: Color
}

private struct TODOActionLabel: View {
    let icon: String
    let title: String
    var isDestructive = false

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .semibold))
            Text(title)
                .font(.system(size: 10, weight: .semibold))
        }
        .foregroundColor(isDestructive ? .red.opacity(0.84) : .grokMuted)
        .padding(.horizontal, 9)
        .frame(height: 27)
        .background(Color.black.opacity(0.26))
        .clipShape(Capsule())
        .overlay {
            Capsule()
                .stroke(Color.white.opacity(0.07), lineWidth: 1)
        }
    }
}
