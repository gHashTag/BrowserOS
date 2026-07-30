// Standalone unit tests for QueenDelegation - Foundation only.
//
// Run (from trios root):
//   swiftc tests/swift/queen_delegation_test.swift rings/SR-00/QueenDelegation.swift \
//     -o /tmp/trios_queen_delegation_test && /tmp/trios_queen_delegation_test

import Foundation

@main
enum QueenDelegationTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    static func task(
        _ issue: Int,
        _ state: DelegatedTaskState,
        paths: [String] = [],
        updated: Double = 0
    ) -> DelegatedTask {
        DelegatedTask(
            conversationId: UUID(),
            issue: IssueReference(owner: "gHashTag", repo: "trios", number: issue),
            title: "Task \(issue)",
            worker: "queen-swift",
            state: state,
            ownedPaths: paths,
            createdAt: t0,
            updatedAt: t0.addingTimeInterval(updated)
        )
    }

    static func main() {
        issueParsing()
        queenNeverCodes()
        concurrencyBound()
        singleWriterOwnership()
        reviewQueueOrder()
        stateMachine()
        virtualBranchNaming()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All QueenDelegation tests passed.")
    }

    static func issueParsing() {
        scenario("a task is bound to exactly one issue, or refuses to bind")

        let short = IssueReference.parse("gHashTag/trios#1086")
        check(short?.number == 1086, "owner/repo#number parses")
        check(short?.owner == "gHashTag" && short?.repo == "trios", "owner and repo are captured")
        check(short?.slug == "gHashTag/trios#1086", "slug round-trips")
        check(
            short?.url == "https://github.com/gHashTag/trios/issues/1086",
            "the issue URL is derived"
        )

        let full = IssueReference.parse("https://github.com/browseros-ai/BrowserOS/issues/2053")
        check(full?.number == 2053, "a full issue URL parses")
        check(full?.repo == "BrowserOS", "repo is captured from the URL")

        // Ambiguity must fail loudly: a task on the wrong issue is worse than
        // one that never starts.
        check(IssueReference.parse("") == nil, "empty input is rejected")
        check(IssueReference.parse("just some text") == nil, "free text is rejected")
        check(IssueReference.parse("trios#12") == nil, "a missing owner is rejected")
        check(IssueReference.parse("gHashTag/trios#0") == nil, "issue zero is rejected")
        check(IssueReference.parse("gHashTag/trios#abc") == nil, "a non-numeric issue is rejected")
        check(
            IssueReference.parse("https://gitlab.com/a/b/issues/1") == nil,
            "a non-GitHub URL is rejected"
        )
    }

    /// The defining constraint: the Queen delegates, she does not code.
    static func queenNeverCodes() {
        scenario("the Queen may not write code herself")

        for tool in ["filesystem_write", "shell_execute", "edit", "bash", "run_command", "write_file"] {
            check(!QueenDelegationPolicy.queenMayUse(tool: tool), "the Queen may not use \(tool)")
        }
        check(
            !QueenDelegationPolicy.queenMayUse(tool: "SHELL_EXECUTE"),
            "the restriction is case-insensitive"
        )
        for tool in ["filesystem_read", "get_active_page", "search", "github_list_issues"] {
            check(QueenDelegationPolicy.queenMayUse(tool: tool), "the Queen may still use \(tool)")
        }
    }

    static func concurrencyBound() {
        scenario("the swarm is bounded so review cost and merge conflicts stay bounded")

        check(QueenDelegationPolicy.canStartAnother(running: 0), "an idle Queen can delegate")
        check(
            QueenDelegationPolicy.canStartAnother(running: QueenDelegationPolicy.maximumConcurrentWorkers - 1),
            "one below the cap is allowed"
        )
        check(
            !QueenDelegationPolicy.canStartAnother(running: QueenDelegationPolicy.maximumConcurrentWorkers),
            "at the cap no new worker starts"
        )
        check(
            !QueenDelegationPolicy.canStartAnother(running: 99),
            "over the cap no new worker starts"
        )
    }

    /// Structural conflict prevention: catch the clash at delegation time, not
    /// at merge time.
    static func singleWriterOwnership() {
        scenario("two workers cannot own the same file")

        let existing = [
            task(1, .running, paths: ["rings/SR-02/ChatViewModel.swift"]),
            task(2, .running, paths: ["BR-OUTPUT/ModelsTabView.swift"]),
            task(3, .accepted, paths: ["rings/SR-00/ModelProvider.swift"]),
        ]

        let clash = QueenDelegationPolicy.conflictingTasks(
            for: ["rings/SR-02/ChatViewModel.swift"],
            among: existing
        )
        check(clash.count == 1, "a live overlap is detected")
        check(clash.first?.issue.number == 1, "the conflicting task is named")

        check(
            QueenDelegationPolicy.conflictingTasks(for: ["docs/NEW.md"], among: existing).isEmpty,
            "an untouched path is free"
        )

        // A finished task no longer owns anything.
        check(
            QueenDelegationPolicy.conflictingTasks(
                for: ["rings/SR-00/ModelProvider.swift"],
                among: existing
            ).isEmpty,
            "a completed task releases its files"
        )

        // Path spelling must not defeat the check.
        check(
            !QueenDelegationPolicy.conflictingTasks(
                for: ["./rings/SR-02/ChatViewModel.swift"],
                among: existing
            ).isEmpty,
            "a leading ./ still collides"
        )
        check(
            !QueenDelegationPolicy.conflictingTasks(
                for: ["/rings/SR-02/ChatViewModel.swift"],
                among: existing
            ).isEmpty,
            "a leading slash still collides"
        )
        check(
            QueenDelegationPolicy.conflictingTasks(for: [], among: existing).isEmpty,
            "claiming nothing conflicts with nothing"
        )
    }

    static func reviewQueueOrder() {
        scenario("the Queen sees what needs her, oldest first")

        let tasks = [
            task(10, .running, updated: 50),
            task(11, .awaitingReview, updated: 30),
            task(12, .failed, updated: 10),
            task(13, .accepted, updated: 5),
            task(14, .rejected, updated: 20),
        ]
        let queue = QueenDelegationPolicy.reviewQueue(tasks)
        check(queue.count == 3, "only attention-needing work is queued")
        check(
            queue.map(\.issue.number) == [12, 14, 11],
            "oldest first, so nothing starves behind a busy worker"
        )
        check(
            !queue.contains { $0.state == .running },
            "a healthy running worker does not demand attention"
        )
        check(
            !queue.contains { $0.state == .accepted },
            "accepted work leaves the queue"
        )

        // Everything above is also what age-only ordering produces: 12, 14 and
        // 11 are the oldest three in that order, so the fixture agrees with the
        // rule it was meant to replace and cannot tell them apart. Removing the
        // age cap from QueenSalience left every check in this project green.
        //
        // These two can tell. `now` is pinned so the ages are known rather than
        // whatever the clock says.
        let now = t0.addingTimeInterval(400 * 3600)
        let recentFailure = task(20, .failed, updated: 399 * 3600)
        let ancientButFine = task(21, .awaitingReview, updated: 0)
        let ranked = QueenDelegationPolicy.reviewQueue(
            [ancientButFine, recentFailure], now: now
        )
        check(
            ranked.map(\.issue.number) == [20, 21],
            "a failure an hour old outranks a quiet task from a fortnight ago"
        )

        // Ties break on age, so an equally salient task cannot starve. Fed
        // newest-first, the queue must still hand back oldest-first.
        let older = task(30, .failed, updated: 100)
        let newer = task(31, .failed, updated: 900)
        check(
            QueenDelegationPolicy.reviewQueue([newer, older], now: now)
                .map(\.issue.number) == [30, 31],
            "and two equally loud tasks come back oldest first, not in the order they arrived"
        )
    }

    static func stateMachine() {
        scenario("only real lifecycles are allowed")

        check(QueenDelegationPolicy.canTransition(from: .queued, to: .running), "queued starts")
        check(QueenDelegationPolicy.canTransition(from: .running, to: .awaitingReview), "running reports back")
        check(QueenDelegationPolicy.canTransition(from: .awaitingReview, to: .accepted), "review accepts")
        check(QueenDelegationPolicy.canTransition(from: .awaitingReview, to: .rejected), "review rejects")
        check(QueenDelegationPolicy.canTransition(from: .rejected, to: .running), "rejected work is retried")
        check(QueenDelegationPolicy.canTransition(from: .failed, to: .running), "failed work is retried")

        // The transition that would let unfinished work be declared done.
        check(
            !QueenDelegationPolicy.canTransition(from: .queued, to: .accepted),
            "work cannot be accepted without ever running"
        )
        check(
            !QueenDelegationPolicy.canTransition(from: .running, to: .accepted),
            "the Queen must review before accepting"
        )
        check(
            !QueenDelegationPolicy.canTransition(from: .accepted, to: .running),
            "accepted work is terminal"
        )
        check(
            !QueenDelegationPolicy.canTransition(from: .cancelled, to: .running),
            "cancelled work is terminal"
        )
        check(DelegatedTaskState.accepted.isTerminal, "accepted is terminal")
        check(!DelegatedTaskState.running.isTerminal, "running is not terminal")
        check(DelegatedTaskState.failed.needsQueenAttention, "failure demands attention")
    }

    /// Virtual branches are what let several bees share one checkout.
    static func virtualBranchNaming() {
        scenario("each task maps deterministically to its own virtual branch")

        let issue = IssueReference(owner: "gHashTag", repo: "trios", number: 1086)
        let name = QueenBranchPolicy.branchName(for: issue, title: "Fix LOGS tab noise profile")
        check(name == "queen/1086-fix-logs-tab-noise-profile", "the branch name reads from the issue and title")

        // Determinism is the point: reconnecting must find the same branch
        // rather than opening a second one for the same issue.
        let again = QueenBranchPolicy.branchName(for: issue, title: "Fix LOGS tab noise profile")
        check(name == again, "the same task always maps to the same branch")

        check(
            QueenBranchPolicy.branchName(for: issue, title: "") == "queen/1086",
            "an empty title still yields a valid branch"
        )

        // Git refs reject many characters; mangling them would break the mapping.
        let messy = QueenBranchPolicy.branchName(
            for: issue,
            title: "Fix: z.ai 1113 -- \"balance\" (again)!"
        )
        check(
            !messy.contains(where: { $0 == " " || $0 == "\"" || $0 == ":" }),
            "punctuation and spaces never reach the branch name"
        )
        check(messy.hasPrefix("queen/1086-"), "the issue number still leads")

        let long = QueenBranchPolicy.branchName(
            for: issue,
            title: String(repeating: "verylongword ", count: 20)
        )
        check(
            long.count <= "queen/1086-".count + QueenBranchPolicy.maximumSlugLength,
            "a long title is truncated rather than producing an unusable ref"
        )

        check(QueenBranchPolicy.isQueenBranch("queen/1086-x"), "queen branches are recognised")
        check(!QueenBranchPolicy.isQueenBranch("feat/zai-provider"), "unrelated branches are left alone")
        check(!QueenBranchPolicy.isQueenBranch("main"), "main is left alone")
        check(
            QueenBranchPolicy.issueNumber(fromBranch: "queen/1086-fix-logs") == 1086,
            "the issue number is recoverable from the branch"
        )
        check(
            QueenBranchPolicy.issueNumber(fromBranch: "feat/other") == nil,
            "a non-queen branch yields no issue"
        )
    }
}
