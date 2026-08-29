import Foundation

/// Runs `git` where the files are.
///
/// `QueenBranchCommitter` spawned `/usr/bin/git` directly, which is correct
/// exactly while the agent-server that writes a bee's files runs on this
/// machine too. Once that server is in a container the two part company: the
/// bee writes there, the committer reads here, finds an unchanged tree and
/// files the task as work that never happened.
///
/// So the location becomes a parameter. Nothing above this type needs to know
/// which machine answered.
///
/// **Synchronous on purpose.** The committer is ~1400 lines of synchronous
/// code and every caller of `runGit` is inside it. Converting that graph to
/// async to accommodate a network hop would be a far larger and riskier change
/// than blocking one background thread on a request, and the committer already
/// blocks on `Process.waitUntilExit()` for exactly as long. Blocking on a
/// `URLSession` completion is safe here because URLSession completes on its own
/// delegate queue, never on the caller's.
protocol QueenGitExecutor {
    /// Runs git and reports what happened.
    ///
    /// `workDir` is interpreted on whichever machine runs the command, so a
    /// caller must hand over a path that machine can see - which is why
    /// `repositoryRoot` is asked of the executor rather than computed locally.
    func run(
        arguments: [String],
        workDir: String,
        environment: [String: String]
    ) -> (ok: Bool, output: String)

    /// The repository root as this executor sees it.
    var repositoryRoot: String? { get }

    /// Whether commands land on this machine. The delegation guard asks this
    /// rather than inferring it from the server URL, so the two can never
    /// disagree.
    var isLocal: Bool { get }
}

/// Spawns git on this machine. The behaviour the committer always had.
struct LocalGitExecutor: QueenGitExecutor {
    var isLocal: Bool { true }

    /// Resolved by asking git, not by string surgery on a path.
    ///
    /// A worktree's root is not its project directory's parent, and guessing
    /// it wrong sends every subsequent command into the wrong tree.
    var repositoryRoot: String? {
        let result = run(
            arguments: ["rev-parse", "--show-toplevel"],
            workDir: ProjectPaths.root,
            environment: [:]
        )
        return result.ok && !result.output.isEmpty ? result.output : nil
    }

    func run(
        arguments: [String],
        workDir: String,
        environment: [String: String]
    ) -> (ok: Bool, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: workDir)
        var env = ProcessInfo.processInfo.environment
        for (key, value) in environment { env[key] = value }
        process.environment = env

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        do {
            try process.run()
        } catch {
            return (false, "could not run git: \(error.localizedDescription)")
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

/// Runs git inside the agent-server's container, through its shell tool.
///
/// The server already exposes `filesystem_bash` and already executes it where
/// the bee's files are. Reusing it means the commit path needs no new endpoint,
/// no second authentication story, and cannot drift away from the tools that
/// wrote the files.
struct RemoteGitExecutor: QueenGitExecutor {
    let baseURL: String
    let token: String?
    let remoteRepositoryRoot: String
    var timeout: TimeInterval = 120

    var isLocal: Bool { false }
    var repositoryRoot: String? { remoteRepositoryRoot }

    func run(
        arguments: [String],
        workDir: String,
        environment: [String: String]
    ) -> (ok: Bool, output: String) {
        // Every argument is single-quoted with embedded quotes escaped, so a
        // commit message containing a quote, a newline or a `;` is data rather
        // than shell. The committer passes bee-authored text through here.
        let command = ([
            environment.map { "\(Self.shellQuote($0.key))=\(Self.shellQuote($0.value))" }
                .sorted()
                .joined(separator: " "),
            "git"
        ] + arguments.map(Self.shellQuote))
            .filter { !$0.isEmpty }
            .joined(separator: " ")

        let full = "cd \(Self.shellQuote(workDir)) && \(command)"
        return callBash(full)
    }

    static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private func callBash(_ command: String) -> (ok: Bool, output: String) {
        guard let url = URL(string: "\(baseURL)/mcp") else {
            return (false, "the configured agent server URL is not a URL")
        }
        let payload: [String: Any] = [
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": [
                "name": "filesystem_bash",
                "arguments": ["command": command]
            ]
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
            return (false, "could not encode the git request")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        var result: (ok: Bool, output: String) = (false, "the git request did not complete")
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, error in
            defer { done.signal() }
            if let error {
                result = (false, "agent server unreachable: \(error.localizedDescription)")
                return
            }
            if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                // 403 here means the token is missing or wrong, and saying so
                // beats "git failed" - the second sends someone reading commit
                // logs looking for a repository problem that is not there.
                result = (false, "agent server refused the git call: HTTP \(http.statusCode)")
                return
            }
            guard let data else {
                result = (false, "agent server returned no body")
                return
            }
            result = Self.parse(data)
        }.resume()

        // A hung server must not hang the committer forever. The wait is a
        // little longer than the request timeout so URLSession's own timeout
        // fires first and produces the better message.
        if done.wait(timeout: .now() + timeout + 15) == .timedOut {
            return (false, "the git call to the agent server timed out")
        }
        return result
    }

