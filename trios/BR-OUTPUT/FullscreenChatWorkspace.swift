// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: FULLSCREEN-CHAT-001 adds the spec-driven adaptive chat workspace.
// Follow-up: seal against .trinity/specs/fullscreen-chat-history.md.
import SwiftUI

struct AdaptiveChatWorkspace: View {
    @ObservedObject var viewModel: ChatViewModel
    let scrollToBottomRequest: Int
    @State private var sidebarCollapsed = false

    /// The user's explicit request to see the full dashboard — the sidebar,
    /// the task history, the expanded layout — from inside the compact panel.
    ///
    /// Before this property the expanded view was only reachable by widening
    /// the window past the layout threshold. No button, no menu item, no
    /// keyboard shortcut: a screen the user could not open. #1118 is the fix.
    /// `false` → compact; `true` → force the expanded layout regardless of
    /// window width. The expanded view's header shows a "Close Dashboard"
    /// button only when the expansion was user-forced (i.e. the window is
    /// still narrow, `metrics.mode == .compact`), so the way out is visible
    /// exactly when it is needed.
    @State private var isDashboardExpanded = false

    var body: some View {
        GeometryReader { geometry in
            let metrics = ChatWorkspaceLayout.metrics(
                width: Double(geometry.size.width),
                sidebarCollapsed: sidebarCollapsed
            )

            if metrics.mode == .compact && !isDashboardExpanded {
                // The narrow panel is where the user actually lives. Without
                // this the supervisor was only visible in fullscreen, so a bee
                // could finish, wait, and be forgotten without a single pixel
                // saying so.
                //
                // The dashboard entry button at the top is the visible way in
                // (#1118). It sets isDashboardExpanded, which forces the
                // expanded layout below regardless of window width.
                VStack(spacing: 0) {
                    dashboardToggleButton
                    QueenCompactSupervisorBar(
                        registry: QueenDelegationRegistry.shared,
                        conversationId: viewModel.conversationId,
                        liveConversationIds: viewModel.workerRunner?.runningConversationIds ?? [],
                        onOpenTask: { viewModel.selectConversation($0) },
                        onOpenQueen: {
                            viewModel.selectConversation(ChatConversation.trinityQueenId)
                        },
                        onAccept: { task in
                            Task { await viewModel.runQueenCommand("/accept \(task.issue.slug)") }
                        },
                        onCancel: { task in
                            Task {
                                await viewModel.runQueenCommand(
                                    "/cancel \(task.issue.slug) stopped from the panel"
                                )
                            }
                        }
                    )
                    ChatPanelView(
                        viewModel: viewModel,
                        scrollToBottomRequest: scrollToBottomRequest,
                        workspaceMode: .compact
                    )
                }
            } else {
                ExpandedChatWorkspace(
                    viewModel: viewModel,
                    sidebarCollapsed: $sidebarCollapsed,
                    metrics: metrics,
                    scrollToBottomRequest: scrollToBottomRequest,
                    isDashboardExpanded: $isDashboardExpanded
                )
            }
        }
    }

    /// The visible way in (#1118, criterion 1). A single button at the top of
    /// the compact panel that opens the full dashboard — the sidebar, the task
    /// history, the expanded chat layout. Without it the expanded view is
    /// unreachable from inside a narrow panel, and that is exactly the gap
    /// criterion 4 guards: a screen with no caller must fail the test.
    private var dashboardToggleButton: some View {
        Button {
            isDashboardExpanded = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "rectangle.split.3x1")
                    .font(TriosType.font(9, weight: .semibold))
                    .foregroundColor(.white.opacity(0.4))
                Text("Open Dashboard")
                    .font(TriosType.font(10, weight: .bold))
                    .foregroundColor(.white.opacity(0.5))
                    .textCase(.uppercase)
                    .tracking(0.5)
                Spacer()
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(TriosType.font(8, weight: .semibold))
                    .foregroundColor(.grokMuted)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(Color.grokElevated.opacity(0.25))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.grokBorder.opacity(0.3))
                .frame(height: 1)
        }
        .accessibilityLabel("Open Dashboard")
    }
}

