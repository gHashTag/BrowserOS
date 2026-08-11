import Combine
import Foundation

/// Holds the Queen's swarm: which task owns which chat, which issue, and which
/// virtual branch.
///
/// This is the supervisor's global state. Workers never read it; they receive a
/// brief and report back. Keeping it in one place is what lets the Queen answer
/// "what is everyone doing" without replaying every worker's conversation.
@MainActor
final class QueenDelegationRegistry: ObservableObject {
    /// One registry for the whole app: the sidebar and the Queen's command
    /// handler must see the same swarm, not two copies of it.
    static let shared = QueenDelegationRegistry()

    @Published private(set) var tasks: [DelegatedTask] = []
    @Published private(set) var lastError: String?

    /// Workers that were still `running` when the app launched — meaning they
    /// died with the previous process. The view model reads this to settle
    /// orphaned changes (stash the worker's virtual-branch edits) and report
    /// how many files were rescued.
    private(set) var orphansReconciledAtLaunch: [DelegatedTask] = []

    /// Atomically hands over the launch orphans and clears the registry's
    /// own copy, so a second ChatViewModel built against the same shared
    /// registry cannot settle the same orphans again.
    func drainOrphansReconciledAtLaunch() -> [DelegatedTask] {
        let drained = orphansReconciledAtLaunch
        orphansReconciledAtLaunch = []
        return drained
    }

    private let storePath: String
    private let dateProvider: () -> Date

    init(
        storePath: String = "\(ProjectPaths.trinity)/state/queen_delegation.json",
        dateProvider: @escaping () -> Date = Date.init
    ) {
        self.storePath = storePath
        self.dateProvider = dateProvider
        load()
    }

    // MARK: - Live / Archive separation
    //
    // Terminal tasks (`merged`, `cancelled`) leave the live list the moment
    // they reach that state. They are not deleted — they remain in the store
    // and are reachable only through `archived`. Every query that feeds the
    // UI or the Queen's decisions draws from the live set, so a settled task
    // can never appear in the sidebar, the review queue, or the slot counter.

    var running: [DelegatedTask] { tasks.filter { $0.state == .running } }

    /// The Queen's review queue, drawn only from live tasks.
    ///
    /// Archived tasks are excluded *before* the policy sees them. The
    /// policy's own `needsQueenAttention` filter already drops `merged` and
    /// `cancelled`, but that is a property of the policy, not of the
    /// registry. Filtering here makes the guarantee structural: even if the
    /// policy were to change, a settled task can never enter the review
    /// queue.
    var reviewQueue: [DelegatedTask] {
        QueenDelegationPolicy.reviewQueue(tasks.filter { !$0.isSettled })
    }

    var active: [DelegatedTask] { tasks.filter { !$0.state.isTerminal } }

    /// The live list: work still on the Queen's plate.
    ///
    /// Anything unfinished, plus failures nobody has acknowledged. Terminal
    /// tasks (`merged`, `cancelled`) are excluded because they are settled —
    /// they live in `archived`, not here.
    var open: [DelegatedTask] {
        tasks.filter { !$0.isSettled }
    }

