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
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.grokText)
            Spacer()
            Button(action: { viewModel.createNewConversation() }) {
                Image(systemName: "plus")
                    .font(.system(size: 12))
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
                .font(.system(size: 10))
                .foregroundColor(.grokMuted)
            TextField("Search", text: $searchText)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .foregroundColor(.grokText)
            if !searchText.isEmpty {
                Button(action: { searchText = "" }) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 10))
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
            // Pinned conversations
            if !pinnedConversations.isEmpty {
                Section {
                    ForEach(pinnedConversations) { conversation in
                        conversationRow(conversation)
                    }
                } header: {
                    Text("Pinned")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.grokMuted)
                        .textCase(nil)
                }
            }
            
            // Regular conversations
            Section {
                ForEach(filteredConversations.filter { !$0.isPinned }) { conversation in
                    conversationRow(conversation)
                }
            }
        }
        .listStyle(.plain)
        .background(Color.clear)
    }
    
    private var pinnedConversations: [ChatConversation] {
        viewModel.conversations.filter { $0.isPinned }
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
            // Pin indicator
            if conversation.isPinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: 8))
                    .foregroundColor(.orange)
            }
            
            avatar(for: conversation)
            
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    if editingConversationId == conversation.id {
                        TextField("Name", text: $editedName)
                            .textFieldStyle(.plain)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(.grokText)
                            .focused($isEditingName)
                            .onSubmit {
                                saveEditedName(for: conversation)
                            }
                    } else {
                        Text(conversation.title)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(.grokText)
                    }
                    
                    Spacer()
                    
                    if let last = last {
                        Text(last.timestamp.formatted(date: .omitted, time: .shortened))
                            .font(.system(size: 9))
                            .foregroundColor(.grokDim)
                    }
                }
                
                HStack(spacing: 4) {
                    Text(preview(for: last))
                        .font(.system(size: 11))
                        .foregroundColor(.grokMuted)
                        .lineLimit(1)
                    Spacer()
                    
                    if conversation.unreadCount > 0 {
                        Text("\(conversation.unreadCount)")
                            .font(.system(size: 10, weight: .semibold))
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
    
    private func startEditing(_ conversation: ChatConversation) {
        editingConversationId = conversation.id
        editedName = conversation.title
        isEditingName = true
    }

    private func saveEditedName(for conversation: ChatConversation) {
        viewModel.renameConversation(conversation.id, to: editedName.trimmingCharacters(in: .whitespacesAndNewlines))
        editingConversationId = nil
        isEditingName = false
    }
    
    private func togglePin(_ conversation: ChatConversation) {
        viewModel.togglePin(conversation.id)
    }
    
    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "message")
                .font(.system(size: 28))
                .foregroundColor(.grokMuted)
            Text("No conversations")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.grokText)
            Text("Start a new chat to begin")
                .font(.system(size: 10))
                .foregroundColor(.grokDim)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    
    private func avatar(for conversation: ChatConversation) -> some View {
        ZStack {
            Circle()
                .fill(Color.grokElevated.opacity(0.5))
                .frame(width: 36, height: 36)
            Image(systemName: conversation.icon)
                .font(.system(size: 14))
                .foregroundColor(.grokAccent)
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
                    .font(.system(size: 10))
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
}
