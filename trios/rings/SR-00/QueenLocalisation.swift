import Foundation

/// Finds where a name lives in source code.
///
/// The Queen needs to point at a region of a file and say "here". A line number
/// is too narrow — a function body is the unit of interest, not a single line.
/// But the full declaration can be enormous, so the range is capped to a window
/// around the declaration line.
///
/// ## How a region is chosen (#1175)
///
/// Four attempts at guessing, four identical scores. Density pointed wherever
/// ordinary words were common — in a 13 000-line file that is a big early span,
/// every time — and each added rule (a declaration name outranking density,
/// unmasked string literals, dotted names only) traded one hit for another
/// miss. The score never moved. The only evidence that survived all four
/// measurements unchanged was an identifier that **is** the name of a declared
/// function, written by whoever composed the spec.
///
/// So this file knows exactly one rule:
///
/// 1. **Declaration name.** The input carries a name, and the file declares
///    exactly one function by that name — and no other input name is a
///    declared function's name either. Return that declaration.
///
/// Every other input returns `nil`. A brief without a range is what worked
/// before, whenever a human named the place; a brief with a wrong range is
/// worse — it walks the bee to the wrong place with authority (#1175).
/// Ambiguity is silence too: #1158 names both a guard and its well-behaved
/// neighbour, and choosing between them by file order, by mention counts, or
/// by any other tie-break was measured to choose wrong. Two names is not
/// knowledge. A name the file declares twice is not knowledge either.
///
/// Mention counting — density — is gone entirely, not demoted. Five
/// measurements (#1173, #1175) agree on what it does: it finds where ordinary
/// words are common, which is a property of the file's shape, not of the work
/// the issue describes.
///
/// This is pure static plumbing: source in, range out, no state, no side effects.
public enum QueenLocalisation {

    /// Maximum number of lines a returned range may span.
    ///
    /// A 3 000-line generated file is useless to a reviewer; three hundred lines
    /// around the declaration is enough context without burying the signal.
    public static let maxRegionWidth = 300

    // MARK: - Public

