import Foundation

/// Starts the agent server this app cannot work without.
///
/// `ProjectPaths.agentServerEntrypoint` has pointed at the runtime for as long
/// as the runtime has lived in this tree, and nothing ever called it. The app
/// depended on a server it did not start, so the server was whatever somebody
/// had left running: after a reboot, nothing. The Queen would then choose an
/// issue, delegate it, and the worker would find no transport - which reads
/// like the supervisor is broken, and is not.
///
/// Idempotent by construction: it asks the port first and only spawns when
/// nothing answers. Two variants can therefore both call this at launch and the
/// second one finds a healthy server and returns.
enum AgentServerLauncher {
    /// Where `bun` might be. Checked in order rather than resolved through the
    /// shell, because an app launched from Finder does not inherit a login
    /// shell's PATH - the single most common way "works in the terminal,
    /// not in the app" happens.
    static let bunCandidates = [
        "/opt/homebrew/bin/bun",
        "/usr/local/bin/bun",
        "\(NSHomeDirectory())/.bun/bin/bun",
    ]

    static func resolveBun(existsAt: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }) -> String? {
        bunCandidates.first(where: existsAt)
    }

    /// Whether a server is already answering on `port`.
    static func isHealthy(port: String, timeout: TimeInterval = 2) async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else {
            return false
        }
        return http.statusCode == 200
    }

    /// Starts the server for this variant if nothing is listening.
    ///
    /// Returns what happened, so the caller can say it rather than guess.
    @discardableResult
    static func startIfNeeded() async -> String {
        let port = ProjectPaths.mcpPort
        if await isHealthy(port: port) {
            return "already running on \(port)"
        }
        guard let bun = resolveBun() else {
            TriosLogBus.shared.error(
                .app, "server.launch.no_runtime",
                "Cannot start the agent server: bun was not found in "
                    + bunCandidates.joined(separator: ", "),
                [:]
            )
            return "bun not found"
        }
        let entrypoint = ProjectPaths.agentServerEntrypoint
        guard FileManager.default.fileExists(atPath: entrypoint) else {
            TriosLogBus.shared.error(
                .app, "server.launch.no_entrypoint",
                "Cannot start the agent server: \(entrypoint) does not exist", [:]
            )
            return "entrypoint missing"
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: bun)
        // --cdp-port is still passed: the server wants a browser and will keep
        // trying for one in the background. It no longer refuses to start
        // without it, which is the whole reason this launcher can be
        // unconditional.
        process.arguments = [
            entrypoint,
            "--server-port", port,
            "--cdp-port", "9222",
        ]
        process.currentDirectoryURL = URL(fileURLWithPath: ProjectPaths.browserOSAgentRoot)
        // Kept, not discarded. The first version sent both to /dev/null, the
        // server started and then died, and there was nothing to read - the
        // one question the launcher exists to answer had been thrown away.
        let logPath = "\(ProjectPaths.trinity)/logs/agent-server-\(port).log"
        try? FileManager.default.createDirectory(
            atPath: "\(ProjectPaths.trinity)/logs", withIntermediateDirectories: true
        )
        FileManager.default.createFile(atPath: logPath, contents: nil)
        if let handle = FileHandle(forWritingAtPath: logPath) {
            process.standardOutput = handle
            process.standardError = handle
        }
        do {
            try process.run()
        } catch {
            TriosLogBus.shared.error(
                .app, "server.launch.failed",
                "Could not start the agent server: \(error.localizedDescription)", [:]
            )
            return "spawn failed"
        }

        // Wait for it, but not forever. A server that has not answered in
        // twenty seconds is a problem to report, not to keep waiting on.
        for _ in 0..<20 {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if await isHealthy(port: port) {
                TriosLogBus.shared.info(
                    .app, "server.launch.ready",
                    "Started the agent server on \(port)", ["port": port]
                )
                return "started on \(port)"
            }
        }
        TriosLogBus.shared.warn(
            .app, "server.launch.slow",
            "The agent server was launched but has not answered on \(port) yet",
            ["port": port]
        )
        return "launched, not answering yet"
    }
}
