import Foundation

/// Reading an issue's boundary section: the one rule, in one place.
///
/// This lived inside the app's view model, which was fine while the app was the
/// only thing that had to read an issue. It is not fine now. The container's
/// tick decides which bee starts next, and deciding that means knowing which
/// files each candidate wants - so either this rule moves here, or the container
/// gets a second copy of it in another language.
///
/// The cost of the second copy was measurable before it was written. Lacking
/// this parser, `queend`'s `choose` judged EVERY candidate against a hardcoded
/// `rings/SR-00`, so the answer was the same regardless of what the issue
/// actually touched. Measured on the live deployment 2026-08-29 with two
/// unrelated candidates:
///
///   #9999: its files are held by trios#1286, trios#1127, trios#1174
///   #8888: its files are held by trios#1286, trios#1127, trios#1174
///
/// Identical reasons for two issues that have nothing in common, because the
/// reasoning never looked at either of them. A refusal like that is not
/// conservative - it is uninformed, and it reads in a log exactly like a careful
/// supervisor declining to cause a conflict.
public enum QueenIssueBoundary {

    /// Whether a heading opens the boundary section.
    ///
    /// Two spellings, because the repository writes its documentation and code
    /// in English while every issue written before that rule says `Границы`.
    /// The heading is a parser token, not prose: recognising only one spelling
    /// would make every English issue undelegatable, and the failure would read
    /// as "no boundary section, so there is nothing to delegate" - true of the
    /// parser, not of the issue.
    public static func isBoundaryHeading(_ trimmed: String) -> Bool {
        trimmed.hasPrefix("## Границы") || trimmed.hasPrefix("## Boundary")
    }

    /// Extracts the path-shaped token from a boundary line.
    ///
    /// The token has no spaces, contains "/" or ends in a dotted extension, and
    /// is stripped of surrounding backticks and prose punctuation.
    ///
    /// The two strips run in a loop rather than in sequence, and that is the
    /// whole substance of this function. Backticks-then-punctuation fails on the
    /// commonest shape there is: a path in backticks followed by a comma. The
    /// trailing character is the comma, so the backtick strip never reaches the
    /// backtick; the punctuation strip then removes the comma and leaves the
    /// backtick exposed at the end, where nothing looks again.
    ///
    /// Five of the sixty-three boundary paths in the live registries carried a
    /// trailing backtick from exactly that. A path like that matches nothing:
    /// `git add --` does not stage it, and the boundary filter drops the
    /// worker's real edits as being outside its boundary. The bee is then
    /// recorded as having produced nothing, which is the commonest failure in
    /// the registry.
    ///
    /// The token boundary is any whitespace, not the ASCII space. Splitting on
    /// " " alone made this disagree with the deliberate second implementation
    /// in `queen-tick.ts`, which has always split on `/\s+/`: fed the line
    /// "-<TAB>rings/SR-00/Foo.swift", the two parsers returned
    /// "-\trings/SR-00/Foo.swift" and "rings/SR-00/Foo.swift" respectively.
    /// Nothing strips the marker afterwards - the leading-strip set below is
    /// "`\"'(" and holds no "-" - and the fused token still contains "/", so it
    /// is returned as if it were a path. That is a path claim the board and the
    /// Queen would then read differently for the same issue.
    public static func pathToken(from line: String) -> String? {
        for raw in line.split(omittingEmptySubsequences: true, whereSeparator: { $0.isWhitespace }) {
            var cleaned = String(raw)
            var changed = true
            while changed, !cleaned.isEmpty {
                changed = false
                if let first = cleaned.first, "`\"'(".contains(first) {
                    cleaned.removeFirst()
                    changed = true
                }
                if let last = cleaned.last, "`\"'.,;:!?)".contains(last) {
                    cleaned.removeLast()
                    changed = true
                }
            }
            guard !cleaned.isEmpty else { continue }
            if cleaned.contains("/")
                || cleaned.range(of: #"\.\w{1,10}$"#, options: .regularExpression) != nil {
                return cleaned
            }
        }
        return nil
    }

    /// The paths an issue declares, or nil when it declares no boundary at all.
    ///
    /// nil and `[]` are different answers and callers must keep them apart. An
    /// issue with no boundary section has told us nothing about what it will
    /// touch; an issue with an empty one has told us nothing either, but did so
    /// on purpose. Neither is "it touches no files", and treating either as an
    /// empty conflict set is how a bee gets started on work whose collisions
    /// nobody could have predicted.
    public static func paths(from body: String) -> [String]? {
        let lines = body.split(separator: "\n", omittingEmptySubsequences: false)
        var inBounds = false
        var paths: [String] = []
        var found = false

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("## ") {
                if inBounds { break }
                inBounds = isBoundaryHeading(trimmed)
                if inBounds { found = true }
                continue
            }
            guard inBounds else { continue }
            if trimmed.isEmpty { continue }
            if let token = pathToken(from: trimmed) { paths.append(token) }
        }

        return found ? paths : nil
    }
}
