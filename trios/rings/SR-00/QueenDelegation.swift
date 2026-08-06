import Foundation

/// A GitHub issue a delegated task is bound to.
///
/// Every worker chat answers to exactly one issue. That is the anchor which
/// makes the swarm auditable: the chat is the conversation, the issue is the
/// contract, and the two never drift apart.
struct IssueReference: Codable, Equatable, Sendable {
    let owner: String
    let repo: String
    let number: Int

    var slug: String { "\(owner)/\(repo)#\(number)" }
    var url: String { "https://github.com/\(owner)/\(repo)/issues/\(number)" }

    /// Parses `owner/repo#123` and full issue URLs. Returns nil rather than
    /// guessing, because a task bound to the wrong issue is worse than one that
    /// refuses to start.
    static func parse(_ text: String) -> IssueReference? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let url = URL(string: trimmed), url.host?.contains("github.com") == true {
            let parts = url.path.split(separator: "/").map(String.init)
            guard parts.count >= 4, parts[2] == "issues", let number = Int(parts[3]), number > 0 else {
                return nil
            }
            return IssueReference(owner: parts[0], repo: parts[1], number: number)
        }

        let hashSplit = trimmed.split(separator: "#")
        guard hashSplit.count == 2, let number = Int(hashSplit[1]), number > 0 else { return nil }
        let path = hashSplit[0].split(separator: "/").map(String.init)
        guard path.count == 2, !path[0].isEmpty, !path[1].isEmpty else { return nil }
        return IssueReference(owner: path[0], repo: path[1], number: number)
    }
}

/// Lifecycle of delegated work.
enum DelegatedTaskState: String, Codable, Equatable, Sendable, CaseIterable {
    /// Created by the Queen, no worker attached yet.
    case queued
    /// A worker chat is open and running.
    case running
    /// Worker reported completion; awaiting the Queen's review.
    case awaitingReview
    /// The Queen accepted the result.
    case accepted
    /// The Queen rejected it and sent it back.
    case rejected
    /// Abandoned.
    case cancelled
    /// The worker failed and could not recover.
    case failed
    /// The task's pull request landed. The only state established by asking the
    /// forge rather than by anyone's judgement.
    case merged

    var isTerminal: Bool {
        switch self {
        case .accepted, .cancelled, .failed, .merged: return true
        case .queued, .running, .awaitingReview, .rejected: return false
        }
    }

    /// Whether the task is finished *and* settled, so it can leave the working
    /// view. `failed` is terminal but deliberately not archivable: a failure
    /// nobody has looked at is still work, and filing it away silently is how
    /// it never gets looked at.
    var isArchivable: Bool {
        switch self {
        case .accepted, .cancelled, .merged: return true
        case .failed, .queued, .running, .awaitingReview, .rejected: return false
        }
    }

    /// Short label for a status pill. Full words read better than camelCase in
    /// a UI the user scans rather than reads.
    var displayName: String {
        switch self {
        case .queued: return "Queued"
        case .running: return "Working"
        case .awaitingReview: return "Needs review"
        case .accepted: return "Accepted"
        case .merged: return "Merged"
        case .rejected: return "Sent back"
        case .cancelled: return "Cancelled"
        case .failed: return "Failed"
        }
    }

    /// Work the Queen still has to act on.
    var needsQueenAttention: Bool {
        switch self {
        case .awaitingReview, .failed, .rejected: return true
        case .queued, .running, .accepted, .cancelled, .merged: return false
        }
    }
}

/// One unit of delegated work: an issue, a worker, and its own chat.
struct DelegatedTask: Identifiable, Codable, Equatable, Sendable {
    let id: UUID
    /// The child conversation this task owns. One task, one chat.
    let conversationId: UUID
    let issue: IssueReference
    var title: String
    var worker: String
    var state: DelegatedTaskState
    /// Files this worker is allowed to write. Empty means unrestricted.
    var ownedPaths: [String]
    /// GitButler virtual branch that isolates this task's edits.
    ///
    /// Virtual branches are why several workers can share one checkout: each
    /// task's changes are attributed to its own branch inside the same working
    /// directory, so there is no worktree to duplicate and no checkout to
    /// switch. Ownership separation is what keeps two bees off each other's
    /// files.
    var virtualBranch: String?
    var createdAt: Date
    var updatedAt: Date
    /// What this bee cost. Optional so delegation stores written before usage
    /// was tracked still decode.
    var inputTokens: Int?
    var outputTokens: Int?
    /// Tool calls made, which is the cheapest proxy for "did it actually work
    /// or just talk".
    var toolCalls: Int?
    /// Files the worker committed to its branch, filled in at review time.
    var committedFiles: Int?
    /// What the worker must make true, written by the Queen when she opens the
    /// task.
    ///
    /// Empty is a real state and is shown as such in the specification rather
    /// than hidden: a task with no criteria cannot be judged complete, only
    /// abandoned, and saying so up front is the difference between a contract
    /// and a wish.
    var acceptanceCriteria: [String]

