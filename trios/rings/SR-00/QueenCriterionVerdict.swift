import Foundation

/// Whether a single acceptance criterion was met.
///
/// Four states, not two or three. "Not checked" is the one that was already
/// here: collapsing it into "not met" makes an unexamined criterion look
/// examined, and collapsing it into "met" is how work gets accepted on a
/// glance. "Stale" was added when a verdict turned out to be carved against
/// code that has since moved: a criterion checked against yesterday's tree is
/// not "met" today, but calling it "unchecked" hides the fact that somebody
/// looked. The difference matters because "re-check this" and "check this for
/// the first time" are different instructions, and a gate that cannot tell
/// them apart wastes the reviewer's attention on the wrong one.
enum QueenCriterionVerdict: String, Codable, Equatable, CaseIterable {
    case met
    case unmet
    case unchecked
    case stale

    var symbol: String {
        switch self {
        case .met: return "[x]"
        case .unmet: return "[ ]"
        case .unchecked: return "[?]"
        case .stale: return "[~]"
        }
    }
}

/// Decides whether delegated work can be accepted, from the criteria and what
/// is known about each.
enum QueenAcceptancePolicy {
    /// The verdict for each criterion, in the order they were written.
    ///
    /// Missing entries read as `unchecked` rather than being dropped: a
    /// criterion nobody answered still has to appear in the table, or the table
    /// silently shrinks to the questions that were convenient.
    ///
    /// When the caller supplies a `currentTreeState`, every recorded verdict
    /// (`.met` or `.unmet`) is checked against the `verdictTreeState` it was
    /// derived against. If the states differ — or if the verdict carries no
    /// state binding at all — the verdict is marked `.stale`. This is what
    /// stops a re-review from silently inheriting verdicts carved against code
    /// that has moved (#1126).
    ///
    /// Both parameters default to `nil` so that callers written before state
    /// tracking continue to work: with neither state provided, the function
    /// behaves exactly as it did before and no verdict is marked stale.
    static func verdicts(
        criteria: [String],
        recorded: [String: QueenCriterionVerdict],
        verdictTreeState: String? = nil,
        currentTreeState: String? = nil
    ) -> [(criterion: String, verdict: QueenCriterionVerdict)] {
        criteria.map { criterion in
            let raw = recorded[criterion] ?? .unchecked
            // Only checked verdicts can go stale. Unchecked was never looked
            // at, so there is nothing to invalidate.
            if (raw == .met || raw == .unmet),
               isStale(verdictTreeState: verdictTreeState, currentTreeState: currentTreeState) {
                return (criterion, .stale)
            }
            return (criterion, raw)
        }
    }

    /// Whether a recorded verdict is no longer trustworthy because the code it
    /// was checked against has moved.
    ///
    /// Returns `false` when `currentTreeState` is `nil`: old callers that do
    /// not track state are left alone, and the function degrades to its
    /// pre-#1126 behaviour.
    ///
    /// Returns `true` when `currentTreeState` is known but `verdictTreeState`
    /// is either absent or different. A checked criterion whose provenance was
    /// stripped cannot be trusted to be current, and treating it as stale is
    /// how the binding stays load-bearing rather than decorative: remove the
    /// binding and the check breaks, which is exactly what #1126 criterion 4
    /// asks for.
    static func isStale(
        verdictTreeState: String?,
        currentTreeState: String?
    ) -> Bool {
        guard let current = currentTreeState else { return false }
        return verdictTreeState != current
    }

