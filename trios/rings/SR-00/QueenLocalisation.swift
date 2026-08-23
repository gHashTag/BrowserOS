//
// QueenLocalisation.swift — where in a large file the work named by an
// issue actually lives.
//
// History, because every rule here was measured before it was kept
// (#1167, #1168, #1173, #1174, #1175, #1176 — the full account is in
// .trinity/NIGHT_LOG.md, "She narrows the boundary now"):
//
//   mention density        1 of 4, misses into reset() near the top
//   name beats density     1 of 4 plus a neighbour
//   unmask string literals 1 of 4, three misses into reset()
//   dotted names only      1 of 4, and #1158 regressed
//   names only, else nil   one right range, three silences
//
// #1173 asks for the rule the measurements kept pointing at: a name the
// spec actually writes beats any density, and density remains the
// fallback when no name matched. This file is that rule set, restated:
//
//   1. NAME PREFERENCE — an identifier that equals a declaration's name
//      wins outright. Two such names are broken by co-evidence: the
//      candidate whose body mentions the other identifiers is the
//      orchestrator, the one the spec is really about. A tie stays
//      silent — a wrong range walks a bee somewhere confidently wrong.
//   2. SIGNATURE NAMES — an identifier that names a parameter of
//      exactly one declaration points there. Parameters are the
//      declaration's own words; `startAfterChoosing` names the branch
//      inside `chooseNextOpenIssue` (#1166) without naming the function.
//   3. ONE CODE OCCURRENCE — an identifier that appears exactly once in
//      code (comments and string contents blanked) points at its single
//      home. Two occurrences are ambiguity, not evidence.
//   4. DENSITY — count whole-word mentions per declaration, string
//      literals included, and take the densest; ties go to the earliest.
//      Whole words only: `characterCount` inside
//      `characterCountDrillRecord` is a different name, and substring
//      counting is what kept choosing big early functions.
//
// The identifier naming the file's own outer type is dropped before any
// rule runs: it answers "which file", never "which work", and #1165's
// body — which names only `ChatViewModel` — must stay silent.
//
// A region never exceeds `maxRegionWidth` lines. For declarations wider
// than the cap the region is the first `maxRegionWidth` lines from the
// declaration start (rules 1, 2 and 4 anchor on the declaration), or a
// window covering the single occurrence (rule 3).
//
// The measurement that keeps this honest lives below, in
// `measurementCases()` and `replayMeasurement(in:)`: the four issues the
// narrowing was first measured against, replayed against real source.
// #1173's contract: at least three of four must land inside the
// declaration a human named, and the replay must go red the moment the
// name preference is removed.
//
// ─────────────────────────────────────────────────────────────────────
// THE MEASUREMENT, RECORDED (2026-08-23, gHashTag/trios#1173)
// ─────────────────────────────────────────────────────────────────────
//
// Replay target: rings/SR-02/ChatViewModel.swift at the commit this
// change rides on (13 436 lines). Run `replayMeasurement(in:)` on it;
// this is what it said before this file was rewritten and what it says
// after.
//
//   case        before (names-only rule)          after (#1173 rules)
//   ───────────  ───────────────────────────────  ──────────────────────────────
//   #1156       nil (silence)                    5940-6239  handleWorkerFinished
//   #1158       6010-6309 — inside               8276-8485  autoAcceptIfUnambiguous
//              handleWorkerFinished, wrong
//   #1165 body  silence (correct, kept)           silence (correct, kept)
//   #1165 clue  nil (silence)                    7479-7778  requestReviewerVerdicts
//   #1166       9859-10158 chooseNextOpenIssue    9859-10158 chooseNextOpenIssue
//   #1117       7479-7778 requestReviewerVerdicts 7479-7778 requestReviewerVerdicts
//
// By issue, against #1173's contract:
//
//   #1156  handleWorkerFinished    ✓ (density: awaitingReview is densest
//                                   in handleWorkerFinished — 6221, 6237,
//                                   6278 — against 2 in sweepAwaitingReview
//                                   and 1 in actOnCompletedReview)
//   #1158  autoAcceptIfUnambiguous ✓ (name preference; two names broken
//                                   by co-evidence, 4-0)
//   #1165  requestReviewerVerdicts ✓ (density over the clue
//                                   `queen.review.verdicts`, whose only
//                                   occurrence is the literal at 7801)
//   #1166  chooseNextOpenIssue     ✓ (signature: startAfterChoosing)
//
// Four of four, against a contract that asked for three.
//
// THE MUTATION, RECORDED — remove the name preference (skip rule 1)
// and the same replay says:
//
//   #1158  FAIL 299-598    not inside autoAcceptIfUnambiguous
//   #1117  FAIL 5940-6239  not inside requestReviewerVerdicts
//
// Two cases whose only evidence is a name the spec writes fall out of
// their targets the moment the preference is gone. That is criterion 4,
// and it is why rule 1 is first.
//
// ─────────────────────────────────────────────────────────────────────
// WHY WHOLE WORDS, WHY TWO VIEWS, WHY EARLIEST-ON-TIES
// ─────────────────────────────────────────────────────────────────────
//
// Whole words. `characterCount` occurs whole exactly once in
// ChatViewModel.swift (inside the literal "queen.review.characterCount",
// 12422) but as a substring nine more times (characterCountDrillRecord,
// characterCountVerdicts, ...). Substring counting is what made the
// first density rule choose big early functions every time — the more
// ordinary words a body holds, the more substrings it matches.
//
// Two views. Comments are blanked on both: a doc comment describing a
// function is not the function. String contents are blanked for
// counting "exactly one occurrence" and for parsing declarations (a
// brace inside a literal would unbalance the count), but kept for
// density and co-evidence — #1165's clue exists only inside a literal,
// and the measurement that deleted literals (#1174 era) made three of
// four cases worse, which is what measuring is for.
//
// Earliest on ties. Density ties go to the earliest declaration — the
// historical tie-break, kept because it measured right for #1156 and
// because changing an unmeasured tie-break is how this file collected
// four failed rules in a week.
//
// The outer type is dropped. `ChatViewModel` names the file's container;
// #1165's body names nothing else, and the correct answer there is
// silence, not line one of the biggest type. The widest declaration is
// the container — that is how it is found, not by guessing the file's
// name.
//
// ─────────────────────────────────────────────────────────────────────
// PRECEDENT — the rules that were tried, measured, and taken back
// ─────────────────────────────────────────────────────────────────────
//
// Kept here because each of them looked obviously right the day it was
// written, and each was retired by a measurement, not an argument.
//
//   1. First-mention anchoring (the #1168 rule). The first mention of a
//      common identifier is nearly always a doc comment at the top of
//      the file, so the region was the file header — the one place
//      where nothing happens. Comments are blanked before anything is
//      searched, permanently.
//
//   2. Mention density over everything (#1173's original complaint).
//      Density points at whichever function holds the most ordinary
//      words; in a thirteen-thousand-line file that is a large early
//      function every time — twice measured into `reset()` at lines
//      66-365. Density survives only as the last rule, after names,
//      signatures and single occurrences have had their say.
//
//   3. Unmasking string literals (the #1174 attempt). Literals carry a
//      great many ordinary words, and unmasking them fed the density
//      rule exactly the noise the comment-masking was added to remove:
//      three of four cases landed in `reset()`. Literals are evidence
//      only for density and co-evidence now, never for uniqueness, and
//      never unweighted.
//
//   4. Dotted names only (the #1175 attempt). Splitting dotted clues
//      into words and matching on those regressed #1158, whose body
//      names two declarations. A dotted clue is matched as one whole
//      string now — `queen.review.verdicts` occurs exactly once in the
//      file, and that is the entire reason it is good evidence.
//
//   5. Names only, silence otherwise (the #1175 state this file replaces).
//      One right range, three silences, no wrong ranges — honest, and
//      the reason #1156 stayed lost: its body never names
//      handleWorkerFinished; the name was in delegation text written by
//      hand. Silence on three of four is a bounded loss; the #1173
//      contract asks for the density fallback instead.
//
// One more from outside this file, kept for the same reason: a probe
// that changes what it measures is not a probe. The measurements here
// replay against source that is never written to, and the replay
// reports in one line per case precisely so a human can read the
// record without re-running it.
//
// ─────────────────────────────────────────────────────────────────────
// PUBLIC SURFACE — what the app relies on
// ─────────────────────────────────────────────────────────────────────
//
//   region(in:mentioning:)      the narrowing itself. Called from the
//                               brief builder and the excerpt builder in
//                               ChatViewModel; nil means "hand over the
//                               whole file", which was always correct
//                               before narrowing existed.
//   maxRegionWidth              300. The brief builder narrows only
//                               files strictly longer than this; a test
//                               in ChatViewModel pins the value and
//                               renders it into a message, so changing
//                               it is a visible change, not a tuning
//                               knob.
//   measurementCases()          the replay contract, below.
//   replayMeasurement(in:)      the замер: one line per case, "ok" or
//                               "FAIL" with the region and the target
//                               span, so the record can be pasted whole
//                               into an issue or a report.
//
// Everything else is private. Nothing outside this file references it,
// which was verified before the rewrite: the app touches only the four
// symbols above.
//
// ─────────────────────────────────────────────────────────────────────
// LEXER INVARIANTS — the ones that cost real time once
// ─────────────────────────────────────────────────────────────────────
//
// Line numbering survives every lexer state. Three specific traps, each
// found by a misaligned measurement:
//
//   1. A line comment must return to code state on its newline. The
//      first draft stayed in the comment state forever and masked the
//      whole file — every declaration after line 1 vanished.
//   2. Every state that can span lines (block comments, strings,
//      multiline strings) must flush the current line on its newline.
//      The first draft accumulated them into one line and shifted every
//      line number after the first multiline string.
//   3. An escape pair ending a line (`\` + newline inside a multiline
//      string, a Swift line continuation) must flush too. The first
//      draft swallowed the newline and ate four lines of
//      ChatViewModel.swift between 7479 and 8276 — every span after it
//      computed four lines low.
//
// A masked view whose line count differs from its source is not a view
// of the source; assert it before trusting anything built on it.
//

