import Foundation

/// Whether what the registry says about a task matches what the repository
/// holds.
///
/// The registry is a claim and the repository is a fact, and nothing compared
/// them. A scan of thirty-five tasks found twenty-two branches carrying the
/// bees' own commits, and for eleven of those the registry said `queued` or
/// `failed` - work that exists and that the Queen does not know about. One task
/// was `accepted` with `committedFiles: 1` and no branch at all.
///
/// Detection before correction. Advancing a state from a git scan is a
/// judgement about work nobody reviewed; saying out loud that the record and
/// the tree disagree is not. This decides only what the disagreement IS, and
/// says nothing about what to do next.
enum QueenReconciliation {
    /// What a comparison found. Ordered by how much it should worry a reader.
    enum Finding: Equatable {
        /// The record and the repository say the same thing.
        case agrees
        /// The registry calls it unstarted or defeated, and its branch carries
        /// the worker's own commits. The commonest case, and the one that loses
        /// real work: #1282 was `failed` beside a 288-line commit.
        case unrecordedWork(commits: Int)
        /// Files are claimed and the branch that would hold them is gone.
        case branchMissing
        /// A commit is named and the object is not in the repository.
        case commitMissing
        /// Files are claimed with no commit named. Historical rather than
        /// alarming: every task predating the commit field reads this way, and
        /// it cannot be distinguished from a genuine loss without one.
        case countWithoutCommit

        /// Whether this needs a person now, as opposed to being an artefact of
        /// records written before the field existed.
        var isUrgent: Bool {
            switch self {
            case .agrees, .countWithoutCommit: return false
            case .unrecordedWork, .branchMissing, .commitMissing: return true
            }
        }
    }

    /// The facts a caller gathers from git before asking.
    ///
    /// Passed in rather than read here so the decision stays pure and the
    /// gathering stays testable on its own. `branchCommits` counts only commits
    /// unique to the branch - a branch cut from an old base is behind, not
    /// ahead, and counting the difference in both directions would call every
    /// stale branch productive.
    struct RepositoryFacts: Equatable {
        var branchExists: Bool
        var branchCommits: Int
        var commitExists: Bool
        /// Files the branch's own commits touched whose content is NOT what
        /// HEAD already holds.
        ///
        /// The difference between work that is stranded and work that has
        /// simply arrived by another road. Twelve branches were reported as
        /// carrying unaccounted work; on inspection every bee commit touched
        /// exactly one file - its own boundary - and all but two of those files
        /// were already in HEAD, swept in by somebody else's `git add -A`.
        ///
        /// Raising twelve when two are real is the noise this report was
        /// written to avoid, so the count of what is actually missing decides,
        /// not the count of commits.
        var unlandedFiles: Int = 0
    }

    /// States in which a commit on the branch is unremarkable.
    ///
    /// `accepted`, `awaitingReview` and `merged` are supposed to have work
    /// behind them - finding it there is the record being right, not wrong.
    static let statesThatExpectWork: Set<DelegatedTaskState> = [
        .awaitingReview, .accepted, .merged, .rejected, .running,
    ]

    static func check(
        state: DelegatedTaskState,
        committedFiles: Int?,
        committedSHA: String?,
        facts: RepositoryFacts
    ) -> Finding {
        // A named commit that is not in the repository is the sharpest
        // disagreement there is: the record points at something and the
        // something is not there.
        if let sha = committedSHA, !sha.isEmpty, !facts.commitExists {
            return .commitMissing
        }
        if let files = committedFiles, files > 0, !facts.branchExists {
            return .branchMissing
        }
        // Work on the branch of a task nobody thinks did any.
        if facts.branchExists,
           facts.branchCommits > 0,
           facts.unlandedFiles > 0,
           !statesThatExpectWork.contains(state) {
            return .unrecordedWork(commits: facts.branchCommits)
        }
        if let files = committedFiles, files > 0,
           committedSHA == nil || committedSHA?.isEmpty == true {
            return .countWithoutCommit
        }
        return .agrees
    }

    /// What to do about a disagreement, and who may decide it.
    ///
    /// Reporting was the half that did not exist; acting on the report is the
    /// half after that, and the two must not be the same step. Eight
    /// disagreements sat visible and motionless for a whole round because
    /// seeing them was all the machinery could do.
    enum Correction: Equatable {
        /// Nothing to do.
        case none
        /// Put the task in the review queue so its branch gets looked at.
        ///
        /// Needs a word from the operator: moving work into review is a claim
        /// that it is ready to be judged, and nobody has read it.
        case sendToReview(reason: String)
        /// Erase a file count that has nothing behind it.
        ///
        /// Also needs a word, for a different reason. Removing the claim is not
        /// a judgement about work - the work is provably not where the record
        /// says - but it edits a task the Queen already called accepted, and a
        /// supervisor that quietly rewrites its own past verdicts is worse than
        /// one that leaves a wrong number visible.
        case clearUnsupportedCount(reason: String)

        var needsOperator: Bool { self != .none }
    }

    /// The correction a finding calls for.
    ///
    /// Pure, and deliberately conservative: every case that changes anything
    /// asks first. The alternative - a supervisor that repairs its own record
    /// on a timer - makes the record agree with the repository by construction
    /// and therefore worth nothing as evidence.
    static func correction(for finding: Finding) -> Correction {
        switch finding {
        case .agrees, .countWithoutCommit:
            return .none
        case .unrecordedWork(let commits):
            return .sendToReview(
                reason: "\(commits) commit(s) on the branch that HEAD does not hold; "
                    + "moving it into review is what gets a person to look at them"
            )
        case .branchMissing:
            return .clearUnsupportedCount(
                reason: "the branch that would hold the claimed files is gone, so the "
                    + "count is a number with nothing behind it"
            )
        case .commitMissing:
            return .clearUnsupportedCount(
                reason: "the commit named in the record is not in the repository"
            )
        }
    }

    /// How a proposal reads when she offers it.
    static func describeCorrection(
        index: Int, issue: String, correction: Correction
    ) -> String? {
        switch correction {
        case .none:
            return nil
        case .sendToReview(let reason):
            return "\(index). \(issue) -> review: \(reason)"
        case .clearUnsupportedCount(let reason):
            return "\(index). \(issue) -> clear the file count: \(reason)"
        }
    }

    /// One line for the log or a notice.
    static func describe(issue: String, finding: Finding) -> String {
        switch finding {
        case .agrees:
            return "\(issue): the record matches the repository"
        case .unrecordedWork(let commits):
            return "\(issue): \(commits) commit(s) on its branch that the record does "
                + "not account for - the work exists and nobody is looking at it"
        case .branchMissing:
            return "\(issue): files are claimed and the branch that would hold them "
                + "is gone"
        case .commitMissing:
            return "\(issue): the commit named in the record is not in the repository"
        case .countWithoutCommit:
            return "\(issue): a file count with no commit named, so it cannot be checked"
        }
    }

    /// A summary line for a whole scan.
    ///
    /// Counts rather than a verdict. "Twenty-two of thirty-five" is a fact the
    /// operator can act on; "the registry is unhealthy" is not.
    static func summary(findings: [Finding]) -> String {
        let urgent = findings.filter(\.isUrgent).count
        let historical = findings.filter { $0 == .countWithoutCommit }.count
        let agreeing = findings.filter { $0 == .agrees }.count
        return "\(findings.count) task(s) checked: \(agreeing) agree, \(urgent) disagree "
            + "in a way that needs looking at, \(historical) carry a count written "
            + "before commits were recorded"
    }
}
