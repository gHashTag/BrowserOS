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
