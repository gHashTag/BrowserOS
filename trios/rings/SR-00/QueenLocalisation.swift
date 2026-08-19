import Foundation

/// Finds where a name lives in source code.
///
/// The Queen needs to point at a region of a file and say "here". A line number
/// is too narrow — a function body is the unit of interest, not a single line.
/// But the full declaration can be enormous, so the range is capped to a window
/// around the hit.
///
/// This is pure static plumbing: source in, range out, no state, no side effects.
///
/// # Measurement record (#1173, repeated 2026-08-19)
///
/// Identifiers extracted from each issue body exactly as
/// `ChatViewModel.identifiers(from:)` extracts them, then driven through
/// `region(in:mentioning:)` against `rings/SR-02/ChatViewModel.swift`
/// (9 527 lines at the time of measuring):
///
/// | задача | идентификаторы из тела        | сужение     | совпало с названным человеком |
/// |--------|-------------------------------|-------------|------------------------------|
/// | #1156  | awaitingReview, characterCount, ChatViewModel | молчание | нет — тело не называет ни одного объявления |
/// | #1158  | autoAcceptIfUnambiguous, acceptanceBlockReason…, ProcessInfo, processInfo, awaitingReview, ChatViewModel | 6275-6493 `autoAcceptIfUnambiguous` | да |
/// | #1165  | ChatViewModel                 | молчание    | нет — тело не называет ничего, кроме имени типа |
/// | #1166  | startAfterChoosing, qualifiesForAutoAccept, fileCount, ownedPaths, isEmpty, ChatViewModel | 7217-7516 `chooseNextOpenIssue` (через параметр `startAfterChoosing`) | да |
///
/// Two of four. The bar set by #1173 was three of four, and the two misses
/// are not reachable by any rule over these bodies: #1156's body never
/// writes `handleWorkerFinished` and #1165's never writes
/// `requestReviewerVerdicts` — the premise "тело задачи почти всегда называет
/// виновника" (#1173) is false for exactly these two bodies. The earlier hit
/// on #1156 came from density landing right on the day's file state; measured
/// today, density lands in `pollPullRequests` (8416-8543), confidently wrong.
///
/// The check breaks when the name preference is removed, as #1173 requires:
/// with density alone (the pre-#1173 rule) the same measurement gives zero
/// of four and three wrong ranges (#1158 → `reset()` 67-366, #1166 →
/// `reset()` 67-366, #1165 → 7337-7383, #1156 → `pollPullRequests`
/// 8416-8543).
///
/// Side effect measured over every open sub-issue × boundary file: exactly
/// one other change — #1131 now narrows to
/// `acceptanceBlockReasonDistinguishingEmptyAnswers` (6027-6203), because its
/// evidence quotes that function's `verdictTreeState`/`currentTreeState`
/// parameters verbatim; before it was silence.
enum QueenLocalisation {

    /// Maximum number of lines a returned range may span.
    ///
    /// A 3 000-line generated file is useless to a reviewer; three hundred lines
    /// around the mention is enough context without burying the signal.
    static let maxRegionWidth = 300

    // MARK: - Public

