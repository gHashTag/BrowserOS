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
        List(selection: $viewModel.selectedConversationId) {
            // Pinned conversations
            if !pinnedConversations.isEmpty {
                Section {
                    ForEach(pinnedConversations) { conversation in
                        conversationRow(conversation)
                            .tag(conversation.id)
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
                        .tag(conversation.id)
                }
            }
        }
        .listStyle(.plain)
        .background(Color.clear)
    }
    
    private var pinnedConversations: [Conversation] {
        viewModel.conversations.filter { $0.isPinned }
    }
    
    private var filteredConversations: [Conversation] {
        if searchText.isEmpty {
            return viewModel.conversations
        }
        return viewModel.conversations.filter {
            $0.name.localizedCaseInsensitiveContains(searchText)
        }
    }
    
    private func conversationRow(_ conversation: Conversation) -> some View {
        let messages = viewModel.getMessages(for: conversation.id)
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
                            .focused()
                            .onSubmit {
                                saveEditedName(for: conversation)
                            }
                    } else {
                        Text(conversation.name)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(.grokText)
                    }
                    
                    Spacer()
                    
                    if let last = last {
                        Text(last.formattedTime)
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
        .background(rowBackground(isSelected: viewModel.selectedConversationId == conversation.id))
        .contextMenu {
            contextMenuItems(for: conversation)
        }
    }
    
    @ViewBuilder
    private func contextMenuItems(for conversation: Conversation) -> some View {
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
    
    private func startEditing(_ conversation: Conversation) {
        editingConversationId = conversation.id
        editedName = conversation.name
    }
    
    private func saveEditedName(for conversation: Conversation) {
        viewModel.renameConversation(conversation.id, to: editedName.trimmingCharacters(in: .whitespacesAndNewlines))
        editingConversationId = nil
    }
    
    private func togglePin(_ conversation: Conversation) {
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
    
    private func avatar(for conversation: Conversation) -> some View {
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
    let conversation: Conversation
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

// MARK: - Conversation Model

struct Conversation: Identifiable, Hashable {
    let id: UUID
    var name: String
    var icon: String
    var isPinned: Bool
    var unreadCount: Int
    let createdAt: Date
    var lastMessageAt: Date
}

// MARK: - ChatViewModel Extension

extension ChatViewModel {
    func createNewConversation() {
        let conversation = Conversation(
            id: UUID(),
            name: "New Chat",
            icon: "message.fill",
            isPinned: false,
            unreadCount: 0,
            createdAt: Date(),
            lastMessageAt: Date()
        )
        conversations.append(conversation)
        selectedConversationId = conversation.id
    }
    
    func renameConversation(_ id: UUID, to newName: String) {
        if let index = conversations.firstIndex(where: { $0.id == id }) {
            conversations[index].name = newName.isEmpty ? "Untitled" : newName
        }
    }
    
    func togglePin(_ id: UUID) {
        if let index = conversations.firstIndex(where: { $0.id == id }) {
            conversations[index].isPinned.toggle()
        }
    }
    
    func deleteConversation(_ id: UUID) {
        conversations.removeAll { $0.id == id }
        if selectedConversationId == id {
            selectedConversationId = nil
        }
    }
    
    func getMessages(for conversationId: UUID) -> [ChatMessage] {
        // Return messages for this conversation
        return []
    }
}
