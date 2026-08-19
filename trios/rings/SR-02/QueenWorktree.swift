import Foundation

/// A private checkout for one worker.
///
/// Until this existed every bee edited the same working tree as the user, the
/// build, and each other. The variant split (#1276) stopped the harness from
/// deleting the Queen's *state*; it did nothing about *sources*, and the moment
/// the Queen started picking up work unprompted the collision became routine:
/// `make check` failed with `cannot find 'result' in scope` on a snapshot of a
/// file bee #1128 was halfway through writing. Seconds later the same file
/// compiled. Nothing was wrong with the code and nothing was wrong with the
/// gate - they were reading and writing the same bytes.
///
/// A worktree is the smallest thing that fixes it. Each bee gets its own
/// directory backed by the same object store, so its branch and its edits live
/// together and neither is visible to anyone else until it commits.
enum QueenWorktree {
    /// Where a task's checkout lives. Under `.worktrees/`, which is already
    /// git-ignored, and named after the issue so an abandoned one says what it
    /// belonged to.
    ///
    /// Scoped by variant for the same reason the data root is (#1276): the
    /// cassette harness dispatches real delegations, so it makes worktrees too.
    /// Sharing one directory put the harness's checkouts and the working
    /// Queen's in the same place, where the cassette suite's branch sweep -
    /// which deletes what it created - would have met a branch checked out by a
    /// live bee. It could not delete it, said so, and went red; had it been
    /// able to, it would have taken a working checkout with it.
    static func path(forIssue number: Int, projectRoot: String, variant: String) -> String {
        "\(projectRoot)/.worktrees/\(variant)/queen-\(number)"
    }

    /// The directory holding one variant's checkouts, safe to clear wholesale.
    static func directory(projectRoot: String, variant: String) -> String {
        "\(projectRoot)/.worktrees/\(variant)"
    }

    /// Why an existing branch must not be reused, or nil if it may be.
    ///
    /// `createVirtualBranch` treats "the branch already exists" as success, so
    /// that reconnecting to a task in flight does not fail. That is right for a
    /// task being resumed and wrong for a leftover: `queen/1127` was still on
    /// disk from a run 140 commits earlier, was silently adopted, and the diff
    /// between it and the current tip read as 641 insertions against 12,508
    /// deletions - the whole Makefile, the night log, every fixture. The bee's
    /// own change was 34 lines inside its boundary. Nothing was destroyed
    /// because a diff is not a merge, but `QueenBranchCommitter` assembles the
    /// combined tree by OVERLAY, and an overlay onto a base that old drops
    /// everything newer.
    ///
    /// Pure so the decision can be driven without a repository. `mergeBase` is
    /// the merge-base of the branch and HEAD; `head` is HEAD. They are equal
    /// exactly when the branch already contains everything HEAD does.
    /// Where a worker should actually stand inside its worktree.
    ///
    /// A worktree is a checkout of the *repository*, and this project is a
    /// directory inside it: the repository root is `BrowserOS`, the project is
    /// `BrowserOS/trios`. The worker was given the worktree root as its working
    /// directory, so a boundary written `docs/counter-negative.md` - which is
    /// project-relative, and correct in the no-worktree case where the working
    /// directory IS the project - resolved one level too high, and the bee
    /// created `<worktree>/docs/counter-negative.md`.
    ///
    /// It then did exactly what it was told and got nothing for it. The
    /// committer stages repository-relative paths, so it asked git for
    /// `trios/docs/counter-negative.md`, which does not exist in that worktree,
    /// staged nothing, and recorded "The worker changed no files" - the
    /// commonest real failure in the release registry, on tasks whose files
    /// were sitting right there, written correctly, one directory up.
    ///
    /// The invariant this restores: a worker's working directory is the project
    /// root, whichever checkout that project is in. Then a boundary means the
    /// same thing in both modes, and the committer's frame and the worker's
    /// frame are the same frame.
    static func workerDirectory(
        worktreePath: String,
        projectRoot: String,
        repositoryRoot: String
    ) -> String {
        let root = normalized(repositoryRoot)
        let project = normalized(projectRoot)
        // The project is the repository, or is not inside it at all: the
        // worktree root is already the right place to stand.
        guard project.hasPrefix(root + "/"), project != root else {
            return worktreePath
        }
        let prefix = String(project.dropFirst(root.count + 1))
        guard !prefix.isEmpty else { return worktreePath }
        return normalized(worktreePath) + "/" + prefix
    }

    private static func normalized(_ path: String) -> String {
        path.hasSuffix("/") ? String(path.dropLast()) : path
    }

    static func staleBranchReason(
        branchExists: Bool,
        mergeBase: String?,
        head: String?
    ) -> String? {
        guard branchExists else { return nil }
        guard let head, !head.isEmpty else {
            return "HEAD could not be resolved, so the branch's age is unknown"
        }
        guard let mergeBase, !mergeBase.isEmpty else {
            return "the branch shares no history with HEAD"
        }
        guard mergeBase != head else { return nil }
        return "the branch was cut before the current HEAD (\(String(head.prefix(8))))"
    }

    /// The name to use when the wanted one is taken by a stale branch.
    ///
    /// A suffix rather than a deletion. A leftover branch may hold the only
    /// copy of somebody's work, and this code has no way to know; the one
    /// thing it must not do is decide that for them.
    static func freshBranchName(base: String, attempt: Int) -> String {
        attempt <= 0 ? base : "\(base)-r\(attempt)"
    }

    /// Whether a path looks like a worktree this code created.
    ///
    /// Checked before removal, because `git worktree remove` takes a path and
    /// this code should never be one typo away from handing it the checkout the
    /// user is sitting in.
    static func isOwnedWorktree(path: String, projectRoot: String, variant: String) -> Bool {
        let prefix = "\(directory(projectRoot: projectRoot, variant: variant))/queen-"
        guard path.hasPrefix(prefix) else { return false }
        let suffix = String(path.dropFirst(prefix.count))
        return !suffix.isEmpty && suffix.allSatisfy(\.isNumber)
    }
}
