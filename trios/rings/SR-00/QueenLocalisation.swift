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
/// `ChatViewModel.identifiers(from:)` extracts them, driven through
/// `region(in:mentioning:)` against `rings/SR-02/ChatViewModel.swift`
/// (9 527 lines):
///
/// | задача | сужение | указано на | совпало | правило |
/// |---|---|---|---|---|
/// | #1156 | 4832-5131 | `handleWorkerFinished` | да | unique: `characterCount` встречается в файле ровно один раз — внутри литерала `"queen.review.characterCount"` (строка 4984), внутри `handleWorkerFinished` |
/// | #1158 | 6275-6493 | `autoAcceptIfUnambiguous` | да | name, richness 7 против 1 у соседнего стража, которого тело тоже называет |
/// | #1165 | молчание | — | нет | см. ниже |
/// | #1166 | 7217-7516 | `chooseNextOpenIssue` | да | parameter: `startAfterChoosing` — параметр только этой функции |
///
/// Three of four. The miss is #1165, and it is an input limitation, not a
/// rule choice: `identifiers(from:)` yields exactly one identifier for that
/// body — `ChatViewModel`, the type name from the boundary path. The body's
/// real signal, `queen.review.verdicts`, is a dotted event name and is
/// filtered out before `region` sees anything; the literal exists at line
/// 5951, inside `requestReviewerVerdicts` (5629-6005). No rule over
/// `["ChatViewModel"]` can select `requestReviewerVerdicts` among two hundred
/// functions except guessing, and guessing was measured worse than silence
/// (#1175). The fix belongs in the extractor, outside this file.
///
/// Break check (criterion: the check must fail when the name preference is
/// removed): with the density rule that stood when #1173 was filed — density
/// decides, no name preference — the same measurement gives **0 of 4**, all
/// four ranges wrong: #1156 → 8416-8543 (`pollPullRequests` area, not a
/// declaration), #1158 → 67-366 (`reset()`), #1165 → 7337-7383,
/// #1166 → 67-366 (`reset()`).
///
/// Regression sweep, every open sub-issue × boundary file over 300 lines
/// (21 pairs): one change besides the four — #1131 now narrows to
/// `acceptanceBlockReasonDistinguishingEmptyAnswers` (6027-6203) through its
/// `verdictTreeState`/`currentTreeState` parameters, quoted verbatim in that
/// issue's evidence. Before: silence.
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
    /// Evidence, strongest first:
    ///
    /// 1. **Name** — a declaration whose own name is one of the identifiers.
    /// 2. **Parameter** — a declaration with a parameter named like one of the
    ///    identifiers (`startAfterChoosing:` names `chooseNextOpenIssue`; a
    ///    call-site label is not a declaration and never matches).
    /// 3. **Unique mention** — an identifier that occurs exactly once in the
    ///    whole file, **including inside string literals**. An issue that
    ///    quotes a log line (`#1149  characterCount`) names the one place that
    ///    emits it; event names live in string literals, so literals are
    ///    searched even though they are blanked for brace tracking.
    ///
    /// A name match beats any parameter, a parameter beats any unique mention:
    /// a unique word can sit inside a neighbouring guard (#1166's
    /// `qualifiesForAutoAccept` occurs once, inside `autoAcceptIfUnambiguous`,
    /// while the parameter `startAfterChoosing` names `chooseNextOpenIssue`
    /// outright). When several candidates share a tier — a spec can name both
    /// the culprit and its neighbour guard — the one whose body is richest in
    /// the spec's identifiers wins: the subject of an issue uses the things the
    /// issue talks about, a function named in passing does not. Ties go to the
    /// earlier declaration.
    ///
    /// When nothing matches, the answer is `nil` — silence, not a guess
    /// (#1175): a brief without a range was always safe, a brief with a wrong
    /// range sends the bee to the wrong place with confidence. Density
    /// counting is gone and stays gone: across five measurements it pointed at
    /// whichever large early function held the most ordinary words, which in a
    /// 9 000-line file is never the subject (#1173, #1175).
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

        // Two views of the same lines. Braces are counted on the view with
        // strings blanked — a literal containing `{` would otherwise corrupt
        // the depth walk. Identifiers are searched on the view with strings
        // kept — that is where event names live (#1173: `characterCount`
        // exists exactly once in ChatViewModel.swift, inside the
        // "queen.review.characterCount" literal, inside handleWorkerFinished).
        let structure = maskCommentsAndStrings(cleaned).components(separatedBy: "\n")
        let text = maskComments(cleaned).components(separatedBy: "\n")
        let depths = braceDepths(lines: structure)

        guard let winner = bestCandidate(
            structure: structure,
            text: text,
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
        guard declarationName(on: structure[capped.lowerBound]) == winner.declaredName else {
            return nil
        }

        return (capped.lowerBound + 1)...(capped.upperBound + 1)
    }

    // MARK: - Masking

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
                    // character — but a backslash-newline continuation must
                    // keep its newline, or every line after it shifts and the
                    // returned range points above the declaration it names.
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

    /// Returns a copy of `source` in which comments are blanked but string
    /// literals are kept verbatim. Newlines are preserved so line numbers stay
    /// aligned with the fully masked view.
    ///
    /// Comment detection is suspended inside string literals (`"//"` is not a
    /// comment), and escapes are consumed as pairs so a `\"` never ends the
    /// literal early.
    private static func maskComments(_ source: String) -> String {
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
                    output.append(c); output.append(next!)
                    i += 2
                } else if c == "\"" {
                    inString = false
                    output.append(c)
                    i += 1
                } else {
                    output.append(c)
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
                    output.append(c)
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
            /// An identifier occurs exactly once in the file, inside this
            /// declaration.
            case unique
        }

        let kind: Kind
        /// 0-based line of `func`/`init`.
        let declLine: Int
        /// 0-based last line of the declaration body.
        let bodyEnd: Int
        /// The name the self-check must find on the first line of the range.
        let declaredName: String
    }

    /// The strongest declaration the identifiers point at, or `nil` when
    /// none of them names a declaration, a parameter, or a unique place.
    private static func bestCandidate(
        structure: [String],
        text: [String],
        depths: [Int],
        identifiers: [String]
    ) -> Candidate? {
        let idSet = Set(identifiers)
        var candidates: [Candidate] = []

        func append(_ kind: Candidate.Kind, declLine: Int, name: String) {
            guard let end = declarationEnd(declLine, depths: depths) else { return }
            candidates.append(
                Candidate(kind: kind, declLine: declLine, bodyEnd: end, declaredName: name)
            )
        }

        // Tiers 1 and 2 read the structure view (strings blanked): a name or
        // a parameter is a declaration, and a declaration line never lives
        // inside a literal.
        for (idx, line) in structure.enumerated() {
            guard let name = declarationName(on: line) else { continue }

            if idSet.contains(name) {
                append(.name, declLine: idx, name: name)
            }
            for param in parameterNames(startingAt: idx, lines: structure)
            where idSet.contains(param) {
                append(.parameter, declLine: idx, name: name)
            }
        }

        // Tier 3 reads the text view (strings kept). An identifier with a
        // single occurrence in the whole file points at the one place that
        // has it — often a log event name inside a literal.
        for identifier in identifiers {
            var total = 0
            var hitLine: Int?
            for (idx, line) in text.enumerated() {
                let matches = countMatchesOnLine(line, [identifier])
                if matches > 0 {
                    total += matches
                    if total > 1 { break }
                    hitLine = idx
                }
            }
            guard total == 1, let hit = hitLine else { continue }
            guard let (declLine, name) = enclosingDeclaration(
                ofHit: hit,
                structure: structure,
                depths: depths
            ) else { continue }
            append(.unique, declLine: declLine, name: name)
        }

        guard !candidates.isEmpty else { return nil }

        // Rank. Lower tier number wins outright; within a tier the richest
        // body wins; ties go to the earlier declaration.
        func rank(_ kind: Candidate.Kind) -> Int {
            switch kind {
            case .name: return 0
            case .parameter: return 1
            case .unique: return 2
            }
        }
        func richness(_ c: Candidate) -> Int {
            totalMentions(in: c.declLine...c.bodyEnd, lines: text, identifiers: identifiers)
        }

        return candidates.min { a, b in
            let ra = rank(a.kind)
            let rb = rank(b.kind)
            if ra != rb { return ra < rb }
            let ha = richness(a)
            let hb = richness(b)
            if ha != hb { return ha > hb }
            return a.declLine < b.declLine
        }
    }

    /// The `func`/`init` declaration enclosing a hit line, walking the depth
    /// array outwards and then back to the declaration keyword.
    private static func enclosingDeclaration(
        ofHit hit: Int,
        structure: [String],
        depths: [Int]
    ) -> (declLine: Int, name: String)? {
        let hitDepth = depths[hit]

        // Mention at file scope — no enclosing declaration.
        if hitDepth == 0 { return nil }

        // First line whose start-depth is below the hit's is the scope entry.
        var scopeEntry = hit
        while scopeEntry > 0, depths[scopeEntry] >= hitDepth {
            scopeEntry -= 1
        }

        // Walk further back to the `func`/`init` line so multi-line
        // signatures anchor at the keyword.
        var declStart = scopeEntry
        while declStart > 0, declarationName(on: structure[declStart]) == nil {
            declStart -= 1
        }
        guard let name = declarationName(on: structure[declStart]) else {
            return nil
        }
        return (declStart, name)
    }

    /// Last 0-based line of the declaration starting at `idx`, walking the
    /// signature forward until the body opens, then to the closing brace.
    ///
    /// Returns `nil` when no body opens within a sane distance (a protocol
    /// stub or a declaration without a body).
    private static func declarationEnd(
        _ idx: Int,
        depths: [Int]
    ) -> Int? {
        let startDepth = depths[idx]
        var end = idx

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

        // Never entered the body — not a declaration with a range to return.
        if depths[end] <= startDepth && end > idx {
            return nil
        }

        return end
    }

    /// Parameter names of the declaration starting at `idx`, read from the
    /// signature between `(` and the body's `{`.
    ///
    /// `startAfterChoosing: Bool = false` yields `startAfterChoosing`; an
    /// omitted external label (`_ x: Int`) yields `x`. The walk stops at the
    /// first closing parenthesis or the body brace, bounded so a stray line
    /// cannot drag in half the file.
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
