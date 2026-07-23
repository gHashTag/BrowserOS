import Foundation

@main
struct TriNetRepositoryStatusTest {
    static func main() throws {
        let snapshot = TriNetRepositorySnapshot.verifiedFallback

        expect(snapshot.pullRequestNumber == 89, "PR number")
        expect(snapshot.pullRequestMerged, "PR is merged")
        expect(snapshot.pullRequestCommitCount == 263, "PR commit count")
        expect(snapshot.shortMergeSHA == "5b147bf", "merge SHA")
        expect(snapshot.isExactPullRequestMerge, "PR head equals merge commit")
        expect(snapshot.shortMainSHA == "e841159", "verified current main SHA")
        expect(snapshot.commitsSinceMerge == 5, "main advanced five commits")
        expect(snapshot.mainProgressText.contains("+5"), "post-merge progress is explicit")
        expect(!snapshot.mainProgressText.contains("0 / 0"), "current main is not shown as zero divergence")
        expect(snapshot.recentCommits.count >= 5, "recent main highlights")
        expect(snapshot.recentCommits.contains(where: { $0.headline.contains("authenticate the INVITE") }), "security fix is visible")
        expect(snapshot.recentCommits.contains(where: { $0.headline.contains("spam-ring hardening") }), "spam hardening is visible")
        expect(snapshot.recentCommits.contains(where: { $0.headline.contains("fuzz the plaintext INVITE listener") }), "listener fuzzing is visible")
        expect(snapshot.deliveryFocusText.contains("Security"), "security focus summary")
        expect(snapshot.deliveryFocusText.contains("spam hardening"), "spam focus summary")
        expect(snapshot.deliveryFocusText.contains("listener fuzzing"), "fuzzing focus summary")
        expect(snapshot.deliveryFocusText.contains("BWE recovery"), "recovery focus summary")

        let pullJSON = Data("""
        {
          "number": 89,
          "title": "Video call app",
          "state": "closed",
          "merged": true,
          "merged_at": "2026-07-22T16:35:26Z",
          "merged_by": {"login": "gHashTag"},
          "merge_commit_sha": "5b147bfb0d0a6c628125dd8aa4bf5d005d40231a",
          "commits": 263,
          "html_url": "https://github.com/gHashTag/tri-net/pull/89",
          "head": {"sha": "5b147bfb0d0a6c628125dd8aa4bf5d005d40231a"}
        }
        """.utf8)
        let payload = try JSONDecoder().decode(TriNetPullRequestPayload.self, from: pullJSON)
        expect(payload.merged, "GitHub merged field decodes")
        expect(payload.commits == 263, "GitHub commit count decodes")
        expect(payload.head.sha == payload.merge_commit_sha, "GitHub exact merge identity decodes")

        let moved = snapshot.replacingMain(
            sha: "abcdef0123456789",
            commitsSinceMerge: 8,
            source: .live
        )
        expect(moved.shortMainSHA == "abcdef0", "live main SHA replacement")
        expect(moved.mainProgressText.contains("+8"), "live post-merge count replacement")
        expect(moved.source == .live, "live source replacement")

        print("All TriNetRepositoryStatus tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
