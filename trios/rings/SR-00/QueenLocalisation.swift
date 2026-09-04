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
/// 4. **Identifier mentioned exactly once.** A rare name with one home —
///    counted only where it is written as its own token. A match that is a
///    component of a longer dotted name (`characterCount` inside
///    `queen.review.characterCount`) is a mention of the *dotted event*,
///    which is rule 2's business, not of the bare identifier. Density never
///    comes back: measurements (#1173, #1175) showed it points where words
///    are common — a big early function — not where the work is.
///
/// No rule answers → `nil`. A confidently wrong range is worse than no range:
/// it sends the bee to read the wrong place with authority (#1175).
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
    /// String literals are *tracked*, not merely copied. A naive pass that
    /// copies everything outside comments reads a `/*` inside a string literal
    /// as the opening of a block comment, and everything after it is blanked.
    /// Measured on 2026-09-04: `"No empty queen/* branch exists to exercise
    /// the shipped "` (ChatViewModel.swift line 6864) swallowed lines 6864 to
    /// the end of a 13 598-line file, and the literal view went blind over the
    /// whole back half — rule 2 could no longer see a log line past it (#1165
    /// lost its only clue), rule 4 could no longer count a mention past it,
    /// and rule 1's corroboration scored every candidate there as zero, which
    /// handed #1158 to whichever named function came first in file order. The
    /// same pass also truncates at a `//` inside a literal (`"https://…"`),
    /// which is this defect one line wide instead of six thousand.
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
                // Verbatim, so a `/*` or `//` inside the literal stays text.
                // A backslash-newline continuation keeps its newline, keeping
                // the line count of this view aligned with the code view.
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

    /// Returns the 0-based indices of every line carrying a **standalone**
    /// mention of at least one identifier. Rule 4 is the only caller: a
    /// mention is its whole evidence, so what counts as one is decided here
    /// and nowhere else.
    private static func allMentionLines(
        lines: [String],
        identifiers: [String]
    ) -> [Int] {
        var result = [Int]()
        for (idx, line) in lines.enumerated() {
            if identifiers.contains(where: { standaloneMentionCount(on: line, of: $0) > 0 }) {
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

    /// Counts whole-word, case-sensitive matches of one identifier on a line,
    /// **skipping every match that is a component of a longer dotted name**.
    ///
    /// `\b` counts `.` as a boundary, so `\bcharacterCount\b` matches inside
    /// `queen.review.characterCount`. That is not a mention of the identifier
    /// `characterCount` — it is a mention of the dotted event, and rule 2 owns
    /// those, whole and with the dots. Counting the fragment here is what let
    /// a log line that had *moved* point #1156 at a function its issue never
    /// names (re-measured 2026-09-04: `settleCharacterCountVerdicts`, a
    /// confidently wrong range where the issue asked for
    /// `handleWorkerFinished`). Silence beats that.
    private static func standaloneMentionCount(on text: String, of identifier: String) -> Int {
        let pattern = "\\b" + NSRegularExpression.escapedPattern(for: identifier) + "\\b"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return 0 }

        let ns = text as NSString
        var count = 0
        regex.enumerateMatches(
            in: text,
            range: NSRange(location: 0, length: ns.length)
        ) { match, _, _ in
            guard let match else { return }
            let end = NSMaxRange(match.range)
            let before = match.range.location > 0
                ? ns.substring(with: NSRange(location: match.range.location - 1, length: 1))
                : ""
            let after = end < ns.length
                ? ns.substring(with: NSRange(location: end, length: 1))
                : ""
            if before == "." || after == "." { return }
            count += 1
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
        return finished(chosen, lines: lines)
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

    /// Caps a name-match candidate and applies the #1176 self-check: the
    /// first line of the returned range must still declare the matched name.
    /// If capping or any other step shifted the start, the range points at
    /// the wrong function — silence it rather than mislead.
    private static func finished(
        _ candidate: (idx: Int, name: String, extent: ClosedRange<Int>),
        lines: [String]
    ) -> ClosedRange<Int>? {
        let capped = capToWidth(candidate.extent, around: candidate.idx)
        guard declarationName(on: lines[capped.lowerBound]) == candidate.name else {
            return nil
        }
        return (capped.lowerBound + 1)...(capped.upperBound + 1)
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
                let capped = capToWidth(enclosing, around: idx)
                return (capped.lowerBound + 1)...(capped.upperBound + 1)
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
        let capped = capToWidth(declarationExtent(declLine: idx, depths: depths), around: idx)
        return (capped.lowerBound + 1)...(capped.upperBound + 1)
    }

    // MARK: - Rule 4: identifier mentioned exactly once

    /// An identifier mentioned exactly once in the whole file — strings
    /// included, because a quoted log line is emitted at one place, but only
    /// where the identifier stands as its own token (`standaloneMentionCount`),
    /// never as a fragment of a longer dotted name. This is the only
    /// mention-based evidence that survived the measurements (#1173, #1175);
    /// counting many mentions is what kept pointing at big early functions.
    /// Several singles must agree on the declaration; disagreement is silence.
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
        let capped = capToWidth(first.extent, around: hit)
        return (capped.lowerBound + 1)...(capped.upperBound + 1)
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

    // MARK: - Замер (#1173)

    /// One case of the #1173 measurement: the identifiers an issue body
    /// yields through `ChatViewModel.identifiers(from:)`, recorded from the
    /// live bodies and re-fetched 2026-09-04 (unchanged since 2026-08-19),
    /// and what the narrowing must answer.
    struct MeasurementCase {
        public let issue: String
        public let identifiers: [String]
        public let expected: Expected

        public enum Expected: Equatable {
            /// The range must lie inside this function's declaration.
            case declaration(String)
            /// No range at all — a wrong range is worse than none (#1175).
            case silence
        }
    }

    /// The замер of #1173, repeated and recorded 2026-09-04 — bodies of the
    /// four issues fetched live, identifiers extracted exactly as
    /// `ChatViewModel.identifiers(from:)` does, `region` run against
    /// `rings/SR-02/ChatViewModel.swift` (13 598 lines at recording, against
    /// 10 062 at the 2026-08-19 recording; the boundary file moves under
    /// concurrent work, so the functions are the contract and the line
    /// numbers are the snapshot):
    ///
    /// | case | recorded 2026-08-19 | at HEAD, re-measured | after this change | the human named |
    /// |---|---|---|---|---|
    /// | #1156 | `handleWorkerFinished` ✓ | silence ✗ | silence ✗ | `handleWorkerFinished` |
    /// | #1158 | `autoAcceptIfUnambiguous` ✓ | 6005-6304 `handleWorkerFinished` ✗ | 8251-8460 `autoAcceptIfUnambiguous` ✓ | `autoAcceptIfUnambiguous` |
    /// | #1165 | silence ✗ | silence ✗ | silence ✗ / 7508-7807 with its clue ✓ | `requestReviewerVerdicts` |
    /// | #1166 | `chooseNextOpenIssue` ✓ | 9976-10275 ✓ | 9976-10275 `chooseNextOpenIssue` ✓ | ветка `startAfterChoosing` |
    ///
    /// **1/4 at HEAD, 2/4 after this change** on the identifiers the caller
    /// actually passes; 3/4 counting #1165 by the clue its body carries.
    /// Recorded as found, not as wanted.
    ///
    /// What moved, and what was broken:
    ///
    /// - **The lexer, not the rules, cost #1158.** `maskComments` did not
    ///   track string literals, so the `/*` inside `"No empty queen/* branch
    ///   exists to exercise the shipped "` (line 6864) blanked the literal
    ///   view from there to the end of the file. Every declaration past 6864
    ///   scored 0 corroboration, the tie fell to whichever candidate came
    ///   first in file order, and #1158 — whose guard and neighbour both sit
    ///   past 6864 — answered `handleWorkerFinished`. Tracking literals
    ///   restores the measurement: `autoAcceptIfUnambiguous` carries 2
    ///   mentions of the other identifiers (`ProcessInfo` and `processInfo`
    ///   on the quoted guard, line 8253), the neighbour 0.
    /// - **#1156's hit is gone, and this file cannot bring it back.** Its
    ///   body never names `handleWorkerFinished`; the 2026-08-19 hit rested
    ///   on `characterCount` matching the tail of
    ///   `"queen.review.characterCount"`, which then lived inside
    ///   `handleWorkerFinished` and now lives inside
    ///   `settleCharacterCountVerdicts` (12555-…). Following that evidence
    ///   today hands back a confidently wrong range naming a function the
    ///   issue never mentions — the very defect #1173 was filed over — so
    ///   rule 4 now counts a mention only where the identifier stands as its
    ///   own token, and #1156 is silent. A miss, recorded, not a guess
    ///   dressed up as a hit.
    /// - **#1165 is still the caller's to lose.** Its body names one clue,
    ///   `queen.review.verdicts` — the log line emitted inside
    ///   `requestReviewerVerdicts` — but the identifier filter in
    ///   `ChatViewModel.identifiers(from:)` (#1178) rejects tokens with dots,
    ///   so the clue never reaches `region` and the live answer is silence.
    ///   Handed through directly, rule 2 lands 7508-7807 inside
    ///   `requestReviewerVerdicts` — the fourth case below proves it. Letting
    ///   dotted event names through that filter is work in
    ///   `rings/SR-02/ChatViewModel.swift`, outside this task's boundary.
    /// - **#1166 — rule 3:** `startAfterChoosing:` is a parameter of
    ///   `chooseNextOpenIssue`'s signature and of no other; `ownedPaths:`
    ///   labels several signatures and is discarded as a common label.
    ///
    /// #1117 is kept as a second witness for the name rule: 7432-7731 inside
    /// `requestReviewerVerdicts`.
    ///
    /// Replay any time — the check criterion 4 stands on:
    ///
    ///     swiftc -O <driver>.swift rings/SR-00/QueenLocalisation.swift -o probe
    ///     probe <chatvm.swift>   # or call replayMeasurement(in:)
    ///
    /// With the name preference (rule 1) removed, the replay goes red on
    /// #1158 and #1117 — nothing else can find a function the issue names —
    /// and the live замер falls to 1/4. Proven from both sides 2026-09-04.
    static func measurementCases() -> [MeasurementCase] {
        [
            MeasurementCase(
                issue: "#1156 — recorded miss: the human named "
                    + "handleWorkerFinished, but the body names no symbol that "
                    + "lives there (its log line moved), so silence is the "
                    + "honest answer",
                identifiers: ["ChatViewModel", "awaitingReview", "characterCount"],
                expected: .silence
            ),
            MeasurementCase(
                issue: "#1158",
                identifiers: [
                    "ChatViewModel", "ProcessInfo",
                    "acceptanceBlockReasonDistinguishingEmptyAnswers",
                    "autoAcceptIfUnambiguous", "awaitingReview", "processInfo",
                ],
                expected: .declaration("autoAcceptIfUnambiguous")
            ),
            MeasurementCase(
                issue: "#1165 (body yields no code symbol; silence is correct)",
                identifiers: ["ChatViewModel"],
                expected: .silence
            ),
            MeasurementCase(
                issue: "#1165 (its actual clue, `queen.review.verdicts`, handed through)",
                identifiers: ["queen.review.verdicts"],
                expected: .declaration("requestReviewerVerdicts")
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
                issue: "#1117",
                identifiers: ["ChatViewModel", "requestReviewerVerdicts"],
                expected: .declaration("requestReviewerVerdicts")
            ),
        ]
    }

    /// Replays the замер against a source file (the boundary file the issues
    /// talk about — for these cases, `rings/SR-02/ChatViewModel.swift`) and
    /// returns one verdict line per case: "ok …" or "FAIL …". This is the
    /// check the fourth criterion of #1173 stands on — remove the name
    /// preference (rule 1) and the #1158/#1117 lines go red, because nothing
    /// else can find a function the issue names. Pure; no I/O. Re-verified
    /// 2026-09-04 against the 13 598-line file: 6/6 ok as written, 4/6 with
    /// rule 1 deleted.
    static func replayMeasurement(in source: String) -> [String] {
        let cleaned = source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let codeLines = maskCommentsAndStrings(cleaned).components(separatedBy: "\n")
        let depths = braceDepths(lines: codeLines)

        return measurementCases().map { measure -> String in
            let range = region(in: source, mentioning: measure.identifiers)
            switch (range, measure.expected) {
            case (nil, .silence):
                return "ok    \(measure.issue): silence"
            case (nil, .declaration(let name)):
                return "FAIL  \(measure.issue): silence, expected inside \(name)"
            case (let r?, .silence):
                return "FAIL  \(measure.issue): \(r.lowerBound)-\(r.upperBound), expected silence"
            case (let r?, .declaration(let name)):
                guard let declIdx = codeLines.firstIndex(where: {
                    declarationName(on: $0) == name
                }) else {
                    return "FAIL  \(measure.issue): this source declares no \(name)"
                }
                let extent = declarationExtent(declLine: declIdx, depths: depths)
                let expected = (extent.lowerBound + 1)...(extent.upperBound + 1)
                if expected.contains(r.lowerBound), r.upperBound <= expected.upperBound {
                    return "ok    \(measure.issue): \(r.lowerBound)-\(r.upperBound) inside \(name)"
                }
                return "FAIL  \(measure.issue): \(r.lowerBound)-\(r.upperBound) not inside \(name) (\(expected.lowerBound)-\(expected.upperBound))"
            }
        }
    }
}