    /// Returns the range (1-indexed) of the single declaration whose name is
    /// one of the identifiers, or `nil` in every other case — no name matches,
    /// several names match, or one name matches several declarations.
    ///
    /// - Parameters:
    ///   - source: Swift source text.
    ///   - identifiers: Whole words to search for (case-sensitive).
    /// - Returns: A 1-indexed `ClosedRange`, or `nil` when the one rule does
    ///     not answer.
    public static func region(
        in source: String,
        mentioning identifiers: [String]
    ) -> ClosedRange<Int>? {
        guard !source.isEmpty, !identifiers.isEmpty else { return nil }

        let cleaned = source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")

        // Comments and string literals are blanked before anything is read.
        // A name in prose or inside a quoted log line is not a declaration,
        // and reading those was one of the four measured ways to be wrong.
        let codeLines = maskCommentsAndStrings(cleaned).components(separatedBy: "\n")
        let depths = braceDepths(lines: codeLines)

        // The one rule — a declared function the input names.
        return namedDeclaration(
            in: codeLines,
            depths: depths,
            identifiers: identifiers
        )
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

    // MARK: - The one rule: declaration name

    /// Returns the 1-indexed range of the declaration the input names, or
    /// `nil` when the input does not name exactly one declaration.
    ///
    /// A candidate is a line that declares a function (`func`/`init`) whose
    /// name is one of the identifiers. Exactly one candidate in the whole
    /// file is a hit. Zero is silence — the honest answer when nobody named
    /// the place. Two or more is silence too, whatever distinguishes them:
    /// every tie-break that was ever tried (file order, mention counts,
    /// corroboration by other identifiers) was measured to pick the
    /// neighbour over the subject (#1175, #1176).
    private static func namedDeclaration(
        in lines: [String],
        depths: [Int],
        identifiers: [String]
    ) -> ClosedRange<Int>? {
        let idSet = Set(identifiers)
        var candidates: [(idx: Int, name: String, extent: ClosedRange<Int>)] = []
        for (idx, line) in lines.enumerated() {
            guard let name = declarationName(on: line), idSet.contains(name) else { continue }
            candidates.append((idx, name, declarationExtent(declLine: idx, depths: depths)))
        }
        guard candidates.count == 1, let only = candidates.first else { return nil }
        return finished(only, lines: lines)
    }

    /// The 0-based extent of the declaration starting at `declLine`:
    /// signature lines, body, closing brace.
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

    /// Caps a name-match candidate and applies the self-check: the first line
    /// of the returned range must still declare the matched name. If capping
    /// or any other step shifted the start, the range points at the wrong
    /// function — silence it rather than mislead.
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

    // MARK: - Name extraction

    /// Extracts the name token from a declaration line.
    /// Only `func` and `init` names qualify — a `var`/`let` property name is
    /// not a function the issue can be about, and local `var` lines are what
    /// the depth walk of the density era anchored on when it "found" a
    /// 12 000-line declaration at the top of the file.
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

    // MARK: - Measurement (#1175)

    /// One case of the measurement: the identifiers an issue yields through
    /// `ChatViewModel.identifiers(from:)`, recorded from the live bodies, and
    /// what the narrowing must answer.
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

    /// The measurement of #1175, recorded 2026-09-02 — bodies of the four issues
    /// fetched live, identifiers extracted exactly as
    /// `ChatViewModel.identifiers(from:)` extracts them, `region` run against
    /// `rings/SR-02/ChatViewModel.swift` (13 597 lines at recording; the
    /// boundary file moves under concurrent work, so the functions are the
    /// contract and the line numbers are the snapshot):
    ///
    /// | case | the one rule answers | the measurement demands |
    /// |---|---|---|
    /// | #1156, spec names the function | 5935-6234 inside `handleWorkerFinished` (5935-6304) | exactly that |
    /// | #1156, body alone | silence | silence |
    /// | #1158 | silence — two declared names, guard and neighbour | silence |
    /// | #1165 | silence — `ChatViewModel` is not a function name | silence |
    /// | #1165, its dotted clue handed through | silence — a dotted event name is never a function name | silence |
    /// | #1166 | silence — `qualifiesForAutoAccept` is declared in another file, not here | silence |
    /// | #1117, witness | 7432-7731 inside `requestReviewerVerdicts` (7432-7807) | exactly that |
    ///
    /// **Seven ok, zero wrong ranges.** One hit the spec earns by naming the
    /// function, five silences, one witness that the rule still fires.
    ///
    /// The two #1156 rows are both real and say together what #1175's first
    /// criterion stands on. The live #1156 body names no function — its
    /// identifiers are `ChatViewModel`, `awaitingReview`, `characterCount`,
    /// none of them a declaration — so the body alone narrows nothing, and
    /// the measurement records that as silence. The hit comes from the spec the
    /// Queen hands the bee: the fourth delegation for #1156 named
    /// `handleWorkerFinished` by hand (the NIGHT_LOG records it: three
    /// untargeted delegations died navigating 6 026 lines, the fourth named
    /// the function and the bee edited on the first attempt).
    /// When a spec names the function, the narrowing must find it — that is
    /// the "still" in the criterion, and it is the only behaviour four
    /// measurements ever found working.
    ///
    /// #1117 is kept as a second witness: its body names
    /// `requestReviewerVerdicts` in plain prose, and the one rule finds it.
    ///
    /// Replay any time — the fourth criterion of #1175 stands on this:
    ///
    ///     swiftc -O <driver>.swift rings/SR-00/QueenLocalisation.swift -o probe
    ///     probe <chatvm.swift>        // or call replayMeasurement(in:)
    ///
    /// **Density, reintroduced verbatim from the first attempt** (the rule of
    /// 737e5e6f: the enclosing declaration of every mention, the one with the
    /// most identifier mentions wins) **against these same seven cases goes
    /// six lines red:**
    ///
    ///     FAIL  #1156 spec:        68-367, not inside handleWorkerFinished
    ///     FAIL  #1156 body:        12900-13128, expected silence
    ///     FAIL  #1158:             68-367, expected silence
    ///     FAIL  #1165:             12900-13128, expected silence
    ///     FAIL  #1166:             68-367, expected silence
    ///     FAIL  #1117 witness:     68-367, not inside requestReviewerVerdicts
    ///
    /// The 68-367 answers are the measurement that closed the case: density's
    /// depth walk anchors on a local `var assistantMessageId: UUID?` at line
    /// 68, calls everything to line 12 268 one "declaration", and caps it to a
    /// 300-line window at the top of the file — a region whose only property
    /// is that ordinary words are common there. Measured 2026-09-02, proven
    /// from both sides: the one rule goes 7/7, density goes 1/7.
    static func measurementCases() -> [MeasurementCase] {
        [
            MeasurementCase(
                issue: "#1156 (the spec names the function)",
                identifiers: [
                    "ChatViewModel", "awaitingReview", "characterCount",
                    "handleWorkerFinished",
                ],
                expected: .declaration("handleWorkerFinished")
            ),
            MeasurementCase(
                issue: "#1156 (the body alone names no function)",
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
                expected: .silence
            ),
            MeasurementCase(
                issue: "#1165 (body yields no code symbol; silence is correct)",
                identifiers: ["ChatViewModel"],
                expected: .silence
            ),
            MeasurementCase(
                issue: "#1165 (its actual clue, `queen.review.verdicts`, handed through)",
                identifiers: ["queen.review.verdicts"],
                expected: .silence
            ),
            MeasurementCase(
                issue: "#1166",
                identifiers: [
                    "ChatViewModel", "fileCount", "isEmpty",
                    "ownedPaths", "qualifiesForAutoAccept", "startAfterChoosing",
                ],
                expected: .silence
            ),
            MeasurementCase(
                issue: "#1117 (witness: a spec that names a function)",
                identifiers: ["ChatViewModel", "requestReviewerVerdicts"],
                expected: .declaration("requestReviewerVerdicts")
            ),
        ]
    }

    /// Replays the measurement against a source file (the boundary file the issues
    /// talk about — for these cases, `rings/SR-02/ChatViewModel.swift`) and
    /// returns one verdict line per case: "ok …" or "FAIL …". This is the
    /// check the fourth criterion of #1175 stands on — reintroduce any
    /// mention-counting rule and the lines above go red, because density
    /// answers where words are common, not where the work is. Pure; no I/O.
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
