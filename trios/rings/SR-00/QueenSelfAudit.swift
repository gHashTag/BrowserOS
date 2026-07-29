import Foundation

/// What the Queen finds when she reads her own code.
///
/// Self-improvement that consists of asking a model "what should we do next"
/// produces plausible roadmaps and no findings. These checks are mechanical and
/// run against the repository as it is, so every item on the roadmap points at
/// a file. The recurring defects in this project have all been of one shape -
/// something built and never called - and that is exactly what a machine can
/// find and a conversation cannot.
enum QueenSelfAudit {
    struct Finding: Identifiable, Equatable {
        enum Severity: String, Equatable {
            /// Shipped and unreachable.
            case dead
            /// Reachable but unproven.
            case unverified
            /// Works, but the shape invites the next bug.
            case fragile
        }

        var id: String { "\(kind)|\(subject)" }
        let severity: Severity
        /// Short machine-readable category, used to group a roadmap.
        let kind: String
        /// The file, symbol or subsystem the finding is about.
        let subject: String
        /// Written to be read aloud in the chat, not parsed.
        let explanation: String
        /// What the Queen would do about it, in one sentence.
        let proposal: String
    }

    /// Ranks a roadmap. Dead code first: an unreachable capability is a lie the
    /// codebase is telling about itself, and every other estimate downstream of
    /// it is wrong.
    static func roadmap(from findings: [Finding]) -> [Finding] {
        findings.sorted { lhs, rhs in
            if lhs.severity != rhs.severity {
                return order(lhs.severity) < order(rhs.severity)
            }
            return lhs.subject < rhs.subject
        }
    }

    private static func order(_ severity: Finding.Severity) -> Int {
        switch severity {
        case .dead: return 0
        case .unverified: return 1
        case .fragile: return 2
        }
    }

    /// Composes the report the Queen posts.
    ///
    /// Prose with reasoning, because a list of file names is a linter and the
    /// point of asking her is that she can say why one item outranks another.
    static func report(findings: [Finding], now: Date) -> String {
        guard !findings.isEmpty else {
            return "I read my own code and found nothing I can prove is wrong. "
                + "That is a statement about my checks, not a clean bill of health: "
                + "they only catch capabilities nobody calls, claims nobody tested, "
                + "and shapes that have burned us before."
        }

        let ranked = roadmap(from: findings)
        var paragraphs = [
            "I went through my own code at \(timestamp(now)) and found "
                + "\(ranked.count) thing\(ranked.count == 1 ? "" : "s") worth your attention."
        ]

        if let dead = ranked.first(where: { $0.severity == .dead }) {
            paragraphs.append(
                "The one I would fix first is \(dead.subject). \(dead.explanation) "
                    + "I put this above everything else because unreachable code is the "
                    + "repository lying about what it can do - the way a limb can look "
                    + "intact while the nerve to it is cut. Every plan made downstream of "
                    + "that belief is wrong. \(dead.proposal)"
            )
        }

        let rest = ranked.filter { $0.severity != .dead || $0.subject != ranked.first?.subject }
        if !rest.isEmpty {
            var lines = ["Then, in the order I would take them:"]
            for finding in rest {
                lines.append("  [\(finding.severity.rawValue)] \(finding.subject) - \(finding.proposal)")
            }
            paragraphs.append(lines.joined(separator: "\n"))
        }

        paragraphs.append(
            "I did not change anything. Each of these becomes a worker chat on its "
                + "own branch the moment you say so - /delegate <issue> queen-swift "
                + "--paths <files> <title> - and nothing lands without your review."
        )
        return paragraphs.joined(separator: "\n\n")
    }

    /// Finds symbols that are declared once and never used anywhere else.
    ///
    /// The check is deliberately crude: one declaration, one occurrence. It has
    /// caught six real defects in this project and it cannot be argued with,
    /// which is more than can be said for a model's opinion about the codebase.
    static func deadSymbols(
        declarations: [String: Int],
        threshold: Int = 1
    ) -> [String] {
        declarations
            .filter { $0.value <= threshold }
            .keys
            .sorted()
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }
}