    /// Corrections the Queen sent into this worker's chat while it ran.
    ///
    /// Kept so "she corrected this three times and it still went wrong" is
    /// answerable at review. A supervisor who steers invisibly leaves a
    /// transcript that reads as if the worker got there alone.
    var interventions: [String]

    /// What was found when each criterion was checked, keyed by the criterion.
    ///
    /// Keyed by text rather than index so editing the criteria list cannot
    /// silently reassign a verdict to a different requirement - a renumbering
    /// that moves a "met" onto something nobody looked at is the worst possible
    /// failure for this table.
    var criterionVerdicts: [String: QueenCriterionVerdict]

    /// The fingerprint of the code tree at the time verdicts were recorded.
    ///
    /// Set when the Queen reviews the branch and records what she found. It is
    /// the state every verdict in `criterionVerdicts` was derived against, so
    /// that acceptance can tell a current verdict from one carved against code
    /// that has since moved (#1126).
    ///
    /// Nil means the binding has not been set — either the task predates state
    /// tracking, or the binding was stripped. When the acceptance policy knows
    /// the current tree state, a nil binding makes every checked verdict stale:
    /// a verdict whose provenance cannot be verified cannot be trusted to be
    /// current, and saying so is what keeps the binding load-bearing rather
    /// than decorative.
    var treeStateFingerprint: String?

    /// The git write-tree hash captured when the worker started, persisted so
    /// `settleFailedWorkerEdits` can measure the worker's changes after a
    /// restart — when the in-memory `workerBaselineTrees` dictionary is gone.
    ///
    /// A write-tree object lives in `.git`, so the hash remains valid across
    /// process restarts. Optional so older stores without this key still decode.
    var baselineTree: String?

    /// The pull request opened for this task's branch, once one exists.
    ///
    /// Nil means no pull request has been opened - not that one failed. The
    /// difference matters when deciding whether a task is waiting on a merge or
    /// waiting on somebody to open it.
    var pullRequestNumber: Int?
    /// How many times the Queen has restarted this worker after it went silent.
    ///
    /// Optional so delegation stores written before resuming existed still
    /// decode. Counted rather than flagged, because the interesting question is
    /// not "was it stuck" but "how many times, and did it ever get anywhere".
    var resumeAttempts: Int?
    /// Which model did the work, so a cost estimate is possible after the fact.
    var provider: String?
    var model: String?

    /// `nil` when the model is not in the price table. An unknown price must
    /// stay unknown rather than becoming an invented average.
    var estimatedCostUSD: Double? {
        guard let provider, let model else { return nil }
        return ModelPricing.estimatedCost(
            inputTokens: inputTokens ?? 0,
            outputTokens: outputTokens ?? 0,
            model: model,
            provider: provider
        )
    }

    var totalTokens: Int { (inputTokens ?? 0) + (outputTokens ?? 0) }

    /// Whether this task can leave the working view.
    ///
    /// Settlement stopped being a property of the state alone the moment a pull
    /// request could be attached. Accepted means the Queen is satisfied, which
    /// is an opinion; if a pull request exists, the work has not landed until
    /// that merges, which is a fact. A task with no pull request settles on
    /// acceptance exactly as before - otherwise every task predating this would
    /// wait forever for a merge nobody is going to perform.
    var isSettled: Bool {
        if state == .accepted, pullRequestNumber != nil { return false }
        return state.isArchivable
    }