private struct ExpandedChatWorkspace: View {
    @ObservedObject var viewModel: ChatViewModel
    @Binding var sidebarCollapsed: Bool
    let metrics: ChatWorkspaceMetrics
    let scrollToBottomRequest: Int
    @Binding var isDashboardExpanded: Bool
    private let glassProfile = ChatGlassStyle.shared

    var body: some View {
        HStack(spacing: 0) {
            if !sidebarCollapsed {
                TaskHistorySidebar(viewModel: viewModel)
                    .frame(width: CGFloat(metrics.sidebarWidth))

                Divider()
                    .overlay(Color.grokBorder.opacity(0.7))
            }

            VStack(spacing: 0) {
                conversationHeader
                Divider().overlay(Color.grokBorder.opacity(0.6))

                // The supervisor strip belongs to the Queen's chat only. In a
                // worker's chat it would be noise about other people's work.
                if viewModel.conversationId == ChatConversation.trinityQueenId {
                    QueenDashboardView(
                        registry: QueenDelegationRegistry.shared,
                        liveConversationIds: viewModel.workerRunner?.runningConversationIds ?? [],
                        onOpenTask: { viewModel.selectConversation($0) },
                        onReview: { task in
                            Task { await viewModel.runQueenCommand("/accept \(task.issue.slug)") }
                        },
                        onCancel: { task in
                            Task {
                                await viewModel.runQueenCommand(
                                    "/cancel \(task.issue.slug) stopped from the swarm view"
                                )
                            }
                        }
                    )
                } else if let task = QueenDelegationRegistry.shared.task(
                    forConversation: viewModel.conversationId
                ) {
                    // A worker chat says nothing about the work without this.
                    QueenTaskBanner(
                        task: task,
                        isLive: viewModel.workerRunner?.isRunning(
                            conversationId: viewModel.conversationId
                        ) ?? false,
                        usage: viewModel.workerRunner?.usage(
                            forConversation: viewModel.conversationId
                        ),
                        onAccept: {
                            Task { await viewModel.runQueenCommand("/accept \(task.issue.slug)") }
                        },
                        onReject: {
                            Task {
                                await viewModel.runQueenCommand(
                                    "/review \(task.issue.slug) reject needs another pass"
                                )
                            }
                        },
                        onCancel: {
                            Task {
                                await viewModel.runQueenCommand(
                                    "/cancel \(task.issue.slug) stopped from its chat"
                                )
                            }
                        },
                        onOpenQueen: {
                            viewModel.selectConversation(ChatConversation.trinityQueenId)
                        }
                    )
                }

                HStack(spacing: 0) {
                    Spacer(minLength: 24)
                    ChatPanelView(
                        viewModel: viewModel,
                        scrollToBottomRequest: scrollToBottomRequest,
                        workspaceMode: .expanded
                    )
                        .frame(maxWidth: CGFloat(metrics.contentMaxWidth))
                    Spacer(minLength: 24)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color.black.opacity(glassProfile.contentOverlayOpacity))
        .task {
            await viewModel.loadConversations()
        }
    }

    private var conversationHeader: some View {
        HStack(spacing: 12) {
            Button(action: { sidebarCollapsed.toggle() }) {
                Image(systemName: sidebarCollapsed ? "sidebar.left" : "sidebar.left")
                    .font(TriosType.font(13, weight: .medium))
                    .foregroundColor(.grokMuted)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .help(sidebarCollapsed ? "Show task history" : "Hide task history")

            // The visible way out (#1118, criterion 1). When the dashboard was
            // opened from the compact panel (the window is still narrow,
            // metrics.mode == .compact), this button collapses it back. It is
            // not shown when the window is wide enough — the expanded layout
            // is the natural state there and there is nothing to close.
            if metrics.mode == .compact {
                Button {
                    isDashboardExpanded = false
                } label: {
                    Image(systemName: "rectangle.compress.vertical")
                        .font(TriosType.font(13, weight: .medium))
                        .foregroundColor(.grokMuted)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .help("Close Dashboard")
                .accessibilityLabel("Close Dashboard")
            }

            Text(currentTitle)
                .font(TriosType.font(13, weight: .semibold))
                .foregroundColor(.grokText)
                .lineLimit(1)

            Spacer()

        }
        .padding(.horizontal, 14)
        .frame(height: 44)
    }

    private var currentTitle: String {
        if let conversation = viewModel.conversations.first(where: {
            $0.id == viewModel.conversationId
        }) {
            return conversation.title
        }
        if let firstUserMessage = viewModel.messages.first(where: { $0.role == .user }) {
            return firstUserMessage.content
        }
        return "New task"
    }
}

private struct TaskHistorySidebar: View {
    @ObservedObject var viewModel: ChatViewModel
    @ObservedObject private var registry = QueenDelegationRegistry.shared
    @State private var searchText = ""
    @State private var hoveredConversationId: UUID?
    @State private var editingConversationId: UUID?
    @State private var draftTitle = ""
    @State private var archiveExpanded = false
    @FocusState private var focusedConversationId: UUID?
    private let glassProfile = ChatGlassStyle.shared

    var body: some View {
        VStack(spacing: 0) {
            sidebarHeader

            // The Queen sits above the task list, in her own frame. She is not a
            // task among tasks: she is the one delegating them.
            queenCard

            searchField

            Divider()
                .overlay(Color.grokBorder.opacity(0.55))
                .padding(.top, 10)

            swarmSection
            archiveSection

            historyContent

            Divider().overlay(Color.grokBorder.opacity(0.55))
            connectionFooter
        }
        .background(Color.black.opacity(glassProfile.sidebarOverlayOpacity))
        .task {
            await viewModel.loadConversations()
        }
    }

    /// The Queen's dedicated entry, styled to her station.
    @ViewBuilder
    private var queenCard: some View {
        let queen = viewModel.conversations.first { $0.id == ChatConversation.trinityQueenId }
        if let queen {
            let isActive = viewModel.conversationId == queen.id
            Button {
                Task { await viewModel.switchConversation(id: queen.id) }
            } label: {
                HStack(spacing: 9) {
                    Image(systemName: "crown.fill")
                        .font(TriosType.font(15))
                        .foregroundColor(.yellow)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(queen.title)
                            .font(TriosType.font(13, weight: .bold))
                            .foregroundColor(.grokText)
                            .lineLimit(1)
                        Text(queenSubtitle)
                            .font(TriosType.font(10))
                            .foregroundColor(.grokMuted)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    if !registry.reviewQueue.isEmpty {
                        Text("\(registry.reviewQueue.count)")
                            .font(TriosType.font(10, weight: .bold, design: .monospaced))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .background(Capsule().fill(Color.orange.opacity(0.22)))
                            .foregroundColor(.orange)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.yellow.opacity(isActive ? 0.16 : 0.07))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(Color.yellow.opacity(0.32), lineWidth: 1)
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 10)
            .padding(.top, 6)
            .accessibilityLabel("Trinity Queen")
            .accessibilityValue(queenSubtitle)
        }
    }

    private var queenSubtitle: String {
        let running = registry.running.count
        let waiting = registry.reviewQueue.count
        if running == 0 && waiting == 0 { return "No work delegated" }
        var parts: [String] = []
        if running > 0 { parts.append("\(running) working") }
        if waiting > 0 { parts.append("\(waiting) awaiting review") }
        return parts.joined(separator: ", ")
    }

    /// Delegated work: one chat per GitHub issue, each on its own virtual branch.
    @ViewBuilder
    private var swarmSection: some View {
        // Open work only. Settled tasks move to the archive below, so the list
        // the user scans is the list they can still act on.
        let tasks = registry.open.sorted { $0.updatedAt > $1.updatedAt }
        if !tasks.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    Image(systemName: "point.3.connected.trianglepath.dotted")
                        .font(TriosType.font(9))
                    Text("Swarm")
                    Spacer()
                    Text("\(registry.running.count)/\(QueenDelegationPolicy.maximumConcurrentWorkers)")
                        .font(TriosType.font(9, design: .monospaced))
                }
                .font(TriosType.font(10, weight: .semibold))
                .foregroundColor(.grokMuted)
                .padding(.horizontal, 12)
                .padding(.top, 8)

                ForEach(tasks) { task in
                    taskRow(task, dimmed: false)
                }

                Divider().overlay(Color.grokBorder.opacity(0.55)).padding(.top, 6)
            }
        }
    }

    /// Settled work, collapsed by default.
    ///
    /// Accepted tasks used to sit in the swarm list forever, so after a day of
    /// delegating the section answering "what needs me" was mostly things that
    /// did not.
    @ViewBuilder
    private var archiveSection: some View {
        let settled = registry.archived
        if !settled.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Button {
                    archiveExpanded.toggle()
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: archiveExpanded ? "chevron.down" : "chevron.right")
                            .font(TriosType.font(8, weight: .semibold))
                        Image(systemName: "archivebox")
                            .font(TriosType.font(9))
                        Text("Archive")
                        Spacer()
                        Text("\(settled.count)")
                            .font(TriosType.font(9, design: .monospaced))
                    }
                    .font(TriosType.font(10, weight: .semibold))
                    .foregroundColor(.grokMuted)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if archiveExpanded {
                    ForEach(settled.prefix(20)) { task in
                        taskRow(task, dimmed: true)
                    }
                    if settled.count > 20 {
                        Text("+\(settled.count - 20) older")
                            .font(TriosType.font(9))
                            .foregroundColor(.grokDim)
                            .padding(.horizontal, 12)
                    }
                }

                Divider().overlay(Color.grokBorder.opacity(0.55)).padding(.top, 6)
            }
        }
    }

    private func taskRow(_ task: DelegatedTask, dimmed: Bool) -> some View {
        let isLive = viewModel.workerRunner?.isRunning(
            conversationId: task.conversationId
        ) ?? false
        return Button {
            Task { await viewModel.switchConversation(id: task.conversationId) }
        } label: {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(task.title)
                            .font(TriosType.font(12, weight: .medium))
                            .foregroundColor(.grokText)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        QueenTaskStatusPill(state: task.state, isLive: isLive, compact: true)
                    }
                    HStack(spacing: 5) {
                        Text(task.issue.slug)
                            .font(TriosType.font(9, design: .monospaced))
                            .foregroundColor(.grokDim)
                        if let branch = task.virtualBranch {
                            Image(systemName: "arrow.triangle.branch")
                                .font(TriosType.font(8))
                                .foregroundColor(.grokDim)
                            Text(branch)
                                .font(TriosType.font(9, design: .monospaced))
                                .foregroundColor(.grokDim)
                                .lineLimit(1)
                        }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
            .opacity(dimmed ? 0.55 : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("\(task.worker) on \(task.issue.slug) - \(QueenTaskStyle.label(for: task.state, isLive: isLive))")
    }

    private var sidebarHeader: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: { viewModel.newConversation() }) {
                HStack(spacing: 9) {
                    Image(systemName: "square.and.pencil")
                        .font(TriosType.font(13, weight: .medium))
                    Text("New task")
                        .font(TriosType.font(13, weight: .medium))
                    Spacer()
                }
                .foregroundColor(.grokText)
                .padding(.horizontal, 10)
                .frame(height: 36)
                .background(Color.white.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 9))
            }
            .buttonStyle(.plain)
            .keyboardShortcut("n", modifiers: [.command])
        }
        .padding(.horizontal, 12)
        .padding(.top, 14)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(TriosType.font(11))
                .foregroundColor(.grokDim)

            TextField("Search tasks", text: $searchText)
                .textFieldStyle(.plain)
                .font(TriosType.font(12))
                .foregroundColor(.grokText)

            if !searchText.isEmpty {
                Button(action: { searchText = "" }) {
                    Image(systemName: "xmark.circle.fill")
                        .font(TriosType.font(11))
                        .foregroundColor(.grokDim)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 32)
        .background(Color.white.opacity(0.055))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 12)
        .padding(.top, 10)
    }

    @ViewBuilder
    private var historyContent: some View {
        if viewModel.conversations.isEmpty {
            sidebarEmptyState(
                icon: "clock.arrow.circlepath",
                title: "No tasks yet",
                detail: "Start a new task to build history."
            )
        } else if filteredConversations.isEmpty {
            sidebarEmptyState(
                icon: "magnifyingglass",
                title: "No matches",
                detail: "Try another search."
            )
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(historySections) { section in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(section.title)
                                .font(TriosType.font(10, weight: .semibold))
                                .foregroundColor(.grokDim)
                                .padding(.horizontal, 10)

                            ForEach(section.conversations) { conversation in
                                conversationRow(conversation)
                            }
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 12)
            }
        }
    }

    private func sidebarEmptyState(icon: String, title: String, detail: String) -> some View {
        VStack(spacing: 8) {
            Spacer()
            Image(systemName: icon)
                .font(TriosType.font(22))
                .foregroundColor(.grokDim)
            Text(title)
                .font(TriosType.font(12, weight: .semibold))
                .foregroundColor(.grokMuted)
            Text(detail)
                .font(TriosType.font(10))
                .foregroundColor(.grokDim)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(20)
    }

    private func conversationRow(_ conversation: ChatConversation) -> some View {
        let isSelected = conversation.id == viewModel.conversationId
        let isHovered = conversation.id == hoveredConversationId
        let isEditing = conversation.id == editingConversationId

        return HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                if isEditing {
                    TextField("Task title", text: $draftTitle)
                        .textFieldStyle(.plain)
                        .font(TriosType.font(12, weight: .semibold))
                        .foregroundColor(.grokText)
                        .focused($focusedConversationId, equals: conversation.id)
                        .onSubmit {
                            saveTitle(for: conversation)
                        }
                        .onExitCommand {
                            cancelTitleEditing()
                        }
                } else {
                    Text(conversation.title)
                        .font(TriosType.font(12, weight: isSelected ? .semibold : .regular))
                        .foregroundColor(.grokText)
                        .lineLimit(1)
                        .contentShape(Rectangle())
                        .highPriorityGesture(
                            TapGesture(count: 2)
                                .onEnded {
                                    startTitleEditing(conversation)
                                }
                        )
                }

                Text(conversation.updatedAt, style: .relative)
                    .font(TriosType.font(9))
                    .foregroundColor(.grokDim)
            }

            Spacer(minLength: 4)

            if isEditing {
                Button(action: { saveTitle(for: conversation) }) {
                    Image(systemName: "checkmark")
                        .font(TriosType.font(10, weight: .semibold))
                        .foregroundColor(.grokText)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
                .help("Save title")
                .accessibilityLabel("Save title")

                Button(action: cancelTitleEditing) {
                    Image(systemName: "xmark")
                        .font(TriosType.font(10, weight: .semibold))
                        .foregroundColor(.grokMuted)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
                .help("Cancel editing")
                .accessibilityLabel("Cancel editing")
            } else if isHovered {
                Button(action: { startTitleEditing(conversation) }) {
                    Image(systemName: "pencil")
                        .font(TriosType.font(10))
                        .foregroundColor(.grokMuted)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
                .help("Rename task")
                .accessibilityLabel("Rename task")

                Button(action: {
                    Task { await viewModel.deleteConversation(id: conversation.id) }
                }) {
                    Image(systemName: "trash")
                        .font(TriosType.font(10))
                        .foregroundColor(.grokMuted)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
                .help("Delete task")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            isSelected
                ? Color.white.opacity(0.11)
                : (isHovered ? Color.white.opacity(0.06) : Color.clear)
        )
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())
        .onTapGesture {
            guard editingConversationId != conversation.id else { return }
            Task { await viewModel.switchConversation(id: conversation.id) }
        }
        .onHover { hovered in
            hoveredConversationId = hovered ? conversation.id : nil
        }
        .accessibilityAction(named: Text("Rename task")) {
            startTitleEditing(conversation)
        }
        .contextMenu {
            Button("Rename") {
                startTitleEditing(conversation)
            }
            Button("Delete", role: .destructive) {
                Task { await viewModel.deleteConversation(id: conversation.id) }
            }
        }
    }

    private func startTitleEditing(_ conversation: ChatConversation) {
        draftTitle = conversation.title
        editingConversationId = conversation.id
        DispatchQueue.main.async {
            focusedConversationId = conversation.id
        }
    }

    private func saveTitle(for conversation: ChatConversation) {
        let title = draftTitle
        editingConversationId = nil
        focusedConversationId = nil
        draftTitle = ""
        Task {
            await viewModel.renameConversation(conversation.id, to: title)
        }
    }

    private func cancelTitleEditing() {
        editingConversationId = nil
        focusedConversationId = nil
        draftTitle = ""
    }

    private var connectionFooter: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(viewModel.isServerReachable ? Color.green : Color.red)
                .frame(width: 7, height: 7)
            Text(viewModel.isServerReachable ? "BrowserOS connected" : "BrowserOS offline")
                .font(TriosType.font(10, weight: .medium))
                .foregroundColor(.grokMuted)
            Spacer()
        }
        .padding(.horizontal, 14)
        .frame(height: 42)
    }

    private var filteredConversations: [ChatConversation] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return viewModel.conversations }
        return viewModel.conversations.filter {
            $0.title.localizedCaseInsensitiveContains(query)
        }
    }

    private var historySections: [TaskHistorySection] {
        let calendar = Calendar.current
        var today: [ChatConversation] = []
        var previousWeek: [ChatConversation] = []
        var older: [ChatConversation] = []

        // The Queen and the swarm are already drawn above - she has her own
        // pinned row and every delegated chat has a Swarm entry. Listing them
        // again here put a second "Trinity Queen" under Today, below the first
        // one, which reads as two Queens.
        //
        // `ChatSidebarView` has excluded exactly these for a while (line 130
        // there); this view was written later and never got the same filter.
        let alreadyShown = Set(
            QueenDelegationRegistry.shared.open.map(\.conversationId)
        ).union([ChatConversation.trinityQueenId])

        for conversation in filteredConversations where !alreadyShown.contains(conversation.id) {
            if calendar.isDateInToday(conversation.updatedAt) {
                today.append(conversation)
            } else if let days = calendar.dateComponents(
                [.day],
                from: calendar.startOfDay(for: conversation.updatedAt),
                to: calendar.startOfDay(for: Date())
            ).day, days <= 7 {
                previousWeek.append(conversation)
            } else {
                older.append(conversation)
            }
        }

        return [
            TaskHistorySection(title: "Today", conversations: today),
            TaskHistorySection(title: "Previous 7 days", conversations: previousWeek),
            TaskHistorySection(title: "Older", conversations: older)
        ].filter { !$0.conversations.isEmpty }
    }
}

private struct TaskHistorySection: Identifiable {
    let title: String
    let conversations: [ChatConversation]
    var id: String { title }
}
