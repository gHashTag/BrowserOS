import Foundation

/// When the presence of a name is evidence that work was done, and when it is
/// only evidence that the work has a subject.
///
/// The Queen skips a candidate as "looks already done" if every identifier its
/// acceptance criteria name is present in its boundary files. That is sound
/// for an issue asking for something new - the name does not exist until the
/// work does - and exactly backwards for a fix, where the criteria name the
/// identifiers that carry the defect. Measured 2026-08-23: eight of seventeen
/// candidates dismissed that way, two of them filed the same hour.
///
/// The question that separates the two is when the names arrived. If they were
/// already in the boundary files at the commit that was HEAD when the issue
/// was written, their presence now says nothing about the issue.
enum QueenEvidencePolicy {
    /// Whether "all the named identifiers are present" may stand as evidence
    /// that the issue is done.
    ///
    /// - Parameters:
    ///   - symbols: identifiers named by the acceptance criteria.
    ///   - contentsWhenFiled: the boundary files' combined contents at the
    ///     commit that was HEAD when the issue was filed, or nil when git
    ///     could not say - a file that did not exist yet, a revision that
    ///     could not be resolved, a failed call.
    ///
    /// A nil answer means the measurement did not happen, and an unmeasured
    /// question may not dismiss work: the caller is told the presence is NOT
    /// evidence, so the issue stays choosable. A false "already done" loses
    /// the work entirely; a false "not done" costs one turn in which the bee
    /// says it is done.
    static func presenceIsEvidence(
        symbols: [String],
        contentsWhenFiled: String?
    ) -> Bool {
        guard !symbols.isEmpty else { return false }
        guard let then = contentsWhenFiled else { return false }
        // Evidence only if at least one name arrived after the issue was
        // filed. If every one of them was already there, the criteria are
        // describing the defect's own vocabulary.
        return !symbols.allSatisfy { then.contains($0) }
    }

    /// The identifiers an issue's acceptance criteria name.
    ///
    /// Two passes and a filter, and every part of it was a defect once:
    /// backtick spans (#1178), bare words carrying an interior capital
    /// (#1179), and a filter that rejects prose, keywords and anything with a
    /// dot or a slash - a file path is not an identifier, and treating one as
    /// evidence made a boundary file's own name argue that its work was done.
    ///
    /// Lived unread inside the view model until 2026-08-23, deciding what the
    /// Queen would work on with nothing able to check it.
    static func namedIdentifiers(
        in body: String,
        ignoringBacktickedSpans: Bool = false
    ) -> [String] {
        var found = Set<String>()

        // Backtick-quoted spans: `QueenLocalisation`, `ChatViewModel.swift`, etc.
        if let regex = try? NSRegularExpression(pattern: "`([^`]+)`") {
            let nsBody = body as NSString
            regex.enumerateMatches(
                in: body,
                range: NSRange(location: 0, length: nsBody.length)
            ) { match, _, _ in
                guard let match else { return }
                let captured = nsBody.substring(with: match.range(at: 1))
                if !captured.isEmpty { found.insert(captured) }
            }
        }

        // Bare words. `ignoringBacktickedSpans` decides whether they may be
        // mined from inside a backtick span, and the two callers genuinely
        // differ.
        //
        // NARROWING wants them: given the boundary `rings/SR-02/
        // ChatViewModel.swift`, the stem ChatViewModel is exactly what to
        // look for in the file, and #1172's drill pins that count.
        //
        // EVIDENCE must not have them: the same stem is present in that file
        // by construction, so the criteria's own filename would argue that
        // its work was done. Caught 2026-08-23 by this function's first
        // test, which it had never had in either role.
        let prose = ignoringBacktickedSpans
            ? ((try? NSRegularExpression(pattern: "`[^`]*`")).map { regex -> String in
                let ns = body as NSString
                return regex.stringByReplacingMatches(
                    in: body,
                    range: NSRange(location: 0, length: ns.length),
                    withTemplate: " "
                )
            } ?? body)
            : body

        // Matches runs of Latin letters and digits that contain an uppercase
        // letter which is not the first character (#1179).
        if let regex = try? NSRegularExpression(
            pattern: "\\b[a-zA-Z0-9]+[A-Z][a-zA-Z0-9]*\\b"
        ) {
            let nsBody = prose as NSString
            regex.enumerateMatches(
                in: prose,
                range: NSRange(location: 0, length: nsBody.length)
            ) { match, _, _ in
                guard let match else { return }
                let captured = nsBody.substring(with: match.range)
                if !captured.isEmpty { found.insert(captured) }
            }
        }

        // Filter to identifier-shaped tokens only: reject prose, keywords,
        // paths, and file extensions (#1178).
        let swiftKeywords: Set<String> = [
            "return", "func", "let", "var", "guard", "where",
            "case", "class", "struct", "enum", "self",
            "true", "false", "nil", "async", "await", "throws",
        ]
        return found.filter { token in
            // ≥6 chars, starts with a letter, only letters and digits
            // (no spaces, slashes, dots / file extensions).
            guard token.count >= 6,
                  let first = token.first,
                  first.isLetter,
                  token.allSatisfy({ $0.isLetter || $0.isNumber })
            else { return false }
            return !swiftKeywords.contains(token)
        }
    }

    /// The identifiers that may serve as EVIDENCE, which is the same
    /// extraction with path stems left out - see the note above.
    static func evidenceIdentifiers(in body: String) -> [String] {
        namedIdentifiers(in: body, ignoringBacktickedSpans: true)
    }
}