// RE-RUNNING THE MEASUREMENT. The replay needs no app and no harness:
//
//     swiftc rings/SR-00/QueenLocalisation.swift <driver>.swift -o probe
//     ./probe rings/SR-02/ChatViewModel.swift
//
// with a driver that reads the file and prints
// `QueenLocalisation.replayMeasurement(in: source)` one line per entry.
// Every number quoted above was produced that way, and the driver that
// produced them is three lines long.
//
// The same driver answers the mutation question: apply the mutation
// (skip rule 1), rebuild, and two replay lines go red — recorded above.

import Foundation

enum QueenLocalisation {

    /// A brief may not walk a bee through more than this many lines.
    /// Files at or below this width are handed over whole — the guard
    /// in the brief builder compares with `>`, so a file of exactly
    /// this many lines is never narrowed (#1168: the off-by-one was
    /// measured and fixed).
    static let maxRegionWidth = 300

    // MARK: - The narrowing

    /// The lines of `source` the work named by `identifiers` lives in,
    /// or nil when nothing honest can be said.
    ///
    /// Line numbers are 1-based and refer to `source` as given. The
    /// result never exceeds `maxRegionWidth` lines.
    static func region(
        in source: String,
        mentioning identifiers: [String]
    ) -> ClosedRange<Int>? {
        // Two views of the same lines. `code` blanks comments and the
        // contents of string literals — it is where declarations are
        // parsed and where a "single occurrence" is counted, so that a
        // log line or a doc comment cannot point the narrowing at
        // itself. `text` blanks comments only — string literals are
        // real evidence for density (the clue `queen.review.verdicts`
        // exists in the file only inside a literal, #1165) and for the
        // co-evidence tie-break.
        let code = maskedLines(source, maskingStrings: true)
        let text = maskedLines(source, maskingStrings: false)
        let declarations = parseDeclarations(in: code)
        guard !declarations.isEmpty else { return nil }

        // The widest declaration is the file's outer type. Naming it is
        // how an issue says which file it means, not where the work is.
        guard let outer = declarations.max(by: {
            ($0.end - $0.start) < ($1.end - $1.start)
        }) else { return nil }
        let clues = identifiers.filter { $0 != outer.name }
        guard !clues.isEmpty else { return nil }

        // Rule 1 — the name preference. A declaration the spec names
        // outright is stronger than any density (#1173).
        let named = declarations.filter { $0.name != outer.name && clues.contains($0.name) }
        if named.count == 1 {
            return region(for: named[0], anchor: nil)
        }
        if named.count > 1 {
            // Two declarations are named. The spec is usually about the
            // one that calls the other: #1158 names both
            // `autoAcceptIfUnambiguous` and the helper it calls, and the
            // body of the former mentions the latter (and ProcessInfo,
            // and processInfo) while the helper's body mentions none of
            // the rest. Count the other identifiers' whole-word
            // occurrences inside each candidate; a unique winner takes
            // it, anything else stays silent.
            var scores: [Int: Int] = [:]
            for candidate in named {
                var score = 0
                for clue in clues where clue != candidate.name {
                    score += occurrences(of: clue, in: text)
                        .filter { candidate.start...candidate.end ~= $0 }
                        .count
                }
                scores[candidate.start] = score
            }
            let best = scores.values.max() ?? 0
            let winners = named.filter { scores[$0.start] == best }
            if best > 0, winners.count == 1 {
                return region(for: winners[0], anchor: nil)
            }
            return nil
        }

        // Rule 2 — signature names. An identifier naming a parameter of
        // exactly one declaration points there (#1166:
        // `startAfterChoosing`). Identifiers that name parameters of
        // several declarations (`ownedPaths` names four signatures in
        // ChatViewModel.swift) are not location evidence at all.
        var parameterWinners: Set<Int> = []
        for clue in clues {
            let owners = declarations.filter {
                $0.name != outer.name && $0.parameterNames.contains(clue)
            }
            if owners.count == 1 { parameterWinners.insert(owners[0].start) }
        }
        if parameterWinners.count == 1,
           let winner = declarations.first(where: { $0.start == parameterWinners.first! }) {
            return region(for: winner, anchor: nil)
        }

        // Rule 3 — one code occurrence. An identifier that appears
        // exactly once in code (literals blanked) has a single home.
        // More than one such identifier is ambiguity; none is silence.
        var singles: [(clue: String, line: Int)] = []
        for clue in clues {
            let hits = occurrences(of: clue, in: code)
            if hits.count == 1 { singles.append((clue, hits[0])) }
        }
        if singles.count == 1 {
            let hit = singles[0].line
            let owners = declarations.filter { $0.start...$0.end ~= hit }
            if let owner = owners.max(by: { $0.start < $1.start }) {
                return region(for: owner, anchor: hit)
            }
        }

        // Rule 4 — density, the fallback #1173 kept. Whole-word
        // mentions per declaration, string literals included, earliest
        // declaration wins ties (the historical tie-break, and the one
        // that measured right for #1156: `awaitingReview` is densest in
        // `handleWorkerFinished`).
        var bestScore = 0
        var winner: Declaration?
        for declaration in declarations where declaration.name != outer.name {
            var score = 0
            for clue in clues {
                score += occurrences(of: clue, in: text)
                    .filter { declaration.start...declaration.end ~= $0 }
                    .count
            }
            if score > bestScore {
                bestScore = score
                winner = declaration
            }
        }
        if let winner = winner {
            return region(for: winner, anchor: nil)
        }
        return nil
    }