    /// Pulls the tool's text out of either a plain JSON-RPC body or an SSE
    /// frame, because the same endpoint answers in both shapes depending on
    /// what the caller accepts.
    static func parse(_ data: Data) -> (ok: Bool, output: String) {
        let raw = String(data: data, encoding: .utf8) ?? ""
        for line in raw.split(separator: "\n", omittingEmptySubsequences: true) {
            let payload = line.hasPrefix("data: ") ? String(line.dropFirst(6)) : String(line)
            guard let bytes = payload.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any]
            else { continue }

            if let error = object["error"] as? [String: Any] {
                let message = error["message"] as? String ?? "unknown error"
                return (false, message)
            }
            guard let result = object["result"] as? [String: Any] else { continue }
            // An `isError` result is a tool that ran and failed, which is a
            // different fact from a transport failure and is reported as the
            // command failing rather than as the server being broken.
            let failed = (result["isError"] as? Bool) ?? false
            guard let content = result["content"] as? [[String: Any]] else {
                return (!failed, "")
            }
            let text = content
                .compactMap { $0["text"] as? String }
                .joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return (!failed, text)
        }
        return (false, "could not read the agent server's answer")
    }
}

/// Chooses the executor once, from configuration, so no caller decides.
enum QueenGit {
    /// The container path the entrypoint clones into. Overridable because a
    /// different deployment may mount somewhere else; the default matches
    /// `docker-entrypoint.sh`.
    static var remoteRepositoryRoot: String {
        ProcessInfo.processInfo.environment["TRIOS_REMOTE_REPO_ROOT"]
            ?? "/workspace/BrowserOS"
    }

    /// The token the server requires from a non-loopback caller.
    ///
    /// Read from the environment only. Writing it into a file or a plist would
    /// put a credential in the repository, and the app is signed - a value
    /// baked into the bundle cannot be rotated without re-signing.
    static var remoteToken: String? {
        let token = ProcessInfo.processInfo.environment["TRIOS_API_TOKEN"]
        return (token?.isEmpty ?? true) ? nil : token
    }

    /// The project directory as the executing machine sees it.
    ///
    /// Derived from the local layout rather than hardcoded: the suffix from the
    /// repository root to the project directory is a property of the
    /// repository, so it is measured here and re-rooted there. Writing
    /// `/workspace/BrowserOS/trios` as a literal would silently be wrong the
    /// day the project moves inside its own repository - which is precisely
    /// the move this branch is arguing about.
    static func projectRoot(local: String = ProjectPaths.root) -> String {
        guard ProjectPaths.agentServerIsRemote else { return local }
        guard let localRoot = LocalGitExecutor().repositoryRoot,
              local.hasPrefix(localRoot)
        else {
            // No local repository to measure against: the container's root is
            // the best answer available, and saying so beats inventing a
            // suffix.
            return remoteRepositoryRoot
        }
        let suffix = String(local.dropFirst(localRoot.count))
        return remoteRepositoryRoot + suffix
    }

    /// Runs git where the repository is and returns what it said.
    ///
    /// Shaped like the `runProcess("/usr/bin/git", …)` calls it replaces, which
    /// returned stdout and stderr merged and let callers judge by the text -
    /// `line.hasPrefix("fatal")`, `output.isEmpty`. Those judgements still hold:
    /// on failure this returns git's complaint, on success only stdout, so a
    /// warning on stderr no longer contaminates a successful answer.
    ///
    /// `workDir` defaults to the project root **as the executing machine sees
    /// it**. Every call site replaced here passed `ProjectPaths.root`, which is
    /// this Mac - correct while git ran here and wrong the moment it did not.
    static func output(_ arguments: [String], in workDir: String? = nil) -> String {
        executor.run(
            arguments: arguments,
            workDir: workDir ?? projectRoot(),
            environment: [:]
        ).output
    }

    /// A directory for scratch files that git itself will read or write.
    ///
    /// It has to be on the machine that RUNS git, not the one that composed the
    /// command. `NSTemporaryDirectory()` is `/var/folders/…` on macOS, and git
    /// in a container told to put its index there fails outright - the
    /// directory does not exist and git does not create parents for
    /// `GIT_INDEX_FILE`. The failure surfaces as a commit that staged nothing,
    /// which reads as a bee that did no work.
    ///
    /// Not for scratch the APP reads. A combined tree built for `swift build`
    /// is compiled here, so it belongs in `NSTemporaryDirectory()` and stays
    /// there deliberately.
    ///
    /// Remote scratch is not cleaned up: deleting it would need a shell this
    /// type does not have, and the container's `/tmp` goes away with the
    /// container. An index is kilobytes and the leak is bounded by a redeploy.
    static var temporaryDirectory: String {
        ProjectPaths.agentServerIsRemote ? "/tmp/" : NSTemporaryDirectory()
    }

    static var executor: QueenGitExecutor {
        guard ProjectPaths.agentServerIsRemote else { return LocalGitExecutor() }
        return RemoteGitExecutor(
            baseURL: ProjectPaths.mcpBaseURL,
            token: remoteToken,
            remoteRepositoryRoot: remoteRepositoryRoot
        )
    }

