// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: untracked mesh-chat file on feat/zai-provider; triage before T27 seal.
// Expires: 2026-12-31
import SwiftUI

/// Thread view for a single mesh chat peer: bubbles + composer.
struct MeshChatThreadView: View {
    @ObservedObject var viewModel: MeshChatViewModel
    let peer: UInt32

    @Namespace private var bottomID

    var body: some View {
        VStack(spacing: 0) {
            threadHeader
            Divider().overlay(Color.grokBorder)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(groupedMessages, id: \.day) { group in
                                    dateHeader(group.day)
                            ForEach(group.messages) { message in
                                bubble(message)
                            }
                        }
                        Color.clear
                            .frame(height: 1)
                            .id(bottomID)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 12)
                }
                .onChange(of: messages.count) { _, _ in
                    scrollToBottom(proxy)
                }
            }
            Divider().overlay(Color.grokBorder)
            composerBar
        }
        .background(Color.clear)
        .onAppear {
            Task { @MainActor in
                await viewModel.ackPeer(peer)
            }
        }
    }

    private var threadHeader: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(Color.grokElevated.opacity(0.5))
                .frame(width: 28, height: 28)
                .overlay(
                    Text("N")
                        .font(TriosType.font(12, weight: .semibold))
                        .foregroundColor(.grokAccent)
                )
            Text("Node \(peer)")
                .font(TriosType.font(13, weight: .semibold))
                .foregroundColor(.grokText)
            Spacer()
            channelBadge
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var channelBadge: some View {
        HStack(spacing: 4) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(TriosType.font(9))
            Text("Ch \(String(viewModel.currentChannel))")
                .font(TriosType.font(9, weight: .semibold))
        }
        .foregroundColor(.grokAccent)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(Color.grokAccent.opacity(0.15))
        .cornerRadius(4)
    }

    private var messages: [MeshChatMessage] {
        viewModel.messages[peer]?.sorted { $0.sentAt < $1.sentAt } ?? []
    }

    private struct DayGroup: Identifiable {
        let day: String
        let messages: [MeshChatMessage]
        var id: String { day }
    }

    private var groupedMessages: [DayGroup] {
        let grouped = Dictionary(grouping: messages) { $0.dayKey }
        return grouped
            .map { DayGroup(day: $0.key, messages: $0.value.sorted { $0.sentAt < $1.sentAt }) }
            .sorted { $0.messages.first?.sentAt ?? 0 < $1.messages.first?.sentAt ?? 0 }
    }

    private func dateHeader(_ day: String) -> some View {
        Text(dayLabel(day))
            .font(TriosType.font(9, weight: .semibold))
            .foregroundColor(.grokDim)
            .padding(.vertical, 4)
            .padding(.horizontal, 8)
            .background(Color.grokElevated.opacity(0.3))
            .cornerRadius(8)
    }

    private func dayLabel(_ day: String) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        guard let date = formatter.date(from: day) else { return day }
        if Calendar.current.isDateInToday(date) { return "Today" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }

    private func bubble(_ message: MeshChatMessage) -> some View {
        HStack {
            if message.isOutgoing { Spacer(minLength: 32) }
            VStack(alignment: message.isOutgoing ? .trailing : .leading, spacing: 4) {
                if message.messageKind.isMedia {
                    mediaContent(message)
                } else {
                    textContent(message)
                }
                HStack(spacing: 4) {
                    Text(message.formattedTime)
                        .font(TriosType.font(9))
                        .foregroundColor(.grokDim)
                    if message.isOutgoing {
                        Image(systemName: message.acked ? "checkmark" : "ellipsis")
                            .font(TriosType.font(8))
                            .foregroundColor(message.acked ? .green : .grokDim)
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                message.isOutgoing
                    ? Color.grokAccent.opacity(0.2)
                    : Color.grokElevated.opacity(0.35)
            )
            .cornerRadius(12)
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(
                        message.isOutgoing
                            ? Color.grokAccent.opacity(0.4)
                            : Color.grokBorder.opacity(0.3),
                        lineWidth: 1
                    )
            )
            if !message.isOutgoing { Spacer(minLength: 32) }
        }
    }

    private func textContent(_ message: MeshChatMessage) -> some View {
        Text(message.displayText)
            .font(TriosType.font(12))
            .foregroundColor(.grokText)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func mediaContent(_ message: MeshChatMessage) -> some View {
        VStack(spacing: 6) {
            Image(systemName: message.messageKind.iconName)
                .font(TriosType.font(22))
                .foregroundColor(.grokAccent)
            Text(message.messageKind.localizedLabel)
                .font(TriosType.font(10, weight: .semibold))
                .foregroundColor(.grokText)
            if !message.displayText.isEmpty {
                Text(message.displayText)
                    .font(TriosType.font(10))
                    .foregroundColor(.grokMuted)
            }
        }
        .frame(minWidth: 80)
    }

    private var composerBar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                TextEditor(text: $viewModel.composerText)
                    .font(TriosType.font(12))
                    .foregroundColor(.grokText)
                    .scrollContentBackground(.hidden)
                    .background(Color.grokElevated.opacity(0.2))
                    .cornerRadius(8)
                    .frame(minHeight: 32, maxHeight: 100)
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(Color.grokBorder.opacity(0.3), lineWidth: 1)
                    )
                    .onChange(of: viewModel.composerText) { _, newValue in
                        if newValue.utf8.count > 200 {
                            // Truncate on a valid Character boundary so we do not
                            // split a multi-byte UTF-8 sequence and clear the field.
                            var capped = newValue
                            while capped.utf8.count > 200, !capped.isEmpty {
                                capped.removeLast()
                            }
                            viewModel.composerText = capped
                        }
                    }
                Button(action: {
                    Task { @MainActor in
                        await viewModel.sendMessage(to: peer)
                    }
                }) {
                    Image(systemName: "paperplane.fill")
                        .font(TriosType.font(14))
                        .foregroundColor(.white)
                        .frame(width: 32, height: 32)
                        .background(
                            viewModel.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                ? Color.grokDim
                                : Color.grokAccent
                        )
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
                .disabled(viewModel.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            HStack {
                Spacer()
                Text("\(viewModel.composerText.utf8.count)/200")
                    .font(TriosType.font(9))
                    .foregroundColor(viewModel.composerText.utf8.count > 180 ? .orange : .grokDim)
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 6)
        }
        .background(Color.grokElevated.opacity(0.15))
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo(bottomID, anchor: .bottom)
        }
    }
}
