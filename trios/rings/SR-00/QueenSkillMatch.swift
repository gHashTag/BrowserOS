import Foundation

/// Which rehearsed procedure a task should be handed.
///
/// The Queen's own charter says it plainly: a skill "is a rehearsed procedure
/// rather than something I improvise, which is why switching one off narrows
/// what I can do rather than how well I do it." Thirty-one of them sit in
/// `.claude/skills/`, the briefing has carried a `skillBody` slot since it was
/// written, `/delegate --skill` has always accepted a name - and not one
/// delegation in this project's history has ever named one. Every bee has
/// worked from first principles beside a shelf of written procedures.
///
/// The match is made from the boundary, because the boundary is the one thing
/// the Queen states about a task before any work happens. It is deliberately
/// conservative: a task that matches nothing gets nothing rather than a
/// plausible-sounding wrong procedure, since a bee briefed with the wrong
/// rehearsal is worse off than a bee briefed with none - it will follow it.
public enum QueenSkillMatch {
    /// Boundary shapes and the skill each one calls for, most specific first.
    ///
    /// Order matters: `tests/swift/run_chat_sse_e2e.sh` is both a test path and
    /// a shell script, and the test reading is the useful one.
    public static let rules: [(matches: (String) -> Bool, skill: String)] = [
        ({ $0.contains("tests/") || $0.hasSuffix("Tests.swift") }, "e2e-testing"),
        ({ $0.hasSuffix("build.sh") || $0.hasSuffix("Makefile") }, "agent-safe-build"),
        ({ $0.contains("rings/RUST-") }, "t27-tri-pipeline"),
        ({ $0.hasSuffix(".swift") }, "agent-safe-build"),
    ]

    /// The skill for this boundary, or nil when nothing fits.
    ///
    /// `available` is the set of skills actually installed AND enabled. A rule
    /// naming a skill that is switched off yields nil rather than a broken
    /// reference: the operator turning a skill off is a decision, and quietly
    /// briefing a worker with it anyway would overrule them.
    ///
    /// Every path must agree. A task owning both a test file and a build script
    /// has no single rehearsal that covers it, and picking the first is a coin
    /// toss dressed as a decision.
    /// Skill identifiers carry a leading slash in the store (`/agent-safe-build`),
    /// and the rules above name them bare. Comparing the two shapes directly
    /// matched nothing, so the whole match was inert while every test passed -
    /// they supplied a synthetic `available` set in the bare shape and agreed
    /// with themselves.
    public static func normalize(_ id: String) -> String {
        id.hasPrefix("/") ? String(id.dropFirst()) : id
    }

    public static func skill(forBoundary paths: [String], available: Set<String>) -> String? {
        let available = Set(available.map(normalize))
        guard !paths.isEmpty else { return nil }
        var chosen: String?
        for path in paths {
            // Compared as written, never folded: the literals above carry the
            // real casing of the things they name (`Tests.swift`, `Makefile`,
            // `rings/RUST-`), and a path lowercased before the rules ran could
            // never contain any of them - three literals in four rules were
            // dead and `rings/RUST-*` boundaries fell through to no skill.
            guard let match = rules.first(where: { $0.matches(path) })?.skill else {
                return nil
            }
            if let chosen, chosen != match { return nil }
            chosen = match
        }
        guard let chosen, available.contains(chosen) else { return nil }
        return chosen
    }
}
