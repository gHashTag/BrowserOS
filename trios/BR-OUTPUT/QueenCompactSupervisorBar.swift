import SwiftUI

/// Supervisor surface for the narrow side panel.
///
/// The swarm strip and the task banner only render above 760pt, and the panel
/// the user actually keeps open is 400pt. So every piece of supervision built
/// so far was invisible in the one place it was needed most: nothing said a bee
/// was running, nothing said a result was waiting, and opening a worker chat
/// showed a wall of text with no indication of what it was.
///
/// One line by default because 400pt is the whole budget. It expands only when
/// tapped, and it says nothing at all when the swarm is empty - a permanent
/// header for an idle hive is a permanent tax on the reading area.
struct QueenCompactSupervisorBar: View {
    @ObservedObject var registry: QueenDelegationRegistry
    let conversationId: UUID
    let liveConversationIds: Set<UUID>
    let onOpenTask: (UUID) -> Void
    let onOpenQueen: () -> Void
    let onAccept: (DelegatedTask) -> Void
    let onCancel: (DelegatedTask) -> Void

    @State private var isExpanded = false

    private var currentTask: DelegatedTask? {
        registry.task(forConversation: conversationId)
    }

    private var isQueenChat: Bool {
        conversationId == ChatConversation.trinityQueenId
    }

    var body: some View {
        Group {
            if let task = currentTask {
                workerBar(task)
            } else if isQueenChat, !registry.open.isEmpty {
                queenBar
            }
        }
    }

    // MARK: - Worker chat

    /// In a worker's chat the only question is "what is this and what do I do
    /// about it", so the bar answers exactly that and offers the two actions.
    private func workerBar(_ task: DelegatedTask) -> some View {
        let isLive = liveConversationIds.contains(task.conversationId)
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                QueenTaskStatusPill(state: task.state, isLive: isLive, compact: true)
                Text(task.issue.slug)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.grokMuted)
                    .lineLimit(1)
                Spacer(minLength: 4)

                if task.state.needsQueenAttention {
                    barButton("Accept", .green) { onAccept(task) }
                }
                if task.state == .running {
                    barButton("Stop", .orange) { onCancel(task) }
                }
                barButton("Queen", .yellow.opacity(0.8), action: onOpenQueen)
            }
            Text(task.virtualBranch ?? "no branch")
                .font(.system(size: 9, design: .monospaced))
                .foregroundColor(.grokDim)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(QueenTaskStyle.color(for: task.state, isLive: isLive).opacity(0.08))
        .overlay(divider, alignment: .bottom)
    }

    // MARK: - Queen chat

    private var queenBar: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                isExpanded.toggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundColor(.grokMuted)
                    Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                        .font(.system(size: 10))
                        .foregroundColor(.grokMuted)
                    Text(summary)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(waitingCount > 0 ? .yellow : .grokMuted)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                ForEach(registry.open) { task in
                    compactRow(task)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.grokElevated.opacity(0.25))
        .overlay(divider, alignment: .bottom)
    }

    private var waitingCount: Int { registry.reviewQueue.count }

    /// Leads with what is owed to the user, because that is the only part that
    /// needs a decision. Running counts are context, not a call to action.
    private var summary: String {
        let running = registry.running.count
        if waitingCount > 0 {
            return "\(waitingCount) needs you  -  \(running)/"
                + "\(QueenDelegationPolicy.maximumConcurrentWorkers) working"
        }
        return "\(running)/\(QueenDelegationPolicy.maximumConcurrentWorkers) working"
    }

    private func compactRow(_ task: DelegatedTask) -> some View {
        let isLive = liveConversationIds.contains(task.conversationId)
        return Button {
            onOpenTask(task.conversationId)
        } label: {
            HStack(spacing: 6) {
                Circle()
                    .fill(QueenTaskStyle.color(for: task.state, isLive: isLive))
                    .frame(width: 5, height: 5)
                Text(task.title)
                    .font(.system(size: 10))
                    .foregroundColor(.grokText)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(QueenTaskStyle.label(for: task.state, isLive: isLive))
                    .font(.system(size: 9, weight: .medium))
                    .foregroundColor(QueenTaskStyle.color(for: task.state, isLive: isLive))
            }
            .padding(.leading, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Shared

    private func barButton(
        _ title: String,
        _ tint: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(title, action: action)
            .buttonStyle(.plain)
            .font(.system(size: 9, weight: .semibold))
            .foregroundColor(tint)
    }

    private var divider: some View {
        Rectangle()
            .frame(height: 1)
            .foregroundColor(.grokDim.opacity(0.2))
    }
}
