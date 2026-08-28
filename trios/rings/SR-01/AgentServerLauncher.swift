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

    /// What a health probe actually established. A Bool collapses three
    /// different facts into one word, and each of the three calls for a
    /// different response: an answer means leave the server alone, a refused
    /// connection means nothing listens (restart now, no second opinion
    /// needed), and a timeout means the port's state is UNKNOWN - the one
    /// case where acting on a single probe once spawned a doomed replacement
    /// into a port a busy-but-alive server still held.
    enum HealthProbe: Equatable {
        /// HTTP 200. `pid` is the serving process when the server is new
        /// enough to report one, nil for servers that predate the field.
        case answering(pid: Int32?)
        /// The connection was refused: no process listens on the port.
        case refused
        /// Timed out or failed some other way: the port's state is unknown.
        case silent
    }

    /// Asks `/health` and reports what was measured, not a summary of it.
    static func probeHealth(port: String, timeout: TimeInterval = 2) async -> HealthProbe {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return .silent }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return .silent
            }
            let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let pid = (body?["pid"] as? NSNumber)?.int32Value
            return .answering(pid: pid)
        } catch let error as URLError where error.code == .cannotConnectToHost {
            return .refused
        } catch {
            return .silent
        }
    }

    /// Whether a server is already answering on `port`.
    static func isHealthy(port: String, timeout: TimeInterval = 2) async -> Bool {
        if case .answering = await probeHealth(port: port, timeout: timeout) { return true }
        return false
    }

    /// How often the supervisor re-asks. Sixty seconds: long enough that a
    /// server restarting on its own is not raced, short enough that a dead one
    /// is not left dead through a whole delegation.
    static let watchInterval: UInt64 = 60_000_000_000

    /// Keeps the server up, rather than starting it once and hoping.
    ///
    /// Starting at launch was not enough and the evidence was six delegated
    /// tasks sitting in `awaitingReview` for six hours: the app had started a
    /// server hours earlier, that server had since died, and nothing looked
    /// again. A supervisor that only supervises at boot supervises nothing.
    ///
    /// `startIfNeeded` is idempotent, so this loop is just the same question
    /// asked repeatedly.
    static func superviseForever() -> Task<Void, Never> {
        Task.detached(priority: .utility) {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: watchInterval)
                guard !Task.isCancelled else { break }
                let port = ProjectPaths.mcpPort
                switch await probeHealth(port: port) {
                case .answering:
                    continue
                case .refused:
                    // Nothing listens. That is measured, not inferred - no
                    // second opinion needed, and no 13-second confirmation
                    // penalty for a server that is genuinely dead.
                    TriosLogBus.shared.warn(
                        .app, "server.watch.down",
                        "The connection to \(port) was refused - nothing is listening; restarting the agent server",
                        ["port": port]
                    )
                case .silent:
                    // A timeout is "unknown", not "down". The night this
                    // distinction was skipped, a busy-but-alive server missed
                    // one probe, the watchdog spawned a replacement into the
                    // taken port, the replacement died on the collision, and
                    // the old server answered the launcher's wait loop -
                    // which then reported the dead child as "started". Ask
                    // again, with more patience, before declaring anything.
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    if case .answering = await probeHealth(port: port, timeout: 6) {
                        TriosLogBus.shared.info(
                            .app, "server.watch.slow_probe",
                            "One health probe timed out on \(port) but the next answered - slow, not down",
                            ["port": port]
                        )
                        continue
                    }
                    TriosLogBus.shared.warn(
                        .app, "server.watch.down",
                        "Two health probes in a row got no answer on \(port); restarting the agent server",
                        ["port": port]
                    )
                }
                let state = await startIfNeeded()
                TriosLogBus.shared.info(
                    .app, "server.watch.restarted", "Agent server: \(state)", [:]
                )
            }
        }
    }

    /// What the launcher measured about a spawn it is waiting on. The facts
    /// are independent - the child's fate, the port's answer, and WHOSE
    /// answer it is - and collapsing them into one word is how a dead child
    /// got reported as "started" while a pre-existing server answered the
    /// probe.
    enum SpawnVerdict: Equatable {
        /// The port answers and the answer is attributed to the child (its
        /// pid), or - for a server too old to report a pid - the child was
        /// still alive after the answer arrived. The pid form is a
        /// measurement; the legacy form is the best remaining inference and
        /// says so in its log line.
        case started
        /// The child exited, yet the port answers: some other server holds the
        /// port. The spawn lost a race, nothing was actually restarted.
        case superseded(exitStatus: Int32)
        /// The child exited and the port is silent: the spawn failed; the exit
        /// status and the server log are the evidence.
        case exited(exitStatus: Int32)
        /// Nothing is decided yet: the port is silent while the child boots,
        /// or a foreign pid answers while the child still lives (its bind
        /// collision will resolve the race within seconds). Keep waiting.
        case stillWaiting
    }

    /// Pure mapping from the measured facts to the verdict, separated from
    /// the polling loop so a test can hold it still.
    ///
    /// `childAlive` must be measured AFTER the health probe answered: the
    /// probe can block for seconds, and a child that died during it must not
    /// be certified by its pre-probe pulse.
    static func spawnVerdict(
        childAlive: Bool,
        exitStatus: Int32?,
        health: HealthProbe,
        childPID: Int32
    ) -> SpawnVerdict {
        guard childAlive else {
            let status = exitStatus ?? -1
            if case .answering = health {
                return .superseded(exitStatus: status)
            }
            return .exited(exitStatus: status)
        }
        switch health {
        case .answering(let pid?) where pid == childPID:
            return .started
        case .answering(nil):
            // A server that predates the pid field: unattributable. The child
            // outlived the answer, which is the strongest claim left.
            return .started
        case .answering:
            // A foreign pid answers while the child lives: the child is about
            // to lose its bind race. Let the collision resolve it.
            return .stillWaiting
        case .refused, .silent:
            return .stillWaiting
        }
    }

    /// Starts the server for this variant if nothing is listening.
    ///
    /// Returns what happened, so the caller can say it rather than guess.
    @discardableResult
    static func startIfNeeded() async -> String {
        // A remote server is not this app's to start. Spawning a local one
        // anyway would bind a port nothing talks to, and the next health probe
        // - which asks the remote - would come back green and be read as proof
        // the spawn worked. Two servers, one of them permanently idle, and a
        // status line that cannot tell you which one answered.
        if ProjectPaths.agentServerIsRemote {
            return "remote server at \(ProjectPaths.mcpBaseURL); not starting a local one"
        }
        let port = ProjectPaths.mcpPort
        switch await probeHealth(port: port) {
        case .answering:
            return "already running on \(port)"
        case .refused:
            break
        case .silent:
            // The app-launch path arrives here directly, without the
            // watchdog's confirmation dance - and the relaunch scenario (the
            // previous app's server still busy on the port) re-creates the
            // incident's trigger exactly. A refused connection above proves
            // an empty port and spawns without penalty; a timeout proves
            // nothing, so it gets the same second opinion.
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if case .answering = await probeHealth(port: port, timeout: 6) {
                return "already running on \(port) (answered the second probe)"
            }
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

        // Wait for it, but not forever - and attribute the answer, not only
        // hear it. The port answering proves only that SOMEBODY answers: the
        // measured incident had the spawned bun die on "port already in use"
        // at second four while the pre-existing server recovered and answered
        // at second seventeen, and this loop reported "started". The server
        // now puts its pid in /health, so the answer is attributed to the
        // child by measurement; the child's liveness is read AFTER the probe
        // returns, so a child that died during the probe's blocking window
        // cannot be certified by its pre-probe pulse.
        for _ in 0..<20 {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            let health = await probeHealth(port: port)
            let alive = process.isRunning
            switch spawnVerdict(
                childAlive: alive,
                exitStatus: alive ? nil : process.terminationStatus,
                health: health,
                childPID: process.processIdentifier
            ) {
            case .started:
                let attribution: String
                if case .answering(let pid?) = health, pid == process.processIdentifier {
                    attribution = "the answer carries the spawned process's pid \(pid)"
                } else {
                    attribution = "the spawned process outlived the answer (a pre-pid server cannot be attributed)"
                }
                TriosLogBus.shared.info(
                    .app, "server.launch.ready",
                    "Started the agent server on \(port) - \(attribution)",
                    ["port": port]
                )
                return "started on \(port)"
            case .superseded(let status):
                TriosLogBus.shared.warn(
                    .app, "server.launch.superseded",
                    "The spawned server exited (status \(status)) but \(port) answers - "
                        + "an existing server holds the port; nothing was restarted. "
                        + "Tail \(ProjectPaths.trinity)/logs/agent-server-\(port).log for its last words",
                    ["port": port, "exit_status": String(status)]
                )
                return "an existing server answers on \(port); the spawn exited (status \(status))"
            case .exited(let status):
                TriosLogBus.shared.error(
                    .app, "server.launch.exited",
                    "The spawned server exited (status \(status)) and \(port) does not answer. "
                        + "Tail \(ProjectPaths.trinity)/logs/agent-server-\(port).log for the reason",
                    ["port": port, "exit_status": String(status)]
                )
                return "spawn exited (status \(status)), \(port) silent"
            case .stillWaiting:
                continue
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