    /// Returns the range (1-indexed) of the declaration the identifiers point
    /// at, or `nil` when they point at nothing the file declares.
    ///
    /// Evidence, strongest first (#1173, #1174):
    ///
    /// 1. A declaration whose **name** is one of the identifiers.
    /// 2. A declaration with a **parameter** named like one of the identifiers
    ///    (`startAfterChoosing:` names `chooseNextOpenIssue`).
    ///
    /// When several declarations match — a spec can name both the culprit and
    /// its neighbour guard — the one whose body actually uses the identifiers
    /// densest wins: the subject of an issue mentions the things the issue
    /// talks about, a function named in passing does not. Ties go to the
    /// earlier declaration.
    ///
    /// When nothing matches, the answer is `nil` — silence, not a guess
    /// (#1175): a spec without a range was always safe, a spec with a wrong
    /// range sends the bee to the wrong place with confidence. Density
    /// counting was removed after four measurements ranked it below every
    /// alternative: it points at whichever large early function holds the most
    /// ordinary words, which in a 9 000-line file is never the subject.
    ///
    /// - Parameters:
    ///   - source: Swift source text.
    ///   - identifiers: Whole words to search for (case-sensitive).
    /// - Returns: A 1-indexed `ClosedRange`, or `nil`.
    static func region(
        in source: String,
        mentioning identifiers: [String]
    ) -> ClosedRange<Int>? {
        guard !source.isEmpty, !identifiers.isEmpty else { return nil }

        let cleaned = source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")

        let masked = maskCommentsAndStrings(cleaned)
        let lines = masked.components(separatedBy: "\n")
        let depths = braceDepths(lines: lines)

        guard let winner = bestCandidate(
            in: lines,
            depths: depths,
            identifiers: identifiers
        ) else {
            return nil
        }

        let raw = winner.declLine...winner.bodyEnd
        let capped = capToWidth(raw, around: winner.declLine)

        // Self-check (#1176): the first line of the returned range must still
        // declare the name that won. If capping or any other step shifted the
        // start, the range points into the middle of something — silence it
        // rather than mislead.
        guard declarationName(on: lines[capped.lowerBound]) == winner.declaredName else {
            return nil
        }

        return (capped.lowerBound + 1)...(capped.upperBound + 1)
    }

    // MARK: - Comment & string masking

    /// Returns a copy of `source` in which every character inside a comment or
    /// string literal is replaced with a space. Newlines are preserved so line
    /// numbers stay aligned.
    ///
    /// Handles `//` line comments, nested `/* */` block comments, and simple
    /// `"..."` string literals with `\` escapes.
    private static func maskCommentsAndStrings(_ source: String) -> String {
        var output = [Character]()
        output.reserveCapacity(source.count)

        let chars = Array(source)
        var i = 0
        var blockDepth = 0
        var inString = false

        while i < chars.count {
            let c = chars[i]
            let next: Character? = i + 1 < chars.count ? chars[i + 1] : nil

            if blockDepth > 0 {
                if c == "/", next == "*" {
                    blockDepth += 1
                    output.append(" "); output.append(" ")
                    i += 2
                } else if c == "*", next == "/" {
                    blockDepth -= 1
                    output.append(" "); output.append(" ")
                    i += 2
                } else {
                    output.append(c == "\n" ? c : " ")
                    i += 1
                }
            } else if inString {
                if c == "\\", next != nil {
                    // An escape consumes the backslash and the escaped
                    // character — but a backslash-newline continuation
                    // must keep its newline, or every line after it
                    // shifts and the returned range points four lines
                    // above the declaration it names (measured on
                    // ChatViewModel.swift's reviewer prompt, #1173).
                    output.append(" ")
                    output.append(next == "\n" ? "\n" : " ")
                    i += 2
                } else if c == "\"" {
                    inString = false
                    output.append(" ")
                    i += 1
                } else {
                    output.append(c == "\n" ? c : " ")
                    i += 1
                }
            } else {
                if c == "/", next == "/" {
                    while i < chars.count, chars[i] != "\n" {
                        output.append(" ")
                        i += 1
                    }
                } else if c == "/", next == "*" {
                    blockDepth = 1
                    output.append(" "); output.append(" ")
                    i += 2
                } else if c == "\"" {
                    inString = true
                    output.append(" ")
                    i += 1
                } else {
                    output.append(c)
                    i += 1
                }
            }
        }

        return String(output)
    }

    // MARK: - Identifier counting

    /// Counts whole-word, case-sensitive matches of every identifier on a line.
    private static func countMatchesOnLine(_ text: String, _ words: [String]) -> Int {
        var count = 0
        for word in words {
            let pattern = "\\b" + NSRegularExpression.escapedPattern(for: word) + "\\b"
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let fullRange = NSRange(location: 0, length: text.utf16.count)
            count += regex.numberOfMatches(in: text, range: fullRange)
        }
        return count
    }

