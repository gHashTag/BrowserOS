import Foundation

/// Turns what the Queen found in her own code into a short list of things she
/// could do next, each one something the user can agree to or decline.
///
/// She is not allowed to open a chat on her own judgement any more, so silence
/// would make her merely passive. Proposing is the other half of that gate: she
/// reads the repository, says what she would do, and waits.
///
/// Three, because a single suggestion reads as a decision already taken and a
/// long list moves the work of choosing back onto the person. Three is enough
/// to show a trade-off and few enough to answer in one line.
enum QueenEvolutionOptions {
    struct Option: Equatable {
        /// A, B, C. Stable labels so the user can answer with a letter.
        let label: String
        let subject: String
        /// Why this is worth doing, in the Queen's own words.
        let rationale: String
        /// What she would actually do.
        let action: String
        /// Whether she can start it herself once permitted, or whether the
        /// answer itself is the work.
        let needsUserDecision: Bool
    }

    static let desiredCount = 3

    /// Builds up to three options from ranked findings.
    ///
    /// Fewer findings means fewer options. Padding to three with filler would
    /// be the same failure as reporting a metric nobody measured: it makes an
    /// empty repository look like it offered a choice.
    static func options(from findings: [QueenSelfAudit.Finding]) -> [Option] {
        let ranked = QueenSelfAudit.roadmap(from: findings)
        let labels = ["A", "B", "C"]
        return ranked.prefix(desiredCount).enumerated().map { index, finding in
            Option(
                label: labels[index],
                subject: finding.subject,
                rationale: finding.explanation,
                action: finding.proposal,
                // A dead capability can be removed without asking anything; an
                // unproven or fragile one usually means deciding what it should
                // do, and that is not the Queen's call.
                needsUserDecision: finding.severity != .dead
            )
        }
    }

    /// The message the Queen posts into the main chat.
    ///
    /// Ends with the exact command that authorises one, because a proposal the
    /// user cannot act on in one line is a status update wearing a question
    /// mark.
    static func message(for options: [Option]) -> String {
        guard !options.isEmpty else {
            return "I read my own code and have nothing to propose. That is a "
                + "statement about my checks rather than about the codebase - they "
                + "only see capabilities nobody calls, claims nobody tested, and "
                + "shapes that have gone wrong here before."
        }

        var lines = ["I looked through the repository. Here is what I would do next."]
        for option in options {
            lines.append("")
            lines.append("\(option.label). \(option.subject)")
            lines.append(option.rationale)
            lines.append("What I would do: \(option.action)")
            if option.needsUserDecision {
                lines.append("This one needs your answer first - I would be "
                    + "guessing at what it should do, and a confident guess is "
                    + "worse here than a question.")
            }
        }
        lines.append("")
        lines.append("I will not open a chat for any of these until you say so. "
            + "Approve one with `/approve owner/repo#N` once there is an issue "
            + "for it.")
        return lines.joined(separator: "\n")
    }
}
