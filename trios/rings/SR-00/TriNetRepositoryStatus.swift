import Foundation

enum TriNetRepositorySnapshotSource: String, Equatable, Sendable {
    case live
    case verifiedFallback

    var label: String {
        switch self {
        case .live: return "LIVE"
        case .verifiedFallback: return "VERIFIED"
        }
    }
}

struct TriNetCommitHighlight: Identifiable, Equatable, Sendable {
    let sha: String
    let headline: String
    let url: String

    var id: String { sha }
    var shortSHA: String { String(sha.prefix(7)) }
}

struct TriNetRepositorySnapshot: Equatable, Sendable {
    let repositoryURL: String
    let repositoryDescription: String
    let defaultBranch: String
    let pullRequestNumber: Int
    let pullRequestTitle: String
    let pullRequestURL: String
    let pullRequestMerged: Bool
    let pullRequestMergedAt: String
    let pullRequestMergedBy: String
    let pullRequestCommitCount: Int
    let pullRequestHeadSHA: String
    let mergeCommitSHA: String
    let currentMainSHA: String
    let commitsSinceMerge: Int
    let recentCommits: [TriNetCommitHighlight]
    let source: TriNetRepositorySnapshotSource
    let fetchedAt: Date

    var shortMergeSHA: String { String(mergeCommitSHA.prefix(7)) }
    var shortMainSHA: String { String(currentMainSHA.prefix(7)) }
    var isExactPullRequestMerge: Bool {
        pullRequestMerged && pullRequestHeadSHA == mergeCommitSHA
    }

    var pullRequestStatusText: String {
        let status = pullRequestMerged ? "MERGED" : "OPEN"
        return "PR #\(pullRequestNumber) \(status)"
    }

    var mainProgressText: String {
        if currentMainSHA == mergeCommitSHA {
            return "main \(shortMainSHA) / exact PR merge"
        }
        return "main \(shortMainSHA) / +\(commitsSinceMerge) after PR merge"
    }

    var deliveryFocusText: String {
        let corpus = recentCommits
            .map(\.headline)
            .joined(separator: " ")
            .lowercased()
        var focus: [String] = []

        if corpus.contains("security") || corpus.contains("invite") || corpus.contains("forced-camera") {
            focus.append("Security")
        }
        if corpus.contains("spam-ring") || corpus.contains("spam hardening") {
            focus.append("spam hardening")
        }
        if corpus.contains("fuzz") && corpus.contains("listener") {
            focus.append("listener fuzzing")
        }
        if corpus.contains("recovery") || corpus.contains("bwe") {
            focus.append("BWE recovery")
        }

        return focus.joined(separator: " / ")
    }