    /// Total identifier mentions within a 0-indexed line range.
    ///
    /// The **richness** of a declaration: how much of what the spec talks
    /// about actually happens inside it. Used to choose between several
    /// declarations the spec names.
    private static func totalMentions(
        in range: ClosedRange<Int>,
        lines: [String],
        identifiers: [String]
    ) -> Int {
        var count = 0
        for i in range {
            count += countMatchesOnLine(lines[i], identifiers)
        }
        return count
    }

    // MARK: - Brace tracking

    /// Element *i* is the brace nesting depth at the **start** of line *i*.
    private static func braceDepths(lines: [String]) -> [Int] {
        var result = [Int]()
        var depth = 0
        for line in lines {
            result.append(depth)
            for ch in line {
                if ch == "{" { depth += 1 }
                else if ch == "}" { depth -= 1 }
            }
        }
        return result
    }

    // MARK: - Candidates

    /// A declaration the identifiers point at, and the kind of the match.
    private struct Candidate {
        enum Kind {
            /// The declaration's own name is one of the identifiers.
            case name
            /// One of its parameters is one of the identifiers.
            case parameter
        }

        let kind: Kind
        /// 0-based line of `func`/`init`.
        let declLine: Int
        /// 0-based last line of the declaration body.
        let bodyEnd: Int
        /// The name the self-check must find on the first line of the range.
        let declaredName: String
        /// The identifier that produced the match (for ranking and logs).
        let matchedIdentifier: String
    }

    /// The strongest declaration the identifiers point at, or `nil` when
    /// none of them names a declaration or a parameter of one.
    private static func bestCandidate(
        in lines: [String],
        depths: [Int],
        identifiers: [String]
    ) -> Candidate? {
        let idSet = Set(identifiers)
        var candidates: [Candidate] = []

        for (idx, line) in lines.enumerated() {
            guard let name = declarationName(on: line) else { continue }

            // Name match — the strongest evidence there is.
            if idSet.contains(name) {
                if let end = declarationEnd(idx, depths: depths, lines: lines) {
                    candidates.append(
                        Candidate(
                            kind: .name,
                            declLine: idx,
                            bodyEnd: end,
                            declaredName: name,
                            matchedIdentifier: name
                        )
                    )
                }
            }

            // Parameter match — weaker, but a spec that says
            // "the `startAfterChoosing` branch" names the function through
            // its parameter when it never writes the function's own name.
            for param in parameterNames(startingAt: idx, lines: lines) where idSet.contains(param) {
                if let end = declarationEnd(idx, depths: depths, lines: lines) {
                    candidates.append(
                        Candidate(
                            kind: .parameter,
                            declLine: idx,
                            bodyEnd: end,
                            declaredName: name,
                            matchedIdentifier: param
                        )
                    )
                }
            }
        }

        guard !candidates.isEmpty else { return nil }

        // Rank. A name match beats a parameter match (#1174's order of
        // strength). Among equals, the declaration whose body is richest in
        // the spec's identifiers wins — measured, not assumed: for #1158 the
        // body's `autoAcceptIfUnambiguous` calls and guards five more of the
        // issue's identifiers while the neighbour guard named in the same
        // body mentions none of them. Ties go to the earlier declaration.
        func richness(_ c: Candidate) -> Int {
            totalMentions(in: c.declLine...c.bodyEnd, lines: lines, identifiers: identifiers)
        }

        return candidates.min { a, b in
            if a.kind != b.kind { return a.kind == .name }
            let ha = richness(a)
            let hb = richness(b)
            if ha != hb { return ha > hb }
            return a.declLine < b.declLine
        }
    }