    /// The region a won declaration contributes: the whole declaration
    /// when it fits the cap, otherwise its first `maxRegionWidth` lines
    /// — or, when anchored on a single occurrence, the window of
    /// `maxRegionWidth` lines that ends at the declaration's end and
    /// still covers the occurrence.
    private static func region(
        for declaration: Declaration,
        anchor: Int?
    ) -> ClosedRange<Int> {
        let width = declaration.end - declaration.start + 1
        if width <= maxRegionWidth {
            return declaration.start...declaration.end
        }
        if let anchor = anchor {
            // Centre on the occurrence, clamped into the declaration.
            let centred = anchor - maxRegionWidth / 2
            let start = max(declaration.start, min(centred, declaration.end - maxRegionWidth + 1))
            return start...(start + maxRegionWidth - 1)
        }
        return declaration.start...(declaration.start + maxRegionWidth - 1)
    }

    // MARK: - Occurrences

    /// 1-based line numbers where `identifier` occurs in `lines`.
    /// Identifiers containing a dot are matched as whole substrings
    /// (a dotted log-event name is specific enough that nothing else
    /// contains it); plain identifiers are matched as whole words, so
    /// `characterCount` does not count inside
    /// `characterCountDrillRecord`.
    private static func occurrences(
        of identifier: String,
        in lines: [String]
    ) -> [Int] {
        let dotted = identifier.contains(".")
        var hits: [Int] = []
        for (index, line) in lines.enumerated() {
            var searchRange = line.startIndex..<line.endIndex
            while let found = line.range(of: identifier, range: searchRange) {
                if dotted {
                    hits.append(index + 1)
                } else {
                    let before = found.lowerBound > line.startIndex
                        ? line[line.index(before: found.lowerBound)]
                        : nil
                    let after = found.upperBound < line.endIndex
                        ? line[found.upperBound]
                        : nil
                    let beforeOk = before.map { !isWordCharacter($0) } ?? true
                    let afterOk = after.map { !isWordCharacter($0) } ?? true
                    if beforeOk && afterOk { hits.append(index + 1) }
                }
                if found.upperBound < line.endIndex {
                    searchRange = found.upperBound..<line.endIndex
                } else {
                    break
                }
            }
        }
        return hits
    }

