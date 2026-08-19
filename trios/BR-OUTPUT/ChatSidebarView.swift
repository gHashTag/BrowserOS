//
//  ChatSidebarView.swift
//  TriOS — Chat Sidebar with Edit & Pin Support
//
//  Allows renaming conversations and pinning to top
//

import SwiftUI

/// ChatSidebarView — Sidebar with edit name and pin functionality
struct ChatSidebarView: View {
    @ObservedObject var viewModel: ChatViewModel
    @ObservedObject private var registry = QueenDelegationRegistry.shared
    @State private var editingConversationId: UUID?
    @State private var editedName: String = ""
    @State private var searchText: String = ""
    @State private var selectedConversationId: UUID? = nil
    @FocusState private var isEditingName: Bool

    var body: some View {
        VStack(spacing: 0) {
            headerBar
            Divider().overlay(Color.grokBorder)
            searchField
            Divider().overlay(Color.grokBorder)
            if viewModel.conversations.isEmpty {
                emptyState
            } else {
                listContent
            }
        }
        .background(Color.clear)
        .frame(width: 280)
    }
    
    private var headerBar: some View {
        HStack(spacing: 8) {
            Text("Conversations")
                .font(TriosType.font(13, weight: .semibold))
                .foregroundColor(.grokText)
            Spacer()
            Button(action: { viewModel.createNewConversation() }) {
                Image(systemName: "plus")
                    .font(TriosType.font(12))
                    .foregroundColor(.grokAccent)
            }
            .buttonStyle(.plain)
            .help("New conversation")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
    
    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(TriosType.font(10))
                .foregroundColor(.grokMuted)
            TextField("Search", text: $searchText)
                .textFieldStyle(.plain)
                .font(TriosType.font(12))
                .foregroundColor(.grokText)
            if !searchText.isEmpty {
                Button(action: { searchText = "" }) {
                    Image(systemName: "xmark.circle.fill")
                        .font(TriosType.font(10))
                        .foregroundColor(.grokMuted)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(8)
        .background(Color.grokElevated.opacity(0.3))
        .cornerRadius(6)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
    
    private var listContent: some View {
        List {
            // The Queen sits above everything, in her own section. She is not a
            // conversation among conversations: she is the one delegating them,
            // and burying her in "Pinned" understates that.
            queenSection

            // Delegated work: one chat per GitHub issue, each on its own
            // virtual branch.
            if !delegatedTasks.isEmpty {
                Section {
                    ForEach(delegatedTasks) { task in
                        delegatedTaskRow(task)
                    }
                } header: {
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
                    .textCase(nil)
                }
            }

            // Pinned conversations
            if !pinnedConversations.isEmpty {
                Section {
                    ForEach(pinnedConversations) { conversation in
                        conversationRow(conversation)
                    }
                } header: {
                    Text("Pinned")
                        .font(TriosType.font(10, weight: .semibold))
                        .foregroundColor(.grokMuted)
                        .textCase(nil)
                }
            }
            
            // Regular conversations
            Section {
                // Excluded from here only while the Swarm section is showing
                // them. The filter used to drop every conversation that had a
                // task at all, so once a task settled it left the swarm list
                // and did not come back here either - the chat became
                // unreachable from the sidebar, and reading what a finished bee
                // actually did meant it was gone.
                ForEach(filteredConversations.filter { !$0.isPinned && $0.id != ChatConversation.trinityQueenId && !swarmConversationIds.contains($0.id) }) { conversation in
                    conversationRow(conversation)
                }
            }
        }
        .listStyle(.plain)
        .background(Color.clear)
    }
    
    /// The Queen's own row, styled to her station: full-width, crowned, and
    /// carrying the swarm's live counters so she is useful at a glance.
    @ViewBuilder
    private var queenSection: some View {
        if let queen = viewModel.conversations.first(where: { $0.id == ChatConversation.trinityQueenId }) {
            Section {
                Button {
                    Task { await viewModel.switchConversation(id: queen.id) }
                } label: {
                    HStack(spacing: 9) {
                        Image(systemName: "crown.fill")
                            .font(TriosType.font(14))
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
                            // Work waiting on her decision, not just running.
                            Text("\(registry.reviewQueue.count)")
                                .font(TriosType.font(10, weight: .bold, design: .monospaced))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 3)
                                .background(Capsule().fill(Color.orange.opacity(0.22)))
                                .foregroundColor(.orange)
                        }
                    }
                    .padding(.vertical, 7)
                    .padding(.horizontal, 9)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(Color.yellow.opacity(viewModel.conversationId == queen.id ? 0.14 : 0.06))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(Color.yellow.opacity(0.30), lineWidth: 1)
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
                .accessibilityLabel("Trinity Queen")
                .accessibilityValue(queenSubtitle)
            }
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

    /// One delegated task: its issue, its worker, its virtual branch.
    private func delegatedTaskRow(_ task: DelegatedTask) -> some View {
        Button {
            Task { await viewModel.switchConversation(id: task.conversationId) }
        } label: {
            HStack(spacing: 8) {
                Circle()
                    .fill(color(for: task.state))
                    .frame(width: 7, height: 7)
                VStack(alignment: .leading, spacing: 2) {
                    Text(task.title)
                        .font(TriosType.font(12, weight: .medium))
                        .foregroundColor(.grokText)
                        .lineLimit(1)
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
                Spacer(minLength: 4)
                Text(task.state.rawValue)
                    .font(TriosType.font(9, weight: .medium))
                    .foregroundColor(color(for: task.state))
            }
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("\(task.worker) on \(task.issue.slug)")
    }

    private func color(for state: DelegatedTaskState) -> Color {
        switch state {
        case .running: return .green
        case .awaitingReview: return .orange
        case .failed, .rejected: return .red
        case .accepted: return .blue
        // Landed work reads as done, not as another shade of pending.
        case .merged: return .green
        case .queued: return .grokMuted
        case .cancelled: return .grokDim
        }
    }

    private var delegatedTasks: [DelegatedTask] {
        // `open`, not `active`. Active means "not terminal", and failed is
        // terminal, so a bee that fell over left this list the instant it did -
        // the one state a supervisor must not miss was the one that vanished.
        // The registry already draws the right line: open keeps a failure until
        // somebody acknowledges it, and the comment beside it says why - a
        // failure nobody has looked at is still work, and filing it away
        // silently is how it never gets looked at.
        registry.open.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// The conversations the Swarm section is drawing right now, so the
    /// ordinary list can leave exactly those out and no more.
    private var swarmConversationIds: Set<UUID> {
        Set(delegatedTasks.map(\.conversationId))
    }

    private var pinnedConversations: [ChatConversation] {
        viewModel.conversations
            .filter { $0.isPinned && $0.id != ChatConversation.trinityQueenId }
            .sorted { $0.updatedAt > $1.updatedAt }
    }
    
    private var filteredConversations: [ChatConversation] {
        if searchText.isEmpty {
            return viewModel.conversations
        }
        return viewModel.conversations.filter {
            $0.title.localizedCaseInsensitiveContains(searchText)
        }
    }
    
    private func conversationRow(_ conversation: ChatConversation) -> some View {
        let messages = viewModel.sidebarMessages(for: conversation.id)
        let last = messages.last

        return HStack(spacing: 10) {
            // Pin indicator (or crown for reserved Trinity Queen)
            if conversation.isReserved {
                Image(systemName: "crown.fill")
                    .font(TriosType.font(8))
                    .foregroundColor(.orange)
            } else if conversation.isPinned {
                Image(systemName: "pin.fill")
                    .font(TriosType.font(8))
                    .foregroundColor(.orange)
            }

            avatar(for: conversation)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    if editingConversationId == conversation.id {
                        TextField("Name", text: $editedName)
                            .textFieldStyle(.plain)
                            .font(TriosType.font(12, weight: .semibold))
                            .foregroundColor(.grokText)
                            .focused($isEditingName)
                            .onSubmit {
                                saveEditedName(for: conversation)
                            }
                    } else {
                        Text(conversation.title)
                            .font(TriosType.font(12, weight: .semibold))
                            .foregroundColor(.grokText)
                    }
                    
                    Spacer()
                    
                    if let last = last {
                        Text(last.timestamp.formatted(date: .omitted, time: .shortened))
                            .font(TriosType.font(9))
                            .foregroundColor(.grokDim)
                    }
                }
                
                HStack(spacing: 4) {
                    Text(preview(for: last))
                        .font(TriosType.font(11))
                        .foregroundColor(.grokMuted)
                        .lineLimit(1)
                    Spacer()
                    
                    if conversation.unreadCount > 0 {
                        Text("\(conversation.unreadCount)")
                            .font(TriosType.font(10, weight: .semibold))
                            .foregroundColor(.white)
                            .frame(minWidth: 16, minHeight: 16)
                            .padding(.horizontal, 4)
                            .background(Color.grokAccent)
                            .clipShape(Capsule())
                    }
                }
            }
            
            // Context menu button (hidden by default, shows on hover)
            MenuButton(conversation: conversation, isEditing: editingConversationId == conversation.id) {
                startEditing(conversation)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(rowBackground(isSelected: viewModel.conversationId == conversation.id))
        .contentShape(Rectangle())
        .onTapGesture {
            Task {
                await viewModel.switchConversation(id: conversation.id)
            }
        }
        .contextMenu {
            contextMenuItems(for: conversation)
        }
    }
    
    @ViewBuilder
    private func contextMenuItems(for conversation: ChatConversation) -> some View {
        Button(action: { startEditing(conversation) }) {
            Label("Rename", systemImage: "pencil")
        }

        if !conversation.isReserved {
            Button(action: { togglePin(conversation) }) {
                Label(conversation.isPinned ? "Unpin" : "Pin", systemImage: conversation.isPinned ? "pin.slash" : "pin")
            }

            Divider()

            Button(role: .destructive) {
                viewModel.deleteConversation(conversation.id)
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }
    
    private func startEditing(_ conversation: ChatConversation) {
        editingConversationId = conversation.id
        editedName = conversation.title
        isEditingName = true
    }

    private func saveEditedName(for conversation: ChatConversation) {
        let title = editedName
        editingConversationId = nil
        isEditingName = false
        Task {
            await viewModel.renameConversation(conversation.id, to: title)
        }
    }
    
    private func togglePin(_ conversation: ChatConversation) {
        viewModel.togglePin(conversation.id)
    }
    
    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "message")
                .font(TriosType.font(28))
                .foregroundColor(.grokMuted)
            Text("No conversations")
                .font(TriosType.font(12, weight: .semibold))
                .foregroundColor(.grokText)
            Text("Start a new chat to begin")
                .font(TriosType.font(10))
                .foregroundColor(.grokDim)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    
    private func avatar(for conversation: ChatConversation) -> some View {
        ZStack {
            Circle()
                .fill(
                    conversation.isReserved
                        ? Color.orange.opacity(0.2)
                        : Color.grokElevated.opacity(0.5)
                )
                .frame(width: 36, height: 36)
            Image(systemName: conversation.icon)
                .font(TriosType.font(14))
                .foregroundColor(conversation.isReserved ? .orange : .grokAccent)
        }
    }
    
    private func preview(for message: ChatMessage?) -> String {
        guard let message = message else { return "No messages" }
        return message.content.prefix(50) + (message.content.count > 50 ? "..." : "")
    }
    
    private func rowBackground(isSelected: Bool) -> some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(isSelected ? Color.grokAccent.opacity(0.15) : Color.grokElevated.opacity(0.1))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(isSelected ? Color.grokAccent.opacity(0.4) : Color.grokBorder.opacity(0.25), lineWidth: 1)
            )
    }
}

// MARK: - Menu Button (Shows on Hover)

struct MenuButton: View {
    let conversation: ChatConversation
    let isEditing: Bool
    let onRename: () -> Void
    
    @State private var isHovering: Bool = false
    
    var body: some View {
        if isHovering && !isEditing {
            Menu {
                Button(action: onRename) {
                    Label("Rename", systemImage: "pencil")
                }
                Button(action: { /* togglePin will be called via context menu */ }) {
                    Label(conversation.isPinned ? "Unpin" : "Pin", systemImage: conversation.isPinned ? "pin.slash" : "pin")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(TriosType.font(10))
                    .foregroundColor(.grokMuted)
            }
            .menuStyle(.borderlessButton)
            .transition(.opacity)
        }
    }
}

// MARK: - ChatViewModel Extension

// ChatSidebarView keeps its own local view state; it must not extend
// ChatViewModel with methods that duplicate or conflict with the canonical
// conversation-management API in rings/SR-02/ChatViewModel.swift.
extension ChatViewModel {
    func sidebarMessages(for conversationId: UUID) -> [ChatMessage] {
        // Sidebar-specific message preview; return empty until wired to persister.
        return []
    }

    /// Human-readable role label for the Trinity Queen reserved conversation.
    var reservedQueenLabel: String {
        "Trinity Queen"
    }
}
