import Foundation

/// What happens to a task once every criterion has a verdict.
///
/// The review itself was never the missing piece. Eight tasks sat in
/// `awaitingReview` in the release registry, the oldest for fifteen hours, and
/// all eight had a complete set of verdicts - every criterion judged, every one
/// of them with at least one `unmet`. The Queen had done the whole job except
/// the last step of it.
///
/// She also already had the step. `/review <slug> reject <why>` moves the task
/// back to the worker, rebriefs it with the reason and restarts the runner - it
/// works, and nothing has ever called it but a human typing the command. So a
/// judged-and-failed task waited for a person while holding its file boundary,
/// and a held boundary is why the next tick reported "all 24 candidates look
/// already done": there was work to choose, and every path to it was owned by
/// something nobody had finished.
///
/// This is the fourth thing in this project found declared and never called,
/// after the autonomy preference, the worktree committer, and the skill match.
/// The shape is always the same - a mechanism built, a rule to invoke it never
/// written - and the symptom is always a queue that only a human drains.
enum QueenReviewDecision {
    enum Decision: Equatable {
        /// Every criterion met and there is a diff to show for it.
        case accept
        /// Something is unmet. Back to the bee, with the failures named.
        case sendBack(unmet: [String])
        /// A person is needed. Bees will not fix this one.
        case escalate(reason: String)
        /// Not judged yet; do nothing and do not count it as anything.
        case wait(reason: String)
    }

    /// Times a task may be returned before it becomes a person's problem.
    ///
    /// Two, for the same reason two attempts are allowed elsewhere: the first
    /// return is the one that can teach - it names criteria the worker had not
    /// satisfied - and a bee that has failed the same named criteria twice is
    /// telling you about the criteria, not about itself.
    static let maximumSendBacks = 2

    /// The decision, from the verdicts and nothing else.
    ///
    /// `committedFiles` matters independently of the verdicts because "every
    /// criterion met" against an empty diff is not a pass: it means the
    /// reviewer had nothing in front of it and answered anyway. Accepting that
    /// would let a bee that did nothing be indistinguishable from one that
    /// succeeded, which is the failure this whole review path exists to catch.
    static func decide(
        verdicts: [(criterion: String, met: Bool)],
        totalCriteria: Int,
        committedFiles: Int?,
        priorSendBacks: Int
    ) -> Decision {
        guard totalCriteria > 0 else {
            return .escalate(
                reason: "the task has no acceptance criteria, so there is nothing to judge "
                    + "it against - it can only be abandoned or accepted on faith"
            )
        }
        guard verdicts.count >= totalCriteria else {
            return .wait(
                reason: "\(verdicts.count) of \(totalCriteria) criteria judged so far"
            )
        }

        let unmet = verdicts.filter { !$0.met }.map(\.criterion)
        if unmet.isEmpty {
            guard (committedFiles ?? 0) > 0 else {
                return .escalate(
                    reason: "every criterion is marked met but nothing was committed; a "
                        + "reviewer that passes an empty diff has judged the absence of "
                        + "work rather than the work"
                )
            }
            return .accept
        }

        guard priorSendBacks < maximumSendBacks else {
            return .escalate(
                reason: "returned \(priorSendBacks) time(s) already and \(unmet.count) "
                    + "criterion(s) are still unmet; a third return would repeat a "
                    + "conversation that has not moved"
            )
        }
        return .sendBack(unmet: unmet)
    }

    /// What the returned worker is told.
    ///
    /// The unmet criteria verbatim, because "it did not pass" is the one thing
    /// a worker cannot act on. The criteria are the contract it agreed to; the
    /// list of the ones it missed is the whole message.
    static func sendBackNote(unmet: [String], attempt: Int) -> String {
        var lines = [
            "Returning this for a \(ordinal(attempt)) pass. "
                + "\(unmet.count) criterion(s) from your own specification are not met:",
        ]
        for (index, criterion) in unmet.enumerated() {
            lines.append("  \(index + 1). \(criterion)")
        }
        lines.append(
            "Address these specifically. If one of them is wrong or impossible as "
                + "written, say so and say why - a criterion that cannot be met is worth "
                + "reporting, and it is the only answer here that is not more code."
        )
        return lines.joined(separator: "\n")
    }

    private static func ordinal(_ n: Int) -> String {
        switch n {
        case 1: return "second"
        case 2: return "third"
        default: return "\(n + 1)th"
        }
    }
}
