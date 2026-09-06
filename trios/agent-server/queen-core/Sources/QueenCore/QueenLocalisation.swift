import Foundation

/// Finds where a name lives in source code.
///
/// The Queen needs to point at a region of a file and say "here". A line number
/// is too narrow — a function body is the unit of interest, not a single line.
/// But the full declaration can be enormous, so the range is capped to a window
/// around the hit.
///
/// ## How a region is chosen (#1173)
///
/// Four rules, strongest first; the first that answers wins:
///
/// 1. **Declaration name.** One of the identifiers is the *name* of a declared
///    function. The issue names the culprit; that outranks every heuristic.
///    When several identifiers name declarations, the subject is the one the
///    *other* identifiers cluster inside — an issue about a guard quotes the
///    guard's code, and that code lives in the subject's body, not in the
///    neighbour's. A tie is silence.
/// 2. **Dotted name in a string literal.** `queen.review.verdicts` quoted in an
///    issue is a log line, and a log line is emitted at exactly one place.
///    Searched only with the dots — a bare word in a string is usually prose.
/// 3. **Parameter label in a signature.** The issue names the branch
///    (`startAfterChoosing`); the branch is a parameter of the function that
///    owns it. Signatures only — a call site says who calls, not who owns.
/// 4. **Identifier mentioned exactly once.** A rare name with one home. Density
///    never comes back: five measurements (#1173, #1175) showed it points where
///    words are common — a big early function — not where the work is.
///
/// No rule answers → `nil`. A confidently wrong range is worse than no range:
/// it sends the bee to read the wrong place with authority (#1175).
///
/// ## The finishing check (#1176)
///
/// Whichever rule answers, the answer is checked before it leaves: the first
/// line of the returned range must declare a function — and for the name rule,
/// exactly the name it matched. The measurement that forced this: #1158, whose
/// spec names `autoAcceptIfUnambiguous`, was answered with a range beginning
/// in the middle of `handleWorkerFinished` — a function that spec never
/// named — because a window capped around a hit deep inside a wide body
/// starts nowhere in particular. Beginning nowhere in particular is silence.
///
/// This is pure static plumbing: source in, range out, no state, no side effects.
public enum QueenLocalisation {

    /// Maximum number of lines a returned range may span.
    ///
    /// A 3 000-line generated file is useless to a reviewer; three hundred lines
    /// around the mention is enough context without burying the signal.
    public static let maxRegionWidth = 300

    /// Keywords that open a declaration body, used to anchor the start of
    /// the enclosing scope. Only declarations with a brace-delimited body
    /// qualify — never the file itself.
    private static let declarationKeywords: [String] = [
        "func", "init", "var",
    ]

    // MARK: - Public

    /// Returns the range (1-indexed) of the declaration the identifiers point
    /// at, decided by the rules in the type documentation, or `nil` when no
    /// rule answers.
    ///
    /// - Parameters:
    ///   - source: Swift source text.
    ///   - identifiers: Whole words to search for (case-sensitive).
    /// - Returns: A 1-indexed `ClosedRange`, or `nil` when nothing qualifies.
    public static func region(
        in source: String,
        mentioning identifiers: [String]
    ) -> ClosedRange<Int>? {
        guard !source.isEmpty, !identifiers.isEmpty else { return nil }

        let cleaned = source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")

        // Two views over the same lines; both preserve the line count, so
        // indices into one are indices into the other.
        // - code view: comments AND string literals blanked. Identifiers of
        //   code only — common words sitting in prose strings must not steer
        //   (#1175 measured that they do).
        // - literal view: comments blanked, strings intact. A quoted event
        //   name is evidence sitting exactly where the code does the work
        //   (#1174).
        let codeLines = maskCommentsAndStrings(cleaned).components(separatedBy: "\n")
        let literalLines = maskComments(cleaned).components(separatedBy: "\n")
        let depths = braceDepths(lines: codeLines)

        // Rule 1 — a declaration whose name matches one of the identifiers.
        if let named = namedDeclaration(
            in: codeLines,
            depths: depths,
            identifiers: identifiers,
            literalLines: literalLines
        ) {
            return named
        }

        // Rule 2 — a dotted event name inside a string literal.
        if let literal = literalDeclaration(
            in: literalLines,
            codeLines: codeLines,
            depths: depths,
            identifiers: identifiers
        ) {
            return literal
        }

        // Rule 3 — a parameter label in a function signature.
        if let parameter = parameterDeclaration(
            in: codeLines,
            depths: depths,
            identifiers: identifiers
        ) {
            return parameter
        }

        // Rule 4 — an identifier mentioned exactly once in the whole file.
        if let unique = uniqueMentionDeclaration(
            in: literalLines,
            codeLines: codeLines,
            depths: depths,
            identifiers: identifiers
        ) {
            return unique
        }

        return nil
    }