    /// Last 0-based line of the declaration starting at `idx`, walking the
    /// same signature-then-body depth path the old rule walked.
    ///
    /// Returns `nil` when no body opens within a sane distance (a protocol
    /// stub or a one-line declaration).
    private static func declarationEnd(
        _ idx: Int,
        depths: [Int],
        lines: [String]
    ) -> Int? {
        let startDepth = depths[idx]
        var end = idx

        // Walk forward through signature lines (same depth) until the body
        // opens (depth increases), then through the body until the closing
        // brace brings depth back down.
        while end + 1 < depths.count, depths[end + 1] >= startDepth {
            if depths[end + 1] > startDepth {
                end += 1
            } else if depths[end] > startDepth {
                // Just left the body — stop.
                break
            } else {
                // Still in the signature — keep scanning for `{`.
                // Bail out if we wander too far (no body found).
                if end - idx > 50 { return nil }
                end += 1
            }
        }

        // Never entered the body (e.g. protocol stub) — not a declaration
        // with a body, so not a place the range can start.
        if depths[end] <= startDepth && end > idx {
            return nil
        }

        return end
    }

    /// Parameter names of the declaration starting at `idx`, read from the
    /// signature between `(` and the body's `{`.
    ///
    /// `startAfterChoosing: Bool = false` yields `startAfterChoosing`;
    /// an omitted external label (`_ x: Int`) yields `x`. The walk stops at
    /// the first closing parenthesis or the body brace, whichever comes
    /// first, bounded so a stray line cannot drag in half the file.
    private static func parameterNames(startingAt idx: Int, lines: [String]) -> [String] {
        var signature = lines[idx]
        var j = idx
        while j + 1 < lines.count,
              j - idx < 12,
              !signature.contains(")"),
              !signature.contains("{")
        {
            j += 1
            signature += " " + lines[j]
        }

        guard let open = signature.firstIndex(of: "(") else { return [] }
        let paramZone = signature[open...].prefix(while: { $0 != "{" })

        var names: [String] = []
        for chunk in paramZone.components(separatedBy: CharacterSet(charactersIn: ",()")) {
            guard let colon = chunk.firstIndex(of: ":") else { continue }
            let words = chunk[..<colon].split(whereSeparator: { $0 == " " || $0 == "\t" })
            guard let last = words.last else { continue }
            let token = String(last)
            guard token != "_",
                  token.range(of: "^[a-zA-Z]\\w*$", options: .regularExpression) != nil
            else { continue }
            names.append(token)
        }
        return names
    }

    // MARK: - Width cap

    /// If the range exceeds `maxRegionWidth`, returns a window of that width
    /// centred on `hitLine` and clamped to the declaration bounds. Otherwise
    /// returns the range unchanged.
    private static func capToWidth(
        _ range: ClosedRange<Int>,
        around hitLine: Int
    ) -> ClosedRange<Int> {
        let width = range.upperBound - range.lowerBound + 1
        guard width > maxRegionWidth else { return range }

        let half = maxRegionWidth / 2
        var start = hitLine - half
        var end = start + maxRegionWidth - 1

        if start < range.lowerBound {
            start = range.lowerBound
            end = start + maxRegionWidth - 1
        }
        if end > range.upperBound {
            end = range.upperBound
            start = max(range.lowerBound, end - maxRegionWidth + 1)
        }

        return start...end
    }

    // MARK: - Declaration names

    /// Extracts the name token from a declaration line.
    /// Only `func` and `init` names qualify — `var`/`let` property names
    /// (state, task, worker, …) are too common to win on name alone.
    /// For `func foo()` → `foo`, for `init` → `init`.
    private static func declarationName(on line: String) -> String? {
        let nsLine = line as NSString
        let fullRange = NSRange(location: 0, length: nsLine.length)
        if let regex = try? NSRegularExpression(pattern: "\\bfunc\\s+([a-zA-Z_]\\w*)"),
           let m = regex.firstMatch(in: line, range: fullRange),
           m.numberOfRanges > 1
        {
            return nsLine.substring(with: m.range(at: 1))
        }
        if line.range(of: "\\binit\\b", options: .regularExpression) != nil {
            return "init"
        }
        return nil
    }
}
