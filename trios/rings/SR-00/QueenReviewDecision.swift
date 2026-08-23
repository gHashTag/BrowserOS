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
/// Then a criterion arrived that no honest bee could ever satisfy (#1286). A
/// negative test states, in the affirmative, the failure it exists to guard
/// against - #1153 asked for a document of fifty thousand characters and said
/// in the issue that the criterion would not be met, because the point was to
/// watch the counter refuse. The counter refused. The check worked. And the
/// task went back to the bee twice over the criterion it had been ordered to
/// leave unmet, escalated to a person who had nothing to decide, and sat in
/// `awaitingReview` holding its files. The defect is that an unmet verdict has
/// no varieties: the review cannot tell "the bee failed" from "the criterion
/// was designed to stay unmet, and did". Both read `unmet`; only one of them
/// is a failure.
///
/// A criterion carrying the deliberately-unfulfillable marker below declares
/// itself заведомо невыполнимый - meant to stay unmet - and this file is where
/// that marker is parsed and honoured. It has to be here: verdicts arrive
/// already judged, and the decision is the one place left that can know a
/// verdict was meant upside down. #1286 itself measured the cost of not having
/// it: the task about the parking parked, burned its two returns, escalated,
/// and held `QueenReviewDecision.swift` for hours until a person cancelled it.
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

    /// The bracketed prefixes that mark a criterion заведомо невыполнимый:
    /// a negative test, judged the other way round (#1286).
    ///
    /// Written at the start of the criterion line, in the issue's own words:
    ///
    ///     ## Готово, когда
    ///     - [заведомо невыполнимый] Проверка ломается, если убрать разбор
    ///       маркера: помеченный критерий снова читается как обычный
    ///     - [negative] the counter refuses, naming the measured number
    ///
    /// Two stems, so the phrase survives its natural endings - `[заведомо
    /// невыполнимый]`, `[заведомо невыполним]`, `[negative]`, `[negative
    /// test]` - and the issue can be written in either language this
    /// repository thinks in. Matched as a prefix after trimming and
    /// lowercasing, so a capitalised first word still marks.
    ///
    /// The brackets are the whole claim. A criterion that merely begins with
    /// the phrase in prose - "Заведомо невыполнимый критерий виден в
    /// контракте" is a sentence about the concept, not a declaration of it -
    /// is an ordinary criterion, because silently inverting a criterion that
    /// was never marked is exactly the accident the marker exists to make
    /// impossible.
    ///
    /// The marker is parsed here and nowhere else, and it is never stripped.
    /// The criterion keeps it verbatim from the issue text through
    /// `QueenTaskSpec.criteriaFromIssue` (which strips bullet prefixes and
    /// checklist state `[x]`/`[ ]`, not declarations), through the brief, the
    /// reviewer's verdict request, the verdict table and this decision - so
    /// the marking is visible everywhere the parsed contract is quoted, which
    /// is what #1286's first criterion asks "visible in the issue text and in
    /// the parsed contract" to mean. Stripping it would also fork the
    /// criterion's identity: verdicts are keyed by the exact string, and a
    /// criterion that arrives here marked but was recorded unmarked would
    /// read as never judged.
    static let deliberatelyUnfulfillableStems = ["[negative", "[заведомо невыполним"]

    /// Whether a criterion carries the deliberately-unfulfillable marker.
    ///
    /// Prefix only, after trimming whitespace: a criterion that merely
    /// *mentions* negativity mid-sentence is ordinary prose, and flipping
    /// such a criterion's verdict by accident is precisely the silent
    /// inversion this marker exists to make explicit.
    static func isDeliberatelyUnfulfillable(_ criterion: String) -> Bool {
        let line = criterion.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return deliberatelyUnfulfillableStems.contains { line.hasPrefix($0) }
    }

    /// How a criterion counts, once the reviewer's verdict is in (#1286).
    ///
    /// THE definition of the inversion, and the only one: a criterion marked
    /// заведомо невыполнимый counts as met exactly when the reviewer found it
    /// unmet - the honest answer for a sentence describing a state the
    /// delivered work exists to keep absent - and as unmet when the reviewer
    /// suddenly found it met, which means the guarded state showed up in the
    /// work and the negative check must break rather than pass vacuously. An
    /// ordinary criterion counts exactly as the reviewer found it.
    ///
    /// Every consumer must call this rather than transcribe the ternary: one
    /// rule written twice is two rules that agree until someone edits one.
    /// `unmetCriteria` below consumes it, and the two consumers outside this
    /// file are each one line against it -
    ///
    ///     // QueenAcceptancePolicy.verdicts (rings/SR-00/QueenCriterionVerdict.swift):
    ///     countsAsMet(criterion: criterion, reviewerFoundMet: recorded == .met)
    ///         ? .met : .unmet
    ///
    ///     // the verdict table ChatViewModel.actOnCompletedReview builds from
    ///     // task.criterionVerdicts (rings/SR-02/ChatViewModel.swift):
    ///     (criterion, countsAsMet(criterion: criterion, reviewerFoundMet: verdict == .met))
    ///
    /// Nothing outside this file calls it yet. As of this writing the
    /// acceptance gate - `QueenAcceptancePolicy.verdicts`, reached from
    /// `autoAcceptIfUnambiguous` and every `/accept` path - still reads a
    /// marked criterion's honest `.unmet` as blocking, so a negative-control
    /// task whose marked criterion resolved exactly as designed is refused
    /// auto-accept and parks in `awaitingReview` holding its boundary: the
    /// very defect #1286 was filed over, surviving one file down. That wiring
    /// is this issue's remaining half and it lives beyond this file's
    /// boundary; do not read this file alone and conclude the pipeline
    /// honours the marker.
    ///
    /// Deliberately self-contained on `String`/`Bool` only: the golden chain
    /// (`make chain`) compiles this file beside `QueenRetryPolicy.swift` and
    /// nothing else, so a reference to `QueenCriterionVerdict` here would
    /// break the twin's build. The Bool shape is what both consumers need.
    static func countsAsMet(
        criterion: String,
        reviewerFoundMet: Bool
    ) -> Bool {
        isDeliberatelyUnfulfillable(criterion) ? !reviewerFoundMet : reviewerFoundMet
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
    /// unfulfilled when the reviewer suddenly finds it met. A marked criterion
    /// that comes back met means the guarded state showed up in the work: the
    /// tested behaviour disappeared, the negative probe was padded or
    /// disarmed, and the decision must break loudly (a send-back naming it)
    /// rather than pass vacuously. See `unmetCriteria` for both directions,
    /// and for what removing that honouring does to a task whose only
    /// unresolved criterion is a marked one: it parks, again, on the answer
    /// that was the point.
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

    /// The criteria that count as unfulfilled once the marker is honoured.
    ///
    /// An ordinary criterion counts against the task exactly when the reviewer
    /// found it unmet. A criterion marked заведомо невыполнимый counts against
    /// the task exactly when the reviewer found it met - and resolves as
    /// fulfilled when it was not, which is the only reading under which a
    /// negative test can ever leave the review queue: the refusal *is* the
    /// result, so a decision that demanded the criterion be met would demand
    /// the probe be disarmed, and #1153 measured what that does - two returns
    /// over the criterion the issue had ordered to stay unmet, then an
    /// escalation, then hours of held boundary. `countsAsMet` above is the
    /// definition this consumes; there is no second copy of the rule here.
    ///
    /// This honouring is load-bearing, not decorative (#1286 criterion 4).
    /// Remove it - let `isDeliberatelyUnfulfillable` answer false, neuter
    /// `countsAsMet` to return the reviewer's answer unchanged, or delete the
    /// branch that consults it - and a marked criterion reads as ordinary
    /// again: its perpetual honest `unmet` lands in this list, the task is
    /// returned over a criterion no bee may satisfy, the returns run out, and
    /// the task parks in `awaitingReview` holding its files until a person
    /// reads the issue. That flip - accept becoming send-back becoming
    /// escalation on the same verdicts - is the check breaking, and it is the
    /// one behaviour this function must not lose.
    static func unmetCriteria(
        _ verdicts: [(criterion: String, met: Bool)]
    ) -> [String] {
        verdicts
            .filter { verdict in
                !countsAsMet(criterion: verdict.criterion, reviewerFoundMet: verdict.met)
            }
            .map(\.criterion)
    }

    /// What the returned worker is told.
    ///
    /// The unmet criteria verbatim, because "it did not pass" is the one thing
    /// a worker cannot act on. The criteria are the contract it agreed to; the
    /// list of the ones it missed is the whole message.
    ///
    /// A marked criterion lands in that list only in the upside-down case -
    /// the reviewer found it met (#1286). Quoted bare, it would tell the bee
    /// its negative test failed when the reviewer said the opposite, so each
    /// marked entry carries the one sentence that makes it readable: met is
    /// the wrong answer for a заведомо невыполнимый criterion, and the thing
    /// to look at is what changed under it, not more code.
    static func sendBackNote(unmet: [String], attempt: Int) -> String {
        var lines = [
            "Returning this for a \(ordinal(attempt)) pass. "
                + "\(unmet.count) criterion(s) from your own specification are not met:",
        ]
        for (index, criterion) in unmet.enumerated() {
            lines.append("  \(index + 1). \(criterion)")
            if isDeliberatelyUnfulfillable(criterion) {
                lines.append(
                    "     judged met - which is the wrong answer for a criterion marked "
                        + "заведомо невыполнимый: the state it describes is the one this "
                        + "work exists to prevent, so a met verdict means the guard no "
                        + "longer holds. Find what changed under it; writing more code "
                        + "against it is not the fix."
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