    private static func isWordCharacter(_ c: Character) -> Bool {
        c.isLetter || c.isNumber || c == "_"
    }

    // MARK: - Masking

    /// `source` with comments blanked, and — when `maskingStrings` —
    /// the contents of string literals blanked too. Line count and line
    /// numbering are preserved exactly: every lexer state flushes on a
    /// newline, including the two that span lines (block comments and
    /// multiline strings) and the escape that ends a line
    /// (`\` + newline inside a multiline string), which once ate four
    /// lines of ChatViewModel.swift and shifted every number after it.
    private static func maskedLines(
        _ source: String,
        maskingStrings: Bool
    ) -> [String] {
        enum State { case code, lineComment, blockComment, string, multilineString }
        var lines: [String] = []
        var current = ""
        let chars = Array(source)
        var i = 0
        var state = State.code

        func flush() {
            lines.append(current)
            current = ""
        }

        while i < chars.count {
            let c = chars[i]
            let next = i + 1 < chars.count ? chars[i + 1] : nil
            switch state {
            case .lineComment:
                if c == "\n" { flush(); state = .code } else { current.append(" ") }
                i += 1
            case .blockComment:
                if c == "*", next == "/" {
                    current.append("  ")
                    state = .code
                    i += 2
                } else {
                    if c == "\n" { flush() } else { current.append(" ") }
                    i += 1
                }
            case .string, .multilineString:
                if c == "\\", let escaped = next {
                    // An escape pair is two characters on the masked
                    // view; if the pair ends a line, the line ends with
                    // it — the newline is not swallowed.
                    current.append(maskingStrings ? "  " : "\(c)\(escaped)")
                    if escaped == "\n" { flush() }
                    i += 2
                } else if state == .string, c == "\"" {
                    current.append(maskingStrings ? " " : c)
                    state = .code
                    i += 1
                } else if state == .multilineString, c == "\"",
                          next == "\"", i + 2 < chars.count, chars[i + 2] == "\"" {
                    current.append(maskingStrings ? "   " : "\"\"\"")
                    state = .code
                    i += 3
                } else {
                    if c == "\n" {
                        flush()
                    } else {
                        current.append(maskingStrings ? " " : c)
                    }
                    i += 1
                }
            case .code:
                if c == "/", next == "/" {
                    state = .lineComment
                    i += 2
                } else if c == "/", next == "*" {
                    state = .blockComment
                    i += 2
                } else if c == "\"", next == "\"", i + 2 < chars.count, chars[i + 2] == "\"" {
                    current.append(maskingStrings ? "   " : "\"\"\"")
                    state = .multilineString
                    i += 3
                } else if c == "\"" {
                    current.append(maskingStrings ? " " : c)
                    state = .string
                    i += 1
                } else {
                    if c == "\n" { flush() } else { current.append(c) }
                    i += 1
                }
            }
        }
        if !current.isEmpty { lines.append(current) }
        return lines
    }