    // MARK: - Comment & string masking

    /// Returns a copy of `source` in which every character inside a comment or
    /// string literal is replaced with a space. Newlines are preserved so line
    /// numbers stay aligned — **including the newline of a backslash-newline
    /// continuation inside a string**. Eating that newline shifted every line
    /// number after it (measured: −4 from line 6432 of ChatViewModel.swift),
    /// so a "correct" range named the wrong lines.
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
                if c == "\\", let escaped = next {
                    output.append(" ")
                    output.append(escaped == "\n" ? "\n" : " ")
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

    /// Returns a copy of `source` in which every character inside a comment is
    /// replaced with a space, and string literals are left **intact**.
    /// Newlines are preserved. Event names ("queen.review.verdicts") are
    /// evidence, not decoration (#1174) — this view exists so rule 2 can see
    /// them while every other rule keeps working on code only.
    ///
    /// String-aware, because the literal view once was not and the file
    /// measured it (#1176, 2026-09-02): a branch glob quoted inside a string —
    /// `"No empty queen/* branch …"`, line 6864 of ChatViewModel.swift —
    /// opened a phantom block comment, and the literal view went blank from
    /// there to the end of the file. 6 726 lines of evidence invisible:
    /// corroboration saw no mentions past the glob, so #1158's two candidates
    /// tied at zero and rule 4 answered with a mid-body window of the wrong
    /// function. A comment opener inside a string is prose, not a comment.
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

            if inString {
                if c == "\\", let escaped = next {
                    output.append(c)
                    output.append(escaped)
                    i += 2
                } else if c == "\"" {
                    inString = false
                    output.append(c)
                    i += 1
                } else {
                    output.append(c)
                    i += 1
                }
            } else if blockDepth > 0 {
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
            } else if c == "/", next == "/" {
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

        return String(output)
    }

    // MARK: - Identifier search

    /// Returns the 0-based indices of every line containing at least one
    /// identifier as a whole word.
    private static func allMentionLines(
        lines: [String],
        identifiers: [String]
    ) -> [Int] {
        var result = [Int]()
        for (idx, line) in lines.enumerated() {
            if countMatchesOnLine(line, identifiers) > 0 {
                result.append(idx)
            }
        }
        return result
    }

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
    private static func totalMentions(
        in range: ClosedRange<Int>,
        lines: [String],
        identifiers: [String]
    ) -> Int {
        var count = 0
        for i in range {
            guard i >= 0, i < lines.count else { continue }
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

    // MARK: - Enclosing declaration

    /// Given a hit line and per-line depths, returns the 0-based closed range
    /// of the enclosing declaration, or `nil` when the hit is not inside a
    /// `func`, `init`, or `var` body.
    private static func enclosingDeclaration(
        hitLine: Int,
        depths: [Int],
        lines: [String]
    ) -> ClosedRange<Int>? {
        let hitDepth = depths[hitLine]

        // Mention at file scope — no enclosing func/init/var.
        if hitDepth == 0 {
            return nil
        }

        // Walk backwards: first line whose start-depth < hitDepth is the scope
        // entry (the line that opened the enclosing block).
        var scopeEntry = hitLine
        while scopeEntry > 0, depths[scopeEntry] >= hitDepth {
            scopeEntry -= 1
        }

        // Walk further back to the declaration keyword line so multi-line
        // signatures (`func foo()\n    -> Int\n{`) are anchored at `func`.
        var declStart = scopeEntry
        while declStart > 0, !containsDeclarationKeyword(lines[declStart]) {
            declStart -= 1
        }

        // No declaration keyword on the anchor line means the enclosing scope
        // is not a func/init/var (e.g. a type body) — skip this mention.
        guard containsDeclarationKeyword(lines[declStart]) else {
            return nil
        }

        // Walk forwards: last line before depth drops below hitDepth is the
        // scope exit (the closing brace).
        var scopeExit = hitLine
        while scopeExit + 1 < lines.count, depths[scopeExit + 1] >= hitDepth {
            scopeExit += 1
        }

        return declStart...scopeExit
    }

    /// True when the line contains a Swift declaration keyword as a whole word.
    private static func containsDeclarationKeyword(_ line: String) -> Bool {
        for kw in declarationKeywords {
            if line.range(of: "\\b" + kw + "\\b", options: .regularExpression) != nil {
                return true
            }
        }
        return false
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

    // MARK: - The finishing check

    /// Caps a rule's answer to `maxRegionWidth` around `hitLine`, then applies
    /// the #1176 self-check: the first line of the returned range must declare
    /// a function — and the name rule, which passes `naming`, must land on
    /// exactly the name it matched. Capping around a hit deep inside a wide
    /// body slides the window off the declaration line, and a range that
    /// begins mid-body begins "not at the named function" just as surely as
    /// one that begins at the neighbour. Either failure is silence, not a
    /// range.
    ///
    /// This is the one place an answer is either returned or silenced. Delete
    /// the two guards and the замер goes red on the `queen.review.verdicts`
    /// case — that flip is the proof the check carries weight (#1176,
    /// criterion 4).
    private static func finished(
        _ extent: ClosedRange<Int>,
        around hitLine: Int,
        in codeLines: [String],
        naming requiredName: String? = nil
    ) -> ClosedRange<Int>? {
        let capped = capToWidth(extent, around: hitLine)

        // Self-check: the range must begin at a line that declares a function
        // — the very name the rule matched, when it matched one.
        guard let startName = declarationName(on: codeLines[capped.lowerBound]) else {
            return nil
        }
        if let requiredName, startName != requiredName {
            return nil
        }

        return (capped.lowerBound + 1)...(capped.upperBound + 1)
    }

    // MARK: - Rule 1: declaration name

    /// Returns the 1-indexed range of the declaration whose name matches one
    /// of the identifiers, or `nil` when no name matches — or when several
    /// match and nothing distinguishes the subject from its neighbours.
    ///
    /// Several identifiers naming several declarations is the neighbour trap
    /// #1176 measured: #1158 names both the guard and the guard's well-behaved
    /// neighbour, and file order alone hands back the neighbour. The subject
    /// is the candidate whose body contains the most mentions of the *other*
    /// identifiers — the issue quotes the code that lives there. A tie —
    /// including an all-zero tie — is silence.
    private static func namedDeclaration(
        in lines: [String],
        depths: [Int],
        identifiers: [String],
        literalLines: [String]
    ) -> ClosedRange<Int>? {
        let idSet = Set(identifiers)
        var candidates: [(idx: Int, name: String, extent: ClosedRange<Int>)] = []
        for (idx, line) in lines.enumerated() {
            guard let name = declarationName(on: line), idSet.contains(name) else { continue }
            candidates.append((idx, name, declarationExtent(declLine: idx, depths: depths)))
        }
        guard let first = candidates.first else { return nil }

        var chosen = first
        if candidates.count > 1 {
            let candidateNames = Set(candidates.map(\.name))
            let others = identifiers.filter { !candidateNames.contains($0) }
            var bestScore = -1
            var tie = false
            for candidate in candidates {
                let score = totalMentions(
                    in: candidate.extent, lines: literalLines, identifiers: others
                )
                if score > bestScore {
                    bestScore = score
                    chosen = candidate
                    tie = false
                } else if score == bestScore {
                    tie = true
                }
            }
            guard !tie else { return nil }
        }
        return finished(
            chosen.extent, around: chosen.idx, in: lines, naming: chosen.name
        )
    }

    /// The 0-based extent of the declaration starting at `declLine`:
    /// signature lines, body, closing brace. Verbatim the walk this file has
    /// always used, extracted so every rule shares one definition.
    private static func declarationExtent(declLine idx: Int, depths: [Int]) -> ClosedRange<Int> {
        let startDepth = depths[idx]
        var end = idx

        // Walk forward through signature lines (same depth) until
        // the body opens (depth increases), then through the body
        // until the closing brace brings depth back down.
        while end + 1 < depths.count, depths[end + 1] >= startDepth {
            if depths[end + 1] > startDepth {
                end += 1
            } else if depths[end] > startDepth {
                // Just left the body — stop.
                break
            } else {
                // Still in the signature — keep scanning for `{`.
                // Bail out if we wander too far (no body found).
                if end - idx > 50 { break }
                end += 1
            }
        }

        // If we never entered the body (e.g. protocol stub), trim back.
        if depths[end] <= startDepth && end > idx {
            end = idx
        }

        return idx...end
    }

    // MARK: - Rule 2: dotted name in a string literal

    /// A dotted identifier (`queen.review.verdicts`) found verbatim inside a
    /// string literal: the issue quotes a log line, and the line is emitted at
    /// exactly one place (#1174). Bare words are deliberately NOT searched in
    /// literals — that was measured and it misses (#1175).
    private static func literalDeclaration(
        in literalLines: [String],
        codeLines: [String],
        depths: [Int],
        identifiers: [String]
    ) -> ClosedRange<Int>? {
        for identifier in identifiers where identifier.contains(".") {
            // Whole token: not a prefix or slice of a longer dotted name.
            let pattern = "(?<![\\w.])"
                + NSRegularExpression.escapedPattern(for: identifier)
                + "(?![\\w.])"
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            for (idx, line) in literalLines.enumerated() {
                let nsLine = line as NSString
                guard regex.firstMatch(
                    in: line,
                    range: NSRange(location: 0, length: nsLine.length)
                ) != nil else { continue }
                guard let enclosing = enclosingDeclaration(
                    hitLine: idx, depths: depths, lines: codeLines
                ) else { continue }
                return finished(enclosing, around: idx, in: codeLines)
            }
        }
        return nil
    }

    // MARK: - Rule 3: parameter label in a signature

    /// A parameter label in a function **signature** — not at a call site.
    /// The issue names the branch (`startAfterChoosing`); the branch is a
    /// parameter of the function that owns it (#1174). Signatures are the
    /// same-depth continuation lines of a `func`/`init` declaration, so call
    /// sites — which sit inside some other body — can never match.
    ///
    /// A label is a **clean pointer** only when it appears in exactly one
    /// signature: `ownedPaths:` names four functions in ChatViewModel.swift
    /// and cannot point anywhere, while `startAfterChoosing:` names one —
    /// the one that owns the branch the issue is about. Two clean pointers
    /// to different functions is ambiguity, and ambiguity is silence.
    private static func parameterDeclaration(
        in lines: [String],
        depths: [Int],
        identifiers: [String]
    ) -> ClosedRange<Int>? {
        var labelRegexes: [(label: String, regex: NSRegularExpression)] = []
        for identifier in identifiers {
            let pattern = "\\b"
                + NSRegularExpression.escapedPattern(for: identifier)
                + "\\s*:"
            if let regex = try? NSRegularExpression(pattern: pattern) {
                labelRegexes.append((identifier, regex))
            }
        }
        guard !labelRegexes.isEmpty else { return nil }

        // Every signature span, once: the declaration line plus its
        // same-depth continuation (a multi-line parameter list).
        var signatures: [(idx: Int, text: String)] = []
        for (idx, line) in lines.enumerated() {
            guard declarationName(on: line) != nil else { continue }
            var signatureEnd = idx
            while signatureEnd + 1 < lines.count,
                  depths[signatureEnd + 1] == depths[idx],
                  declarationName(on: lines[signatureEnd + 1]) == nil,
                  signatureEnd + 1 - idx <= 8
            {
                signatureEnd += 1
            }
            signatures.append((idx, lines[idx...signatureEnd].joined(separator: "\n")))
        }

        var clean: [Int: String] = [:]
        for entry in labelRegexes {
            var found: [Int] = []
            for signature in signatures {
                let ns = signature.text as NSString
                if entry.regex.firstMatch(
                    in: signature.text,
                    range: NSRange(location: 0, length: ns.length)
                ) != nil {
                    found.append(signature.idx)
                }
            }
            // Exactly one signature carries this label → the label points.
            if found.count == 1 {
                clean[found[0]] = entry.label
            }
        }
        let targets = Set(clean.keys)
        guard targets.count == 1, let idx = targets.first else { return nil }
        return finished(
            declarationExtent(declLine: idx, depths: depths),
            around: idx,
            in: lines
        )
    }

    // MARK: - Rule 4: identifier mentioned exactly once

    /// An identifier mentioned exactly once in the whole file — strings
    /// included, because a quoted log line is emitted at one place. This is
    /// the only mention-based evidence that survived five measurements
    /// (#1173, #1175); counting many mentions is what kept pointing at big
    /// early functions. Several singles must agree on the declaration;
    /// disagreement is silence.
    private static func uniqueMentionDeclaration(
        in literalLines: [String],
        codeLines: [String],
        depths: [Int],
        identifiers: [String]
    ) -> ClosedRange<Int>? {
        var singles: [(identifier: String, line: Int)] = []
        for identifier in identifiers {
            let hits = allMentionLines(lines: literalLines, identifiers: [identifier])
            if hits.count == 1 {
                singles.append((identifier, hits[0]))
            }
        }
        guard !singles.isEmpty else { return nil }

        var anchored: [(line: Int, extent: ClosedRange<Int>)] = []
        for single in singles {
            guard let enclosing = enclosingDeclaration(
                hitLine: single.line, depths: depths, lines: codeLines
            ) else { continue }
            anchored.append((single.line, enclosing))
        }
        let extents = Set(anchored.map { [$0.extent.lowerBound, $0.extent.upperBound] })
        guard extents.count == 1, let first = anchored.first else { return nil }

        let hit = anchored.map(\.line).min() ?? first.line
        return finished(first.extent, around: hit, in: codeLines)
    }

    // MARK: - Name extraction

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

    // MARK: - Замер (#1173, #1176)

    /// One case of the #1173 measurement: the identifiers an issue body
    /// yields through `ChatViewModel.identifiers(from:)`, recorded from the
    /// live bodies on 2026-08-19, and what the narrowing must answer.
    struct MeasurementCase {
        public let issue: String
        public let identifiers: [String]
        public let expected: Expected

        public enum Expected: Equatable {
            /// The range must begin at this function's declaration line and
            /// stay inside its extent. Not "somewhere inside" — a range that
            /// begins mid-body begins "not at the named function" (#1176).
            case declaration(String)
            /// The issue's own acceptance, verbatim (#1176): begin at this
            /// function's declaration, or say nothing at all. A range that
            /// begins anywhere else — another function, mid-body, the wrong
            /// end — is a FAIL.
            case declarationOrSilence(String)
            /// No range at all — a wrong range is worse than none (#1175).
            case silence
        }
    }

    /// The замер of #1173, re-recorded 2026-09-02 for #1176 — bodies of the
    /// issues unchanged (identifiers are what `ChatViewModel.identifiers(from:)`
    /// extracts from them), `region` run against `rings/SR-02/ChatViewModel.swift`
    /// as it stands (13 590 lines at recording; the boundary file moves under
    /// concurrent work, so the functions are the contract and the line numbers
    /// are the snapshot). Two things the re-recording found:
    ///
    /// 1. The literal view was blind. A branch glob quoted inside a string —
    ///    `"No empty queen/* branch …"`, line 6864 — opened a phantom block
    ///    comment and blanked the view from there to the end of the file.
    ///    6 726 lines of evidence invisible: corroboration saw no mentions
    ///    past the glob, #1158's two candidates tied at zero, and rule 4
    ///    answered with 6005-6304 — the middle of `handleWorkerFinished`, a
    ///    function that spec never named. The confident wrong range #1176 is
    ///    about, and its enabler. `maskComments` knows strings now.
    /// 2. #1156's clue moved: the quoted log event `queen.review.characterCount`
    ///    is no longer emitted inside `handleWorkerFinished` but inside
    ///    `settleCharacterCountVerdicts` (upstream moved it, 2026-09-02). The
    ///    recording follows the clue, not the old address.
    ///
    /// | case | answers, 2026-09-02 | expected |
    /// |---|---|---|
    /// | #1156 | 12555-12584 `settleCharacterCountVerdicts` | the same |
    /// | #1158 | 8251-8460 `autoAcceptIfUnambiguous` | it, or silence |
    /// | #1165 body | silence | silence |
    /// | #1165 clue `queen.review.verdicts` | silence | it, or silence |
    /// | #1166 | 9976-10275 `chooseNextOpenIssue` | the same |
    /// | #1117 | 7432-7731 `requestReviewerVerdicts` | it, or silence |
    ///
    /// Why each row answers what it answers:
    ///
    /// - #1156 — rule 4: `characterCount` appears exactly once in the file, as
    ///   the quoted log line `"queen.review.characterCount"` (12576) inside
    ///   `settleCharacterCountVerdicts`; the range begins at its declaration.
    /// - #1158 — rule 1, corroboration: the neighbour
    ///   `acceptanceBlockReasonDistinguishingEmptyAnswers` (7830-8006)
    ///   carries 0 of the other identifiers; `autoAcceptIfUnambiguous`
    ///   (8251-8460) carries 2 — `ProcessInfo` and `processInfo`, the guard
    ///   the issue quotes. The subject wins outright. Were upstream to move
    ///   the guard again, the tie is silence, which the case accepts.
    /// - #1165 body — `ChatViewModel` alone: no rule answers, correctly.
    /// - #1165 clue — rule 2 finds `queen.review.verdicts` at line 7754, 322
    ///   lines into the 376-line `requestReviewerVerdicts`. The window capping
    ///   slides the start to 7508 — mid-body, beginning nowhere in particular
    ///   — and the #1176 finishing check silences it. This row is the witness
    ///   for #1176's fourth criterion: delete the guards in `finished` and it
    ///   goes red with `7508-7807 not starting at requestReviewerVerdicts`.
    /// - #1166 — rule 3: `startAfterChoosing:` labels `chooseNextOpenIssue`'s
    ///   signature and no other; the wide body caps to a window that still
    ///   begins at the declaration.
    /// - #1117 — rule 1, single candidate: one name, one declaration, the
    ///   range begins at it (7432). No corroboration needed.
    ///
    /// #1165's body still filters its clue out before it reaches `region` —
    /// `ChatViewModel.identifiers(from:)` (#1178) rejects dotted tokens, so
    /// only the handed-through case below exercises the clue. That filter is
    /// `rings/SR-02/ChatViewModel.swift`, outside this task's boundary.
    ///
    /// Replay any time:
    ///
    ///     swiftc -O <driver>.swift rings/SR-00/QueenLocalisation.swift -o probe
    ///     probe <chatvm.swift> <bodies-dir>   # or call replayMeasurement(in:)
    ///
    /// What reddens what, measured 2026-09-02: removing the finishing check
    /// (the two guards in `finished`) reddens the `queen.review.verdicts` row
    /// — that is #1176's fourth criterion. Removing rule 1 entirely no longer
    /// reddens #1158 or #1117: both fall to silence, which #1176 accepts —
    /// the name rule is what still *points*; the finishing check is what
    /// keeps every pointer honest.
    static func measurementCases() -> [MeasurementCase] {
        [
            MeasurementCase(
                // The quoted log event moved upstream into this function
                // (2026-09-02); the recording follows the clue, not the old
                // handleWorkerFinished address of the 2026-08-19 table.
                issue: "#1156",
                identifiers: ["ChatViewModel", "awaitingReview", "characterCount"],
                expected: .declaration("settleCharacterCountVerdicts")
            ),
            MeasurementCase(
                issue: "#1158",
                identifiers: [
                    "ChatViewModel", "ProcessInfo",
                    "acceptanceBlockReasonDistinguishingEmptyAnswers",
                    "autoAcceptIfUnambiguous", "awaitingReview", "processInfo",
                ],
                // #1176 criterion 1, verbatim: point at the named function,
                // or say nothing. The neighbour's name is in the body too —
                // only corroboration separates them, and a tie is silence.
                expected: .declarationOrSilence("autoAcceptIfUnambiguous")
            ),
            MeasurementCase(
                issue: "#1165 (body yields no code symbol; silence is correct)",
                identifiers: ["ChatViewModel"],
                expected: .silence
            ),
            MeasurementCase(
                // #1176 criterion 4's witness. The event sits 322 lines into
                // a 376-line function, so the capped window would begin
                // mid-body; the finishing check silences it. Delete the
                // guards in `finished` and this line goes red with a range
                // that starts at 7508 — inside the function, beginning at
                // nothing. Pointing, or silence — never that.
                issue: "#1165 (its actual clue, `queen.review.verdicts`, handed through)",
                identifiers: ["queen.review.verdicts"],
                expected: .declarationOrSilence("requestReviewerVerdicts")
            ),
            MeasurementCase(
                issue: "#1166",
                identifiers: [
                    "ChatViewModel", "fileCount", "isEmpty",
                    "ownedPaths", "qualifiesForAutoAccept", "startAfterChoosing",
                ],
                expected: .declaration("chooseNextOpenIssue")
            ),
            MeasurementCase(
                // #1176 criterion 2, verbatim: point at the named function,
                // or say nothing.
                issue: "#1117",
                identifiers: ["ChatViewModel", "requestReviewerVerdicts"],
                expected: .declarationOrSilence("requestReviewerVerdicts")
            ),
        ]
    }

    /// Replays the замер against a source file (the boundary file the issues
    /// talk about — for these cases, `rings/SR-02/ChatViewModel.swift`) and
    /// returns one verdict line per case: "ok …" or "FAIL …".
    ///
    /// A returned range is ok only when it BEGINS at the named function's
    /// declaration line and stays inside its extent (#1176 criterion 3) —
    /// "somewhere inside" is not good enough, because a range that begins
    /// mid-body begins "not at the named function" the same way a range that
    /// begins at the neighbour does.
    ///
    /// Pure; no I/O.
    static func replayMeasurement(in source: String) -> [String] {
        let cleaned = source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let codeLines = maskCommentsAndStrings(cleaned).components(separatedBy: "\n")
        let depths = braceDepths(lines: codeLines)

        return measurementCases().map { measure -> String in
            let range = region(in: source, mentioning: measure.identifiers)
            switch (range, measure.expected) {
            case (nil, .silence), (nil, .declarationOrSilence):
                return "ok    \(measure.issue): silence"
            case (nil, .declaration(let name)):
                return "FAIL  \(measure.issue): silence, expected at \(name)"
            case (let r?, .silence):
                return "FAIL  \(measure.issue): \(r.lowerBound)-\(r.upperBound), expected silence"
            case (let r?, .declaration(let name)), (let r?, .declarationOrSilence(let name)):
                guard let declIdx = codeLines.firstIndex(where: {
                    declarationName(on: $0) == name
                }) else {
                    return "FAIL  \(measure.issue): this source declares no \(name)"
                }
                let extent = declarationExtent(declLine: declIdx, depths: depths)
                let expected = (extent.lowerBound + 1)...(extent.upperBound + 1)
                if r.lowerBound == expected.lowerBound, r.upperBound <= expected.upperBound {
                    return "ok    \(measure.issue): \(r.lowerBound)-\(r.upperBound) at \(name)"
                }
                return "FAIL  \(measure.issue): \(r.lowerBound)-\(r.upperBound) not starting at \(name) (\(expected.lowerBound)-\(expected.upperBound))"
            }
        }
    }
}
