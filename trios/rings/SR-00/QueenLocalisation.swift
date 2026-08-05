import Foundation

/// Finds where a name lives in source code.
///
/// The Queen needs to point at a region of a file and say "here". A line number
/// is too narrow — a function body is the unit of interest, not a single line.
/// But the full declaration can be enormous, so the range is capped to a window
/// around the hit.
///
/// This is pure static plumbing: source in, range out, no state, no side effects.
enum QueenLocalisation {

    /// Maximum number of lines a returned range may span.
    ///
    /// A 3 000-line generated file is useless to a reviewer; three hundred lines
    /// around the mention is enough context without burying the signal.
    static let maxRegionWidth = 300

    /// Keywords that open a declaration body, used to anchor the start of
    /// the enclosing scope. Only declarations with a brace-delimited body
    /// qualify — never the file itself.
    private static let declarationKeywords: [String] = [
        "func", "init", "var",
    ]

    // MARK: - Public

    /// Counts mentions of every identifier per declaration and returns the
    /// range of the declaration with the most mentions (1-indexed).
    ///
    /// - Parameters:
    ///   - source: Swift source text.
    ///   - identifiers: Whole words to search for (case-sensitive).
    /// - Returns: A 1-indexed `ClosedRange`, or `nil` when no identifier is
    ///   mentioned outside comments. Ties are broken in favour of the later
    ///   declaration. Ranges wider than `maxRegionWidth` lines are trimmed
    ///   to a window of that width centred on the first hit in the winning
    ///   declaration.
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

        let mentionLines = allMentionLines(lines: lines, identifiers: identifiers)
        guard !mentionLines.isEmpty else { return nil }

        var bestRange: ClosedRange<Int>?
        var bestCount = 0

        for hitLine in mentionLines {
            guard let raw = enclosingDeclaration(
                hitLine: hitLine,
                depths: depths,
                lines: lines
            ) else { continue }

            let count = totalMentions(
                in: raw,
                lines: lines,
                identifiers: identifiers
            )

            if count > bestCount
                || (count == bestCount && (bestRange == nil || raw.lowerBound > bestRange!.lowerBound))
            {
                bestCount = count
                bestRange = raw
            }
        }

        guard let raw = bestRange else { return nil }

        let hitInBest = mentionLines.first { raw.contains($0) } ?? mentionLines[0]
        let capped = capToWidth(raw, around: hitInBest)

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
                    output.append(" "); output.append(" ")
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
}
