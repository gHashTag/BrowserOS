import Foundation

/// Which rehearsed procedure a task should be handed.
///
/// The Queen's own charter says it plainly: a skill "is a rehearsed procedure
/// rather than something I improvise, which is why switching one off narrows
/// what I can do rather than how well I do it." Twenty-six of them sit in
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
enum QueenSkillMatch {
    /// Boundary shapes and the skill each one calls for, most specific first.
    ///
    /// Order matters: `tests/swift/run_chat_sse_e2e.sh` is both a test path and
    /// a shell script, and the test reading is the useful one.
    static let rules: [(matches: (String) -> Bool, skill: String)] = [
        ({ $0.contains("tests/") || $0.hasSuffix("Tests.swift") }, "e2e-testing"),
        ({ $0.hasSuffix("build.sh") || $0.hasSuffix("Makefile") }, "agent-safe-build"),
        ({ $0.contains("rings/RUST-") }, "tri-pipeline"),
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
    static func skill(forBoundary paths: [String], available: Set<String>) -> String? {
        guard !paths.isEmpty else { return nil }
        var chosen: String?
        for path in paths {
            let lower = path.lowercased()
            guard let match = rules.first(where: { $0.matches(lower) })?.skill else {
                return nil
            }
            if let chosen, chosen != match { return nil }
            chosen = match
        }
        guard let chosen, available.contains(chosen) else { return nil }
        return chosen
    }
}
