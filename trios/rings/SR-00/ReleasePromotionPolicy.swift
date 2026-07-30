import Foundation

/// Evidence gathered about a dev build before it may become the release.
struct PromotionEvidence: Equatable, Sendable {
    /// The dev bundle exists and is newer than the release one.
    var devBuildExists: Bool
    /// Every Swift logic suite passed.
    var suitesPassed: Int
    var suitesTotal: Int
    /// The chat end-to-end run succeeded.
    var chatEndToEndPassed: Bool
    /// Compiler errors in application sources.
    var compileErrors: Int
    /// Uncommitted files in the working tree.
    var dirtyFiles: Int
    /// The dev app actually launched and answered a health probe.
    var devAppHealthy: Bool
}

/// One reason a promotion is refused.
struct PromotionBlocker: Equatable, Sendable {
    let id: String
    let message: String
}

/// Decides whether a dev build may be promoted to release.
///
/// Promotion is the one moment the working app is deliberately replaced, so it
/// is the one moment worth gating. The gates are the same signals a human would
/// check, written down so they cannot be skipped in a hurry - and so a green
/// result means something specific rather than "it seemed fine".
enum ReleasePromotionPolicy {
    /// Dirty files are tolerated up to here; beyond it the build under test is
    /// not the thing that was reviewed.
    static let maximumDirtyFiles = 20

    static func blockers(for evidence: PromotionEvidence) -> [PromotionBlocker] {
        var found: [PromotionBlocker] = []

        if !evidence.devBuildExists {
            found.append(PromotionBlocker(
                id: "no-dev-build",
                message: "There is no dev build to promote. Run ./build.sh first."
            ))
        }
        if evidence.compileErrors > 0 {
            found.append(PromotionBlocker(
                id: "compile-errors",
                message: "\(evidence.compileErrors) compile error(s) in application sources."
            ))
        }
        if evidence.suitesTotal == 0 {
            found.append(PromotionBlocker(
                id: "no-suites",
                message: "No test suites ran; a promotion with no evidence is not a promotion."
            ))
        } else if evidence.suitesPassed < evidence.suitesTotal {
            let failed = evidence.suitesTotal - evidence.suitesPassed
            found.append(PromotionBlocker(
                id: "suite-failures",
                message: "\(failed) of \(evidence.suitesTotal) logic suites failed."
            ))
        }
        if !evidence.chatEndToEndPassed {
            found.append(PromotionBlocker(
                id: "chat-e2e",
                message: "The chat end-to-end run did not pass."
            ))
        }
        if !evidence.devAppHealthy {
            found.append(PromotionBlocker(
                id: "dev-unhealthy",
                message: "The dev app did not launch and answer a health probe."
            ))
        }
        if evidence.dirtyFiles > maximumDirtyFiles {
            found.append(PromotionBlocker(
                id: "too-dirty",
                message: "\(evidence.dirtyFiles) uncommitted files; the build under test is not what was reviewed."
            ))
        }
        return found
    }

    static func mayPromote(_ evidence: PromotionEvidence) -> Bool {
        blockers(for: evidence).isEmpty
    }

    /// One-line verdict for the report.
    static func verdict(for evidence: PromotionEvidence) -> String {
        let blockers = blockers(for: evidence)
        guard !blockers.isEmpty else {
            return "Ready to promote: \(evidence.suitesPassed)/\(evidence.suitesTotal) suites, chat e2e green, dev app healthy."
        }
        return "Blocked (\(blockers.count)): " + blockers.map(\.message).joined(separator: " ")
    }
}
