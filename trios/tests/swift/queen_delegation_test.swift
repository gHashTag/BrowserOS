// Standalone unit tests for QueenDelegation - Foundation only.
//
// Run (from trios root):
//   swiftc tests/swift/queen_delegation_test.swift rings/SR-00/QueenDelegation.swift \
//     -o /tmp/trios_queen_delegation_test && /tmp/trios_queen_delegation_test

import Foundation
import QueenCore

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
        forbiddenQueenToolCall()
        stateMachine()
        virtualBranchNaming()
        spokenForIsNotTheSameAsWorkedOn()
        budgetKnobParsing()
        pullRequestGuardReadsTheBranch()
        unpublishableWorkIsRefusedBeforeSpending()
        reviewBoundaryAgesOut()
        aRefusedTurnIsNotTheIssuesFault()

        // ── QueenIssueBoundary: the rule the container now runs too ──
        //
        // It answered the same thing for every candidate before this file
        // existed, because `choose` judged them all against a hardcoded
        // `rings/SR-00`. These pin the three answers that must stay distinct:
        // paths, no section at all, and an empty section.
        check(QueenIssueBoundary.paths(from:
                "## What\n\ndo it\n\n## Boundary\n\n`rings/SR-02/Foo.swift`\n")
              == ["rings/SR-02/Foo.swift"],
              "a boundary section yields its paths")
        check(QueenIssueBoundary.paths(from: "## Границы\n\nrings/SR-00/Bar.swift")
              == ["rings/SR-00/Bar.swift"],
              "the Russian heading parses too - most issues predate the rule")
        check(QueenIssueBoundary.paths(from: "## What\n\nno boundary here") == nil,
              "no section is nil, not an empty conflict set")
        check(QueenIssueBoundary.paths(from: "## Boundary\n\n") == [],
              "an empty section is [] and still not nil")
        check(QueenIssueBoundary.paths(from:
                "## Boundary\n\na/b.swift\n\n## Notes\n\nc/d.swift")
              == ["a/b.swift"],
              "the section ends at the next heading")
        // A path in backticks followed by a comma: the shape that put a
        // trailing backtick on five of sixty-three live boundary paths, so the
        // committer staged nothing and the bee read as having done nothing.
        check(QueenIssueBoundary.pathToken(from: "`rings/SR-02/ChatViewModel.swift`,")
              == "rings/SR-02/ChatViewModel.swift",
              "a backticked path with a trailing comma comes out clean")
        check(QueenIssueBoundary.pathToken(from: "rings/SR-00/A.swift see notes")
              == "rings/SR-00/A.swift",
              "prose after the path does not become the path")
        check(QueenIssueBoundary.pathToken(from: "just some words") == nil,
              "a line with no path-shaped token yields nil")
        // A list marker separated from its path by a tab. Splitting on the
        // ASCII space alone returned "-\trings/SR-00/Foo.swift" here while
        // queen-tick.ts, splitting on /\s+/, returned "rings/SR-00/Foo.swift"
        // from the same line - the board and the Queen reading one issue two
        // ways. The outer trim only reaches the ends of the line, and no strip
        // removes a "-", so the fused token survived and still contained "/".
        check(QueenIssueBoundary.pathToken(from: "-\trings/SR-00/Foo.swift")
              == "rings/SR-00/Foo.swift",
              "a tab between the marker and the path is a token boundary")
        check(QueenIssueBoundary.paths(from: "## Boundary\n\n-\ta/b.swift\n")
              == ["a/b.swift"],
              "a tab-separated boundary line yields the path alone")

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All QueenDelegation tests passed.")
    }

    /// Work that could not leave the machine that did it.
    ///
    /// This scenario used to assert a guard keyed on `serverIsRemote &&
    /// committerRunsLocally`. Both were derived from one value and were exact
    /// negations, so the conjunction was `x && !x` and the guard could never
    /// fire - the tests passed because they called the function directly with
    /// hand-written arguments the program could never produce. That is the
    /// failure mode this file exists to catch, so it is worth naming: a unit
    /// test proves the function, never the wiring.
    /// A boundary held by a task nobody is working on.
    ///
    /// Measured 2026-08-29: three tasks in awaitingReview, two of them 5 days
    /// 9 hours old, holding one path each. Thirteen ticks in the same session,
    /// every one reporting capacity free, 78 boundary_taken skips, and zero
    /// delegations.
    /// A turn the server refused before a byte arrived.
    ///
    /// Measured 2026-08-29 on the first autonomous delegation into the cloud:
    /// /chat answered 403, the runner recorded a terminal turn with zero output
    /// tokens, zero tool calls and no commit, and this was classified
    /// `unmeasured` - which counts against the issue. Two such refusals retired
    /// #1111 as "attempts have already failed on their own merits". The
    /// perimeter had failed; the work was never reached.
    static func aRefusedTurnIsNotTheIssuesFault() {
        scenario("a turn that produced nothing is not a failure on the merits")

        check(QueenRetryPolicy.classify(
            streamOutcome: "terminal", completedTurns: 1, toolCalls: 0,
            committedFiles: nil, outputTokens: 0) == .interrupted,
            "zero tokens, zero tools, no commit: the attempt never happened")

        // A worker that SAID something and then failed is a real attempt.
        check(QueenRetryPolicy.classify(
            streamOutcome: "terminal", completedTurns: 1, toolCalls: 0,
            committedFiles: nil, outputTokens: 400) == .unmeasured,
            "a worker that spoke is measured as before")

        // So is one that called a tool without speaking.
        check(QueenRetryPolicy.classify(
            streamOutcome: "terminal", completedTurns: 1, toolCalls: 3,
            committedFiles: nil, outputTokens: 0) == .unmeasured,
            "a worker that used a tool did something")

        // nil is not zero: nobody counted, which is not nothing happened.
        check(QueenRetryPolicy.classify(
            streamOutcome: "terminal", completedTurns: 1, toolCalls: 0,
            committedFiles: nil, outputTokens: nil) == .unmeasured,
            "an uncounted turn stays unmeasured, not excused")

        check(QueenFailureKind.interrupted.countsAgainstTheIssue == false,
              "and interrupted is the kind that does not retire an issue")
    }

    static func reviewBoundaryAgesOut() {
        scenario("a review boundary stops excluding everyone after two days")

        let now = Date()
        func aged(_ state: DelegatedTaskState, hours: Double) -> DelegatedTask {
            DelegatedTask(
                conversationId: UUID(),
                issue: IssueReference(owner: "gHashTag", repo: "trios", number: 1),
                title: "held",
                worker: "queen-swift",
                state: state,
                ownedPaths: ["docs"],
                createdAt: now.addingTimeInterval(-hours * 3600),
                updatedAt: now.addingTimeInterval(-hours * 3600)
            )
        }

        check(QueenDelegationPolicy.conflictingTasks(
            for: ["docs"], among: [aged(.awaitingReview, hours: 2)], now: now
        ).count == 1,
        "a review from this morning still holds its boundary")

        check(QueenDelegationPolicy.conflictingTasks(
            for: ["docs"], among: [aged(.awaitingReview, hours: 129)], now: now
        ).isEmpty,
        "a review held 5 days stops excluding everyone else")

        // Only awaitingReview ages out. A running bee may be writing right now,
        // and a rejected one is expected back on those same files.
        for state in [DelegatedTaskState.running, .queued, .rejected] {
            check(QueenDelegationPolicy.conflictingTasks(
                for: ["docs"], among: [aged(state, hours: 500)], now: now
            ).count == 1,
            "\(state) keeps its boundary however old it is")
        }

        check(QueenDelegationPolicy.conflictingTasks(
            for: ["docs"], among: [aged(.accepted, hours: 1)], now: now
        ).isEmpty,
        "an accepted task holds nothing")
    }

    static func unpublishableWorkIsRefusedBeforeSpending() {
        scenario("unpublishable work is refused before spending")

        check(QueenDelegationPolicy.unpublishableWorkRefusal(
            workHappensRemotely: false, canPublish: true) == nil,
            "local work that can be pushed is allowed")

        check(QueenDelegationPolicy.unpublishableWorkRefusal(
            workHappensRemotely: false, canPublish: false) == nil,
            "local work is allowed even when a push would fail: git says why, "
                + "and the commit is still on this machine")

        let refusal = QueenDelegationPolicy.unpublishableWorkRefusal(
            workHappensRemotely: true, canPublish: false)
        check(refusal != nil, "remote work with no way back is refused")
        check(refusal?.contains("discarded by the next deploy") == true,
              "the refusal names what is lost, not just the condition")

        // The two arguments are independent facts, which the guard this
        // replaced was not. When a branch can be carried out of the container
        // this stops refusing on its own.
        check(QueenDelegationPolicy.unpublishableWorkRefusal(
            workHappensRemotely: true, canPublish: true) == nil,
            "remote work that can be published is allowed")
    }

    /// A second turn that changes nothing is not an empty branch.
    ///
    /// Measured 2026-08-23 on #1287: the bee did the work in its first turn,
    /// the second turn committed nothing because nothing was left to do, and
    /// the guard refused a pull request for a branch carrying two real
    /// commits - "the worker committed nothing" said about work sitting in
    /// git.
    static func pullRequestGuardReadsTheBranch() {
        scenario("a zero file count with a named commit is a branch, not an empty one")

        func task(files: Int?, sha: String?) -> DelegatedTask {
            var t = DelegatedTask(
                conversationId: UUID(),
                issue: IssueReference(owner: "gHashTag", repo: "trios", number: 1287),
                title: "poll",
                worker: "queen-swift",
                ownedPaths: ["rings/SR-02/ChatViewModel.swift"]
            )
            t.state = .awaitingReview
            t.virtualBranch = "queen/1287"
            t.committedFiles = files
            t.committedSHA = sha
            return t
        }

        check(
            QueenDelegationPolicy.pullRequestBlockReason(
                for: task(files: 0, sha: "5120d52d92f7")
            ) == nil,
            "zero files but a named commit proposes fine - the branch is the evidence"
        )
        check(
            QueenDelegationPolicy.pullRequestBlockReason(
                for: task(files: 0, sha: nil)
            )?.contains("committed nothing") == true,
            "zero files AND no commit is genuinely nothing to propose"
        )
        check(
            QueenDelegationPolicy.pullRequestBlockReason(
                for: task(files: 0, sha: "")
            )?.contains("committed nothing") == true,
            "an empty SHA is absent, not present - the distinction this repository keeps re-learning"
        )
        check(
            QueenDelegationPolicy.pullRequestBlockReason(
                for: task(files: 3, sha: "5120d52d92f7")
            ) == nil,
            "the ordinary case still passes"
        )
    }

    /// The daily cap is the operator's budget decision, delivered through a
    /// knob file. A corrupt or absurd knob must fall back to the default
    /// rather than silently disabling the ceiling - the knob raises the cap,
    /// it must never be able to remove it by accident.
    static func budgetKnobParsing() {
        scenario("the operator's budget knob parses strictly or not at all")

        check(
            SwarmBudget.parsed(knobJSON: Data(#"{"dailyCapUSD": 30}"#.utf8))
                == SwarmBudget(dailyLimitUSD: 30_000_000),
            "an integer dollar knob becomes exact micro-dollars"
        )
        check(
            SwarmBudget.parsed(knobJSON: Data(#"{"dailyCapUSD": 12.5}"#.utf8))
                == SwarmBudget(dailyLimitUSD: 12_500_000),
            "a fractional dollar knob keeps its cents"
        )
        check(
            SwarmBudget.parsed(knobJSON: Data(#"{"dailyCapUSD": "25"}"#.utf8))
                == SwarmBudget(dailyLimitUSD: 25_000_000),
            "a quoted number still parses - operators edit JSON by hand"
        )
        check(
            SwarmBudget.parsed(knobJSON: Data(#"{"dailyCapUSD": 0}"#.utf8)) == nil,
            "zero is refused: a knob cannot switch the ceiling off"
        )
        check(
            SwarmBudget.parsed(knobJSON: Data(#"{"dailyCapUSD": -5}"#.utf8)) == nil,
            "a negative cap is refused"
        )
        check(
            SwarmBudget.parsed(knobJSON: Data(#"{"dailyCapUSD": 2000000}"#.utf8)) == nil,
            "an absurd cap (over $1M/day) is refused as a typo, not obeyed"
        )
        check(
            SwarmBudget.parsed(knobJSON: Data("not json".utf8)) == nil,
            "garbage falls back to nil so the caller keeps the default"
        )
        check(
            SwarmBudget.parsed(knobJSON: Data(#"{"daily_cap": 30}"#.utf8)) == nil,
            "a wrong key name is not guessed at"
        )
    }

    /// The release tick printed "a worker already has it" eight times in one
    /// pass. The registry it printed that from held no running task at all:
    /// eleven accepted, three merged, five awaitingReview. Every one of those
    /// eight lines was false, and together they described a busy swarm on a
    /// board that was finished and blocked.
    static func spokenForIsNotTheSameAsWorkedOn() {
        scenario("only a running task has a worker, and the line says so")

        let P = QueenDelegationPolicy.self

        check(
            P.spokenForReport(states: [.running]).bucket == "a worker has it",
            "a running task is the one case that really has a worker"
        )
        check(
            P.spokenForReport(states: [.running]).detail.contains("a worker already has it"),
            "and it still says so"
        )

        // The defect, stated three ways.
        for settled in [DelegatedTaskState.accepted, .merged, .awaitingReview] {
            let report = P.spokenForReport(states: [settled])
            check(
                !report.detail.contains("a worker already has it"),
                "\(settled.rawValue) does not claim a worker"
            )
            check(
                report.detail.contains(settled.rawValue),
                "\(settled.rawValue) names the state it is actually in"
            )
            check(
                report.bucket == "settled or waiting on you",
                "\(settled.rawValue) is counted apart from work in progress"
            )
        }

        // `queued` documents itself as having no worker attached yet, so it is
        // neither in progress nor settled.
        check(
            P.spokenForReport(states: [.queued]).bucket == "queued for a worker",
            "queued is its own bucket - claimed, but nobody is on it"
        )
        check(
            !P.spokenForReport(states: [.queued]).detail.contains("a worker already has it"),
            "and queued does not claim a worker either"
        )

        // An issue can carry several tasks. One running worker outranks any
        // number of finished ones: the board really is busy on that issue.
        check(
            P.spokenForReport(states: [.accepted, .running]).bucket == "a worker has it",
            "one running task among settled ones still means a worker has it"
        )
        check(
            P.spokenForReport(states: [.accepted, .running]).detail.contains("accepted"),
            "and the other states are still named"
        )

        // Duplicated states must not read as more tasks than there are.
        check(
            P.spokenForReport(states: [.accepted, .accepted]).detail
                == P.spokenForReport(states: [.accepted]).detail,
            "a repeated state is named once, not counted twice"
        )

        check(
            P.spokenForReport(states: []).bucket == "spoken for, state unrecorded",
            "no recorded state is reported as exactly that, not as a worker"
        )
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

        // A name GitHub cannot have is rejected here rather than four layers
        // downstream as an HTTP status. `trios\` came from a Makefile recipe
        // writing `\#`, which Make strips in an assignment and keeps in a
        // recipe; it reached the app, went out as /repos/gHashTag/trios%5C/...,
        // and was reported as "Unexpected GitHub response", a 403, a worker
        // with no boundary, and finally "the worker changed no files".
        check(
            IssueReference.parse("gHashTag/trios\\#1086") == nil,
            "a backslash in the repo name is rejected, not sent to GitHub"
        )
        check(
            IssueReference.parse("gHash\\Tag/trios#1086") == nil,
            "and in the owner name too"
        )
        check(
            IssueReference.parse("https://github.com/gHashTag/trios%5C/issues/1086") == nil,
            "the URL form cannot smuggle one in either"
        )
        check(
            IssueReference.parse("gHashTag/trios with space#1086") == nil,
            "a space is not a repository name"
        )
        // The legal punctuation must still parse, or this guard has broken
        // every repository with a dot, an underscore or a dash in its name.
        check(
            IssueReference.parse("browseros-ai/Browser_OS.next#7")?.repo == "Browser_OS.next",
            "dots, underscores and dashes are legal and still parse"
        )
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

        check(
            QueenDelegationPolicy.effectiveMaximumConcurrentWorkers(nil) == 4,
            "an older caller keeps the four-worker default"
        )
        check(
            QueenDelegationPolicy.effectiveMaximumConcurrentWorkers(2) == 2,
            "a two-slot runtime stays at two"
        )
        check(
            QueenDelegationPolicy.effectiveMaximumConcurrentWorkers(8) == 8,
            "eight verified runtime slots are admitted"
        )
        check(
            QueenDelegationPolicy.effectiveMaximumConcurrentWorkers(0) == 1,
            "a below-range runtime limit is clamped to one"
        )
        check(
            QueenDelegationPolicy.effectiveMaximumConcurrentWorkers(99) == 8,
            "an above-range runtime limit is clamped to eight"
        )
        check(
            QueenDelegationPolicy.canStartAnother(running: 7, maximumConcurrentWorkers: 8),
            "the eighth worker may start when the effective limit is eight"
        )
        check(
            !QueenDelegationPolicy.canStartAnother(running: 4, maximumConcurrentWorkers: 4),
            "a four-slot runtime refuses a fifth worker"
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

    static func forbiddenQueenToolCall() {
        scenario("the same tool call means different things in different chats")

        let queenChat = UUID()
        let workerChat = UUID()
        typealias P = QueenDelegationPolicy

        // Nothing can refuse the call - the client sends no tool list and the
        // agent server takes no filter - so noticing is the whole of what this
        // does. Which makes getting the condition right the whole of the value.
        check(
            P.isForbiddenQueenToolCall(
                conversationId: queenChat, queenConversationId: queenChat,
                tool: "filesystem_write"
            ),
            "the Queen writing a file is the supervisor editing code"
        )
        check(
            !P.isForbiddenQueenToolCall(
                conversationId: workerChat, queenConversationId: queenChat,
                tool: "filesystem_write"
            ),
            "and a worker writing a file is a worker doing its job"
        )
        check(
            !P.isForbiddenQueenToolCall(
                conversationId: queenChat, queenConversationId: queenChat,
                tool: "filesystem_read"
            ),
            "reading is hers to do; she has to review what came back"
        )
        check(
            P.isForbiddenQueenToolCall(
                conversationId: queenChat, queenConversationId: queenChat,
                tool: "FILESYSTEM_WRITE"
            ),
            "and the name is matched without regard to case, since providers differ"
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
        // A boundary must always be releasable. Review can only accept or
        // reject, and the send-back ceiling forbids another rejection, so
        // without this a task at the ceiling holds its files with no move
        // left that frees them - measured on #1286, which sat in
        // awaitingReview while `/cancel` logged
        // "Cannot move gHashTag/trios#1286 from awaitingReview to cancelled".
        check(
            QueenDelegationPolicy.canTransition(from: .awaitingReview, to: .cancelled),
            "a task at the send-back ceiling can still release its boundary"
        )
        check(
            QueenDelegationPolicy.canTransition(from: .queued, to: .cancelled)
                && QueenDelegationPolicy.canTransition(from: .running, to: .cancelled)
                && QueenDelegationPolicy.canTransition(from: .rejected, to: .cancelled)
                && QueenDelegationPolicy.canTransition(from: .failed, to: .cancelled),
            "every non-terminal state can be cancelled, not only some of them"
        )

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
