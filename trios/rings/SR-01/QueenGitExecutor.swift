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
    static var canPublish: Bool { executor.isLocal }
}
