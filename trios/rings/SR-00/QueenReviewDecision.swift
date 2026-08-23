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
/// Then a criterion arrived that no bee could ever satisfy (#1286). A negative
/// test states, in the affirmative, the failure it exists to guard against -
/// "the check breaks if you remove the marker parsing: the marked criterion is
/// read as ordinary again and the task gets stuck again" - and against the
/// delivered work that sentence is false *by design*, because the work exists
/// to make the stuck state absent. An adversarial reviewer reads the sentence
/// literally, finds the state it describes missing from the tree, and answers
/// `unmet` - honestly, every time, forever. The bee is returned a criterion it
/// cannot fix without undoing the feature, twice, and the task escalates to a
/// person who has nothing to decide: the criterion did exactly its job, and
/// only its reading was wrong. That is a negative test parking itself in the
/// review queue forever, boundary held, waiting for a human to say what the
/// contract already said.
///
/// A criterion carrying `negativeCriterionMarker` declares itself заведомо
/// невыполнимый - knowingly unfulfillable - and this file is where that marker
/// is parsed and honoured. It has to be here: verdicts arrive already judged,
/// and the decision is the one place left that can know a verdict was meant
/// upside down.
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

    /// The marker that declares a criterion заведомо невыполнимый: a negative
    /// test, judged the other way round.
    ///
    /// Written as a bracketed prefix on the criterion line, in the issue's own
    /// words:
    ///
    ///     ## Acceptance criteria
    ///     - [заведомо невыполнимый] the check breaks if the marker parsing is
    ///       removed: the task gets stuck again
    ///
    /// It is parsed here and nowhere else, and it is never stripped. The
    /// criterion keeps it verbatim from the issue text through the brief, the
    /// reviewer's verdict request, the verdict table and this decision, so the
    /// marking stays visible everywhere the parsed contract is quoted - and
    /// stripping it would fork the criterion's identity, because verdicts are
    /// keyed by the exact string. Case-insensitive, since the phrase is prose
    /// and the issue may capitalise it.
    static let negativeCriterionMarker = "[заведомо невыполнимый]"

    /// Whether a criterion carries the negative marker (#1286).
    ///
    /// Prefix only, after trimming whitespace: a criterion that merely
    /// *mentions* the phrase mid-sentence is ordinary prose about negativity,
    /// not a declaration of it, and flipping such a criterion's verdict by
    /// accident is exactly the silent inversion this marker exists to make
    /// explicit.
    static func isNegativeCriterion(_ criterion: String) -> Bool {
        criterion.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .hasPrefix(negativeCriterionMarker)
    }

    /// The decision, from the verdicts and nothing else.
    ///
    /// `committedFiles` matters independently of the verdicts because "every
    /// criterion met" against an empty diff is not a pass: it means the
    /// reviewer had nothing in front of it and answered anyway. Accepting that
    /// would let a bee that did nothing be indistinguishable from one that
    /// succeeded, which is the failure this whole review path exists to catch.
    ///
    /// A criterion marked заведомо невыполнимый resolves the other way round
    /// (#1286): the decision counts it fulfilled exactly when the reviewer
    /// found it unmet - the honest, expected answer for a sentence describing
    /// a state the delivered work exists to keep absent - and counts it
    /// unfulfilled when the reviewer suddenly finds it met. A negative
    /// criterion that comes back met means the guarded state showed up in the
    /// work: the tested behaviour disappeared, and the negative check must
    /// break loudly (a send-back naming it) rather than pass vacuously. Remove
    /// this marker parsing and the marked criterion reads as ordinary again,
    /// its perpetual `unmet` returns the task until the returns run out, and
    /// the parking defect is back - which is criterion 4 of #1286, stated here
    /// so the parsing cannot be deleted as decoration without the reason
    /// going with it.
    ///
    /// Criterion 4 asks for more than a reason in a comment: it asks for a
    /// check that *breaks* when the parsing is removed. `decide` therefore
    /// self-verifies before returning - the same shape as the adversary-marker
    /// guard in `QueenReviewVerdictRequest.buildBrief` (#1127), which is the
    /// precedent this follows. The verification is driven: replacing
    /// `isNegativeCriterion`'s body with `false` makes both disagreement cases
    /// below fire, in both directions.
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

        let unmet = unmetCriteria(verdicts)

        // #1286 criterion 4: the check that breaks if the marker parsing is
        // removed. A criterion carrying the marker is re-detected here
        // independently and its treatment is compared against what the parse
        // produced; on disagreement the decision refuses to be silent - it
        // escalates naming the breakage, because a task parked over a
        // criterion that is met by staying unmet must not look like ordinary
        // business. See `markerParseDisagreement` for why the detection here
        // is a copy rather than a call.
        if let broken = markerParseDisagreement(verdicts: verdicts, unmet: unmet) {
            TriosLogBus.shared.warn(
                .queen,
                "queen.assertion.negative_marker_parse_missing",
                "A criterion carrying \(negativeCriterionMarker) was read as an "
                    + "ordinary criterion - the marker parsing in QueenReviewDecision "
                    + "is gone (#1286). Judged \(broken.met ? "met" : "unmet"), which "
                    + "resolves \(broken.met ? "unfulfilled" : "fulfilled") only when "
                    + "the marker is honoured. Criterion: "
                    + String(broken.criterion.prefix(80)),
                ["criterion": String(broken.criterion.prefix(120))]
            )
            return .escalate(
                reason: "the criterion '"
                    + String(broken.criterion.prefix(80))
                    + "' carries \(negativeCriterionMarker) but was read as an ordinary "
                    + "criterion: with the parsing intact it resolves the other way "
                    + "round, so the parse is gone and the decision cannot be trusted "
                    + "to keep this task out of the review queue on its own (#1286)"
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

    /// The unmet criteria, with the negative marker honoured (#1286).
    ///
    /// A marked criterion is unfulfilled exactly when the reviewer found it
    /// met; every ordinary criterion is unchanged. Extracted from `decide` so
    /// the self-verification can compare the parse's output against an
    /// independent expectation without re-running the whole decision.
    static func unmetCriteria(
        _ verdicts: [(criterion: String, met: Bool)]
    ) -> [String] {
        verdicts
            .filter { verdict in
                isNegativeCriterion(verdict.criterion) ? verdict.met : !verdict.met
            }
            .map(\.criterion)
    }

    /// The #1286 criterion 4 check: the first verdict whose treatment
    /// disagrees with what its marker demands, or nil.
    ///
    /// This re-derives the marker detection locally - trim, lowercase,
    /// prefix - instead of calling `isNegativeCriterion`, and the duplication
    /// is the mechanism, not an oversight. A check that shared the production
    /// parse would be removed with it: delete or break `isNegativeCriterion`
    /// and the guard's own detection goes too, which is exactly the silent
    /// death criterion 4 exists to prevent. The copies are meant to disagree
    /// under mutation; unifying them would make the guard decorative. (The
    /// mirrored-copy lesson cuts the other way only for copies that must
    /// agree.)
    ///
    /// The expectation it asserts: a criterion carrying the marker is
    /// unfulfilled exactly when it was judged met. Driven in both directions:
    /// with `isNegativeCriterion` neutered to `false`, a marked criterion
    /// judged unmet lands in `unmet` (read as ordinary - disagreement) and a
    /// marked criterion judged met stays out of it (vacuous pass -
    /// disagreement); with the parse intact, every case agrees and this
    /// returns nil.
    private static func markerParseDisagreement(
        verdicts: [(criterion: String, met: Bool)],
        unmet: [String]
    ) -> (criterion: String, met: Bool)? {
        for verdict in verdicts
        where verdict.criterion
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .hasPrefix(negativeCriterionMarker) {
            if verdict.met != unmet.contains(verdict.criterion) {
                return verdict
            }
        }
        return nil
    }

    /// What the returned worker is told.
    ///
    /// The unmet criteria verbatim, because "it did not pass" is the one thing
    /// a worker cannot act on. The criteria are the contract it agreed to; the
    /// list of the ones it missed is the whole message.
    ///
    /// A marked criterion lands in that list only in the upside-down case - the
    /// reviewer found it met (#1286). Quoted bare, it would tell the bee its
    /// negative test failed when the reviewer said the opposite, so each marked
    /// entry carries the one sentence that makes it readable: met is the wrong
    /// answer for a заведомо невыполнимый criterion, and the thing to look at
    /// is what changed under it, not more code.
    static func sendBackNote(unmet: [String], attempt: Int) -> String {
        var lines = [
            "Returning this for a \(ordinal(attempt)) pass. "
                + "\(unmet.count) criterion(s) from your own specification are not met:",
        ]
        for (index, criterion) in unmet.enumerated() {
            lines.append("  \(index + 1). \(criterion)")
            if isNegativeCriterion(criterion) {
                lines.append(
                    "     judged met - which is the wrong answer for a criterion marked "
                        + "\(negativeCriterionMarker): the state it describes is the one "
                        + "this work exists to prevent. A negative criterion that comes "
                        + "back met means the guard no longer holds. Find what changed "
                        + "under it; writing more code against it is not the fix."
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
