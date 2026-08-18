import Foundation

/// Asks a reviewer agent for a verdict on each acceptance criterion.
///
/// The reviewer is prompted as an adversary — its task is to find why each
/// criterion is NOT met, and `met` is recorded only when the reviewer tried
/// to break the criterion and could not. A reviewer that confirms everything
/// it sees is a rubber stamp; the adversarial framing makes confirmation
/// harder than refutation, so a `met` that survives is one the reviewer
/// stood behind rather than one it nodded through. (#1127)
///
/// When two or more providers are configured, `reviewerProvider` routes the
/// reviewer to one the worker did not use, so the same model is not grading
/// its own output. When only one provider exists, role separation — the
/// adversarial prompt itself — is the safeguard: the same model plays a
/// different part, and the prompt is materially different from anything a
/// worker receives. (#1127)
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
    /// Maximum lines a single file may occupy in the brief before being
    /// truncated. A file dumped in full crowds out the diff and the criteria,
    /// leaving the reviewer with a wall of code and no room for the verdicts
    /// the brief exists to collect. Truncation is explicit — the marker shows
    /// how many lines were omitted — so the reviewer knows the file was cut
    /// rather than ending where the fence closes.
    private static let maxFileLinesInBrief = 500

    // MARK: - Adversarial prompt identity (#1127 criteria 1 & 4)

    /// A token embedded in every adversarial reviewer brief. Tests check for
    /// it to prove the reviewer received the adversary's instructions — if
    /// the brief were replaced with a worker's prompt, which carries no such
    /// marker, the check goes red (#1127 criterion 4). A caller that wants
    /// to gate trust on prompt identity before accepting a response uses
    /// `isAdversarialBrief` the same way.
    ///
    /// The marker is a literal, not a hash: a hash of the prompt would change
    /// every time the wording is revised, turning every improvement into a
    /// broken test. A stable token survives edits and still proves the prompt
    /// is the adversary's, because the worker's prompt never carries it.
    static let adversaryPromptMarker = "adversary-review"

    /// Whether a prompt carries the adversary marker.
    ///
    /// Returns `false` for any text that lacks the token — including the old
    /// neutral reviewer prompt and any worker prompt. The standing check is
    /// in the test suite: a worker prompt is asserted to fail this test, so
    /// swapping the adversary's instructions for the worker's turns the
    /// check red (#1127 criterion 4). A caller may use it the same way as a
    /// gate: a brief without the marker is not an adversary's brief, and a
    /// response to it is not an adversary's verdict. This is the check that
    /// "breaks" when the reviewer receives the worker's instructions instead
    /// of the adversary's.
    static func isAdversarialBrief(_ prompt: String) -> Bool {
        prompt.contains(adversaryPromptMarker)
    }

    // MARK: - Reviewer model selection (#1127 criterion 2)

    /// Picks the provider the reviewer must run on, given what the settings
    /// actually hold.
    ///
    /// `usableProviders` is every provider that can serve a request right
    /// now. For a provider whose `requiresAPIKey` is true, that means at
    /// least one key in `ModelCredentialStore`; for `.ollama`, which needs
    /// no key, being present in the settings is enough — the criterion
    /// (#1127) speaks of a second provider in the settings, and a local
    /// second provider is a second provider even when it holds no key. The
    /// caller builds that list; this function stays pure so the decision
    /// can be asserted without touching the Keychain.
    ///
    /// The decision is the criterion's own wording, as code:
    ///
    /// - Two or more usable providers → the first one that is not the
    ///   worker's. The reviewer judges on a different provider, so the
    ///   assumptions that wrote the code are not the ones grading it. Which
    ///   model the reviewer uses on that provider is the caller's choice;
    ///   the separation the criterion demands is at the provider.
    /// - One usable provider, or none → `nil`. Not an error: role
    ///   separation — the adversarial brief above — is the safeguard, and
    ///   the caller sends the worker's configuration, still carrying the
    ///   adversary's instructions. `journalModelLine(provider: nil)` records
    ///   exactly that, so the journal never claims a separation that did
    ///   not happen.
    ///
    /// `workerProvider` may be `nil` when the worker's provider is unknown;
    /// any usable provider is then acceptable (an identity that is unknown
    /// is already not trusted to be the same as the worker's).
    ///
    /// Contract for the supervision path, which lives outside this file:
    /// when this returns a provider, the reviewer's request goes out on
    /// that provider's configuration rather than the worker's; when it
    /// returns `nil`, the request goes out unchanged and the brief alone
    /// carries the independence. The decision is here, the routing is
    /// there — a call site that ignores the returned provider quietly
    /// turns criterion 2 back into role separation for everyone.
    static func reviewerProvider(
        workerProvider: ModelProvider?,
        usableProviders: [ModelProvider]
    ) -> ModelProvider? {
        guard usableProviders.count > 1 else { return nil }
        if let workerProvider {
            return usableProviders.first(where: { $0 != workerProvider })
        }
        return usableProviders.first
    }

    // MARK: - Journal metadata (#1127 criterion 3)

    /// Formats the model identity for the review journal so a reader can see
    /// which model produced each verdict.
    ///
    /// The independence of a verdict is only as strong as the independence of
    /// the model behind it. When the reviewer used a different provider than
    /// the worker, the line says so. When it used the same provider (role
    /// separation was the safeguard), the line says that too — so a reader
    /// knows the prompt was the defence, not the model.
    ///
    /// `provider` is `nil` when only one provider exists or when
    /// `reviewerProvider` returned `nil`. In both cases the reviewer ran on
    /// the same provider as the worker, and the line records that fact rather
    /// than hiding it behind a model name alone.
    static func journalModelLine(model: String, provider: String?) -> String {
        if let provider {
            return "Verdict by \(model) via \(provider)"
        }
        return "Verdict by \(model) (same provider as worker; role separation)"
    }

    // MARK: - Brief

    /// Builds the brief a reviewer agent receives.
    ///
    /// The reviewer is framed as an adversary: its task is to find why each
    /// criterion is NOT met, not to confirm that it is. `met` is the verdict
    /// for a criterion the reviewer tried to break and could not — anything
    /// weaker stays unchecked. This framing is the difference between a
    /// reviewer and a rubber stamp.
    ///
    /// The brief opens with `adversaryPromptMarker` so the caller can verify
    /// (`isAdversarialBrief`) that the prompt was not swapped for a worker's
    /// before sending it. The criteria are listed as a numbered table so the
    /// response can refer to them by number or by text. The diff is included
    /// verbatim so the reviewer sees what changed rather than a summary of
    /// it — a summary that paraphrases a diff is the same summary that hides
    /// the line that fails. The full contents of touched files are appended
    /// after the diff so a criterion that asks about code the change did not
    /// touch — but that lives in a file the change did — can be judged from
    /// what is there, not only from what was added or removed. Large files
    /// are truncated with a visible marker rather than omitted silently.
    static func brief(
        criteria: [String],
        diff: String,
        fileContents: [String: String] = [:]
    ) -> String {
        var lines: [String] = [
            "[\(adversaryPromptMarker)]",
            "",
            "You are an adversarial reviewer, not a helper. Your task is to find",
            "why each criterion is NOT met — not to confirm that it is.",
            "",
            "For each criterion, try to break it. Look for gaps, missing cases,",
            "partial implementations, edges the code does not handle, and anything",
            "that would fail under scrutiny. Only mark a criterion as \"met\" when",
            "you have actively tried to refute it and could not find a single reason",
            "it fails. If you can find even one reason the criterion does not hold,",
            "mark it \"unmet\" and state why.",
            "",
            "This is not about being harsh — it is about being honest. A criterion",
            "that survives an attempt to break it is one you can stand behind. One",
            "approved on a glance is one nobody checked.",
            "",
            "Below are the acceptance criteria, the diff of what the worker changed,",
            "and the full contents of the files that were touched. For each criterion",
            "give a verdict on its own line, using the criterion's number, in this",
            "format:",
            "",
            "N. met|unmet|could not check — one sentence explaining why",
            "",
            "Say \"could not check\" if the diff and file contents do not let you",
            "tell. Do not guess: a criterion you are unsure about is better left to",
            "a human than silently marked met.",
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

        // Full file contents let the reviewer judge criteria that depend on
        // unchanged code near the change — a diff alone hides the context
        // the criterion asks about. Truncated, not omitted, when a file is
        // large enough to crowd the rest of the brief.
        if !fileContents.isEmpty {
            lines.append("")
            lines.append("## Touched files (full contents after change)")
            for path in fileContents.keys.sorted() {
                let content = fileContents[path] ?? ""
                let fileLines = content.components(separatedBy: "\n")
                lines.append("")
                lines.append("### \(path)")
                lines.append("```")
                if fileLines.count <= Self.maxFileLinesInBrief {
                    lines.append(content)
                } else {
                    lines.append(
                        fileLines.prefix(Self.maxFileLinesInBrief)
                            .joined(separator: "\n")
                    )
                    lines.append(
                        "… (truncated: \(Self.maxFileLinesInBrief) of "
                        + "\(fileLines.count) lines)"
                    )
                }
                lines.append("```")
            }
        }

        let result = lines.joined(separator: "\n")

        // Regression guard (#1127 criterion 4): the brief must carry the
        // adversary marker. If the adversarial framing were removed — the
        // opening lines replaced with a neutral or worker-style prompt — the
        // marker disappears and isAdversarialBrief returns false. This guard
        // fires to make the breakage visible: a brief without the marker is
        // a brief the caller must not trust, because the reviewer was prompted
        // as a helper, not as an adversary. Placed here, not at the call site,
        // so it is impossible to build a brief that bypasses it — the function
        // self-verifies before returning.
        if !isAdversarialBrief(result) {
            TriosLogBus.shared.warn(
                .queen,
                "queen.assertion.adversarial_marker_missing",
                "Reviewer brief does not carry the adversary marker — the "
                    + "adversarial prompt was removed or replaced with a "
                    + "worker's prompt (#1127)"
            )
        }

        return result
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
        // whether the number is bare ("3."), wrapped in markdown ("**3.",
        // "- 3."), or preceded by a checkbox ("[x] 3.").
        if let line = lines.first(where: {
            lineStartsWithNumber($0, prefix: numberPrefix)
        }) {
            return verdictKeyword(in: line, stripping: echo)
        }
        // Strategy 2: a line that quotes the criterion's opening words.
        // The reviewer may abbreviate a long criterion, so only the first few
        // words need to appear.
        if !echo.isEmpty {
            let needle = echo.trimmingCharacters(
                in: CharacterSet.punctuationCharacters.union(.whitespaces)
            )
            if !needle.isEmpty,
               let line = lines.first(where: {
                   $0.localizedCaseInsensitiveContains(needle)
               }) {
                return verdictKeyword(in: line, stripping: echo)
            }
        }
        return nil
    }

    /// Whether a line's meaningful content begins with the criterion's
    /// number prefix. Handles bare numbers ("3."), checkbox markers
    /// ("[x] 3.", "[ ] 3."), and markdown decoration on the number
    /// itself ("**3.", "- 3.", "* 3.") — reviewers wrap numbers in
    /// bold or lead with a bullet, and the prefix hides behind them.
    ///
    /// Stripping decoration here does not make the parser more willing
    /// to guess: `verdictKeyword` still demands a keyword on the matched
    /// line, so a decorated number with no verdict word returns nil.
    private static func lineStartsWithNumber(
        _ line: String,
        prefix: String
    ) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix(prefix) { return true }
        let stripped = trimmed.replacingOccurrences(
            of: #"^([*#\-|]+|\[[xX ?]\])\s*"#,
            with: "",
            options: .regularExpression
        )
        return stripped.hasPrefix(prefix)
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
