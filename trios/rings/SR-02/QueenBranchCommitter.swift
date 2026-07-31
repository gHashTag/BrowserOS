import Foundation

/// Records a worker's edits on its own branch without disturbing the checkout.
///
/// A bee edits files in the shared working tree, so "which changes are mine"
/// cannot be answered by `git status` alone. The answer here is a pair of
/// snapshots: a tree written when the worker starts and another when it
/// finishes. Their diff is exactly what changed during the run.
///
/// Everything goes through a throwaway index (`GIT_INDEX_FILE`) and
/// `commit-tree` / `update-ref`, so HEAD, the real index and the user's working
/// tree are never touched. `git checkout -b` used to drag the entire repository
/// onto one bee's branch, which is the conflict the branch exists to prevent.
enum QueenBranchCommitter {
    struct Outcome {
        let committed: Bool
        let summary: String
        /// How many files landed. The Queen's auto-accept rule needs a count,
        /// not prose it would have to parse back out.
        var fileCount: Int = 0
    }

    /// Snapshots the working tree and returns the tree object id.
    ///
    /// Call before the worker starts. A nil result means the baseline could not
    /// be taken, and the commit step will then refuse rather than guess which
    /// edits belong to the worker.
    /// The project the worker edits. A parameter rather than a constant so the
    /// plumbing can be exercised against a scratch repository - a committer that
    /// can only be tested by pointing it at the real checkout is a committer
    /// nobody tests.
    static func snapshotWorkingTree(projectRoot: String = ProjectPaths.root) async -> String? {
        await Task.detached(priority: .utility) {
            let index = temporaryIndexPath()
            defer { try? FileManager.default.removeItem(atPath: index) }
            // `add -A` against an empty temporary index stages the whole tree
            // as it is right now, including files the user has not committed.
            guard runGit(["add", "-A"], index: index, projectRoot: projectRoot) != nil else {
                return nil
            }
            let tree = runGit(["write-tree"], index: index, projectRoot: projectRoot)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard let tree, !tree.isEmpty else { return nil }
            return tree
        }.value
    }