    /// Verdicts the Queen can reach on evidence, without taking anyone's word.
    ///
    /// A worker stating that it met a criterion is not a check - it is the same
    /// agent grading its own homework, and a gate that accepts that is
    /// decoration. But some criteria are settled by fact rather than opinion:
    /// "docs/queen-review-gate.md exists" is answered by what the branch
    /// actually carries.
    ///
    /// So a criterion naming a path gets a verdict from the paths that changed:
    /// met if one of them is there, unmet if none is. A criterion naming no
    /// path gets no entry at all and stays unchecked, which keeps acceptance
    /// blocked on exactly the questions a person still has to answer. The point
    /// is not to unblock the gate; it is to stop it blocking on things nobody
    /// needed to be asked.
    static func mechanicalVerdicts(
        criteria: [String],
        changedPaths: [String]
    ) -> [String: QueenCriterionVerdict] {
        var found: [String: QueenCriterionVerdict] = [:]
        let changed = Set(changedPaths.map(QueenDelegationPolicy.normalizePath))
        for criterion in criteria {
            let mentioned = pathsMentioned(in: criterion)
            guard !mentioned.isEmpty else { continue }
            let satisfied = mentioned.contains { path in
                changed.contains { $0 == path || $0.hasSuffix("/\(path)") }
            }
            found[criterion] = satisfied ? .met : .unmet
        }
        return found
    }

    /// Tokens in a sentence that look like a file path: a slash and a suffix.
    ///
    /// Deliberately narrow. "it is short" names nothing checkable and must not
    /// be guessed at - a wrong verdict is worse than an absent one, because the
    /// absent one still stops the merge.
    static func pathsMentioned(in criterion: String) -> [String] {
        criterion
            .split(whereSeparator: { $0 == " " || $0 == "," || $0 == ";" })
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "`'\".:()")) }
            .filter { token in
                token.contains("/") && token.contains(".") && !token.hasSuffix("/")
            }
            .map(QueenDelegationPolicy.normalizePath)
    }

    /// Why this work cannot be accepted yet, or nil if it can.
    ///
    /// Stale criteria — those checked against a tree that has since moved — are
    /// named in their own sentence and block acceptance just as firmly as unmet
    /// or unchecked ones. "Checked against different code" is a different
    /// instruction from "never checked": the first asks the reviewer to
    /// re-examine something they already looked at, the second asks them to
    /// look for the first time. Collapsing them would send the reviewer back to
    /// criteria they already settled while the ones nobody touched wait (#1126).
    static func acceptanceBlockReason(
        criteria: [String],
        recorded: [String: QueenCriterionVerdict],
        verdictTreeState: String? = nil,
        currentTreeState: String? = nil
    ) -> String? {
        guard !criteria.isEmpty else {
            // No contract means nothing to check against. Accepting is still
            // possible - refusing would strand every task opened before criteria
            // existed - but the reviewer should know what they are signing.
            return nil
        }
        let table = verdicts(
            criteria: criteria,
            recorded: recorded,
            verdictTreeState: verdictTreeState,
            currentTreeState: currentTreeState
        )
        let unmet = table.filter { $0.verdict == .unmet }
        let stale = table.filter { $0.verdict == .stale }
        let unchecked = table.filter { $0.verdict == .unchecked }

        if !unmet.isEmpty {
            return "\(unmet.count) criterion(s) were not met: "
                + unmet.map(\.criterion).joined(separator: "; ")
        }
        if !stale.isEmpty {
            return "\(stale.count) criterion(s) were checked against different code: "
                + stale.map(\.criterion).joined(separator: "; ")
                + ". They need re-checking against the current tree."
        }
        if !unchecked.isEmpty {
            return "\(unchecked.count) criterion(s) were never checked: "
                + unchecked.map(\.criterion).joined(separator: "; ")
                + ". An unchecked criterion is not a pass."
        }
        return nil
    }

    /// The table a reviewer reads instead of the worker's summary.
    static func table(
        criteria: [String],
        recorded: [String: QueenCriterionVerdict],
        verdictTreeState: String? = nil,
        currentTreeState: String? = nil
    ) -> String {
        guard !criteria.isEmpty else {
            return "No acceptance criteria were set, so there is nothing to check "
                + "against. Whatever is accepted here is accepted on judgement."
        }
        return verdicts(
            criteria: criteria,
            recorded: recorded,
            verdictTreeState: verdictTreeState,
            currentTreeState: currentTreeState
        )
        .enumerated()
        .map { index, row in "\(row.verdict.symbol) \(index + 1). \(row.criterion)" }
        .joined(separator: "\n")
    }
}
