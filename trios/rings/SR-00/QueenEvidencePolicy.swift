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
}
