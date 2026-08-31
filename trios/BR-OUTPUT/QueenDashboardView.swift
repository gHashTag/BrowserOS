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

    /// Mirrors the stored preference so the toggle redraws when flipped.
    @State private var autonomyOn: Bool = ChatViewModel.storedAutonomyPreference

    /// How many rows are shown before the strip scrolls instead of growing.
    ///
    /// Four is the worker ceiling, so a full swarm fits exactly. Past that the
    /// strip keeps its height and scrolls: a supervisor panel that grows with
    /// its contents pushes the transcript underneath it down by a different
    /// amount every tick, which is the single largest source of the screen
    /// moving while you read it.
    private static let maxVisibleRows = 4

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if rows.isEmpty {
                Text("No bees in flight. /delegate <owner/repo#N> <worker> <title> to start one.")
                    .font(TriosType.font(11))
                    .foregroundColor(.grokDim)
                    // Same height as one row, so the first bee to launch does
                    // not shove the conversation down as it appears.
                    .frame(height: Self.rowHeight, alignment: .leading)
            } else {
                let visible = min(rows.count, Self.maxVisibleRows)
                ScrollView(.vertical, showsIndicators: rows.count > Self.maxVisibleRows) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(rows, id: \.id) { task in
                            row(task)
                        }
                    }
                }
                .frame(height: Self.rowHeight * CGFloat(visible))
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
                .font(TriosType.font(11))
                .foregroundColor(.grokMuted)
            Text("SWARM")
                .font(TriosType.font(11, weight: .semibold))
                .foregroundColor(.grokMuted)
                .tracking(1.1)
            Text("\(running.count)/\(QueenDelegationPolicy.maximumConcurrentWorkers) running")
                .font(TriosType.font(11))
                .foregroundColor(.grokDim)
                // Reserved: the count changes on every dispatch, and a label
                // that resizes drags everything after it sideways.
                .frame(width: Self.runningCountWidth, alignment: .leading)
            // Always drawn, so the strip does not reflow the moment a bee
            // finishes. Dimmed to nothing when there is nobody waiting.
            Text("\(waiting.count) awaiting you")
                .font(TriosType.font(11, weight: .semibold))
                .foregroundColor(waiting.isEmpty ? .clear : .yellow)
            Spacer()
            cloudDashboardLink
            autonomyToggle
        }
    }

    /// The way to the swarm that is NOT on this machine.
    ///
    /// This strip reads the local registry, which is the whole board only while
    /// the Queen is the only supervisor. She is not: a tick runs in the
    /// container, takes its own lease, cuts its own worktrees and dispatches its
    /// own bees, and none of that appears in a file on this Mac. An operator
    /// looking here at a quiet strip would conclude the hive is idle while four
    /// bees are working in the cloud.
    ///
    /// A link rather than a mirror, deliberately. Reproducing cloud state in
    /// this view means a second model of the same board, free to disagree with
    /// the first - the defect this whole line of work keeps repairing. The
    /// dashboard the container serves is the one place that state is authored.
    ///
    /// Hidden when no cloud supervisor is configured, because then there is
    /// nothing on the other end of it.
    @ViewBuilder
    private var cloudDashboardLink: some View {
        if let base = QueenLease.endpoint, let url = URL(string: "\(base)/queen/dashboard") {
            Link(destination: url) {
                HStack(spacing: 4) {
                    Image(systemName: "cloud")
                    Text("CLOUD")
                        .tracking(1.1)
                }
                .font(TriosType.font(11, weight: .semibold))
                .foregroundColor(.grokMuted)
            }
            .buttonStyle(.plain)
            .help("The swarm running in the container - lease, last round, dispatches")
        }
    }

    /// The one control that decides whether the Queen starts work by herself.
    ///
    /// It lives here because this strip is the only place on screen that
    /// answers "what is the swarm doing", and "nothing, because you never
    /// turned it on" is one of the answers. Before this there was no control at
    /// all: the preference had a setter and no caller, so in dev - where it
    /// defaults off - the Queen could not be started by any means the app
    /// offered.
    private var autonomyToggle: some View {
        Toggle(isOn: Binding(
            get: { autonomyOn },
            set: { newValue in
                autonomyOn = newValue
                ChatViewModel.storedAutonomyPreference = newValue
            }
        )) {
            Text("Autonomy")
                .font(TriosType.font(11, weight: .medium))
                .foregroundColor(autonomyOn ? .grokText : .grokDim)
        }
        .toggleStyle(.switch)
        .controlSize(.mini)
        .help(autonomyOn
            ? "The Queen picks up open issues on her own, every five minutes."
            : "The Queen acts only when you ask her to.")
    }

    private func row(_ task: DelegatedTask) -> some View {
        let isLive = liveConversationIds.contains(task.conversationId)
        return HStack(spacing: 8) {
            Circle()
                .fill(statusColor(task, isLive: isLive))
                .frame(width: 6, height: 6)

            VStack(alignment: .leading, spacing: 1) {
                Text(task.title)
                    .font(TriosType.font(13, weight: .medium))
                    .foregroundColor(.grokText)
                    .lineLimit(1)
                Text("\(task.issue.slug)  \(task.worker)  \(task.virtualBranch ?? "-")")
                    .font(TriosType.font(11, design: .monospaced))
                    .foregroundColor(.grokDim)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            // A registry state of `running` with no live stream is a stuck bee.
            // Saying so beats a green dot that lies.
            //
            // Reserved to the width of the longest thing it can ever say. The
            // label changes on its own as work progresses - `queued` to
            // `running` to `awaitingReview` is 6, 7 and 14 characters - and
            // because it sits after a Spacer, every one of those transitions
            // used to resize the title column beside it. The row appeared to
            // twitch for no reason a supervisor could see.
            ZStack(alignment: .trailing) {
                Text(Self.widestStatusLabel)
                    .font(TriosType.font(11, weight: .medium))
                    .hidden()
                Text(task.state == .running && !isLive ? "no stream" : task.state.rawValue)
                    .font(TriosType.font(11, weight: .medium))
                    .foregroundColor(statusColor(task, isLive: isLive))
                    .lineLimit(1)
            }

            // One reserved slot rather than two conditional buttons. A task
            // moving from `running` to `awaitingReview` swaps Stop for Review,
            // and the two are different widths, so the swap shifted the row.
            ZStack(alignment: .trailing) {
                Text("Review")
                    .font(TriosType.font(11, weight: .semibold))
                    .hidden()
                if task.state.needsQueenAttention {
                    Button("Review") { onReview(task) }
                        .buttonStyle(.plain)
                        .font(TriosType.font(11, weight: .semibold))
                        .foregroundColor(.yellow)
                } else if task.state == .running {
                    // Available while it runs, which is the only time stopping
                    // helps.
                    Button("Stop") { onCancel(task) }
                        .buttonStyle(.plain)
                        .font(TriosType.font(11, weight: .semibold))
                        .foregroundColor(.orange)
                }
            }
        }
        .frame(height: Self.rowHeight)
        .contentShape(Rectangle())
        .onTapGesture { onOpenTask(task.conversationId) }
        .help("Open \(task.issue.slug)")
    }

    /// The longest label the status column can ever hold.
    ///
    /// Derived from the enum rather than typed out, so a state added later
    /// widens the reservation instead of overflowing it. `no stream` is in the
    /// list because the row can say it and it is not a case of the enum.
    static let widestStatusLabel: String = {
        let candidates = DelegatedTaskState.allCases.map(\.rawValue) + ["no stream"]
        return candidates.max(by: { $0.count < $1.count }) ?? "awaitingReview"
    }()

    /// Width reserved for the running count in the header.
    ///
    /// `4/4 running` is the widest it gets, and it is measured at the current
    /// type scale rather than fixed, because the scale is the operator's to
    /// change and a reservation that ignores it clips the text it was meant to
    /// protect.
    static var runningCountWidth: CGFloat { TriosType.size(11) * 6.2 }

    /// One row: two lines of text plus the breathing room around them.
    ///
    /// Scales with the type so raising the type size grows the strip instead of
    /// cropping its second line.
    static var rowHeight: CGFloat { TriosType.size(13) + TriosType.size(11) + 10 }

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
