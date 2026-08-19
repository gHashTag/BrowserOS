import Foundation

/// Whether a pull request has earned its merge.
///
/// Until now the Queen asked the forge to merge and took whatever answer came
/// back. GitHub only refuses a red pull request when branch protection makes it
/// refuse; without that the merge succeeds and a failing change lands. Three of
/// hers merged that way, and only luck decided they were green.
///
/// The decision is separated from the request so it can be driven without a
/// network: the shapes below are the ones the forge actually returns, and each
/// has a different consequence.
enum QueenMergeGate {
    /// A check rollup as the forge reports it, reduced to what matters here.
    enum Rollup: String, Equatable, Sendable {
        case success = "SUCCESS"
        case pending = "PENDING"
        case failure = "FAILURE"
        case error = "ERROR"
        /// No checks ran at all.
        case none = "NONE"
    }

    enum Decision: Equatable {
        /// Every required check passed. Merge.
        case merge
        /// Checks are still running. Ask again later; do not merge and do not
        /// wake anybody.
        case wait(reason: String)
        /// A check failed. The bee is woken with this reason and works until
        /// the gate is green.
        case wakeWorker(reason: String)
        /// Nothing to merge, or the forge says it cannot be merged for a
        /// reason no amount of bee work will change.
        case refuse(reason: String)
    }

    /// The gate. Pure, so every branch below is reachable in a test.
    ///
    /// `checksConfigured` matters more than it looks: a repository with no CI
    /// reports `NONE`, and treating that as failure would block every merge
    /// forever in a project that has no checks - while treating it as success
    /// would make this gate a decoration in a project that MEANT to have them.
    /// The caller states which world it is in.
    static func decision(
        rollup: Rollup,
        mergeable: Bool?,
        isDraft: Bool,
        checksConfigured: Bool
    ) -> Decision {
        if isDraft {
            return .refuse(reason: "the pull request is still a draft")
        }
        if mergeable == false {
            return .refuse(reason: "the forge says it cannot be merged as it stands")
        }
        switch rollup {
        case .success:
            return .merge
        case .pending:
            return .wait(reason: "checks are still running")
        case .failure, .error:
            return .wakeWorker(
                reason: rollup == .error
                    ? "a check errored rather than failing - the run itself did not complete"
                    : "a check failed"
            )
        case .none:
            guard checksConfigured else { return .merge }
            return .wait(
                reason: "checks are configured for this repository but none have "
                    + "reported yet; merging now would merge past a gate rather "
                    + "than through it"
            )
        }
    }

    /// What the woken worker is told, in the terms its brief already uses.
    ///
    /// Named separately because a wake-up that says only "it is red" gives the
    /// worker nothing to act on, and a worker with nothing to act on repeats
    /// what it did. The failing check names are the whole point.
    static func wakeInstruction(
        prNumber: Int,
        reason: String,
        failingChecks: [String]
    ) -> String {
        let named = failingChecks.isEmpty
            ? "The forge did not name which check."
            : "Failing: " + failingChecks.joined(separator: ", ") + "."
        return "Pull request #\(prNumber) did not pass the gate: \(reason). \(named) "
            + "Work on your own branch until the gate is green. Do not open a new "
            + "pull request - this one is yours and it stays open. Push to the same "
            + "branch and the checks run again."
    }
}
