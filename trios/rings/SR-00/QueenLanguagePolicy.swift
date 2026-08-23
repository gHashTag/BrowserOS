import Foundation

/// L3, measured: everything committed is English.
///
/// The rule existed as prose for months and caught nothing, because nothing
/// measured it. On 2026-08-22 a bee replaced the English document
/// `docs/parallel-two.md` with a Russian rewrite - 45 English lines deleted,
/// 8 Russian lines added - and every gate downstream passed it: the reviewer
/// judged only a character count, which a rewrite in any language satisfies,
/// auto-accept saw a committed file and a named SHA, and a pull request
/// opened. A human closed it. This policy is what a human had to be for.
///
/// What is deliberately NOT measured here, and why:
///
/// - **The commit subject.** Bee commit subjects mirror their issue titles,
///   and most issues in this repository were written in Russian before L3 was
///   extended on 2026-08-19. Refusing those would block every legitimate bee
///   working an older issue - measured: the same hour's #1151, whose Swift
///   work was sound, carries a Russian subject. Tightening that is the
///   operator's decision about their own backlog, not a guard's.
/// - **New files written in Russian.** A new file has no previous language to
///   depart from, and the same hour showed the false-positive risk is real.
///   The measured harm is the rewrite: English prose that existed and stopped
///   existing.
/// - **Russian inside source code.** This tree's own Swift quotes Russian
///   issue text in comments and string literals (`## Границы` is parsed by
///   name). Ratio, not presence, is what separates a quote from a rewrite.
enum QueenLanguagePolicy {
    /// A file must carry at least this many letters before its language is
    /// judged. A two-line stub flipping "language" says nothing.
    static let minimumLettersToJudge = 200

    /// Above this share of non-ASCII letters, the text is not English prose.
    static let rewrittenRatio = 0.40

    /// At or below this share, the text was English prose.
    static let wasEnglishRatio = 0.10

    /// Share of *letters* that are outside ASCII. Letters only: punctuation,
    /// digits, markdown syntax and Swift operators are language-neutral, and
    /// counting them would make a heavily-punctuated Russian file read as
    /// half English.
    ///
    /// Returns 0 for text with no letters at all - nothing to judge is not
    /// evidence of a rewrite.
    static func nonASCIILetterRatio(_ text: String) -> Double {
        var letters = 0
        var nonASCII = 0
        for scalarBearing in text.unicodeScalars {
            guard CharacterSet.letters.contains(scalarBearing) else { continue }
            letters += 1
            if !scalarBearing.isASCII { nonASCII += 1 }
        }
        guard letters > 0 else { return 0 }
        return Double(nonASCII) / Double(letters)
    }

    /// Number of letters in the text, the size gate for judging it.
    static func letterCount(_ text: String) -> Int {
        text.unicodeScalars.reduce(into: 0) { count, scalarBearing in
            if CharacterSet.letters.contains(scalarBearing) { count += 1 }
        }
    }

    /// Names the refusal when an English file is being replaced by a
    /// non-English one, or nil when the change is anything else.
    ///
    /// Both sides are measured and both numbers go into the message: a
    /// refusal that cannot show its measurement is the same guess this
    /// repository keeps paying for.
    static func rewriteRefusal(path: String, before: String, after: String) -> String? {
        guard letterCount(before) >= minimumLettersToJudge else { return nil }
        let was = nonASCIILetterRatio(before)
        let now = nonASCIILetterRatio(after)
        guard was <= wasEnglishRatio, now >= rewrittenRatio else { return nil }
        return "`\(path)` was \(percent(was)) non-English letters and the staged "
            + "version is \(percent(now)). L3 says everything committed is English, "
            + "so a translation of an existing English file cannot land. The work "
            + "is still in the worktree: rewrite the file in English, or say in the "
            + "issue that the boundary was wrong."
    }

    /// The first refusal among staged files, so a commit carrying one rewrite
    /// among good files still stops and names which file stopped it.
    static func rewriteRefusal(stagedFiles: [(path: String, before: String, after: String)]) -> String? {
        for file in stagedFiles {
            if let reason = rewriteRefusal(
                path: file.path, before: file.before, after: file.after
            ) {
                return reason
            }
        }
        return nil
    }

    /// A commit subject that satisfies L3 whatever language the issue is in.
    ///
    /// The generated subject was `<type>(trios): <task.title>`, and `task.title`
    /// is the GitHub issue title verbatim. Issues filed before 2026-08-19 are
    /// in Russian, so the Queen generated Russian commit subjects, which L3
    /// forbids.
    ///
    /// Nothing downstream could repair it. `QueenBranchCommitter` never
    /// amends, so returning the task to its worker adds a SECOND commit
    /// carrying the same generated subject; and the title is read from the
    /// registry record rather than from GitHub, so renaming the issue changes
    /// nothing either. The only place this can be fixed is where the subject
    /// is composed. Measured on #1173, whose commit reads
    /// `fix(trios): Сужение попадает один раз из четырёх ...`.
    ///
    /// An English title is used unchanged - the issue's own words are the best
    /// description of the work, and most issues are English. A non-English one
    /// is replaced by what the commit touches, which is English by
    /// construction and is the one fact always available. Nothing is lost:
    /// `Closes #N` in the body already carries the traceability, and the issue
    /// keeps its own title.
    ///
    /// Judged by ratio rather than by presence, like every other rule here. A
    /// title is short, so one accented letter in `Café` or a transliterated
    /// surname stays under the threshold and the title survives; a title
    /// written in another script does not.
    static func commitSubject(
        title: String,
        ownedPaths: [String],
        issueNumber: Int
    ) -> String {
        let flattened = title
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !flattened.isEmpty, nonASCIILetterRatio(flattened) <= wasEnglishRatio {
            return flattened
        }
        return describing(ownedPaths: ownedPaths, issueNumber: issueNumber)
    }

    /// The English fallback subject: what this commit was allowed to touch.
    static func describing(ownedPaths: [String], issueNumber: Int) -> String {
        let paths = ownedPaths
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        switch paths.count {
        case 0:
            // No boundary to describe. The issue number is all that is left,
            // and it is still a true statement about the commit.
            return "resolve issue \(issueNumber)"
        case 1:
            return "update \(paths[0])"
        default:
            if let shared = commonDirectory(of: paths) {
                return "update \(paths.count) files under \(shared)"
            }
            return "update \(paths.count) files for issue \(issueNumber)"
        }
    }

    /// The deepest directory containing every path, or nil when they share none.
    ///
    /// Compared component by component rather than as strings: `rings/SR-0`
    /// is a common string prefix of `rings/SR-00/A.swift` and
    /// `rings/SR-01/B.swift`, and it is not a directory.
    static func commonDirectory(of paths: [String]) -> String? {
        guard let first = paths.first else { return nil }
        var shared = first.split(separator: "/").map(String.init)
        shared.removeLast()
        for path in paths.dropFirst() {
            var components = path.split(separator: "/").map(String.init)
            components.removeLast()
            // Stops at the FIRST mismatch. A `where lhs == rhs` filter would
            // skip a differing component and keep a later matching one,
            // splicing together a directory that does not exist.
            var matched: [String] = []
            for (lhs, rhs) in zip(shared, components) {
                guard lhs == rhs else { break }
                matched.append(lhs)
            }
            shared = matched
            if shared.isEmpty { return nil }
        }
        return shared.isEmpty ? nil : shared.joined(separator: "/")
    }

    private static func percent(_ ratio: Double) -> String {
        "\(Int((ratio * 100).rounded()))%"
    }
}
