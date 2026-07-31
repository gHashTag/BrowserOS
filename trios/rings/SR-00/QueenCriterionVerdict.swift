import Foundation

/// Whether a single acceptance criterion was met.
///
/// Three states, not two. "Not checked" is the one that matters: collapsing it
/// into "not met" makes an unexamined criterion look examined, and collapsing
/// it into "met" is how work gets accepted on a glance. The whole reason the
/// specification exists is to stop completion being asserted in one sentence,
/// and a two-state verdict quietly restores that.
enum QueenCriterionVerdict: String, Codable, Equatable, CaseIterable {
    case met
    case unmet
    case unchecked

    var symbol: String {
        switch self {
        case .met: return "[x]"
        case .unmet: return "[ ]"
        case .unchecked: return "[?]"
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
    static func verdicts(
        criteria: [String],
        recorded: [String: QueenCriterionVerdict]
    ) -> [(criterion: String, verdict: QueenCriterionVerdict)] {
        criteria.map { ($0, recorded[$0] ?? .unchecked) }
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
    static func acceptanceBlockReason(
        criteria: [String],
        recorded: [String: QueenCriterionVerdict]
    ) -> String? {
        guard !criteria.isEmpty else {
            // No contract means nothing to check against. Accepting is still
            // possible - refusing would strand every task opened before criteria
            // existed - but the reviewer should know what they are signing.
            return nil
        }
        let table = verdicts(criteria: criteria, recorded: recorded)
        let unchecked = table.filter { $0.verdict == .unchecked }
        let unmet = table.filter { $0.verdict == .unmet }

        if !unmet.isEmpty {
            return "\(unmet.count) criterion(s) were not met: "
                + unmet.map(\.criterion).joined(separator: "; ")
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
        recorded: [String: QueenCriterionVerdict]
    ) -> String {
        guard !criteria.isEmpty else {
            return "No acceptance criteria were set, so there is nothing to check "
                + "against. Whatever is accepted here is accepted on judgement."
        }
        return verdicts(criteria: criteria, recorded: recorded)
            .enumerated()
            .map { index, row in "\(row.verdict.symbol) \(index + 1). \(row.criterion)" }
            .joined(separator: "\n")
    }
}
