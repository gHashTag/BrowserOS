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

    var isTerminal: Bool {
        switch self {
        case .accepted, .cancelled, .failed: return true
        case .queued, .running, .awaitingReview, .rejected: return false
        }
    }

    /// Whether the task is finished *and* settled, so it can leave the working
    /// view. `failed` is terminal but deliberately not archivable: a failure
    /// nobody has looked at is still work, and filing it away silently is how
    /// it never gets looked at.
    var isArchivable: Bool {
        switch self {
        case .accepted, .cancelled: return true
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
        case .rejected: return "Sent back"
        case .cancelled: return "Cancelled"
        case .failed: return "Failed"
        }
    }

    /// Work the Queen still has to act on.
    var needsQueenAttention: Bool {
        switch self {
        case .awaitingReview, .failed, .rejected: return true
        case .queued, .running, .accepted, .cancelled: return false
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

    init(
        id: UUID = UUID(),
        conversationId: UUID = UUID(),
        issue: IssueReference,
        title: String,
        worker: String,
        state: DelegatedTaskState = .queued,
        ownedPaths: [String] = [],
        virtualBranch: String? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        inputTokens: Int? = nil,
        outputTokens: Int? = nil,
        toolCalls: Int? = nil,
        committedFiles: Int? = nil,
        provider: String? = nil,
        model: String? = nil
    ) {
        self.id = id
        self.conversationId = conversationId
        self.issue = issue
        self.title = title
        self.worker = worker
        self.state = state
        self.ownedPaths = ownedPaths
        self.virtualBranch = virtualBranch
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.toolCalls = toolCalls
        self.committedFiles = committedFiles
        self.provider = provider
        self.model = model
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

    /// Maximum worker chats running at once.
    ///
    /// Bounded because every running worker costs the Queen context on every
    /// review, and because merge conflicts scale with concurrency.
    static let maximumConcurrentWorkers = 4

    static func canStartAnother(running: Int) -> Bool {
        running < maximumConcurrentWorkers
    }

    /// Detects an ownership clash before two workers touch the same file.
    ///
    /// Single-writer on hotspot files is the structural way to avoid conflicts;
    /// detecting it at delegation time is far cheaper than at merge time.
    static func conflictingTasks(
        for paths: [String],
        among tasks: [DelegatedTask]
    ) -> [DelegatedTask] {
        let wanted = Set(paths.map(normalizePath))
        guard !wanted.isEmpty else { return [] }
        return tasks.filter { task in
            guard !task.state.isTerminal else { return false }
            let owned = Set(task.ownedPaths.map(normalizePath))
            return !owned.isDisjoint(with: wanted)
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
        case (.rejected, .running), (.rejected, .cancelled):
            return true
        case (.failed, .running), (.failed, .cancelled):
            return true
        default:
            return false
        }
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