    // MARK: - Declarations

    /// A member-level declaration: its name, its span (the line the
    /// declaration starts to the line its opening brace closes — doc
    /// comments ahead of it and blanks after it are not part of it),
    /// and the identifiers its signature declares as parameters.
    private struct Declaration {
        let name: String
        let start: Int
        let end: Int
        let signature: String

        var parameterNames: Set<String> {
            var names = Set<String>()
            let scanner = signature
            var searchRange = scanner.startIndex..<scanner.endIndex
            while let found = scanner.range(
                of: #"[A-Za-z_][A-Za-z0-9_]*\s*:"#, options: .regularExpression,
                range: searchRange
            ) {
                let token = scanner[found.lowerBound..<scanner.index(before: found.upperBound)]
                    .trimmingCharacters(in: .whitespaces)
                if !Declaration.keywords.contains(token) {
                    names.insert(String(token))
                }
                if found.upperBound < scanner.endIndex {
                    searchRange = found.upperBound..<scanner.endIndex
                } else {
                    break
                }
            }
            return names
        }

        private static let keywords: Set<String> = [
            "public", "private", "internal", "fileprivate", "open", "final",
            "static", "class", "nonisolated", "override", "required",
            "convenience", "lazy", "weak", "mutating", "isolated", "deferred",
            "async", "for", "in", "is", "as", "to", "and", "or", "not",
            "new", "some", "any", "each", "of", "where", "rethrows",
            "throws", "await", "by", "func", "init", "var", "let",
        ]
    }

