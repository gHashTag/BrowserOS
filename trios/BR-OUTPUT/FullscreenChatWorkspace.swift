// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: FULLSCREEN-CHAT-001 adds the spec-driven adaptive chat workspace.
// Follow-up: seal against .trinity/specs/fullscreen-chat-history.md.
import SwiftUI

struct AdaptiveChatWorkspace: View {
    @ObservedObject var viewModel: ChatViewModel
    let scrollToBottomRequest: Int
    @State private var sidebarCollapsed = false
    @StateObject private var intelligenceEngine = QueenIntelligenceEngine()

    var body: some View {
        GeometryReader { geometry in
            let metrics = ChatWorkspaceLayout.metrics(
                width: Double(geometry.size.width),
                sidebarCollapsed: sidebarCollapsed
            )

            if metrics.mode == .compact {
                ChatPanelView(
                    viewModel: viewModel,
                    scrollToBottomRequest: scrollToBottomRequest,
                    workspaceMode: .compact,
                    intelligenceEngine: intelligenceEngine
                )
            } else {
                ExpandedChatWorkspace(
                    viewModel: viewModel,
                    sidebarCollapsed: $sidebarCollapsed,
                    metrics: metrics,
                    scrollToBottomRequest: scrollToBottomRequest,
                    intelligenceEngine: intelligenceEngine
                )
            }
        }
    }
}

private struct ExpandedChatWorkspace: View {
    @ObservedObject var viewModel: ChatViewModel
    @Binding var sidebarCollapsed: Bool
    let metrics: ChatWorkspaceMetrics
    let scrollToBottomRequest: Int
    @ObservedObject var intelligenceEngine: QueenIntelligenceEngine
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

                HStack(spacing: 0) {
                    Spacer(minLength: 24)
                    ChatPanelView(
                        viewModel: viewModel,
                        scrollToBottomRequest: scrollToBottomRequest,
                        workspaceMode: .expanded,
                        intelligenceEngine: intelligenceEngine
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
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.grokMuted)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .help(sidebarCollapsed ? "Show task history" : "Hide task history")

            Text(currentTitle)
                .font(.system(size: 13, weight: .semibold))
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
    @State private var searchText = ""
    @State private var hoveredConversationId: UUID?
    private let glassProfile = ChatGlassStyle.shared

    var body: some View {
        VStack(spacing: 0) {
            sidebarHeader
            searchField

            Divider()
                .overlay(Color.grokBorder.opacity(0.55))
                .padding(.top, 10)

            historyContent

            Divider().overlay(Color.grokBorder.opacity(0.55))
            connectionFooter
        }
        .background(Color.black.opacity(glassProfile.sidebarOverlayOpacity))
        .task {
            await viewModel.loadConversations()
        }
    }

    private var sidebarHeader: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: { viewModel.newConversation() }) {
                HStack(spacing: 9) {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 13, weight: .medium))
                    Text("New task")
                        .font(.system(size: 13, weight: .medium))
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
                .font(.system(size: 11))
                .foregroundColor(.grokDim)

            TextField("Search tasks", text: $searchText)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .foregroundColor(.grokText)

            if !searchText.isEmpty {
                Button(action: { searchText = "" }) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
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
                                .font(.system(size: 10, weight: .semibold))
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
                .font(.system(size: 22))
                .foregroundColor(.grokDim)
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.grokMuted)
            Text(detail)
                .font(.system(size: 10))
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

        return HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(conversation.title)
                    .font(.system(size: 12, weight: isSelected ? .semibold : .regular))
                    .foregroundColor(.grokText)
                    .lineLimit(1)

                Text(conversation.updatedAt, style: .relative)
                    .font(.system(size: 9))
                    .foregroundColor(.grokDim)
            }

            Spacer(minLength: 4)

            if isHovered {
                Button(action: {
                    Task { await viewModel.deleteConversation(id: conversation.id) }
                }) {
                    Image(systemName: "trash")
                        .font(.system(size: 10))
                        .foregroundColor(.grokMuted)
                        .frame(width: 24, height: 24)
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
            Task { await viewModel.switchConversation(id: conversation.id) }
        }
        .onHover { hovered in
            hoveredConversationId = hovered ? conversation.id : nil
        }
        .contextMenu {
            Button("Delete", role: .destructive) {
                Task { await viewModel.deleteConversation(id: conversation.id) }
            }
        }
    }

    private var connectionFooter: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(viewModel.isServerReachable ? Color.green : Color.red)
                .frame(width: 7, height: 7)
            Text(viewModel.isServerReachable ? "BrowserOS connected" : "BrowserOS offline")
                .font(.system(size: 10, weight: .medium))
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

        for conversation in filteredConversations {
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