    init(
        id: UUID = UUID(),
        conversationId: UUID = UUID(),
        issue: IssueReference,
        title: String,
        worker: String,
        state: DelegatedTaskState = .queued,
        ownedPaths: [String] = [],
        acceptanceCriteria: [String] = [],
        interventions: [String] = [],
        criterionVerdicts: [String: QueenCriterionVerdict] = [:],
        treeStateFingerprint: String? = nil,
        virtualBranch: String? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        inputTokens: Int? = nil,
        outputTokens: Int? = nil,
        toolCalls: Int? = nil,
        committedFiles: Int? = nil,
        resumeAttempts: Int? = nil,
        pullRequestNumber: Int? = nil,
        provider: String? = nil,
        model: String? = nil,
        baselineTree: String? = nil
    ) {
        self.id = id
        self.conversationId = conversationId
        self.issue = issue
        self.title = title
        self.worker = worker
        self.state = state
        self.ownedPaths = ownedPaths
        self.acceptanceCriteria = acceptanceCriteria
        self.interventions = interventions
        self.criterionVerdicts = criterionVerdicts
        self.treeStateFingerprint = treeStateFingerprint
        self.virtualBranch = virtualBranch
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.toolCalls = toolCalls
        self.committedFiles = committedFiles
        self.resumeAttempts = resumeAttempts
        self.pullRequestNumber = pullRequestNumber
        self.provider = provider
        self.model = model
        self.baselineTree = baselineTree
    }
}

/// Rules the Queen follows when handing work out.
///
/// The supervisor pattern's known failure modes drive every rule here: the
/// orchestrator accumulates context from every worker until it overflows; it is
/// a single point of failure; and parallel workers corrupt each other when they
/// write the same files. So the Queen passes a *subset* of context, never the
/// whole history, and ownership of hot files is exclusive.
enum QueenDelegationPolicy {
    /// The Queen never edits code. She may only open, brief, review, and close
    /// worker chats. Encoded so the rule is testable rather than aspirational.
    static let queenForbiddenTools: Set<String> = [
        "filesystem_write", "write_file", "write", "edit", "shell_execute", "bash", "run_command"
    ]

    static func queenMayUse(tool: String) -> Bool {
        !queenForbiddenTools.contains(tool.lowercased())
    }

    /// Whether a tool call arriving in some conversation breaks the Queen's own
    /// rule, given which conversation is hers.
    ///
    /// A worker calling filesystem_write is the worker doing its job; the same
    /// call in the Queen's chat is the supervisor editing code. The difference
    /// is entirely which conversation it arrived in, so the decision takes both
    /// and lives here rather than as a condition inline at the call site, where
    /// only a running app could tell whether it was right.
    static func isForbiddenQueenToolCall(
        conversationId: UUID,
        queenConversationId: UUID,
        tool: String
    ) -> Bool {
        conversationId == queenConversationId && !queenMayUse(tool: tool)
    }

    /// Maximum worker chats running at once.
    ///
    /// Bounded because every running worker costs the Queen context on every
    /// review, and because merge conflicts scale with concurrency.
    static let maximumConcurrentWorkers = 4

    static func canStartAnother(running: Int) -> Bool {
        running < maximumConcurrentWorkers
    }

    /// Whether two boundaries can reach the same file.
    ///
    /// A directory contains everything beneath it, so `docs` and `docs/live`
    /// overlap even though the strings differ. The comparison is by path
    /// component, not by characters: `docs` and `docsite` share a prefix and
    /// nothing else.
    ///
    /// This is the single notion of containment for the ownership rule and for
    /// judging writes. They had one each, and disagreed.
    static func pathsOverlap(_ first: String, _ second: String) -> Bool {
        let a = normalizePath(first)
        let b = normalizePath(second)
        guard !a.isEmpty, !b.isEmpty else { return false }
        return a == b || a.hasPrefix("\(b)/") || b.hasPrefix("\(a)/")
    }

