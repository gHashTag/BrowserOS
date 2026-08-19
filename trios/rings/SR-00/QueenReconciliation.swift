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
           !statesThatExpectWork.contains(state) {
            return .unrecordedWork(commits: facts.branchCommits)
        }
        if let files = committedFiles, files > 0,
           committedSHA == nil || committedSHA?.isEmpty == true {
            return .countWithoutCommit
        }
        return .agrees
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