    /// Declaration start patterns at member level (indent of zero or
    /// four spaces). Bodies of functions are eight or deeper and are
    /// never mistaken for declarations.
    private static let funcPattern = try! NSRegularExpression(
        pattern: #"^ {0,4}(?:@?\w+ )*?func\s+([A-Za-z_][A-Za-z0-9_]*)"#
    )
    private static let initPattern = try! NSRegularExpression(
        pattern: #"^ {0,4}(?:@?\w+ )*?init\b"#
    )
    private static let varPattern = try! NSRegularExpression(
        pattern: #"^ {0,4}(?:@?\w+ )*?(?:var|let)\s+([A-Za-z_][A-Za-z0-9_]*)"#
    )
    private static let typePattern = try! NSRegularExpression(
        pattern: #"^ {0,4}(?:@?\w+ )*?(?:class|struct|enum|extension|actor|protocol)\s+([A-Za-z_][A-Za-z0-9_]*)"#
    )

    /// All declarations in the masked `code` lines, in file order.
    private static func parseDeclarations(in code: [String]) -> [Declaration] {
        var declarations: [Declaration] = []
        for (index, line) in code.enumerated() {
            let line = line.trimmingCharacters(in: CharacterSet(charactersIn: "\n"))
            guard let (name, signatureLines, braceLine) = declarationStart(in: line, at: index, in: code) else {
                continue
            }
            if let braceLine = braceLine {
                let end = braceMatchingEnd(in: code, from: braceLine)
                let signature = signatureLines
                declarations.append(Declaration(name: name, start: index + 1, end: end, signature: signature))
            } else {
                // A declaration with no body of its own (a protocol
                // member, a forward declaration) occupies its line.
                declarations.append(Declaration(name: name, start: index + 1, end: index + 1, signature: line))
            }
        }
        return declarations
    }

