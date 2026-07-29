import Foundation

/// How a system message should read to the user.
///
/// Every system message used to render as a red badge with a warning triangle,
/// so "Delegated #1086 to queen-swift", "1 awaiting you" and an actual provider
/// failure were visually identical. A supervisor surface where success looks
/// like an error teaches the user to ignore the colour entirely.
enum SystemNoticeKind: String, Equatable, CaseIterable {
    case success
    case info
    case warning
    case failure

    /// SF Symbol shown beside the text.
    var symbolName: String {
        switch self {
        case .success: return "checkmark.circle.fill"
        case .info: return "info.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .failure: return "xmark.octagon.fill"
        }
    }

    /// Errors are the only kind worth a permanently visible copy button:
    /// they are what a user needs to paste into a bug report.
    var deservesPersistentCopyButton: Bool {
        self == .failure || self == .warning
    }
}

/// Classifies system messages and strips the marker they carry.
///
/// Markers are ASCII and inline (`[ok] `, `[i] `, `[!] `, `[x] `) rather than a
/// field on `ChatMessage` because conversations already persisted on disk have
/// no such field, and a rendering change must not require a history migration.
/// Unmarked legacy text falls back to a keyword scan.
enum SystemNoticeClassifier {
    static let successMarker = "[ok] "
    static let infoMarker = "[i] "
    static let warningMarker = "[!] "
    static let failureMarker = "[x] "

    /// Words that mean a message is reporting a genuine problem. Kept narrow on
    /// purpose: "Accepted ... probe rejection" must not be classed as a failure
    /// just because it contains the word "rejection".
    private static let failurePhrases = [
        "could not", "cannot ", "failed", "error", "unavailable",
        "is not ", "no such", "refused", "aborted", "timed out"
    ]

    static func classify(_ content: String) -> (kind: SystemNoticeKind, text: String) {
        if content.hasPrefix(successMarker) {
            return (.success, String(content.dropFirst(successMarker.count)))
        }
        if content.hasPrefix(infoMarker) {
            return (.info, String(content.dropFirst(infoMarker.count)))
        }
        if content.hasPrefix(warningMarker) {
            return (.warning, String(content.dropFirst(warningMarker.count)))
        }
        if content.hasPrefix(failureMarker) {
            return (.failure, String(content.dropFirst(failureMarker.count)))
        }

        // Legacy history: no marker. Strip the emoji some old messages carry and
        // guess from the wording.
        let cleaned = content.replacingOccurrences(of: "\u{26A0}\u{FE0F} ", with: "")
        let lowered = cleaned.lowercased()
        let looksBad = failurePhrases.contains { lowered.contains($0) }
        return (looksBad ? .failure : .info, cleaned)
    }
}
