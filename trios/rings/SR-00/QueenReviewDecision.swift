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
///
/// The second queue with no exit was quieter, because it opened over a *pass*
/// (#1286). A negative test is a task one of whose criteria is obliged to stay
/// unmet: #1153 asks for a fifty-thousand-character file, says plainly that the
/// criterion will not be met, and requires the counter to refuse, naming the
/// measured number and the threshold. The counter refused. The run succeeded.
/// The review read `unmet`, could not tell "the bee failed" from "it worked",
/// returned the task twice, escalated, and the boundary stayed held over the
/// one outcome the task existed to produce. An `unmet` with no varieties is
/// what parked it; the marker below gives it the missing one.
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

    // MARK: - The negative-test marker (#1286 criteria 1 & 4)

    /// The tokens that mark a criterion as deliberately unmet.
    ///
    /// Written into the issue under the criteria heading, carried verbatim into
    /// the parsed contract by `QueenTaskSpec.criteriaFromIssue` (which strips
    /// only checklist state - `[x]`, `[X]`, `[ ]` - and keeps the sentence), and
    /// read back here at decision time. Bracketed on both ends so ordinary
    /// prose cannot trip it: "never" appears in sentences that mean nothing of
    /// the kind, and a criterion parked on a false marker is the same queue
    /// with no exit wearing a different hat. Two spellings of the Russian one,
    /// because the issue text says «заведомо невыполнимый критерий» and the
    /// natural bracket forms differ by the adjective's ending.
    ///
    /// Literals rather than a hash of the phrasing, for the same reason the
    /// adversary marker is one: a hash would change with every wording
    /// revision and turn each improvement into a broken contract, while a
    /// stable token survives edits and still carries the meaning (#1127's
    /// precedent, applied here).
    static let negativeCriterionMarkers: [String] = [
        "[заведомо невыполним]",
        "[заведомо невыполнимый]",
        "[deliberately unmet]",
    ]

    /// Whether a criterion is marked as one the task is obliged to leave
    /// unmet.
    ///
    /// Case-insensitive containment, not a prefix test: the marker travels
    /// inside the criterion text, and demanding it lead the sentence would
    /// reject the contract the author actually wrote in favour of one this
    /// function prefers. Anything unmarked reads exactly as it always did -
    /// an unmarked criterion judged unmet is still a failure, which is the
    /// default the whole review path was built on.
    static func isDeliberatelyUnmet(_ criterion: String) -> Bool {
        let lowered = criterion.lowercased()
        return negativeCriterionMarkers.contains { lowered.contains($0) }
    }

    /// The verdict as the contract reads it, not as it was recorded.
    ///
    /// A marked criterion is met exactly when the reviewer could not meet it,
    /// and unmet exactly when the reviewer met it (#1286 criterion 2). That
    /// inversion is the whole point of the marker: the negative check *breaks*
    /// if the behaviour it exists to check disappears - a counter that stops
    /// refusing satisfies the criterion, the inversion turns the satisfied
    /// into an unmet, and the task goes back named, instead of sailing through
    /// on the disappearance of the thing it was testing.
    ///
    /// Unmarked criteria pass through untouched, so every task without a
    /// negative criterion decides exactly as before - the marker adds a
    /// variety to `unmet` rather than redefining it.
    static func effectiveVerdict(
        _ verdict: (criterion: String, met: Bool)
    ) -> (criterion: String, met: Bool) {
        guard isDeliberatelyUnmet(verdict.criterion) else { return verdict }
        return (verdict.criterion, !verdict.met)
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
    ///
    /// Verdicts are read through `effectiveVerdict`, so a marked criterion
    /// resolves on its refusal: a negative test whose every criterion has a
    /// verdict - including the one that ends in the refusal it was written to
    /// produce - reaches `.accept` here with no person anywhere in the loop,
    /// and the boundary it held is free to be chosen again (#1286 criterion 3).
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

        let unmet = verdicts.map(effectiveVerdict).filter { !$0.met }.map(\.criterion)

        // Regression guard (#1286 criterion 4), driven from the failing side:
        // a criterion marked deliberately unmet that was judged unmet resolves
        // to *met* above, so it can never legitimately appear in the return
        // list. The only way it lands there is the inversion not having run
        // for it - the marker parsing removed or bypassed at the call above,
        // while `isDeliberatelyUnmet` still answers true. That is the
        // parked-forever signature this issue exists to remove, and it must
        // not be worked through quietly: burning both returns on a criterion
        // nobody can satisfy, then escalating with "the conversation has not
        // moved", points the human at the bee when the defect is in the
        // parsing. So the decision escalates immediately with the regression
        // named. Re-derived from the raw verdicts, deliberately, so the check
        // observes what the mapping did rather than comparing a copy against
        // itself; delete `isDeliberatelyUnmet` entirely and the file stops
        // compiling instead - the removal is loud either way.
        let markerIgnored = verdicts.filter {
            isDeliberatelyUnmet($0.criterion) && !$0.met && unmet.contains($0.criterion)
        }
        if !markerIgnored.isEmpty {
            TriosLogBus.shared.warn(
                .queen,
                "queen.assertion.negative_marker_ignored",
                "A criterion marked deliberately unmet was judged unmet and still "
                    + "counted as a failure - the marker's verdict inversion did not "
                    + "run for it, so the negative test reads as ordinary and parks "
                    + "on its own success again (#1286)",
                ["criteria": markerIgnored.count.description]
            )
            return .escalate(
                reason: "\(markerIgnored.count) criterion(s) are marked deliberately "
                    + "unmet and were judged unmet - which is the outcome they exist "
                    + "to produce - yet they are still counted as failures. The "
                    + "marker's verdict inversion did not run for them, so this "
                    + "negative test reads as an ordinary failure and will park in "
                    + "review forever. That is a regression in the marker parsing "
                    + "(#1286), not something the worker can fix by trying again."
            )
        }

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
    ///
    /// A marked criterion on this list gets its own explanation. It can only
    /// be here because the reviewer found it *satisfied* - the one outcome a
    /// negative criterion counts as failure - and a worker told only "not met"
    /// about a criterion the reviewer called met has been handed a
    /// contradiction with no handle on it. The line names the handle: the
    /// behaviour the criterion exists to check has disappeared, and restoring
    /// it is the work.
    static func sendBackNote(unmet: [String], attempt: Int) -> String {
        var lines = [
            "Returning this for a \(ordinal(attempt)) pass. "
                + "\(unmet.count) criterion(s) from your own specification are not met:",
        ]
        for (index, criterion) in unmet.enumerated() {
            lines.append("  \(index + 1). \(criterion)")
            if isDeliberatelyUnmet(criterion) {
                lines.append(
                    "     This one is marked deliberately unmet: it resolves only "
                        + "while it cannot be satisfied. The reviewer found it "
                        + "satisfied, so the behaviour it exists to check has "
                        + "disappeared - restore that behaviour; removing the "
                        + "marker is not an answer here."
                )
            }
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
