import SwiftUI

/// Colour and shape for a delegated task's state.
///
/// One place, so a status reads the same in the sidebar, the swarm strip and
/// the task banner. When each surface picked its own colours, the same task
/// looked green in one and grey in another.
enum QueenTaskStyle {
    static func color(for state: DelegatedTaskState, isLive: Bool = true) -> Color {
        switch state {
        case .running: return isLive ? .green : .orange
        case .awaitingReview: return .yellow
        case .accepted: return .green
        case .rejected: return .orange
        case .failed: return .red
        case .queued: return .grokMuted
        case .cancelled: return .grokDim
        }
    }

    static func symbol(for state: DelegatedTaskState, isLive: Bool = true) -> String {
        switch state {
        case .running: return isLive ? "arrow.triangle.2.circlepath" : "exclamationmark.circle"
        case .awaitingReview: return "hand.raised.fill"
        case .accepted: return "checkmark.circle.fill"
        case .rejected: return "arrow.uturn.backward"
        case .failed: return "xmark.octagon.fill"
        case .queued: return "clock"
        case .cancelled: return "minus.circle"
        }
    }

    /// A running task whose stream has died is not running. Saying "stalled"
    /// beats a spinner that will never stop.
    static func label(for state: DelegatedTaskState, isLive: Bool = true) -> String {
        state == .running && !isLive ? "Stalled" : state.displayName
    }
}

/// Compact status pill used wherever a task appears.
struct QueenTaskStatusPill: View {
    let state: DelegatedTaskState
    var isLive: Bool = true
    var compact: Bool = false

    var body: some View {
        let tint = QueenTaskStyle.color(for: state, isLive: isLive)
        return HStack(spacing: 3) {
            Image(systemName: QueenTaskStyle.symbol(for: state, isLive: isLive))
                .font(.system(size: compact ? 8 : 9, weight: .semibold))
            Text(QueenTaskStyle.label(for: state, isLive: isLive))
                .font(.system(size: compact ? 9 : 10, weight: .semibold))
        }
        .foregroundColor(tint)
        .padding(.horizontal, compact ? 5 : 7)
        .padding(.vertical, compact ? 1 : 2)
        .background(tint.opacity(0.15))
        .clipShape(Capsule())
    }
}

/// Banner pinned above a worker's chat.
///
/// Opening a worker conversation used to show a wall of text with no indication
/// of which issue it served, which branch it owned, or whether anyone was still
/// waiting on it. The transcript answers "what was said"; this answers "what is
/// this and what do I do about it".
struct QueenTaskBanner: View {
    let task: DelegatedTask
    let isLive: Bool
    let usage: QueenWorkerRunner.WorkerUsage?
    let onAccept: () -> Void
    let onReject: () -> Void
    let onCancel: () -> Void
    let onOpenQueen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                QueenTaskStatusPill(state: task.state, isLive: isLive)

                Text(task.issue.slug)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundColor(.grokText)

                Text(task.worker)
                    .font(.system(size: 10))
                    .foregroundColor(.grokMuted)

                Spacer()

                if task.state.needsQueenAttention {
                    Button("Accept", action: onAccept)
                        .buttonStyle(.plain)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.green)
                    Button("Send back", action: onReject)
                        .buttonStyle(.plain)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.orange)
                }

                if task.state == .running {
                    Button("Stop", action: onCancel)
                        .buttonStyle(.plain)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.orange)
                }

                Button(action: onOpenQueen) {
                    Image(systemName: "crown.fill")
                        .font(.system(size: 10))
                        .foregroundColor(.yellow.opacity(0.8))
                }
                .buttonStyle(.plain)
                .help("Back to the Queen")
            }

            HStack(spacing: 10) {
                metric("branch", task.virtualBranch ?? "-")
                metric("owns", task.ownedPaths.isEmpty ? "unrestricted" : task.ownedPaths.joined(separator: ", "))
                if let files = task.committedFiles {
                    metric("committed", files == 0 ? "nothing" : "\(files) file\(files == 1 ? "" : "s")")
                }
                if let spend = spendLabel {
                    metric("spend", spend)
                }
                Spacer()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(QueenTaskStyle.color(for: task.state, isLive: isLive).opacity(0.07))
        .overlay(
            Rectangle()
                .frame(height: 1)
                .foregroundColor(.grokDim.opacity(0.25)),
            alignment: .bottom
        )
    }

    /// Live usage while the bee runs, recorded usage once it stops.
    ///
    /// Each number appears only if it was actually measured. Not every provider
    /// emits usage on the stream, and printing "0 tokens" turns a missing
    /// measurement into a claim about the worker.
    private var spendLabel: String? {
        let total = (usage?.inputTokens ?? task.inputTokens ?? 0)
            + (usage?.outputTokens ?? task.outputTokens ?? 0)
        let tools = usage?.toolCalls ?? task.toolCalls ?? 0

        var parts: [String] = []
        if total > 0 {
            let expensive = total >= QueenDelegationPolicy.workerTokenWarningThreshold
            // Money first when the model is priced. "$0.14" is a number a person
            // can act on; "180k tokens" needs a lookup table they do not have.
            if let cost = task.estimatedCostUSD, cost > 0 {
                parts.append("~\(ModelPricing.format(cost))\(expensive ? " (over budget)" : "")")
                parts.append("\(formatted(total)) tokens")
            } else {
                parts.append("\(formatted(total)) tokens\(expensive ? " (over budget)" : "")")
            }
        }
        if tools > 0 {
            parts.append("\(tools) tool\(tools == 1 ? "" : "s")")
        }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    private func formatted(_ tokens: Int) -> String {
        tokens >= 1000 ? "\(tokens / 1000)k" : "\(tokens)"
    }

    private func metric(_ name: String, _ value: String) -> some View {
        HStack(spacing: 4) {
            Text(name)
                .font(.system(size: 9))
                .foregroundColor(.grokDim)
            Text(value)
                .font(.system(size: 9, design: .monospaced))
                .foregroundColor(.grokMuted)
                .lineLimit(1)
        }
    }
}