    /// Settled work, newest first. Kept rather than deleted so "what did the
    /// swarm actually do today" has an answer.
    ///
    /// This is the archive's access point: an explicit, read-only view of
    /// every task that reached a terminal state. Tasks are never removed to
    /// produce it — they are filtered from the same store that holds live
    /// work.
    var archived: [DelegatedTask] {
        tasks.filter { $0.isSettled }.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Moves terminal tasks off the live list and into the archive view.
    ///
    /// Terminal tasks already leave `open` and `reviewQueue` by virtue of
    /// their state — the filtering is automatic. This method is the
    /// explicit, named action for archival: the Queen calls it to
    /// acknowledge that finished work has moved off the board. It logs each
    /// archived task and returns them so the caller can report what moved.
    ///
    /// Tasks are not deleted. They remain in the store and are visible
    /// through `archived` for as long as `pruneArchive` has not trimmed them.
    @discardableResult
    func archiveTerminalTasks() -> [DelegatedTask] {
        let toArchive = tasks.filter { $0.isSettled }
        guard !toArchive.isEmpty else { return [] }
        for task in toArchive {
            TriosLogBus.shared.info(
                .queen,
                "queen.archive",
                "Archived \(task.issue.slug) (\(task.state.displayName))",
                [
                    "issue": task.issue.slug,
                    "state": task.state.rawValue,
                ]
            )
        }
        return toArchive.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Bees that have stopped without saying so.
    ///
    /// Measured on the evidence the runner recorded - no byte for the stall
    /// threshold and no open stream - rather than on `updatedAt` alone.
    /// `updatedAt` moves when the Queen writes bookkeeping, not when the worker
    /// speaks, so a long turn that streamed for an hour was "stale" the whole
    /// time and got reaped the instant its stream object went away (#1247).
    func stalled(now: Date = Date()) -> [DelegatedTask] {
        tasks.filter {
            $0.state == .running && QueenDelegationPolicy.hasGoneSilent($0, now: now)
        }
    }

    func task(forConversation id: UUID) -> DelegatedTask? {
        tasks.first { $0.conversationId == id }
    }

    func task(forIssue issue: IssueReference) -> DelegatedTask? {
        tasks.first { $0.issue == issue && !$0.state.isTerminal }
    }

    /// The task for an issue whatever state it reached, newest first.
    ///
    /// `task(forIssue:)` deliberately hides terminal states so `/delegate`
    /// refuses to open a second chat on a live issue. That filter reaches one
    /// step too far: `accepted` is terminal, and opening the pull request is
    /// the step immediately after acceptance. So the moment the Queen accepted
    /// work, the task vanished from the lookup the next step used, that step
    /// said "I have no task for this issue" and returned - which is why no
    /// pull request has ever been opened in this project's history.
    func anyTask(forIssue issue: IssueReference) -> DelegatedTask? {
        tasks.filter { $0.issue == issue }.max { $0.updatedAt < $1.updatedAt }
    }

    /// Whether the Queen may open another worker right now, and why not.
    /// Issues the user has agreed the Queen may work on, this session.
    ///
    /// Not persisted: consent to open a chat is about now, and a decision made
    /// last week should not silently authorise work today.
    private(set) var approvedIssues: Set<String> = []

    func approve(issue: IssueReference) {
        approvedIssues.insert(issue.slug)
    }

    func delegationBlockReason(paths: [String]) -> String? {
        if !QueenDelegationPolicy.canStartAnother(running: running.count) {
            return "\(running.count) workers already running "
                + "(limit \(QueenDelegationPolicy.maximumConcurrentWorkers))."
        }
        let clashes = QueenDelegationPolicy.conflictingTasks(for: paths, among: tasks)
        guard clashes.isEmpty else {
            let names = clashes.map(\.issue.slug).joined(separator: ", ")
            return "Those files are already owned by \(names)."
        }
        return nil
    }

    // MARK: - Mutations

    /// Opens a task. Returns nil when delegation is blocked, so the caller can
    /// tell the user why instead of silently doing nothing.
    @discardableResult
    func delegate(
        issue: IssueReference,
        title: String,
        worker: String,
        conversationId: UUID,
        ownedPaths: [String] = [],
        acceptanceCriteria: [String] = []
    ) -> DelegatedTask? {
        // One live task per issue: two chats on one issue is the fastest way to
        // get two workers fighting over the same change.
        if let existing = task(forIssue: issue) {
            lastError = "\(issue.slug) is already delegated to \(existing.worker)."
            return nil
        }
        if let reason = delegationBlockReason(paths: ownedPaths) {
            lastError = reason
            return nil
        }

        let now = dateProvider()
        let task = DelegatedTask(
            conversationId: conversationId,
            issue: issue,
            title: title,
            worker: worker,
            state: .queued,
            ownedPaths: ownedPaths,
            acceptanceCriteria: acceptanceCriteria,
            virtualBranch: QueenBranchPolicy.branchName(for: issue, title: title),
            createdAt: now,
            updatedAt: now
        )
        tasks.append(task)
        lastError = nil
        persist()
        TriosLogBus.shared.info(
            .queen,
            "queen.delegate",
            "Delegated \(issue.slug) to \(worker)",
            [
                "issue": issue.slug,
                "worker": worker,
                "branch": task.virtualBranch ?? "-",
                "conversation": conversationId.uuidString
            ]
        )
        return task
    }

    /// Moves a task through its lifecycle, refusing illegal jumps.
    @discardableResult
    func transition(taskID: UUID, to state: DelegatedTaskState) -> Bool {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return false }
        let from = tasks[index].state
        guard QueenDelegationPolicy.canTransition(from: from, to: state) else {
            lastError = "Cannot move \(tasks[index].issue.slug) from \(from.rawValue) to \(state.rawValue)."
            TriosLogBus.shared.warn(
                .queen,
                "queen.transition.rejected",
                lastError ?? "illegal transition",
                ["issue": tasks[index].issue.slug]
            )
            return false
        }
        tasks[index].state = state
        tasks[index].updatedAt = dateProvider()
        lastError = nil
        persist()
        TriosLogBus.shared.info(
            .queen,
            "queen.transition",
            "\(tasks[index].issue.slug): \(from.rawValue) -> \(state.rawValue)",
            ["issue": tasks[index].issue.slug, "worker": tasks[index].worker]
        )
        return true
    }

    /// Records what a worker turn cost. Additive because a task can run more
    /// than once: a rejected bee is re-briefed in the same chat, and its second
    /// attempt is not free.
    func recordUsage(
        taskID: UUID,
        inputTokens: Int?,
        outputTokens: Int?,
        toolCalls: Int?
    ) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        if let inputTokens { tasks[index].inputTokens = (tasks[index].inputTokens ?? 0) + inputTokens }
        if let outputTokens { tasks[index].outputTokens = (tasks[index].outputTokens ?? 0) + outputTokens }
        if let toolCalls { tasks[index].toolCalls = (tasks[index].toolCalls ?? 0) + toolCalls }
        tasks[index].updatedAt = dateProvider()
        persist()

        if QueenDelegationPolicy.isExpensive(tasks[index]) {
            TriosLogBus.shared.warn(
                .queen,
                "queen.worker.expensive",
                "Worker has passed the token warning threshold",
                [
                    "issue": tasks[index].issue.slug,
                    "tokens": String(tasks[index].totalTokens)
                ]
            )
        }
    }

