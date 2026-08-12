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

    /// A fingerprint of only the files inside the task boundary, so the
    /// Queen's own state writes cannot age a verdict (#1131).
    ///
    /// `snapshotWorkingTree` hashes the entire tree. When the Queen writes
    /// `.trinity/state/*` between verdict recording and acceptance, that hash
    /// changes — even though the code under review has not. Every checked
    /// verdict then reads `.stale` because the fingerprints differ, and the
    /// acceptance gate blocks on code that did not move.
    ///
    /// The boundary-scoped fingerprint builds a tree from only `ownedPaths`:
    /// it stages the whole working tree, lists every blob, keeps only those
    /// whose path falls inside the boundary, and writes a second tree from
    /// just those entries. Two such trees have the same SHA iff the boundary
    /// files have not changed — regardless of what the Queen or another bee
    /// wrote elsewhere.
    ///
    /// Returns nil when `ownedPaths` is empty (there is no boundary to
    /// fingerprint) or when git fails to stage or write the tree. The caller
    /// treats nil as "no fingerprint," which the acceptance policy reads as
    /// "missing, not stale" (#1131).
    static func fingerprintBoundary(
        ownedPaths: [String],
        projectRoot: String = ProjectPaths.root
    ) async -> String? {
        guard !ownedPaths.isEmpty else { return nil }
        return await Task.detached(priority: .utility) {
            let index = temporaryIndexPath()
            defer { try? FileManager.default.removeItem(atPath: index) }

            // Stage the entire working tree to capture the current state of
            // every file, then write it to a tree object we can inspect.
            guard runGit(["add", "-A"], index: index, projectRoot: projectRoot) != nil,
                  let fullTree = runGit(
                      ["write-tree"], index: index, projectRoot: projectRoot
                  )?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !fullTree.isEmpty else { return nil }

            // List every blob in the full tree: "<mode> <type> <sha>\t<path>"
            let lsTree = runGit(
                ["ls-tree", "-r", "--full-tree", fullTree],
                index: index, projectRoot: projectRoot
            ) ?? ""

            // Keep only blobs whose path falls inside the task's boundary.
            let repoOwned = ownedPaths.map {
                repositoryRelative($0, projectRoot: projectRoot)
            }
            let boundaryEntries = lsTree
                .split(separator: "\n")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .filter { entry in
                    guard let tabRange = entry.range(of: "\t") else { return false }
                    let path = String(entry[tabRange.upperBound...])
                    let normalized = QueenDelegationPolicy.normalizePath(path)
                    return repoOwned.contains {
                        normalized == $0 || normalized.hasPrefix("\($0)/")
                    }
                }

            guard !boundaryEntries.isEmpty else {
                // No boundary files exist in the tree. The empty tree SHA is
                // deterministic (4b825…), so two calls that both find nothing
                // will match — a file appearing later will change the hash.
                return "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
            }

            // Build a fresh index containing only the boundary entries, then
            // write a tree from it. This tree's SHA depends only on the
            // boundary files' content and structure — everything else is
            // invisible.
            //
            // `--add` is required: `update-index --cacheinfo` alone refuses
            // to insert a path that does not already exist in the index
            // ("cannot add to the index - missing --add option?"). The
            // boundary index starts empty, so every entry is a first
            // insertion. Without `--add`, the command fails silently (its
            // exit code is non-zero, but the return value was ignored) and
            // `write-tree` produces the empty-tree SHA — a constant that
            // never changes regardless of boundary content (#1131).
            let boundaryIndex = temporaryIndexPath()
            defer { try? FileManager.default.removeItem(atPath: boundaryIndex) }
            for entry in boundaryEntries {
                guard let tabRange = entry.range(of: "\t") else { continue }
                let meta = String(entry[entry.startIndex..<tabRange.lowerBound])
                let path = String(entry[tabRange.upperBound...])
                let metaParts = meta.split(separator: " ")
                guard metaParts.count >= 3 else { continue }
                let mode = String(metaParts[0])
                let sha = String(metaParts[2])
                _ = runGit(
                    ["update-index", "--add", "--cacheinfo", "\(mode),\(sha),\(path)"],
                    index: boundaryIndex, projectRoot: projectRoot
                )
            }
            let tree = runGit(
                ["write-tree"], index: boundaryIndex, projectRoot: projectRoot
            )?.trimmingCharacters(in: .whitespacesAndNewlines)
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

    /// The branch a pull request should land on: the branch the main
    /// checkout is currently on (#1142).
    ///
    /// A worker's worktree is cut from `origin/<targetBranch>`, where
    /// `targetBranch` is whatever branch the main checkout is on. The PR
    /// base must be that same branch so the diff shows only the worker's
    /// commits — not the full distance between `dev` and `feat/queen-supervisor`
    /// (2017 files in #1142).
    ///
    /// Using `origin/HEAD` (the remote default) is wrong: the default may be
    /// `dev` while the actual target is `feat/queen-supervisor`, and the PR
    /// diff then spans the entire gap between them. The checkout's branch is
    /// the branch the work was built on top of, and that is the only correct
    /// base.
    ///
    /// Returns nil when HEAD is detached (`git rev-parse` prints literal
    /// `HEAD`) or git cannot resolve the branch name. The caller must treat
    /// nil as "do not open a PR": silently guessing the wrong base is worse
    /// than not opening one.
    static func baseBranch(projectRoot: String = ProjectPaths.root) -> String? {
        let branch = QueenStatusViewModel.runProcess(
            "/usr/bin/git",
            arguments: ["rev-parse", "--abbrev-ref", "HEAD"],
            workDir: projectRoot,
            timeout: 10
        ).trimmingCharacters(in: .whitespacesAndNewlines)

        // `git rev-parse --abbrev-ref HEAD` prints the branch name (e.g.
        // `feat/queen-supervisor`) or the literal `HEAD` when detached.
        // `HEAD` is not a valid PR base, so treat it as nil.
        guard !branch.isEmpty, branch != "HEAD" else { return nil }
        return branch
    }

    /// The commit a worker's branch was cut from (#1135).
    ///
    /// **Superseded by the worktree workflow (#1142).** When a bee works in
    /// a worktree cut from `origin/<targetBranch>`, the branch point is
    /// simply the tip of `origin/<targetBranch>` — no merge-base computation
    /// is needed. Callers should use `prBaseBranch(targetBranch:)` instead.
    ///
    /// Returns nil when the branch does not exist, HEAD cannot be
    /// resolved, the merge-base fails, or the branch carries no commits
    /// of its own yet (merge-base == tip).
    static func branchPoint(
        of beeBranch: String,
        projectRoot: String = ProjectPaths.root
    ) -> String? {
        let root = repositoryRoot(projectRoot: projectRoot)
        let beeRef = "refs/heads/\(beeBranch)"

        // Verify the branch exists and get its tip.
        let tip = QueenStatusViewModel.runProcess(
            "/usr/bin/git",
            arguments: ["rev-parse", "--verify", beeRef],
            workDir: root,
            timeout: 10
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !tip.isEmpty, !tip.contains("fatal:") else { return nil }

        // The merge-base of the bee's branch and HEAD is the commit the
        // branch was created from.
        let base = QueenStatusViewModel.runProcess(
            "/usr/bin/git",
            arguments: ["merge-base", beeRef, "HEAD"],
            workDir: root,
            timeout: 10
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !base.isEmpty, !base.contains("fatal:") else { return nil }

        // If the merge-base is the tip, the branch has no commits of its
        // own — nothing to open a PR for.
        guard base != tip else { return nil }

        return base
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
        // Race the push against a deadline.  Without it, a process stuck
        // waiting on a network hiccup or a half-open socket keeps the whole
        // pull-request step hostage; the 90 s ceiling is generous for any
        // real push and merciless for one that has stalled.
        await withTaskGroup(of: String?.self) { group in
            group.addTask(priority: .utility) {
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
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: 90_000_000_000)
                return "git push for \(branch) did not finish within 90 seconds"
            }
            let result = await group.next() ?? "git push for \(branch) did not finish within 90 seconds"
            group.cancelAll()
            return result
        }
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
    ///
    /// When `ownedPaths` is non-empty, only paths inside the worker's lane are
    /// returned. Two bees share one working tree, so a diff between the baseline
    /// and end trees picks up every write — including another bee's. Without
    /// this filter a bee that stayed inside its boundary is charged with the
    /// other bee's work and flagged out-of-bounds for files it never touched.
    /// The diff cannot tell one bee's write from another's; the lane is the
    /// only signal available. A genuine out-of-bounds write by this bee is
    /// still caught: `observeWorker` flags tool-based writes during the turn,
    /// and `commitWorkerChanges` refuses to carry files outside the boundary
    /// onto the branch.
    static func changedPaths(
        since baselineTree: String?,
        projectRoot: String = ProjectPaths.root,
        ownedPaths: [String] = []
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
            var paths = diff
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

            // When the worker's lane is known, keep only paths inside it so
            // that a second bee writing elsewhere in the shared tree does not
            // appear on this bee's report. The diff cannot tell one bee's
            // write from another's; the lane is the only signal available.
            // The same logic `commitWorkerChanges` uses to decide what lands
            // on the branch.
            if !ownedPaths.isEmpty {
                let owned = ownedPaths.map { repositoryRelative($0, projectRoot: projectRoot) }
                paths = paths.filter { path in
                    let normalized = QueenDelegationPolicy.normalizePath(path)
                    return owned.contains { normalized == $0 || normalized.hasPrefix("\($0)/") }
                }
            }

            return paths
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

    // MARK: - Worktree-based workflow (#1142)

    /// The filesystem location and git identity of a single bee's worktree.
    ///
    /// A worktree gives each bee its own isolated working tree, cut from the
    /// origin of the real target branch. Two bees no longer share one
    /// checkout, so the second bee cannot silently overwrite the first's
    /// files (#1139), and the bee's branch starts at the tip of the real
    /// branch — no synthetic `-base` branch is needed (#1141).
    struct WorktreeHandle {
        /// Absolute filesystem path to the worktree directory.
        let path: String
        /// The branch the bee commits to (e.g. `queen/1142-slug`).
        let branch: String
        /// The real project branch the PR should target (e.g. `dev`,
        /// `feat/queen-supervisor`). This is the PR `base`, not a snapshot.
        let targetBranch: String
    }

    /// Creates a dedicated git worktree for one bee, cut from the origin of
    /// the real target branch.
    ///
    /// The worktree lives outside the shared checkout (under the system temp
    /// directory) and outside `/Users/playra/trios-land`. It is removed by
    /// `removeWorktree` after the branch is pushed.
    ///
    /// The bee's branch starts exactly at `origin/<targetBranch>`, so:
    /// - The PR diff shows only the bee's work.
    /// - No `-base` branch is needed (#1141).
    /// - The PR `base` is the real target branch, not a snapshot.
    ///
    /// Returns nil when fetch or worktree creation fails. The caller must
    /// treat nil as "cannot isolate this bee — abort the task."
    static func prepareWorktree(
        for beeBranch: String,
        from targetBranch: String,
        projectRoot: String = ProjectPaths.root
    ) async -> WorktreeHandle? {
        await Task.detached(priority: .utility) {
            let root = repositoryRoot(projectRoot: projectRoot)

            // Bring the latest state of the target branch from origin so the
            // worktree starts at the real tip, not a stale remote-tracking ref.
            let (fetchOk, _) = runGitInDir(
                ["fetch", "origin", targetBranch],
                workDir: root
            )
            guard fetchOk else { return nil }

            // Worktree directory: under the system temp, never under the
            // shared checkout or /Users/playra/trios-land.
            let safeName = beeBranch.replacingOccurrences(of: "/", with: "-")
            let worktreePath = NSTemporaryDirectory()
                + "queen-worktrees/\(safeName)"

            // Remove a stale worktree from a previous run if one exists.
            _ = runGitInDir(
                ["worktree", "remove", "--force", worktreePath],
                workDir: root
            )

            // Create a new worktree on the bee's branch, starting from the
            // fetched origin ref. `-b` creates the local branch at
            // `origin/<targetBranch>`, so the bee's branch grows only on
            // top of the real target branch's tip.
            let (addOk, addErr) = runGitInDir(
                ["worktree", "add", "-b", beeBranch, worktreePath,
                 "origin/\(targetBranch)"],
                workDir: root
            )
            guard addOk else {
                TriosLogBus.shared.error(
                    .queen, "queen.worktree.addFailed",
                    "Could not create worktree for \(beeBranch)",
                    ["error": addErr, "targetBranch": targetBranch]
                )
                return nil
            }

            return WorktreeHandle(
                path: worktreePath,
                branch: beeBranch,
                targetBranch: targetBranch
            )
        }.value
    }

    /// Stages and commits the bee's changes inside its worktree.
    ///
    /// Unlike `commitWorkerChanges` — which snapshots the shared tree, diffs
    /// against a baseline, and uses a throwaway index with `commit-tree` —
    /// this method operates directly inside the worktree. The worktree IS
    /// the bee's own tree, so `git add` + `git commit` are all that is
    /// needed. No baseline snapshot, no temp index, no filtering of other
    /// bees' writes: they are invisible because they live in a different
    /// tree entirely.
    ///
    /// `ownedPaths` are staged explicitly so files the bee was not allowed
    /// to touch cannot ride along, even if they exist in the worktree.
    /// When `ownedPaths` is empty, all changes are staged.
    static func commitInWorktree(
        worktreePath: String,
        message: String,
        ownedPaths: [String],
        projectRoot: String = ProjectPaths.root
    ) async -> Outcome {
        // The worktree isolation invariant (#1142 criterion 7): if the path
        // is the main checkout (`.git` is a directory, not a file), refuse.
        // A bee that works in the shared tree can overwrite another bee's
        // files (#1139) and its commits ride on top of the human's work
        // instead of the target branch. `isWorktree` returns false for the
        // main checkout, and this guard turns that into a hard stop rather
        // than a silent corruption.
        guard isWorktree(worktreePath) else {
            return Outcome(
                committed: false,
                summary: "Refused to commit in the shared checkout at `\(worktreePath)`. "
                    + "A bee must work in its own worktree (#1142)."
            )
        }
        return await Task.detached(priority: .utility) {
            // Convert project-relative owned paths to repository-relative
            // paths. The worktree is a full checkout, so the paths match
            // the main repo's structure.
            let addArgs: [String]
            if ownedPaths.isEmpty {
                addArgs = ["add", "-A"]
            } else {
                addArgs = ["add", "--"] + ownedPaths.map {
                    repositoryRelative($0, projectRoot: projectRoot)
                }
            }

            let (addOk, addErr) = runGitInDir(
                addArgs, workDir: worktreePath
            )
            guard addOk else {
                return Outcome(
                    committed: false,
                    summary: "Could not stage files in worktree: \(addErr)"
                )
            }

            // Count what was staged so the outcome can report it.
            let (diffOk, diffOut) = runGitInDir(
                ["diff", "--cached", "--name-only"],
                workDir: worktreePath
            )
            let stagedCount = diffOk
                ? diffOut.split(separator: "\n")
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }.count
                : 0

            guard stagedCount > 0 else {
                return Outcome(
                    committed: false,
                    summary: "The worker changed no files in the worktree."
                )
            }

            let (commitOk, commitErr) = runGitInDir(
                ["commit", "-m", message],
                workDir: worktreePath
            )
            guard commitOk else {
                return Outcome(
                    committed: false,
                    summary: "Could not commit in worktree: \(commitErr)"
                )
            }

            return Outcome(
                committed: true,
                summary: "Committed \(stagedCount) file(s) in worktree `\(worktreePath)`.",
                fileCount: stagedCount
            )
        }.value
    }

    /// Pushes the bee's branch from its worktree to origin.
    ///
    /// Returns nil on success, or git's error message on failure.
    /// `--force-with-lease` rather than `--force`: re-running a review
    /// should update the branch, but not over something that arrived while
    /// we were not looking.
    static func pushFromWorktree(
        worktreePath: String,
        branch: String
    ) async -> String? {
        await Task.detached(priority: .utility) {
            let (ok, err) = runGitInDir(
                ["push", "--force-with-lease", "-u", "origin",
                 "\(branch):\(branch)"],
                workDir: worktreePath
            )
            return ok ? nil : "git push failed for \(branch): \(err)"
        }.value
    }

    /// Removes a worktree after the branch has been pushed.
    ///
    /// `git worktree list` does not grow: every prepare/remove pair is
    /// balanced. `--force` is used so uncommitted changes in the worktree
    /// do not block removal (the bee's work is already on the branch).
    ///
    /// Returns nil on success, or git's error message on failure.
    static func removeWorktree(
        _ worktreePath: String,
        projectRoot: String = ProjectPaths.root
    ) async -> String? {
        await Task.detached(priority: .utility) {
            let root = repositoryRoot(projectRoot: projectRoot)
            let (ok, err) = runGitInDir(
                ["worktree", "remove", "--force", worktreePath],
                workDir: root
            )
            return ok ? nil : "git worktree remove failed: \(err)"
        }.value
    }

    /// The branch a PR should target when a bee works in a worktree: the
    /// real target branch, not a synthetic snapshot.
    ///
    /// When a bee works in a worktree cut from `origin/<targetBranch>`, the
    /// bee's commits sit directly on top of the target branch's tip. The PR
    /// `base` is therefore the target branch itself — no snapshot ref,
    /// no `-base` branch.
    static func prBaseBranch(targetBranch: String) -> String {
        targetBranch
    }

    /// Whether the given path still has a worktree registered with git.
    ///
    /// After `removeWorktree`, this must return false. If it returns true
    /// after removal, the worktree was not cleaned up and `git worktree list`
    /// has grown.
    static func worktreeExists(
        _ path: String,
        projectRoot: String = ProjectPaths.root
    ) -> Bool {
        let root = repositoryRoot(projectRoot: projectRoot)
        let (ok, output) = runGitInDir(
            ["worktree", "list", "--porcelain"],
            workDir: root
        )
        guard ok else { return false }
        return output.contains("worktree \(path)")
    }

    /// Verifies that a path is a linked worktree, not the main checkout.
    ///
    /// The main checkout has a `.git` directory; a linked worktree has a
    /// `.git` file that points back to the main repo. This is the cheapest
    /// signal that "this path is an isolated worktree, not the shared tree."
    ///
    /// Tests use this to prove that reverting to the shared tree breaks the
    /// isolation invariant (#1142 criterion 7): if the path is the main
    /// checkout, `isWorktree` returns false, and the commit path should
    /// refuse to proceed.
    static func isWorktree(_ path: String) -> Bool {
        let gitPath = "\(path)/.git"
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: gitPath, isDirectory: &isDir) else {
            return false
        }
        // Main checkout: `.git` is a directory → not a linked worktree.
        // Linked worktree: `.git` is a file containing `gitdir: …` → true.
        return !isDir.boolValue
    }

    // MARK: - Combined State Verification

    /// The outcome of asking whether the combined tree of several branches
    /// compiles.
    ///
    /// `builds` is the authoritative answer. `summary` carries enough of the
    /// compiler output to see *why* it failed without dumping a megabyte of
    /// build log. `combinedTreeSha` is the tree that was tested, for
    /// traceability; nil means the tree could not be assembled at all.
    struct CombinedBuildResult {
        let builds: Bool
        let summary: String
        var combinedTreeSha: String?
    }

    /// Builds a single tree that overlays every branch's edits onto a
    /// shared base ref.
    ///
    /// Each worker branches from the same checkout and stays inside its own
    /// files, so the combined tree is simply the base with each branch's
    /// changed paths overwritten by that branch's version. Two branches that
    /// touch the same path are a boundary violation the Queen prevents; if it
    /// happens anyway, the last branch in the array wins and the caller
    /// should investigate.
    ///
    /// Returns nil when the base ref or any branch cannot be resolved, or the
    /// tree cannot be written. The caller should treat nil as "do not accept —
    /// the combined state is unknown."
    static func combinedTree(
        branches: [String],
        baseRef: String,
        projectRoot: String = ProjectPaths.root
    ) async -> String? {
        guard !branches.isEmpty else { return nil }
        return await Task.detached(priority: .utility) {
            let index = temporaryIndexPath()
            defer { try? FileManager.default.removeItem(atPath: index) }

            // Start from the base tree so the combined index carries
            // everything no branch touched.
            guard runGit(["read-tree", baseRef],
                         index: index, projectRoot: projectRoot) != nil else {
                return nil
            }

            for branch in branches {
                let branchRef = "refs/heads/\(branch)"
                guard runGit(["rev-parse", "--verify", branchRef],
                             index: index, projectRoot: projectRoot) != nil else {
                    return nil
                }

                // Paths this branch changed relative to base.
                let diff = runGit(
                    ["diff", "--name-only", baseRef, branchRef],
                    index: index, projectRoot: projectRoot
                ) ?? ""
                let changed = diff
                    .split(separator: "\n")
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }

                // Overlay each changed path from the branch tip onto the
                // combined index. `ls-tree` gives mode and SHA;
                // `update-index --cacheinfo` stages them without touching
                // the working tree. A path absent from the branch was
                // deleted there, so it is removed from the index.
                for path in changed {
                    let entry = runGit(
                        ["ls-tree", branchRef, "--", path],
                        index: index, projectRoot: projectRoot
                    )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    if entry.isEmpty {
                        _ = runGit(["update-index", "--remove", "--", path],
                                   index: index, projectRoot: projectRoot)
                        continue
                    }
                    // Format: "<mode> <type> <sha>\t<path>"
                    guard let tabRange = entry.range(of: "\t") else { continue }
                    let meta = String(entry[entry.startIndex..<tabRange.lowerBound])
                    let metaParts = meta.split(separator: " ")
                    guard metaParts.count >= 3 else { continue }
                    let mode = String(metaParts[0])
                    let sha = String(metaParts[2])
                    // --add is load-bearing, and its absence was invisible.
                    // Without it git refuses any path not already in the
                    // index, so every file a branch ADDS was silently dropped
                    // from the combined tree - and the result was discarded,
                    // so nothing said so. The drift guard therefore could not
                    // see the commonest two-bee conflict at all: one bee adds
                    // a caller, another changes the signature it calls. The
                    // scenario built exactly that and the combined tree came
                    // out with the new signature and no new caller, so it
                    // compiled and the guard reported success (#1268).
                    guard runGit(
                        ["update-index", "--add", "--cacheinfo", "\(mode),\(sha),\(path)"],
                        index: index, projectRoot: projectRoot
                    ) != nil else { return nil }
                }
            }

            guard let tree = runGit(["write-tree"], index: index, projectRoot: projectRoot)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                !tree.isEmpty else {
                return nil
            }
            return tree
        }.value
    }

    /// Extracts the combined tree of all branches into a throwaway directory
    /// and runs `swift build` there.
    ///
    /// This is the gate that catches interface drift: when one lane changes
    /// a function's signature and another lane's caller was written against
    /// the old one, each branch compiles in isolation but the combined tree
    /// does not. Without this check the broken tree lands on trunk and the
    /// next person to build discovers it.
    ///
    /// The build runs in a copy extracted by `checkout-index` from a
    /// throwaway index, not in the shared checkout, so the user's working
    /// tree, the real index, and every other worker's view are undisturbed.
    static func verifyCombinedBuild(
        branches: [String],
        baseRef: String,
        projectRoot: String = ProjectPaths.root
    ) async -> CombinedBuildResult {
        guard !branches.isEmpty else {
            return CombinedBuildResult(
                builds: true,
                summary: "No branches to combine — nothing to verify.",
                combinedTreeSha: nil
            )
        }

        guard let treeSha = await combinedTree(
            branches: branches, baseRef: baseRef, projectRoot: projectRoot
        ) else {
            return CombinedBuildResult(
                builds: false,
                summary: "Could not assemble the combined tree from branches: "
                    + branches.joined(separator: ", ") + ".",
                combinedTreeSha: nil
            )
        }

        return await Task.detached(priority: .utility) {
            let index = temporaryIndexPath()
            defer { try? FileManager.default.removeItem(atPath: index) }

            let tempDir = NSTemporaryDirectory()
                + "queen-combined-\(UUID().uuidString)/"
            let fm = FileManager.default
            defer { try? fm.removeItem(atPath: tempDir) }

            do {
                try fm.createDirectory(
                    atPath: tempDir, withIntermediateDirectories: true
                )
            } catch {
                return CombinedBuildResult(
                    builds: false,
                    summary: "Could not create a temp directory for the combined build.",
                    combinedTreeSha: treeSha
                )
            }

            // Load the combined tree into the temp index and extract every
            // file into the temp directory. `checkout-index --prefix` writes
            // files at <prefix>/<repo-relative-path>, preserving the
            // directory structure that `swift build` expects. The prefix
            // must end with "/" and the directory must already exist.
            guard runGit(["read-tree", treeSha],
                         index: index, projectRoot: projectRoot) != nil else {
                return CombinedBuildResult(
                    builds: false,
                    summary: "Could not read the combined tree into a scratch index.",
                    combinedTreeSha: treeSha
                )
            }
            guard runGit(["checkout-index", "--prefix=\(tempDir)", "-a"],
                         index: index, projectRoot: projectRoot) != nil else {
                return CombinedBuildResult(
                    builds: false,
                    summary: "Could not extract the combined tree for building.",
                    combinedTreeSha: treeSha
                )
            }

            // Run `swift build` in the temp directory and report whether it
            // succeeded. The exit status, not the output text, is the
            // authoritative signal: a warning printed to stderr does not
            // mean the tree is broken.
            let build = Process()
            build.executableURL = URL(fileURLWithPath: "/usr/bin/swift")
            build.arguments = ["build"]
            build.currentDirectoryURL = URL(fileURLWithPath: tempDir)
            build.environment = ProcessInfo.processInfo.environment
            let output = Pipe()
            build.standardOutput = output
            build.standardError = output

            let watchdog = DispatchWorkItem {
                if build.isRunning { build.terminate() }
            }
            DispatchQueue.global(qos: .utility).asyncAfter(
                deadline: .now() + 300, execute: watchdog
            )

            do {
                try build.run()
            } catch {
                return CombinedBuildResult(
                    builds: false,
                    summary: "Could not start `swift build`: \(error)",
                    combinedTreeSha: treeSha
                )
            }

            let outputData = output.fileHandleForReading.readDataToEndOfFile()
            build.waitUntilExit()
            watchdog.cancel()

            let outputText = String(data: outputData, encoding: .utf8) ?? ""
            let succeeded = build.terminationStatus == 0

            let summary: String
            if succeeded {
                summary = "Combined build of \(branches.count) branch(es) succeeded."
            } else {
                // First few error lines — enough to see the failure without
                // dumping the entire build log.
                let snippet = outputText
                    .split(separator: "\n")
                    .filter { $0.contains("error:") }
                    .prefix(5)
                    .joined(separator: "\n")
                summary = "Combined build FAILED. Tree: \(treeSha)."
                    + (snippet.isEmpty ? "" : "\n\(snippet)")
            }

            return CombinedBuildResult(
                builds: succeeded,
                summary: summary,
                combinedTreeSha: treeSha
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
        // Credentials are the dead end of an automated pipeline: git waits
        // for a username at a prompt nobody can see, and every step that
        // follows the push never runs.  Forbid the prompt outright.
        environment["GIT_TERMINAL_PROMPT"] = "0"
        environment["GIT_ASKPASS"] = ""
        environment["SSH_ASKPASS"] = ""
        environment["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes"
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

    /// Runs a git command in a specific directory without the `GIT_INDEX_FILE`
    /// override.
    ///
    /// Used for commands inside a worktree, where the index is the worktree's
    /// own and must not be redirected to a temp file. Also used for
    /// worktree-management commands (`fetch`, `worktree add`, `worktree remove`)
    /// that operate on the main repo but do not need a custom index.
    ///
    /// Unlike `runGit`, this helper returns both stdout and stderr so callers
    /// can report git's actual complaint when something goes wrong.
    private static func runGitInDir(
        _ arguments: [String],
        workDir: String
    ) -> (ok: Bool, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: workDir)
        process.environment = ProcessInfo.processInfo.environment

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        do {
            try process.run()
        } catch {
            return (false, "")
        }
        let outData = stdout.fileHandleForReading.readDataToEndOfFile()
        let errData = stderr.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let outText = String(data: outData, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let errText = String(data: errData, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard process.terminationStatus == 0 else {
            return (false, errText.isEmpty ? outText : errText)
        }
        return (true, outText)
    }
}