    /// Detects an ownership clash before two workers touch the same file.
    ///
    /// Single-writer on hotspot files is the structural way to avoid conflicts;
    /// detecting it at delegation time is far cheaper than at merge time.
    ///
    /// Compared as paths rather than as strings. Set disjointness was the old
    /// test, and it only ever caught two bees naming a boundary identically -
    /// the one case a human notices unaided. The case it let through is the
    /// ordinary one: one bee owns `rings`, the next owns
    /// `rings/SR-02/ChatViewModel.swift`, both are inside their boundary when
    /// they write that file, and nothing complains until the merge. Two bees
    /// running in parallel on `docs` and `docs/live` is how this surfaced.
    static func conflictingTasks(
        for paths: [String],
        among tasks: [DelegatedTask]
    ) -> [DelegatedTask] {
        let wanted = paths.map(normalizePath).filter { !$0.isEmpty }
        guard !wanted.isEmpty else { return [] }
        return tasks.filter { task in
            guard !task.state.isTerminal else { return false }
            return task.ownedPaths.contains { owned in
                wanted.contains { pathsOverlap(owned, $0) }
            }
        }
    }

    static func normalizePath(_ path: String) -> String {
        var value = path.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasPrefix("./") { value.removeFirst(2) }
        while value.hasPrefix("/") { value.removeFirst() }
        return value
    }

    /// Tokens one bee may spend before the Queen is told it is expensive.
    ///
    /// Not a hard cap: killing a worker mid-edit leaves the repository in a
    /// state nobody chose. Surfacing the number and letting the Queen cancel is
    /// the honest version of a budget when the work is not transactional.
    static let workerTokenWarningThreshold = 200_000

    /// A worker with no stream and no result has stopped, whatever the registry
    /// says. Distinguishing "slow" from "gone" is the point.
    /// How many times a silent worker is restarted before the Queen gives up.
    ///
    /// Two, not zero and not many. Zero is today's behaviour - an hour of
    /// silence ends in a closed chat and nothing learned. Many lets a confused
    /// worker spend the day rediscovering the same wall.
    /// Why a pull request cannot be opened for a task, or nil if it can.
    ///
    /// Split out from the call that opens it so the refusals are testable
    /// without a network or a token. Every one of these is a case where opening
    /// a pull request would publish something wrong: an empty branch, a second
    /// pull request for work that already has one, or a task nobody has
    /// finished reviewing.
    static func pullRequestBlockReason(for task: DelegatedTask) -> String? {
        if let existing = task.pullRequestNumber {
            return "#\(existing) is already open for this task."
        }
        guard task.virtualBranch != nil else {
            return "the task has no branch, so there is nothing to propose."
        }
        if let files = task.committedFiles, files == 0 {
            return "the worker committed nothing, so the pull request would be empty."
        }
        switch task.state {
        case .accepted, .awaitingReview:
            return nil
        case .queued, .running:
            return "the work is not finished yet."
        case .rejected:
            return "the work was sent back and has not been redone."
        case .cancelled, .failed:
            return "the task was closed without a result."
        case .merged:
            return "this work already landed."
        }
    }

    /// What a pull request's current shape means for the task waiting on it.
    enum PullRequestOutcome: String, Equatable {
        /// Merged. The work landed and the chat can close.
        case landed
        /// Closed with nothing merged. Back to the queue, not the archive.
        case abandoned
        /// Still open. Nothing to decide yet.
        case pending
    }

    /// Reads the forge's answer without inferring anything from `state` alone.
    ///
    /// Takes two facts rather than the GitHub model on purpose. SR-00 is the
    /// bottom ring; reaching up into BR-OUTPUT for a decoding type would make
    /// this policy un-compilable on its own, which is exactly how three suites
    /// silently stopped building earlier in this project. The caller reads the
    /// model, this decides.
    ///
    /// The distinction is the point: "closed" is the same word for landed and
    /// abandoned work, and a poll that guessed would archive changes that never
    /// reached the branch.
    static func outcome(merged: Bool, closedUnmerged: Bool) -> PullRequestOutcome {
        if merged { return .landed }
        if closedUnmerged { return .abandoned }
        return .pending
    }

    /// The state a task should move to for an outcome, or nil to leave it alone.
    static func nextState(for outcome: PullRequestOutcome) -> DelegatedTaskState? {
        switch outcome {
        case .landed: return .merged
        case .abandoned: return .awaitingReview
        case .pending: return nil
        }
    }