    /// The `owner/name` of the checkout the branch actually lives in.
    ///
    /// Not the issue's repository, and the difference is not cosmetic. The
    /// issues for this work live in gHashTag/trios while the code and every
    /// worker branch live in gHashTag/BrowserOS, so asking GitHub to open a
    /// pull request in the issue's repository from a branch that repository has
    /// never seen fails, silently, one step from the end of the cycle. A pull
    /// request belongs where its commits are; the issue stays as a link in the
    /// body.
    static func originRepository(projectRoot: String = ProjectPaths.root) -> String? {
        let url = QueenStatusViewModel.runProcess(
            "/usr/bin/git",
            arguments: ["remote", "get-url", "origin"],
            workDir: projectRoot,
            timeout: 10
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else { return nil }
        // git@github.com:owner/name.git or https://github.com/owner/name.git
        guard let range = url.range(of: "github.com") else { return nil }
        var tail = String(url[range.upperBound...])
        if tail.hasPrefix(":") || tail.hasPrefix("/") { tail.removeFirst() }
        if tail.hasSuffix(".git") { tail.removeLast(4) }
        let parts = tail.split(separator: "/").map(String.init)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        return "\(parts[0])/\(parts[1])"
    }

    /// The branch a pull request should land on: the remote's default.
    ///
    /// A worker's branch is cut from HEAD. Opening a PR against whatever the
    /// checkout happens to be on targets the wrong base — or, worse, the
    /// branch itself, producing a pull request that can never merge. The
    /// right base is the branch the forge considers the trunk: whatever
    /// `origin/HEAD` points at.
    ///
    /// Returns nil when the default branch cannot be determined — no remote
    /// configured, no HEAD symbolic-ref set, or a bare name git refuses to
    /// resolve. The caller must treat nil as "do not open a PR": silently
    /// guessing the wrong base is worse than not opening one.
    static func baseBranch(projectRoot: String = ProjectPaths.root) -> String? {
        let ref = QueenStatusViewModel.runProcess(
            "/usr/bin/git",
            arguments: ["symbolic-ref", "refs/remotes/origin/HEAD"],
            workDir: projectRoot,
            timeout: 10
        ).trimmingCharacters(in: .whitespacesAndNewlines)

        // `git symbolic-ref` prints something like
        // `refs/remotes/origin/main`. Strip the prefix; what remains is the
        // branch name the PR's `base` field needs.
        guard ref.hasPrefix("refs/remotes/origin/") else { return nil }
        let branch = String(ref.dropFirst("refs/remotes/origin/".count))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return branch.isEmpty ? nil : branch
    }

    /// Publishes a worker's branch so a pull request can be opened from it.
    ///
    /// The commit path deliberately never touched the network, and the pull
    /// request path assumed the branch was already there. Between them, nothing
    /// pushed: the bee's work sat on a local branch, GitHub was asked to open a
    /// pull request from a ref it had never seen, and the whole cycle stopped
    /// one step short of the thing it exists for.
    ///
    /// Returns nil on success, or git's own complaint. `--force-with-lease`
    /// rather than `--force`: re-running a review should update the branch, but
    /// not over the top of something that arrived while we were not looking.
    static func pushBranch(
        _ branch: String,
        projectRoot: String = ProjectPaths.root
    ) async -> String? {
        await Task.detached(priority: .utility) {
            let index = temporaryIndexPath()
            defer { try? FileManager.default.removeItem(atPath: index) }
            let output = runGit(
                ["push", "--force-with-lease", "-u", "origin", "\(branch):\(branch)"],
                index: index, projectRoot: projectRoot
            )
            guard output != nil else {
                return "git push failed for \(branch)"
            }
            return nil
        }.value
    }

    /// Which repository-relative paths differ from `baselineTree` right now.
    ///
    /// The observer decides whether a worker wrote outside its lane by reading
    /// the names of the tools it called, which cannot see a write made with
    /// `echo >` or `sed -i` through the shell: filesystem_bash is neither
    /// write-named nor path-argumented. Names are guesses about what happened;
    /// this is what happened.
    ///
    /// Deliberately not called from observeWorker, which runs on every SSE
    /// delta - a git invocation per token would cost more than the warning is
    /// worth. It belongs where a turn ends.
    static func changedPaths(
        since baselineTree: String?,
        projectRoot: String = ProjectPaths.root
    ) async -> [String] {
        guard let baselineTree else { return [] }
        return await Task.detached(priority: .utility) {
            let index = temporaryIndexPath()
            defer { try? FileManager.default.removeItem(atPath: index) }
            guard runGit(["add", "-A"], index: index, projectRoot: projectRoot) != nil,
                  let endTree = runGit(["write-tree"], index: index, projectRoot: projectRoot)?
                      .trimmingCharacters(in: .whitespacesAndNewlines),
                  !endTree.isEmpty else { return [] }
            let diff = runGit(
                ["diff", "--name-only", baselineTree, endTree],
                index: index, projectRoot: projectRoot
            ) ?? ""
            return diff
                .split(separator: "\n")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                // The Queen writes her own state (.trinity/state/*,
                // .trinity-dev/state/*) between the two snapshots as
                // bookkeeping — registry, verdicts, task tracking. Those
                // are not the worker's edits, but a git diff cannot tell
                // them apart from one: both are just "a path that changed
                // while the worker ran." Without this filter they surface
                // as boundary violations and false evidence, accusing the
                // worker of writing files it never touched.
                //
                // Narrow on purpose: only the state subdirectory, not the
                // whole .trinity tree. Specs and wave logs under .trinity
                // are real work product that a boundary check must still see.
                .filter { path in
                    let normalized = QueenDelegationPolicy.normalizePath(path)
                    return !normalized.contains(".trinity/state/")
                        && !normalized.contains(".trinity-dev/state/")
                }
        }.value
    }

    /// Commits the paths that changed since `baselineTree` onto `branch`.
    static func commitWorkerChanges(
        branch: String,
        baselineTree: String?,
        message: String,
        ownedPaths: [String],
        projectRoot: String = ProjectPaths.root
    ) async -> Outcome {
        guard let baselineTree else {
            return Outcome(
                committed: false,
                summary: "No baseline snapshot was taken, so nothing was committed to `\(branch)`."
            )
        }
        return await Task.detached(priority: .utility) {
            let index = temporaryIndexPath()
            defer { try? FileManager.default.removeItem(atPath: index) }

            guard runGit(["add", "-A"], index: index, projectRoot: projectRoot) != nil,
                  let endTree = runGit(["write-tree"], index: index, projectRoot: projectRoot)?
                      .trimmingCharacters(in: .whitespacesAndNewlines),
                  !endTree.isEmpty else {
                return Outcome(committed: false, summary: "Could not snapshot the working tree.")
            }

            let diff = runGit(
                ["diff", "--name-only", baselineTree, endTree],
                index: index, projectRoot: projectRoot
            ) ?? ""
            var changed = diff
                .split(separator: "\n")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }

            // An explicit boundary wins over the diff: files the worker was not
            // allowed to touch must not ride along on its branch even if
            // something else changed them while it ran.
            if !ownedPaths.isEmpty {
                let owned = ownedPaths.map { repositoryRelative($0, projectRoot: projectRoot) }
                changed = changed.filter { path in
                    let normalized = QueenDelegationPolicy.normalizePath(path)
                    return owned.contains { normalized == $0 || normalized.hasPrefix("\($0)/") }
                }
            }
            guard !changed.isEmpty else {
                return Outcome(committed: false, summary: "The worker changed no files, so `\(branch)` is unchanged.")
            }

            // Build the commit's tree from the branch tip plus only those paths,
            // so concurrent edits by other workers do not leak onto this branch.
            let branchRef = "refs/heads/\(branch)"
            guard let parent = runGit(["rev-parse", branchRef], index: index, projectRoot: projectRoot)?
                .trimmingCharacters(in: .whitespacesAndNewlines), !parent.isEmpty else {
                return Outcome(committed: false, summary: "Branch `\(branch)` does not exist.")
            }
            guard runGit(["read-tree", parent], index: index, projectRoot: projectRoot) != nil else {
                return Outcome(committed: false, summary: "Could not read `\(branch)` into a scratch index.")
            }
            guard runGit(["add", "--"] + changed, index: index, projectRoot: projectRoot) != nil,
                  let tree = runGit(["write-tree"], index: index, projectRoot: projectRoot)?
                      .trimmingCharacters(in: .whitespacesAndNewlines),
                  !tree.isEmpty else {
                return Outcome(committed: false, summary: "Could not stage the worker's files.")
            }
            guard let commit = runGit(
                ["commit-tree", tree, "-p", parent, "-m", message],
                index: index, projectRoot: projectRoot
            )?.trimmingCharacters(in: .whitespacesAndNewlines), !commit.isEmpty else {
                return Outcome(committed: false, summary: "Could not write the commit object.")
            }
            guard runGit(["update-ref", branchRef, commit], index: index, projectRoot: projectRoot) != nil else {
                return Outcome(committed: false, summary: "Could not move `\(branch)` to the new commit.")
            }

            let names = changed.prefix(5).joined(separator: ", ")
            let extra = changed.count > 5 ? " (+\(changed.count - 5) more)" : ""
            return Outcome(
                committed: true,
                summary: "Committed \(changed.count) file(s) to `\(branch)`: \(names)\(extra).",
                fileCount: changed.count
            )
        }.value
    }

