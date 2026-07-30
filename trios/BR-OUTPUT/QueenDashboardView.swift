import SwiftUI

/// Live supervisor strip shown above the Queen's chat.
///
/// The chat transcript is a log: it says what happened, in order, forever. A
/// supervisor also needs the opposite - what is true right now, in one glance,
/// without scrolling. This is that half. It appears only in the Queen's own
/// conversation, because it is the only place the answer to "what is everyone
/// doing" is the point of the screen.
struct QueenDashboardView: View {
    @ObservedObject var registry: QueenDelegationRegistry
    /// Conversations the runner is streaming into right now. A task can be
    /// `running` in the registry while its stream has already died, and the
    /// difference is exactly what a supervisor needs to see.
    let liveConversationIds: Set<UUID>
    let onOpenTask: (UUID) -> Void
    let onReview: (DelegatedTask) -> Void
    let onCancel: (DelegatedTask) -> Void

    private var running: [DelegatedTask] { registry.running }
    private var waiting: [DelegatedTask] { registry.reviewQueue }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if registry.active.isEmpty && waiting.isEmpty {
                Text("No bees in flight. /delegate <owner/repo#N> <worker> <title> to start one.")
                    .font(.system(size: 11))
                    .foregroundColor(.grokDim)
            } else {
                ForEach(rows, id: \.id) { task in
                    row(task)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.grokElevated.opacity(0.25))
        .overlay(
            Rectangle()
                .frame(height: 1)
                .foregroundColor(.grokDim.opacity(0.25)),
            alignment: .bottom
        )
    }

    /// Attention first, then work in progress. A supervisor's screen should
    /// order by what it wants from you, not by when the task was created.
    private var rows: [DelegatedTask] {
        waiting + running.filter { task in !waiting.contains { $0.id == task.id } }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                .font(.system(size: 11))
                .foregroundColor(.grokMuted)
            Text("SWARM")
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(.grokMuted)
                .tracking(1.1)
            Text("\(running.count)/\(QueenDelegationPolicy.maximumConcurrentWorkers) running")
                .font(.system(size: 10))
                .foregroundColor(.grokDim)
            if !waiting.isEmpty {
                Text("\(waiting.count) awaiting you")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.yellow)
            }
            Spacer()
        }
    }

    private func row(_ task: DelegatedTask) -> some View {
        let isLive = liveConversationIds.contains(task.conversationId)
        return HStack(spacing: 8) {
            Circle()
                .fill(statusColor(task, isLive: isLive))
                .frame(width: 6, height: 6)

            VStack(alignment: .leading, spacing: 1) {
                Text(task.title)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.grokText)
                    .lineLimit(1)
                Text("\(task.issue.slug)  \(task.worker)  \(task.virtualBranch ?? "-")")
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundColor(.grokDim)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            // A registry state of `running` with no live stream is a stuck bee.
            // Saying so beats a green dot that lies.
            Text(task.state == .running && !isLive ? "no stream" : task.state.rawValue)
                .font(.system(size: 9, weight: .medium))
                .foregroundColor(statusColor(task, isLive: isLive))

            if task.state.needsQueenAttention {
                Button("Review") { onReview(task) }
                    .buttonStyle(.plain)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.yellow)
            }
            // Available while it runs, which is the only time stopping helps.
            if task.state == .running {
                Button("Stop") { onCancel(task) }
                    .buttonStyle(.plain)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.orange)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture { onOpenTask(task.conversationId) }
        .help("Open \(task.issue.slug)")
    }

    private func statusColor(_ task: DelegatedTask, isLive: Bool) -> Color {
        switch task.state {
        case .running: return isLive ? .green : .orange
        case .awaitingReview: return .yellow
        // Accepted is dimmed because it is still waiting on its merge; merged
        // is the state that is actually over.
        case .accepted: return .grokDim
        case .merged: return .green
        case .failed, .rejected: return .red
        case .queued: return .grokMuted
        case .cancelled: return .grokDim
        }
    }
}