    var mergedAtUTCText: String {
        guard let date = ISO8601DateFormatter().date(from: pullRequestMergedAt) else {
            return pullRequestMergedAt
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd HH:mm 'UTC'"
        return formatter.string(from: date)
    }

    func replacingMain(
        sha: String,
        commitsSinceMerge: Int,
        source: TriNetRepositorySnapshotSource
    ) -> TriNetRepositorySnapshot {
        TriNetRepositorySnapshot(
            repositoryURL: repositoryURL,
            repositoryDescription: repositoryDescription,
            defaultBranch: defaultBranch,
            pullRequestNumber: pullRequestNumber,
            pullRequestTitle: pullRequestTitle,
            pullRequestURL: pullRequestURL,
            pullRequestMerged: pullRequestMerged,
            pullRequestMergedAt: pullRequestMergedAt,
            pullRequestMergedBy: pullRequestMergedBy,
            pullRequestCommitCount: pullRequestCommitCount,
            pullRequestHeadSHA: pullRequestHeadSHA,
            mergeCommitSHA: mergeCommitSHA,
            currentMainSHA: sha,
            commitsSinceMerge: commitsSinceMerge,
            recentCommits: recentCommits,
            source: source,
            fetchedAt: Date()
        )
    }

    static let verifiedFallback = TriNetRepositorySnapshot(
        repositoryURL: "https://github.com/gHashTag/tri-net",
        repositoryDescription: "TRI-NET self-organizing relay-drone and fixed-node internet mesh.",
        defaultBranch: "main",
        pullRequestNumber: 89,
        pullRequestTitle: "Video call app (Mac + iOS): calls, adaptive video, mesh robustness + t27 migration & audits",
        pullRequestURL: "https://github.com/gHashTag/tri-net/pull/89",
        pullRequestMerged: true,
        pullRequestMergedAt: "2026-07-22T16:35:26Z",
        pullRequestMergedBy: "gHashTag",
        pullRequestCommitCount: 263,
        pullRequestHeadSHA: "5b147bfb0d0a6c628125dd8aa4bf5d005d40231a",
        mergeCommitSHA: "5b147bfb0d0a6c628125dd8aa4bf5d005d40231a",
        currentMainSHA: "e841159be4d3eb536b6bcbdf8e921ca573c907c2",
        commitsSinceMerge: 5,
        recentCommits: [
            TriNetCommitHighlight(
                sha: "e841159be4d3eb536b6bcbdf8e921ca573c907c2",
                headline: "perf(bwe): probe-up gate 3->2, cuts recovery 26s->17s",
                url: "https://github.com/gHashTag/tri-net/commit/e841159be4d3eb536b6bcbdf8e921ca573c907c2"
            ),
            TriNetCommitHighlight(
                sha: "7096309",
                headline: "harden(security): INVITE seen-MAC cache (defense-in-depth anti-replay)",
                url: "https://github.com/gHashTag/tri-net/commit/7096309"
            ),
            TriNetCommitHighlight(
                sha: "b467cd1",
                headline: "fix(security): INVITE anti-replay via freshness timestamp",
                url: "https://github.com/gHashTag/tri-net/commit/b467cd1"
            ),
            TriNetCommitHighlight(
                sha: "8eec0e1",
                headline: "fix(security): authenticate the INVITE (HMAC) - closes forced-camera exfiltration",
                url: "https://github.com/gHashTag/tri-net/commit/8eec0e1"
            ),
            TriNetCommitHighlight(
                sha: "5b147bf",
                headline: "docs(security): CONFIRMED unauthenticated forced-camera exfiltration via group INVITE",
                url: "https://github.com/gHashTag/tri-net/commit/5b147bf"
            ),
            TriNetCommitHighlight(
                sha: "1146716",
                headline: "fix(phone): reject participant-less INVITEs (spam-ring hardening, both platforms)",
                url: "https://github.com/gHashTag/tri-net/commit/1146716"
            ),
            TriNetCommitHighlight(
                sha: "c39b04d",
                headline: "docs(skill): fuzz the plaintext INVITE listener on :7000 (no crash)",
                url: "https://github.com/gHashTag/tri-net/commit/c39b04d"
            )
        ],
        source: .verifiedFallback,
        fetchedAt: Date(timeIntervalSince1970: 1_785_000_000)
    )
}

struct TriNetGitHubUserPayload: Codable, Equatable {
    let login: String
}

struct TriNetGitHubHeadPayload: Codable, Equatable {
    let sha: String
}

struct TriNetPullRequestPayload: Codable, Equatable {
    let number: Int
    let title: String
    let state: String
    let merged: Bool
    let merged_at: String
    let merged_by: TriNetGitHubUserPayload
    let merge_commit_sha: String
    let commits: Int
    let html_url: String
    let head: TriNetGitHubHeadPayload
}

struct TriNetRepositoryPayload: Codable, Equatable {
    let description: String?
    let default_branch: String
    let html_url: String
}

struct TriNetCommitAuthorPayload: Codable, Equatable {
    let date: String
}

struct TriNetCommitDetailPayload: Codable, Equatable {
    let message: String
    let author: TriNetCommitAuthorPayload
}

struct TriNetCommitPayload: Codable, Equatable {
    let sha: String
    let html_url: String
    let commit: TriNetCommitDetailPayload
}

struct TriNetComparePayload: Codable, Equatable {
    let status: String
    let ahead_by: Int
    let behind_by: Int
    let total_commits: Int
}