    func recordModel(taskID: UUID, provider: String, model: String) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        tasks[index].provider = provider
        tasks[index].model = model
        persist()
    }

    /// Estimated spend across every task updated today.
    ///
    /// Tasks whose model is not in the price table contribute nothing, so this
    /// is a floor rather than a total - and the caller says so.
    func spentToday(now: Date = Date()) -> Double {
        let calendar = Calendar.current
        return tasks
            .filter { calendar.isDate($0.updatedAt, inSameDayAs: now) }
            .compactMap(\.estimatedCostUSD)
            .reduce(0, +)
    }

    func recordCommittedFiles(taskID: UUID, count: Int) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        tasks[index].committedFiles = count
        persist()
    }

    func recordIntervention(taskID: UUID, text: String) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        tasks[index].interventions.append(text)
        tasks[index].updatedAt = Date()
        persist()
    }

    /// Records what was found for one criterion.
    ///
    /// Returns false when the text matches no criterion on the task, so a typo
    /// is refused rather than quietly filed under a requirement that does not
    /// exist - a verdict nobody can see is worse than none.
    @discardableResult
    func recordVerdict(taskID: UUID, criterion: String, verdict: QueenCriterionVerdict) -> Bool {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return false }
        let criteria = tasks[index].acceptanceCriteria

        // Exact match first — the common, cheapest path.
        let matched: String? = if criteria.contains(criterion) {
            criterion
        } else {
            criteria.first(where: { Self.normalised($0) == Self.normalised(criterion) })
        }

        guard let key = matched else {
            TriosLogBus.shared.warn(
                .queen,
                "queen.verdict.unmatched",
                "Verdict criterion did not match any acceptance criterion",
                [
                    "received": criterion,
                    "expected": criteria.joined(separator: " | "),
                ]
            )
            return false
        }

        tasks[index].criterionVerdicts[key] = verdict
        tasks[index].updatedAt = Date()
        persist()
        return true
    }

    /// Normalises a criterion string for fuzzy comparison: trims whitespace,
    /// strips surrounding quotes and backticks, and folds case.
    private static func normalised(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "`", with: "")
            .replacingOccurrences(of: "\"", with: "")
            .replacingOccurrences(of: "'", with: "")
            .lowercased()
    }

    func recordPullRequest(taskID: UUID, number: Int) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        tasks[index].pullRequestNumber = number
        tasks[index].updatedAt = Date()
        persist()
    }

    /// Records the head commit SHA the Queen reviewed, so the merge request
    /// can send it and the forge can refuse (409) if the branch has moved
    /// (#1254). Called when the pull request is first fetched for an accepted
    /// task.
    func recordReviewedHeadSHA(taskID: UUID, sha: String) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        tasks[index].reviewedHeadSHA = sha
        tasks[index].updatedAt = dateProvider()
        persist()
    }

    /// Clears the reviewed head SHA after a 409 (head moved), so the next
    /// review captures a fresh SHA rather than reusing one that the branch
    /// has already moved past (#1254).
    func clearReviewedHeadSHA(taskID: UUID) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        tasks[index].reviewedHeadSHA = nil
        tasks[index].updatedAt = dateProvider()
        persist()
    }

    /// Records a restart and marks the task as freshly active.
    ///
    /// Bumping `updatedAt` is the point, not bookkeeping: `stalled()` measures
    /// silence from that timestamp, so without it a resumed worker is reaped
    /// again on the very next sweep and the restart accomplishes nothing.
    func recordResumeAttempt(taskID: UUID) -> Int {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return 0 }
        let next = (tasks[index].resumeAttempts ?? 0) + 1
        tasks[index].resumeAttempts = next
        tasks[index].updatedAt = Date()
        persist()
        return next
    }

    /// Marks that a worker completed another turn (#1247).
    ///
    /// A task with at least one completed turn is not an orphan even if the
    /// runner has no active run for it: the worker did real work. The stalled
    /// threshold still applies independently, so a worker that completed a turn
    /// but then went silent is reaped after the full stall interval — this
    /// method only protects against the orphan sweep, not against genuine
    /// silence.
    func recordCompletedTurn(taskID: UUID) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        tasks[index].completedTurns = (tasks[index].completedTurns ?? 0) + 1
        persist()
    }

    /// Files what the runner reported about a worker's stream.
    ///
    /// The runner is the layer that knows whether a turn is in flight, when the
    /// last byte landed, and whether the stream ended with a terminal event or
    /// was cut. Recording those as they happen is what lets `stalled` read
    /// evidence instead of sampling "is a stream running right now" - an answer
    /// that is stale the moment it is given (#1247, #1248).
    ///
    /// No `persist()` here, and no `updatedAt` bump. This is liveness for the
    /// current process: a byte fact would otherwise rewrite the whole store
    /// once a second per worker, and bumping `updatedAt` would let bookkeeping
    /// masquerade as the worker speaking - the confusion that made a live
    /// worker look stale in the first place. A stale value that reaches the
    /// store through some other mutation is harmless: everything the store
    /// calls `running` at launch is reconciled as failed before it is read.
    ///
    /// `lastByteAt` never moves backwards, so a `.terminal` fact carrying the
    /// turn's real last byte cannot undo a later one.
    func recordStreamFact(
        taskID: UUID,
        outcome: WorkerStreamOutcome,
        lastByteAt: Date?
    ) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        tasks[index].streamOutcome = outcome
        if let lastByteAt,
           lastByteAt > (tasks[index].lastStreamByteAt ?? .distantPast) {
            tasks[index].lastStreamByteAt = lastByteAt
        }
    }

    /// Drops the oldest settled tasks once the archive grows past `limit`.
    ///
    /// Unbounded history turns the delegation store into a file that has to be
    /// parsed on every launch and a sidebar section nobody can scroll.
    @discardableResult
    func pruneArchive(limit: Int = 50) -> Int {
        let settled = archived
        guard settled.count > limit else { return 0 }
        let doomed = Set(settled.dropFirst(limit).map(\.id))
        tasks.removeAll { doomed.contains($0.id) }
        persist()
        return doomed.count
    }

    /// Persists the baseline tree hash for a task so that
    /// `settleFailedWorkerEdits` can still measure the worker's changes after
    /// a restart, when the in-memory `workerBaselineTrees` dictionary is gone.
    func setBaselineTree(taskID: UUID, baselineTree: String?) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        tasks[index].baselineTree = baselineTree
        persist()
    }

    func updateOwnedPaths(taskID: UUID, paths: [String]) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        tasks[index].ownedPaths = paths
        tasks[index].updatedAt = dateProvider()
        persist()
    }

    // MARK: - Persistence

    /// Plain JSON on purpose: the swarm's state is operational metadata, not a
    /// secret, and a human being able to read it during an incident is worth
    /// more than encrypting issue numbers.
    private func load() {
        guard let data = FileManager.default.contents(atPath: storePath) else { return }
        do {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            tasks = try decoder.decode([DelegatedTask].self, from: data)
            orphansReconciledAtLaunch = reconcileOrphanedWorkers()
        } catch {
            lastError = "Could not read the delegation store: \(error.localizedDescription)"
        }
    }

    /// A worker only exists as a live stream inside a running app. Anything the
    /// store calls `running` at launch died with the previous process, so it is
    /// marked failed rather than left holding a slot the Queen can never fill.
    private func reconcileOrphanedWorkers() -> [DelegatedTask] {
        let orphans = tasks.indices.filter { tasks[$0].state == .running }
        guard !orphans.isEmpty else { return [] }
        let now = dateProvider()
        var reconciled: [DelegatedTask] = []
        for index in orphans {
            tasks[index].state = .failed
            tasks[index].updatedAt = now
            TriosLogBus.shared.warn(
                .queen,
                "queen.worker.orphaned",
                "Worker did not survive a restart",
                ["issue": tasks[index].issue.slug, "worker": tasks[index].worker]
            )
            reconciled.append(tasks[index])
        }
        persist()
        return reconciled
    }

    private func persist() {
        let directory = (storePath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true
        )
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(tasks)
            try data.write(to: URL(fileURLWithPath: storePath), options: .atomic)
        } catch {
            lastError = "Could not save the delegation store: \(error.localizedDescription)"
        }
    }
}
