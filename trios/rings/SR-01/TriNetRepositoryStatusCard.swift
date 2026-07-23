import SwiftUI

enum TriNetRepositoryCardContext {
    case git
    case mesh

    var highlightLimit: Int {
        switch self {
        case .git: return 5
        case .mesh: return 3
        }
    }
}

struct TriNetRepositoryStatusCard: View {
    @ObservedObject var store: TriNetRepositoryStatusStore
    let context: TriNetRepositoryCardContext

    private var snapshot: TriNetRepositorySnapshot { store.snapshot }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            header
            Text(snapshot.repositoryDescription)
                .font(.system(size: 10))
                .foregroundColor(.grokMuted)
                .lineLimit(context == .git ? 2 : 1)

            pullRequestRow
            mainRow
            deliveryFocusRow

            Divider().overlay(Color.grokBorder.opacity(0.7))

            HStack {
                Text("Recent main")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.grokMuted)
                Spacer()
                Text("merge \(snapshot.shortMergeSHA)")
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundColor(.grokDim)
            }

            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(snapshot.recentCommits.prefix(context.highlightLimit))) { commit in
                    commitRow(commit)
                }
            }

            if let error = store.lastError {
                HStack(spacing: 5) {
                    Image(systemName: "exclamationmark.triangle.fill")
                    Text("Live refresh unavailable: \(error). Showing verified data.")
                        .lineLimit(2)
                }
                .font(.system(size: 9))
                .foregroundColor(.orange.opacity(0.85))
            }
        }
        .padding(11)
        .background(Color.grokElevated.opacity(0.24))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.grokBorder.opacity(0.55), lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .onAppear {
            store.refreshIfNeeded()
        }
    }

    private var header: some View {
        HStack(spacing: 7) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.grokText)
            Text("gHashTag/tri-net")
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundColor(.grokText)

            Text(snapshot.source.label)
                .font(.system(size: 8, weight: .bold, design: .monospaced))
                .foregroundColor(snapshot.source == .live ? Color.green : Color.orange)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(
                    (snapshot.source == .live ? Color.green : Color.orange).opacity(0.12)
                )
                .clipShape(Capsule())

            Spacer()

            if store.isLoading {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 14, height: 14)
            }

            Button {
                Task { await store.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.grokMuted)
            }
            .buttonStyle(.plain)
            .disabled(store.isLoading)
            .help("Refresh tri-net from GitHub")

            repositoryLink
        }
    }

    @ViewBuilder
    private var repositoryLink: some View {
        if let url = URL(string: snapshot.repositoryURL) {
            Link(destination: url) {
                Image(systemName: "arrow.up.right.square")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.grokMuted)
            }
            .buttonStyle(.plain)
            .help("Open tri-net on GitHub")
        }
    }

    private var pullRequestRow: some View {
        HStack(spacing: 7) {
            if let url = URL(string: snapshot.pullRequestURL) {
                Link(destination: url) {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.triangle.merge")
                        Text(snapshot.pullRequestStatusText)
                    }
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundColor(snapshot.pullRequestMerged ? Color.green : Color.orange)
                }
                .buttonStyle(.plain)
            }

            Text("\(snapshot.pullRequestCommitCount) commits")
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundColor(.grokMuted)

            Spacer()

            if snapshot.isExactPullRequestMerge {
                Label("exact", systemImage: "checkmark.seal.fill")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(.green.opacity(0.9))
            }
        }
        .help("Merged by \(snapshot.pullRequestMergedBy) at \(snapshot.mergedAtUTCText)")
    }

    private var mainRow: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.branch")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.grokMuted)
            if let url = URL(string: "\(snapshot.repositoryURL)/commit/\(snapshot.currentMainSHA)") {
                Link(snapshot.mainProgressText, destination: url)
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundColor(.grokText)
                    .lineLimit(1)
                    .buttonStyle(.plain)
            } else {
                Text(snapshot.mainProgressText)
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundColor(.grokText)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private var deliveryFocusRow: some View {
        if !snapshot.deliveryFocusText.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "scope")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(.orange.opacity(0.9))
                Text(snapshot.deliveryFocusText)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundColor(.grokMuted)
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Delivery focus: \(snapshot.deliveryFocusText)")
        }
    }

    private func commitRow(_ commit: TriNetCommitHighlight) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Circle()
                .fill(commitColor(commit.headline))
                .frame(width: 5, height: 5)
            Text(commit.shortSHA)
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundColor(.grokMuted)
            if let url = URL(string: commit.url) {
                Link(commit.headline, destination: url)
                    .font(.system(size: 9))
                    .foregroundColor(.grokText)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .buttonStyle(.plain)
            } else {
                Text(commit.headline)
                    .font(.system(size: 9))
                    .foregroundColor(.grokText)
                    .lineLimit(1)
            }
        }
    }

    private func commitColor(_ headline: String) -> Color {
        if headline.contains("security") || headline.contains("INVITE") {
            return .orange
        }
        if headline.hasPrefix("perf") {
            return .blue
        }
        if headline.hasPrefix("fix") || headline.hasPrefix("harden") {
            return .green
        }
        return .grokDim
    }
}
