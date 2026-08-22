import Foundation

/// Tells "the keychain is slow" apart from "the keychain is waiting for a
/// human", which are the same eight-second timeout and completely different
/// problems.
///
/// Measured 2026-08-22/23: the release app rebuilt itself, its ad-hoc
/// signature stopped matching the ACL on its own keychain items, and macOS put
/// an access dialog on screen. A menu-bar app cannot answer that dialog, so
/// every keychain call queued behind it and died on its own deadline. The
/// journal said `listing com.browseros.trios.model-keys did not answer in 8s`
/// twenty times across two full warm-up cycles - a sentence that sends the
/// reader to look at the keychain, which was fine: the shell read the same
/// service's attributes in 24 ms and the dev app read it successfully in the
/// same minute.
///
/// `SecurityAgent` is the process macOS runs to show that dialog. Its presence
/// is the measurement nobody was taking.
enum KeychainPromptDetector {
    /// The process that owns keychain access dialogs.
    static let promptProcessName = "SecurityAgent"

    /// Whether an access dialog is currently on screen, measured by asking for
    /// the process rather than inferring from a timeout.
    ///
    /// Deliberately cheap and deliberately late: callers ask only AFTER a
    /// stall, so the healthy path never spawns anything. Blocking, so callers
    /// must be off the main actor - a diagnosis that freezes the interface is
    /// worse than the stall it explains.
    static func promptIsWaiting(
        runningProcesses: () -> [String] = defaultRunningProcesses
    ) -> Bool {
        runningProcesses().contains { $0.hasSuffix(promptProcessName) }
    }

    /// Process names, read once per call. `pgrep` rather than a full `ps`
    /// parse: one name, one answer, no output to misread.
    static func defaultRunningProcesses() -> [String] {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        task.arguments = ["-x", promptProcessName]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do {
            try task.run()
        } catch {
            return []
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        // pgrep prints pids, not names; a non-empty answer means the named
        // process exists. The name is echoed back so the caller's predicate
        // reads the same either way.
        let found = !(String(data: data, encoding: .utf8) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return found ? [promptProcessName] : []
    }

    /// What to say about a stall, given what was measured about it.
    ///
    /// Two different sentences because they send the reader to two different
    /// places: one to a dialog on their own screen, one to the keychain.
    static func stallExplanation(
        service: String,
        deadlineSeconds: Int,
        promptWaiting: Bool
    ) -> String {
        guard promptWaiting else {
            return "listing \(service) did not answer in \(deadlineSeconds)s"
        }
        return "listing \(service) did not answer in \(deadlineSeconds)s because "
            + "a macOS keychain access dialog is open and waiting for you - "
            + "every keychain call queues behind it. This app cannot answer it. "
            + "Approve access (Always Allow) and the next attempt succeeds. "
            + "A rebuild changes the app's signature, which is what makes "
            + "macOS ask again."
    }

    /// What to say when a whole warm-up cycle has failed.
    ///
    /// The old line - "the cache is still empty" - is true and useless: it
    /// reports the outcome of ten attempts without saying whether trying an
    /// eleventh could ever work. Against a waiting dialog it never can.
    static func warmupFailureExplanation(
        attempts: Int,
        promptWaiting: Bool
    ) -> String {
        guard promptWaiting else {
            return "Provider key warm-up failed after \(attempts) attempts; "
                + "the cache is still empty."
        }
        return "Provider key warm-up failed after \(attempts) attempts, and "
            + "retrying cannot help: a macOS keychain access dialog is waiting "
            + "for you on screen, and every attempt queued behind it. Approve "
            + "access (Always Allow); no rebuild or relaunch is needed."
    }
}
