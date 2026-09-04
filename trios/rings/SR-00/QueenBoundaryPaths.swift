import Foundation

/// Reduces the paths a worker names to the form `ownedPaths` are written in,
/// and answers which of them fall outside the boundary.
///
/// This lived inside `QueenObserver`, where it could not be tested: the
/// observer takes a transcript, a transcript is made of `ChatMessage`, and
/// `ChatMessage` reaches `AgentTask` and onward through most of the app. So a
/// suite asserting one fact about one string had to link half the tree, and
/// the suite was therefore never written. What survived in the gap:
///
/// A worker does not run in the project directory. It runs in its own git
/// worktree, so the path it puts in a tool call is
///
///     <root>/.worktrees/<variant>/<task>/<project>/rings/SR-00/Thing.swift
///
/// while an owned path is project-relative: `rings/SR-00/Thing.swift`.
/// Removing only `<root>` leaves `.worktrees/<variant>/<task>/<project>/…`,
/// which neither equals an owned path nor is prefixed by one - so the
/// containment test failed for EVERY write, and the Queen was told "it wrote
/// outside the paths it was given" about work entirely inside the boundary.
///
/// Measured on #1286 (2026-08-23): the task sat at the send-back ceiling
/// carrying exactly that intervention, while its one commit touched exactly
/// the one file in its `ownedPaths`. The bee was right; the comparison was not.
///
/// Foundation and nothing else, deliberately. The rule is worth testing, so
/// it must be reachable by a suite that links one file.
public enum QueenBoundaryPaths {
    /// Trims whitespace and leading `./` and `/` so two spellings of one path
    /// compare equal.
    ///
    /// `QueenDelegationPolicy.normalizePath` forwards here rather than keeping
    /// a second copy: a rule transcribed twice is two rules that agree until
    /// someone edits one.
    public static func normalize(_ path: String) -> String {
        var value = path.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasPrefix("./") { value.removeFirst(2) }
        while value.hasPrefix("/") { value.removeFirst() }
        return value
    }

    /// Reduces a path a worker named to one comparable with `ownedPaths`.
    ///
    /// Three reductions in order: the absolute root, the worktree it was
    /// working in, and the project directory inside the repository. Each is
    /// separately testable below.
    ///
    /// Known and accepted limit: a bee that writes the same project-relative
    /// file inside a DIFFERENT bee's worktree is no longer distinguishable
    /// from writing its own. Catching that needs the task's own worktree
    /// passed in. Reporting every correct write as a violation was the worse
    /// of the two, and it is what was happening.
    public static func projectRelative(_ path: String, root: String) -> String {
        guard !root.isEmpty else { return path }
        let prefix = root.hasSuffix("/") ? root : root + "/"
        var value = path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : path
        value = strippingWorktree(value)
        value = strippingProject(value, root: root)
        return value
    }

    /// Drops `.worktrees/<variant>/<task>/` when it opens the path.
    ///
    /// Exactly three components, and only in first position. A path that
    /// merely contains `.worktrees` further down names a different file and
    /// keeps its name.
    public static func strippingWorktree(_ path: String) -> String {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count > 3, parts[0] == ".worktrees" else { return path }
        return parts.dropFirst(3).joined(separator: "/")
    }

    /// Drops the project directory when a path is relative to the REPOSITORY.
    ///
    /// The project is a subdirectory of the repository in this checkout, so a
    /// worktree's copy of it is `<worktree>/trios/…` and git reports paths as
    /// `trios/…`. An owned path never carries that component.
    public static func strippingProject(_ path: String, root: String) -> String {
        let project = (root as NSString).lastPathComponent
        guard !project.isEmpty, path.hasPrefix("\(project)/") else { return path }
        return String(path.dropFirst(project.count + 1))
    }

    /// The paths among `writes` that fall outside `ownedPaths`.
    ///
    /// An empty boundary means nothing can be outside it - a task with no
    /// declared paths is not a task that owns everything.
    ///
    /// Both halves are reduced by the SAME rule before they are compared,
    /// because both arrive in more than one spelling. Git reports a write from
    /// the repository root - `trios/docs/x.md` - while an issue boundary is
    /// written by a human, who may spell the same path either
    /// repository-relative (`trios/docs/x.md`) or project-relative
    /// (`docs/x.md`), and this issue itself (#1306) declares its boundary in
    /// the repository-relative spelling. Reducing only the write measured one
    /// spelling against the other and reported a bee that had committed
    /// exactly the file it was given. `projectRelative` is the reduction both
    /// sides go through, so a leading project component comes off each and an
    /// interior directory named like the project stays significant on both.
    public static func strays(
        among writes: [String],
        ownedPaths: [String],
        root: String
    ) -> [String] {
        guard !ownedPaths.isEmpty else { return [] }
        let owned = ownedPaths.map { normalize(projectRelative($0, root: root)) }
        var found: Set<String> = []
        for path in writes {
            let candidate = normalize(projectRelative(path, root: root))
            // A write is inside when its own boundary contains it, which is not
            // symmetric: owning `docs/live` does not license writing `docs`.
            let inside = owned.contains { candidate == $0 || candidate.hasPrefix("\($0)/") }
            if !inside { found.insert(candidate) }
        }
        return found.sorted()
    }
}