    /// Why the Queen may not open this chat yet, or nil if the user has agreed.
    ///
    /// The Queen proposes; the person decides. Without this she is free to keep
    /// opening chats on her own judgement, and a supervisor that can start work
    /// unprompted is not a supervisor, it is a second author with a budget.
    ///
    /// Deliberately not a rate limit. Slowing down an agent that should not be
    /// acting at all just spreads the same decision over more hours.
    static func approvalBlockReason(issue: IssueReference, approved: Set<String>) -> String? {
        guard !approved.contains(issue.slug) else { return nil }
        return "\(issue.slug) has not been approved. Propose it first and let the "
            + "user decide - `/approve \(issue.slug)` once they agree."
    }

    static let maxResumeAttempts = 2

    static let stallThreshold: TimeInterval = 60 * 60

    static func isExpensive(_ task: DelegatedTask) -> Bool {
        task.totalTokens >= workerTokenWarningThreshold
    }

    /// The Queen may close this herself.
    ///
    /// Deliberately narrow: a bee that reported back, changed files inside its
    /// boundary, and cost nothing unusual. Anything ambiguous stays for a human,
    /// because an orchestrator that accepts its own workers' claims is an
    /// orchestrator with no reviewer.
    static func qualifiesForAutoAccept(
        _ task: DelegatedTask,
        committedFiles: Int
    ) -> Bool {
        guard task.state == .awaitingReview else { return false }
        guard committedFiles > 0 else { return false }
        guard !task.ownedPaths.isEmpty else { return false }
        guard !isExpensive(task) else { return false }
        guard !task.acceptanceCriteria.isEmpty else { return false }
        return true
    }

    /// Tasks the Queen should look at first, loudest rather than oldest.
    ///
    /// Ordering by age alone made a task that had failed three times look
    /// exactly like one that had never run. `QueenSalience` weights the signals
    /// that actually cost something - failure, rejection, an empty result, an
    /// unusual bill - and age is only the tie-breaker it used to be the whole
    /// of.
    /// Supplies learned weights. Set once at startup; defaults to the priors so
    /// the policy stays pure and usable from tests with no learner behind it.
    nonisolated(unsafe) static var learnedWeight: (QueenSalience.Feature) -> Double = { $0.prior }

    static func reviewQueue(_ tasks: [DelegatedTask], now: Date = Date()) -> [DelegatedTask] {
        QueenSalience.reviewQueue(tasks, now: now, weightFor: learnedWeight)
    }

    /// Legal state transitions. Anything else is a bug in the caller, and
    /// silently allowing it would let a task be "accepted" without ever running.
    static func canTransition(from: DelegatedTaskState, to: DelegatedTaskState) -> Bool {
        switch (from, to) {
        case (.queued, .running), (.queued, .cancelled):
            return true
        case (.running, .awaitingReview), (.running, .failed), (.running, .cancelled):
            return true
        case (.awaitingReview, .accepted), (.awaitingReview, .rejected):
            return true
        // A pull request is the only thing that can settle accepted work, and
        // it can settle it either way: landed, or closed with nothing landed
        // and therefore back in the queue.
        case (.accepted, .merged), (.accepted, .awaitingReview):
            return true
        case (.rejected, .running), (.rejected, .cancelled):
            return true
        case (.failed, .running), (.failed, .cancelled):
            return true
        default:
            return false
        }
    }

    /// Builds a conventional-commit PR title from a delegated task.
    ///
    /// The forge's `validate-pr-title` check rejects raw task titles because they
    /// are not conventional-commit subjects. This function infers the type from
    /// the task's owned paths — `docs` when every path is under `docs/`, `test`
    /// when every path is under `tests/`, `feat` otherwise — fixes the scope to
    /// `trios`, and appends the task's own title unchanged. The whole line is
    /// truncated to 72 characters on a word boundary so the subject stays within
    /// the conventional-commit limit.
    static func conventionalPRTitle(for task: DelegatedTask) -> String {
        let type: String
        if !task.ownedPaths.isEmpty, task.ownedPaths.allSatisfy({ path in
            let p = normalizePath(path)
            return p == "docs" || p.hasPrefix("docs/")
        }) {
            type = "docs"
        } else if !task.ownedPaths.isEmpty, task.ownedPaths.allSatisfy({ path in
            let p = normalizePath(path)
            return p == "tests" || p.hasPrefix("tests/")
        }) {
            type = "test"
        } else {
            type = "feat"
        }

        let full = "\(type)(trios): \(task.title)"
        guard full.count > 72 else { return full }

        let head = String(full.prefix(72))
        if let lastSpace = head.lastIndex(of: " ") {
            return String(head[..<lastSpace])
        }
        return head
    }
}