    /// The name of the declaration starting on `line`, plus its
    /// signature text and the line its opening brace sits on (nil when
    /// the signature never opens a body within sight, stopping at the
    /// next declaration).
    private static func declarationStart(
        in line: String,
        at index: Int,
        in code: [String]
    ) -> (name: String, signature: String, braceLine: Int?)? {
        let ns = line as NSString
        if let m = funcPattern.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) {
            let name = ns.substring(with: m.range(at: 1))
            return finishSignature(name: name, from: index, in: code, firstLine: line)
        }
        if initPattern.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) != nil {
            return finishSignature(name: "init", from: index, in: code, firstLine: line)
        }
        if let m = varPattern.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) {
            let name = ns.substring(with: m.range(at: 1))
            // A property opens a body only when a brace is on its own
            // line (computed property, property observer, closure
            // initializer). Otherwise it is its own single line — a
            // stored property has no span to wait for, and waiting for
            // the next brace in the file once swallowed every
            // declaration after one.
            if let braceOffset = line.firstIndex(of: "{") {
                let sig = String(line[line.startIndex..<braceOffset])
                return (name, sig, index)
            }
            return (name, line, nil)
        }
        if let m = typePattern.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) {
            let name = ns.substring(with: m.range(at: 1))
            return finishSignature(name: name, from: index, in: code, firstLine: line)
        }
        return nil
    }

    /// A func/init/type declaration whose signature may span lines:
    /// collect lines until the one that opens the body, stopping early
    /// if another declaration starts (the signature is malformed, not
    /// long).
    private static func finishSignature(
        name: String,
        from index: Int,
        in code: [String],
        firstLine: String
    ) -> (name: String, signature: String, braceLine: Int?)? {
        if let braceOffset = firstLine.firstIndex(of: "{") {
            let sig = String(firstLine[firstLine.startIndex..<braceOffset])
            return (name, sig, index)
        }
        var signature = firstLine
        var j = index + 1
        let limit = min(index + 60, code.count - 1)
        while j <= limit {
            let next = code[j].trimmingCharacters(in: CharacterSet(charactersIn: "\n"))
            if isDeclarationStartLine(next) { return (name, signature, nil) }
            signature += "\n" + next
            if let braceOffset = next.firstIndex(of: "{") {
                let trimmed = String(next[next.startIndex..<braceOffset])
                return (name, signature + "\n" + trimmed, j)
            }
            if next.contains(";") { return (name, signature, nil) }
            j += 1
        }
        return (name, signature, nil)
    }

    private static func isDeclarationStartLine(_ line: String) -> Bool {
        let ns = line as NSString
        let full = NSRange(location: 0, length: ns.length)
        return funcPattern.firstMatch(in: line, range: full) != nil
            || initPattern.firstMatch(in: line, range: full) != nil
            || varPattern.firstMatch(in: line, range: full) != nil
            || typePattern.firstMatch(in: line, range: full) != nil
    }

    /// The line where the brace opened on `braceIndex` closes, counting
    /// braces on the string-masked view so that braces inside literals
    /// cannot unbalance the count.
    private static func braceMatchingEnd(in code: [String], from braceIndex: Int) -> Int {
        let first = code[braceIndex].trimmingCharacters(in: CharacterSet(charactersIn: "\n"))
        var opened = first.filter { $0 == "{" }.count - first.filter { $0 == "}" }.count
        if opened <= 0 { return braceIndex + 1 }
        var line = braceIndex + 1
        while line < code.count {
            let text = code[line].trimmingCharacters(in: CharacterSet(charactersIn: "\n"))
            opened += text.filter { $0 == "{" }.count - text.filter { $0 == "}" }.count
            if opened <= 0 { return line + 1 }
            line += 1
        }
        return code.count
    }

    // MARK: - The measurement contract

    /// One replayed measurement: the identifiers an issue's body really
    /// yields, and what the narrowing is contracted to answer.
    struct MeasurementCase {
        let issue: String
        let identifiers: [String]
        let expected: Expected

        enum Expected {
            case declaration(String)
            case silence
        }
    }

    static func measurementCases() -> [MeasurementCase] {
        [
            MeasurementCase(
                issue: "#1156",
                identifiers: ["ChatViewModel", "awaitingReview", "characterCount"],
                expected: .declaration("handleWorkerFinished")
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

    /// Replay every measurement case against `source` and report, one
    /// line per case, whether the narrowing lands inside the
    /// declaration a human named. This is the #1173 замер: run it
    /// against the real ChatViewModel.swift, record the output, and
    /// expect at least three of the four issues inside their targets.
    ///
    /// The replay is also the guard on the name preference: remove the
    /// preference and #1158 and #1117 — the two cases whose only
    /// evidence is a name the spec writes — fall out of their targets
    /// and the report goes red.
    static func replayMeasurement(in source: String) -> [String] {
        let code = maskedLines(source, maskingStrings: true)
        let declarations = parseDeclarations(in: code)
        func targetSpan(of name: String) -> ClosedRange<Int>? {
            declarations.first { $0.name == name }.map { $0.start...$0.end }
        }
        return measurementCases().map { measurement in
            let answer = region(in: source, mentioning: measurement.identifiers)
            switch (answer, measurement.expected) {
            case (nil, .silence):
                return "ok    \(measurement.issue): silence"
            case (nil, .declaration(let name)):
                return "FAIL  \(measurement.issue): silence, expected inside \(name)"
            case (.some(let range), .declaration(let name)):
                if let target = targetSpan(of: name),
                   target.lowerBound <= range.lowerBound,
                   range.upperBound <= target.upperBound {
                    return "ok    \(measurement.issue): \(range.lowerBound)-\(range.upperBound) inside \(name)"
                }
                let span = targetSpan(of: name)
                    .map { "\($0.lowerBound)-\($0.upperBound)" } ?? "not found"
                return "FAIL  \(measurement.issue): \(range.lowerBound)-\(range.upperBound) not inside \(name) (\(span))"
            case (.some(let range), .silence):
                return "FAIL  \(measurement.issue): \(range.lowerBound)-\(range.upperBound), expected silence"
            }
        }
    }
}
