import Foundation

/// Asks a reviewer agent for a verdict on each acceptance criterion.
///
/// Mechanical verdicts settle criteria that name a file — the file exists or
/// it does not — but most criteria ask whether something works, is correct,
/// or reads the right way. Those questions a path check cannot answer, and
/// leaving them as "never checked" is how a review turns into a rubber stamp.
/// This builds the brief that carries the criteria and the branch diff to a
/// reviewer agent, and parses the response back into verdicts.
///
/// Parsing is deliberately conservative: a garbled, empty, or inconclusive
/// answer leaves a criterion absent from the result, which reads as
/// `unchecked` downstream. The parser never records `.unchecked` itself —
/// "could not check" from the reviewer is treated the same as no answer at
/// all, so an unreviewed criterion is simply missing from the dictionary
/// rather than carrying a value that looks like a verdict. Guessing "met"
/// from a response that did not say so is how unexamined work gets accepted
/// on a glance — the whole point of the three-state verdict is that "I did
/// not check" is different from "I checked and it passed".
enum QueenReviewVerdictRequest {
    /// Builds the brief a reviewer agent receives.
    ///
    /// The criteria are listed as a numbered table so the response can refer
    /// to them by number or by text. The diff is included verbatim so the
    /// reviewer sees what changed rather than a summary of it — a summary
    /// that paraphrases a diff is the same summary that hides the line that
    /// fails.
    static func brief(
        criteria: [String],
        diff: String
    ) -> String {
        var lines: [String] = [
            "You are a code reviewer. Below are the acceptance criteria for a task",
            "and the diff of what the worker changed. For each criterion give a",
            "verdict on its own line, using the criterion's number, in this format:",
            "",
            "N. met|unmet|could not check — one sentence explaining why",
            "",
            "Say \"could not check\" if the diff does not let you tell. Do not guess:",
            "a criterion you are unsure about is better left to a human than",
            "silently marked met.",
            "",
            "## Acceptance criteria"
        ]
        for (index, criterion) in criteria.enumerated() {
            lines.append("\(index + 1). \(criterion)")
        }
        lines.append("")
        lines.append("## Diff")
        if diff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            lines.append("(no changes detected)")
        } else {
            lines.append("```diff")
            lines.append(diff)
            lines.append("```")
        }
        return lines.joined(separator: "\n")
    }

    /// Parses a reviewer's response into per-criterion verdicts.
    ///
    /// Only criteria that appear in the response with a recognisable verdict
    /// (`.met` or `.unmet`) are returned. Absent criteria stay out of the
    /// dictionary and read as `unchecked` when the acceptance policy builds
    /// its table — the contract is that an answer the parser could not
    /// understand, or one that explicitly says "could not check", must not
    /// become a pass. The parser never records `.unchecked`; an unreviewed
    /// criterion is simply missing.
    static func parse(
        _ response: String,
        criteria: [String]
    ) -> [String: QueenCriterionVerdict] {
        let trimmed = response.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [:] }

        let lines = trimmed.components(separatedBy: .newlines)
        var verdicts: [String: QueenCriterionVerdict] = [:]

        for (index, criterion) in criteria.enumerated() {
            guard let verdict = verdictOnLine(
                forCriterion: criterion,
                lineNumber: index + 1,
                in: lines
            ) else { continue }
            verdicts[criterion] = verdict
        }
        return verdicts
    }

    // MARK: - Parsing internals

    /// Finds the verdict for one criterion by scanning response lines.
    ///
    /// Two strategies, in order:
    /// 1. A line whose leading token is the criterion's number ("3.").
    /// 2. A line containing enough of the criterion text to be unambiguous.
    ///
    /// A line that matches the criterion but carries no recognisable verdict
    /// keyword returns nil — "I looked at criterion 2 and it seems fine" is
    /// not the format that was asked for, and reading "fine" as "met" is a
    /// guess.
    private static func verdictOnLine(
        forCriterion criterion: String,
        lineNumber number: Int,
        in lines: [String]
    ) -> QueenCriterionVerdict? {
        let numberPrefix = "\(number)."
        // The criterion text is stripped from any matched line before the
        // verdict keyword search. A criterion whose own wording contains a
        // verdict word — "met" inside "must be met", "unmet" inside "is not
        // unmet" — would otherwise be decided by its own echo when the
        // reviewer merely quoted it back. What remains after stripping is the
        // reviewer's own words; if those carry no verdict keyword, the
        // criterion stays absent.
        let echo = distinctivePrefix(of: criterion)

        // Strategy 1: a line that references the criterion by its number,
        // either as the leading token ("3.") or after a checkbox marker
        // ("[x] 3.").
        if let line = lines.first(where: {
            lineStartsWithNumber($0, prefix: numberPrefix)
        }) {
            return verdictKeyword(in: line, stripping: echo)
        }
        // Strategy 2: a line that quotes the criterion's opening words.
        // The reviewer may abbreviate a long criterion, so only the first few
        // words need to appear.
        if !echo.isEmpty {
            if let line = lines.first(where: {
                $0.localizedCaseInsensitiveContains(echo)
            }) {
                return verdictKeyword(in: line, stripping: echo)
            }
        }
        return nil
    }

    /// Whether a line's meaningful content begins with the criterion's
    /// number prefix. Handles both bare numbers ("3.") and checkbox-style
    /// markers that precede them ("[x] 3.", "[ ] 3.").
    private static func lineStartsWithNumber(
        _ line: String,
        prefix: String
    ) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix(prefix) { return true }
        let strippedCheckbox = trimmed.replacingOccurrences(
            of: #"^\[[xX ?]\]\s*"#,
            with: "",
            options: .regularExpression
        )
        return strippedCheckbox.hasPrefix(prefix)
    }

    /// Extracts a verdict from the keywords on a single line.
    ///
    /// Returns only `.met` or `.unmet` — never `.unchecked`. A criterion the
    /// reviewer could not settle ("could not check", "[?]") must stay absent
    /// from the result dictionary so it reads as unchecked downstream. Recording
    /// `.unchecked` explicitly would make an answer the parser understood look
    /// identical to one it could not parse, which is the very confusion the
    /// three-state verdict exists to prevent.
    ///
    /// "not met" is checked before "met" so that "not met" is not swallowed
    /// by a substring match on "met". Word boundaries guard against "metrics"
    /// and "parameter" — false friends that would turn a line about something
    /// else into a pass.
    private static func verdictKeyword(
        in line: String,
        stripping echo: String = ""
    ) -> QueenCriterionVerdict? {
        // Remove the echoed criterion text so keywords from the criterion's
        // own wording do not decide its verdict. A reviewer who writes
        // "1. the file must be met" and nothing else has not given a verdict —
        // "met" came from the criterion, not from the reviewer.
        let searchLine = echo.isEmpty
            ? line
            : line.replacingOccurrences(of: echo, with: " ", options: .caseInsensitive)
        let lower = searchLine.lowercased()

        // Checkbox markers used elsewhere in the project.
        if lower.contains("[x]") { return .met }
        if lower.contains("[ ]") { return .unmet }
        // "[?]" is treated the same as "could not check": the criterion stays
        // absent rather than being recorded as .unchecked.

        if matchesWord(lower, "not met") || matchesWord(lower, "unmet") {
            return .unmet
        }
        if matchesWord(lower, "met") {
            return .met
        }
        return nil
    }

    /// Word-boundary match so "met" does not fire inside "metrics".
    private static func matchesWord(_ text: String, _ word: String) -> Bool {
        let escaped = NSRegularExpression.escapedPattern(for: word)
        let pattern = "\\b\(escaped)\\b"
        return text.range(of: pattern, options: .regularExpression) != nil
    }

    /// The first few words of a criterion, enough to find it in a line of
    /// prose without matching common connective text.
    private static func distinctivePrefix(
        of criterion: String,
        wordLimit: Int = 6
    ) -> String {
        criterion
            .split(separator: " ")
            .prefix(wordLimit)
            .joined(separator: " ")
    }
}