    // MARK: - Plumbing

    private static func temporaryIndexPath() -> String {
        NSTemporaryDirectory() + "queen-index-\(UUID().uuidString)"
    }

    /// The repository root, which is not necessarily the project directory:
    /// trios lives inside the BrowserOS checkout, so every path git reports is
    /// prefixed with `trios/`. Running the plumbing anywhere else made
    /// `git diff --name-only` and the caller's owned paths disagree, and the
    /// worker's file was filtered out of its own commit.
    static func repositoryRoot(projectRoot: String = ProjectPaths.root) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["rev-parse", "--show-toplevel"]
        process.currentDirectoryURL = URL(fileURLWithPath: projectRoot)
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        guard (try? process.run()) != nil else { return projectRoot }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let output = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return output.isEmpty ? projectRoot : output
    }

    /// Rewrites a project-relative path (`docs`) into a repository-relative one
    /// (`trios/docs`), which is the only form git will agree with.
    static func repositoryRelative(
        _ path: String,
        projectRoot: String = ProjectPaths.root
    ) -> String {
        let root = repositoryRoot(projectRoot: projectRoot)
        let project = projectRoot
        guard project.hasPrefix(root), project != root else {
            return QueenDelegationPolicy.normalizePath(path)
        }
        let prefix = QueenDelegationPolicy.normalizePath(String(project.dropFirst(root.count)))
        let normalized = QueenDelegationPolicy.normalizePath(path)
        return prefix.isEmpty ? normalized : "\(prefix)/\(normalized)"
    }

    /// The inverse of `repositoryRelative`: git reports `trios/docs/x.md` and a
    /// boundary is written as `docs`, so a measured path has to come back down
    /// to the project before it can be compared with one.
    ///
    /// A path outside the project entirely keeps its repository-relative form.
    /// It is out of bounds under any boundary, and rewriting it would only
    /// disguise where it is.
    static func projectRelative(
        _ path: String,
        projectRoot: String = ProjectPaths.root
    ) -> String {
        let root = repositoryRoot(projectRoot: projectRoot)
        let normalized = QueenDelegationPolicy.normalizePath(path)
        guard projectRoot.hasPrefix(root), projectRoot != root else { return normalized }
        let prefix = QueenDelegationPolicy.normalizePath(String(projectRoot.dropFirst(root.count)))
        guard !prefix.isEmpty, normalized.hasPrefix("\(prefix)/") else { return normalized }
        return String(normalized.dropFirst(prefix.count + 1))
    }

    /// Returns nil on a non-zero exit so each step can refuse to continue.
    private static func runGit(
        _ arguments: [String],
        index: String,
        projectRoot: String = ProjectPaths.root
    ) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: repositoryRoot(projectRoot: projectRoot))
        var environment = ProcessInfo.processInfo.environment
        environment["GIT_INDEX_FILE"] = index
        process.environment = environment

        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()
        do {
            try process.run()
        } catch {
            return nil
        }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return String(data: data, encoding: .utf8) ?? ""
    }
}
