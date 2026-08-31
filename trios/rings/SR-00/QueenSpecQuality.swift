import Foundation

/// Whether an issue is a specification, or only a wish.
///
/// The rule the operator set: every task is a GitHub spec, written to
/// github/spec-kit's practice. This is that rule made checkable, because a
/// standard nothing measures is a standard people believe they are following.
///
/// WHY IT MATTERS HERE RATHER THAN AS DOCUMENTATION. Measured on the live
/// board: **24 of 27** open issues in the backlog could not be delegated to
/// anyone. Not because the swarm was busy - because they never said which
/// files they touch, so nothing could be reserved for them and any bee sent at
/// one would collide with whatever else was running. The swarm was not slow, it
/// was starved, and the cause was upstream of every scheduler.
///
/// SPEC-KIT'S SECTIONS, and one of ours. From templates/spec-template.md at
/// github/spec-kit, the three sections it marks *(mandatory)*:
///
///   User Scenarios & Testing   prioritised stories, each with an independent
///                              test and Given/When/Then acceptance scenarios
///   Requirements               FR-001 style, each saying MUST
///   Success Criteria           measurable outcomes, not adjectives
///
/// To which this repository adds a fourth that spec-kit has no reason to have:
/// a BOUNDARY. spec-kit assumes one author on one feature branch. Here a
/// supervisor allocates files to concurrent workers, so an issue that has not
/// named its files cannot be given out at all - that is not a quality
/// preference, it is the difference between delegatable and not.
///
/// WHAT THIS DELIBERATELY DOES NOT DO: judge whether the spec is any GOOD. It
/// checks that the parts a machine can check are present. A shallow spec with
/// all four sections passes here and fails at review, which is the right place
/// for a judgement about substance.
public enum QueenSpecQuality {

    /// One requirement of a spec, and whether the text satisfies it.
    public struct Check: Equatable, Sendable {
        public let name: String
        public let met: Bool
        /// What to add, phrased so it can be pasted into the issue.
        public let remedy: String

        public init(name: String, met: Bool, remedy: String) {
            self.name = name
            self.met = met
            self.remedy = remedy
        }
    }

    public struct Verdict: Equatable, Sendable {
        public let checks: [Check]
        /// Delegatable at all. False when the boundary is missing: everything
        /// else is quality, this one is capability.
        public let delegatable: Bool
        /// Every mandatory section present.
        public let isSpec: Bool

        public var missing: [String] { checks.filter { !$0.met }.map(\.name) }

        public init(checks: [Check], delegatable: Bool, isSpec: Bool) {
            self.checks = checks
            self.delegatable = delegatable
            self.isSpec = isSpec
        }
    }

    /// Headings are matched case-insensitively and in both languages the
    /// repository's issues are written in.
    ///
    /// L3 says everything written from 2026-08-19 is English; issues older than
    /// that are Russian, and they are still open. A checker that recognised
    /// only the English spelling would report every one of them as missing a
    /// section it plainly has - the same defect `QueenIssueBoundary` already
    /// had to fix for the boundary heading itself.
    static func hasSection(_ body: String, _ names: [String]) -> Bool {
        let lower = body.lowercased()
        return names.contains { lower.contains("## \($0.lowercased())") }
    }

    /// A Given/When/Then scenario, in either language.
    static func hasAcceptanceScenario(_ body: String) -> Bool {
        let lower = body.lowercased()
        let given = ["**given**", "given ", "дано", "если "]
        let then = ["**then**", "then ", "тогда", "то "]
        return given.contains(where: lower.contains) && then.contains(where: lower.contains)
    }

    /// A requirement written as an obligation rather than a hope.
    ///
    /// spec-kit's form is `**FR-001**: System MUST ...`. The MUST is the part
    /// that matters: "should support" and "would be nice" cannot be judged met
    /// or unmet, so a reviewer cannot close the task and a bee cannot know when
    /// it has finished.
    static func hasObligation(_ body: String) -> Bool {
        if body.range(of: #"\bFR-\d{3}\b"#, options: .regularExpression) != nil { return true }
        let lower = body.lowercased()
        return lower.contains(" must ") || lower.contains("должен ") || lower.contains("обязан ")
    }

    /// A criterion a machine or a reviewer can settle.
    ///
    /// A number, a file path, a command, a log line, or a quoted string. The
    /// point is not the digit - it is that "faster" and "cleaner" cannot be
    /// checked, and this repository has closed tasks on adjectives before.
    static func hasMeasurableOutcome(_ body: String) -> Bool {
        let patterns = [
            #"\b\d+\s*(ms|s|MB|GB|%|files?|lines?|tests?|attempts?)\b"#,
            #"`[^`]+\.(swift|ts|rs|md|json|zig|v)`"#,
            #"\bexit(s)? (0|non-zero)\b"#,
            #"`(make|swift|bun|cargo|git) [^`]+`"#,
        ]
        return patterns.contains {
            body.range(of: $0, options: [.regularExpression, .caseInsensitive]) != nil
        }
    }

    public static func judge(body: String) -> Verdict {
        let boundary = QueenIssueBoundary.paths(from: body)
        let hasBoundary = (boundary?.isEmpty == false)

        let checks: [Check] = [
            Check(
                name: "boundary",
                met: hasBoundary,
                remedy: "Add a `## Boundary` section listing every file this task "
                    + "may touch, one per line. Without it nothing can be reserved "
                    + "and the task cannot be given to anyone."
            ),
            Check(
                name: "scenarios",
                met: hasSection(body, ["User Scenarios", "Scenarios", "Сценарии"])
                    || hasAcceptanceScenario(body),
                remedy: "Add `## User Scenarios & Testing` with at least one "
                    + "Given/When/Then scenario. A task with no scenario cannot be "
                    + "shown to work; it can only be declared finished."
            ),
            Check(
                name: "requirements",
                met: hasSection(body, ["Requirements", "Требования"]) && hasObligation(body),
                remedy: "Add `## Requirements` with numbered obligations - "
                    + "`FR-001: ... MUST ...`. \"Should\" and \"would be nice\" "
                    + "cannot be judged met or unmet."
            ),
            Check(
                name: "success criteria",
                met: (hasSection(body, ["Success Criteria", "Критерии", "Done when", "Готово когда"])
                      || hasSection(body, ["Acceptance"]))
                    && hasMeasurableOutcome(body),
                remedy: "Add `## Success Criteria` with outcomes something can "
                    + "check: a number, a file, a command and its exit code, or a "
                    + "log line to grep for. Adjectives close tasks that were never "
                    + "done."
            ),
        ]

        return Verdict(
            checks: checks,
            delegatable: hasBoundary,
            isSpec: checks.allSatisfy(\.met)
        )
    }

    /// One line naming what the issue still needs, for a log or a board.
    public static func shortfall(_ verdict: Verdict) -> String? {
        let missing = verdict.missing
        guard !missing.isEmpty else { return nil }
        return "not yet a spec - missing " + missing.joined(separator: ", ")
    }
}