    /// Whether the commit path runs on this machine. One answer, one place.
    static var runsLocally: Bool { executor.isLocal }

    /// Whether a branch made by the executor can reach the remote.
    ///
    /// Locally this is the machine's own git credentials, which are the
    /// operator's and are assumed present - a failing push then says so with
    /// git's own words. Remotely it is false and stays false until a branch can
    /// be carried out of the container: no push credential is kept there,
    /// because the agents own that checkout and therefore own the git
    /// configuration and hooks any privileged git run would obey.
    /// Whether a branch produced by the executor can reach GitHub at all.
    ///
    /// True on both sides now, for different reasons: a local executor pushes
    /// directly, and a remote one has its work carried back by
    /// `importRemoteBranch` and pushed from here. It is kept as a question
    /// rather than deleted because the answer is a property of the executor,
    /// and an executor that can neither push nor be read back would be a real
    /// case - one that should refuse a worker rather than lose its output.
    static var canPublish: Bool { executor.isLocal || executor.repositoryRoot != nil }

    /// Whether the branch is already on the machine that will push it.
    static var canPublishDirectly: Bool { executor.isLocal }

    /// The marker `filesystem_bash` prepends when it dropped output.
    ///
    /// A patch that was truncated is not a smaller patch, it is a corrupt one,
    /// and `git am` would apply the surviving hunks and call it a success.
    private static let truncationMarker = "characters were discarded while the command ran"

    /// Carries a branch off the executing machine and onto this one.
    ///
    /// No credential travels and none is needed. A checkout the agents can
    /// write is a checkout whose `.git/config` and `.git/hooks` they control,
    /// so a push credential placed there is a credential they can take -
    /// measured, in review: a planted `credential.helper` and a planted
    /// `pre-push` hook each captured the privileged environment. The way out of
    /// that is not to hide the secret better but to not have one there.
    ///
    /// `format-patch` renders the branch as text, which survives a transport
    /// built for tool output, and `git am` replays it here with the author,
    /// date and message intact. This machine already holds the operator's git
    /// credentials, and has to be present anyway because `swift build` cannot
    /// leave macOS.
    ///
    /// Returns nil on success, or the reason it could not.
    static func importRemoteBranch(_ branch: String, base: String) -> String? {
        guard !executor.isLocal else { return nil }
        guard let remoteRoot = executor.repositoryRoot else {
            return "the remote executor did not report a repository root"
        }

        let patch = executor.run(
            arguments: ["format-patch", "\(base)..\(branch)", "--stdout"],
            workDir: remoteRoot,
            environment: [:]
        )
        guard patch.ok else {
            return "could not read \(branch) from the agent server: \(patch.output)"
        }
        if patch.output.contains(truncationMarker) {
            // Refusing beats applying the part that fitted. The alternative is
            // a branch that looks pushed and is missing its middle.
            return "the patch for \(branch) was larger than the tool transport "
                + "and arrived truncated; it was not applied"
        }
        guard !patch.output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return "the agent server reports no commits on \(branch) after \(base)"
        }

        let local = LocalGitExecutor()
        guard let localRoot = local.repositoryRoot else {
            return "this machine has no git repository to import into"
        }
        let file = NSTemporaryDirectory() + "queen-import-\(UUID().uuidString).patch"
        defer { try? FileManager.default.removeItem(atPath: file) }
        do {
            try patch.output.write(toFile: file, atomically: true, encoding: .utf8)
        } catch {
            return "could not stage the patch here: \(error.localizedDescription)"
        }

        // Start the local branch at the same base the patch was cut against,
        // so `am` replays onto identical ground. `-B` because a re-run must
        // update the branch rather than refuse.
        let cut = local.run(
            arguments: ["branch", "-f", branch, base],
            workDir: localRoot, environment: [:]
        )
        guard cut.ok else { return "could not create \(branch) here: \(cut.output)" }

        // A scratch worktree, because `git am` needs a work tree and the
        // operator's checkout is not ours to disturb - they may have files open
        // in it. Applying with a temporary index instead would land the changes
        // as one blob and lose the commit boundaries, which are the bee's
        // account of what it did.
        let scratch = NSTemporaryDirectory() + "queen-import-\(UUID().uuidString)"
        defer { _ = local.run(arguments: ["worktree", "remove", "--force", scratch],
                              workDir: localRoot, environment: [:]) }
        let added = local.run(
            arguments: ["worktree", "add", "--force", scratch, branch],
            workDir: localRoot, environment: [:]
        )
        guard added.ok else { return "could not open a scratch checkout: \(added.output)" }

        let applied = local.run(
            arguments: ["am", "--3way", file],
            workDir: scratch, environment: [:]
        )
        guard applied.ok else {
            // Leave nothing half-applied behind for the next attempt to trip on.
            _ = local.run(arguments: ["am", "--abort"], workDir: scratch, environment: [:])
            return "could not replay \(branch) here: \(applied.output)"
        }
        return nil
    }
}