/// Names the GitButler virtual branch that isolates a task.
///
/// Deterministic from the issue, so the same task always maps to the same
/// branch: reconnecting after a restart finds its work rather than opening a
/// second branch for the same issue.
enum QueenBranchPolicy {
    static let prefix = "queen"
    static let maximumSlugLength = 40

    /// The one statement of where a worker may write.
    ///
    /// Said twice before this: "You may write to these paths and no others" in
    /// the specification, "You may edit only these paths" in the standing
    /// orders. Nothing had gone wrong yet, which is the only interesting thing
    /// about it - the branch rule read the same way until the day it did not.
    static func boundaryRule(ownedPaths: [String]) -> String {
        guard !ownedPaths.isEmpty else {
            return "No paths were assigned to you. Ask in this chat before "
                + "editing anything, because everything here is shared until "
                + "someone says otherwise."
        }
        return "You may create or edit files under these paths and nowhere "
            + "else: " + ownedPaths.joined(separator: ", ")
            + ". Work outside them is dropped rather than reviewed."
    }

    /// The one statement of what a finished worker owes the Queen.
    ///
    /// These two did not merely differ, they disagreed. The specification said
    /// to answer every criterion and not to summarise; the standing orders
    /// asked for "a short report". Short and do-not-summarise pull opposite
    /// ways, and the orders are the side an agent trusts, so the instruction
    /// most likely to be followed was the one that loses the Queen the
    /// per-criterion verdicts her acceptance check is built on.
    static let reportRule =
        "When you stop, answer every acceptance criterion in turn: met, not "
        + "met, or could not check. Do not summarise and do not shorten this "
        + "part - an unchecked criterion is not a pass, and saying so plainly "
        + "costs you nothing."

    /// The one statement of who moves the branch and who leaves it alone.
    ///
    /// This sentence used to exist twice - in the specification and in the
    /// worker's standing orders - and for one release the two disagreed. The
    /// specification had been corrected after a live worker checked its branch
    /// out and dragged the shared checkout with it; the standing orders still
    /// said "attribute every edit to the branch", which is the sentence that
    /// caused it, sitting in the place an agent trusts more. A test now catches
    /// that disagreement, but catching is not preventing: one source cannot
    /// disagree with itself.
    static func ownershipRule(branch: String) -> String {
        "Every edit belongs to `\(branch)`, and the Queen attributes them to it "
            + "after your turn. Do not check that branch out, switch to it, "
            + "create it, or commit anything: the checkout is shared with the "
            + "user, with the build, and with every other worker."
    }

    static func branchName(for issue: IssueReference, title: String) -> String {
        let slug = slugify(title)
        return slug.isEmpty
            ? "\(prefix)/\(issue.number)"
            : "\(prefix)/\(issue.number)-\(slug)"
    }

    /// Lowercase, ASCII, hyphen-separated. Git refs reject many characters and
    /// silently mangling them would break the task-to-branch mapping.
    static func slugify(_ title: String) -> String {
        var words: [String] = []
        var current = ""
        for character in title.lowercased() {
            if character.isLetter || character.isNumber, character.isASCII {
                current.append(character)
            } else if !current.isEmpty {
                words.append(current)
                current = ""
            }
        }
        if !current.isEmpty { words.append(current) }

        var slug = ""
        for word in words {
            if slug.isEmpty {
                slug = word
            } else if slug.count + 1 + word.count <= maximumSlugLength {
                slug += "-" + word
            } else {
                break
            }
        }
        return String(slug.prefix(maximumSlugLength))
    }

    /// True when a branch name belongs to the Queen's swarm, so unrelated
    /// branches in the same repository are never touched.
    static func isQueenBranch(_ name: String) -> Bool {
        name.hasPrefix("\(prefix)/")
    }

    /// Extracts the issue number a queen branch was created for.
    static func issueNumber(fromBranch name: String) -> Int? {
        guard isQueenBranch(name) else { return nil }
        let tail = name.dropFirst(prefix.count + 1)
        let digits = tail.prefix { $0.isNumber }
        return Int(digits)
    }
}
