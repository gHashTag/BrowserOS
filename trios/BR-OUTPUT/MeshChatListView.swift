// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: untracked mesh-chat file on feat/zai-provider; triage before T27 seal.
// Expires: 2026-12-31
import SwiftUI

/// Sidebar list of mesh chat conversations.
struct MeshChatListView: View {
    @ObservedObject var viewModel: MeshChatViewModel
    @State private var newPeerText: String = ""
    @State private var isAddingPeer = false

    var body: some View {
        VStack(spacing: 0) {
            headerBar
            Divider().overlay(Color.grokBorder)
            if viewModel.conversations.isEmpty && !isAddingPeer {
                emptyState
            } else {
                listContent
            }
        }
        .background(Color.clear)
    }

    private var headerBar: some View {
        HStack(spacing: 8) {
            Text("Mesh Chat")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.grokText)
            Spacer()
            Button(action: { isAddingPeer.toggle() }) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 12))
                    .foregroundColor(.grokAccent)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var listContent: some View {
        List(selection: $viewModel.selectedPeer) {
            if isAddingPeer {
                addPeerRow
            }
            ForEach(viewModel.conversations) { conversation in
                conversationRow(conversation)
                    .tag(conversation.peer)
            }
        }
        .listStyle(.plain)
        .background(Color.clear)
    }

    private func conversationRow(_ conversation: MeshConversation) -> some View {
        let messages = viewModel.messages[conversation.peer] ?? []
        let last = messages.last

        return HStack(spacing: 10) {
            avatar(for: conversation.peer)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    Text(peerName(conversation.peer))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.grokText)
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
                    if conversation.unread > 0 {
                        Text("\(conversation.unread)")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(.white)
                            .frame(minWidth: 16, minHeight: 16)
                            .padding(.horizontal, 4)
                            .background(Color.grokAccent)
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(rowBackground(isSelected: viewModel.selectedPeer == conversation.peer))
    }

    private var addPeerRow: some View {
        HStack(spacing: 8) {
            TextField("Node ID", text: $newPeerText)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .foregroundColor(.grokText)
            Button("Add") {
                if let id = UInt32(newPeerText) {
                    viewModel.selectPeer(id)
                    newPeerText = ""
                    isAddingPeer = false
                }
            }
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(.grokAccent)
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Color.grokElevated.opacity(0.2))
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.system(size: 28))
                .foregroundColor(.grokMuted)
            Text("No mesh conversations")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.grokText)
            Text("Tap + to start a chat with a Node ID")
                .font(.system(size: 10))
                .foregroundColor(.grokDim)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func avatar(for peer: UInt32) -> some View {
        ZStack {
            Circle()
                .fill(Color.grokElevated.opacity(0.5))
                .frame(width: 36, height: 36)
            Text(String(peerName(peer).prefix(1)))
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.grokAccent)
        }
    }

    private func peerName(_ peer: UInt32) -> String {
        "Node \(peer)"
    }

    private func preview(for message: MeshChatMessage?) -> String {
        guard let message = message else { return "No messages" }
        if message.messageKind.isMedia {
            return message.messageKind.localizedLabel
        }
        return message.displayText.isEmpty ? message.messageKind.localizedLabel : message.displayText
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
