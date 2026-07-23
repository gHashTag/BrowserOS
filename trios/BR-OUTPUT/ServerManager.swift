// AGENT-V-WAIVER: T27-EPIC-001 BrowserClaw companion lifecycle recovery.
// Follow-up: seal ServerManager after supervisor conformance tests land.
import Cocoa
import Foundation

/// Manages the BrowserOS MCP server (bun) and Tailscale funnel processes.
@MainActor
final class ServerManager {
    private var serverTask: Process?
    private var funnelTask: Process?
    private var serverLogHandle: FileHandle?
    private var ownsServerProcess = false
    private var startupTask: Task<Void, Never>?
    private(set) var serverRunning = false
    private(set) var funnelRunning = false

    var onStatusChange: (() -> Void)?

    // MARK: - Server

    func startIfNeeded() {
        guard startupTask == nil else { return }
        startupTask = Task { [weak self] in
            await self?.ensureServerRunning()
            self?.startupTask = nil
        }
    }

    func toggleServer() {
        if serverRunning {
            stopOwnedServer()
        } else {
            startIfNeeded()
        }
    }

    private func ensureServerRunning() async {
        if await healthCheck() {
            serverRunning = true
            ownsServerProcess = false
            onStatusChange?()
            NSLog("[ServerManager] Adopted healthy companion on port \(ProjectPaths.mcpPort)")
            return
        }

        for attempt in 1...3 {
            do {
                try launchServer()
                if await waitUntilHealthy(timeoutSeconds: 15) {
                    serverRunning = true
                    onStatusChange?()
                    NSLog("[ServerManager] Companion ready after attempt \(attempt)")
                    return
                }
                stopOwnedProcess()
            } catch {
                NSLog("[ServerManager] Start attempt \(attempt) failed: \(error)")
            }
            if attempt < 3 {
                try? await Task.sleep(nanoseconds: UInt64(1 << attempt) * 1_000_000_000)
            }
        }
        NSLog("[ServerManager] Companion startup halted after retry budget exhausted")
        serverRunning = false
        onStatusChange?()
    }

    private func waitUntilHealthy(timeoutSeconds: Int) async -> Bool {
        let checks = timeoutSeconds * 2
        for _ in 0..<checks {
            if Task.isCancelled { return false }
            if await healthCheck() { return true }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        return false
    }

    private func launchServer() throws {
        let bunPath = resolveBunPath()
        guard let bunPath else {
            throw ServerManagerError.bunNotFound
        }
        let root = ProjectPaths.browserOSAgentRoot
        let entrypoint = "\(root)/apps/server/src/index.ts"
        guard FileManager.default.fileExists(atPath: entrypoint) else {
            throw ServerManagerError.entrypointNotFound(entrypoint)
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: bunPath)
        task.arguments = [entrypoint]
        task.currentDirectoryURL = URL(fileURLWithPath: root)
        var environment = ProcessInfo.processInfo.environment
        environment["BROWSEROS_SKIP_OPENCLAW"] = "1"
        environment["BROWSEROS_CDP_PORT"] = String(CompanionServerConfig.loadCDPPort())
        environment["BROWSEROS_SERVER_PORT"] = ProjectPaths.mcpPort
        environment["BROWSEROS_EXTENSION_PORT"] = "9300"
        environment["BROWSEROS_RESOURCES_DIR"] = root
        environment["BROWSEROS_EXECUTION_DIR"] = root
        task.environment = environment

        let logURL = URL(fileURLWithPath: ProjectPaths.trinity)
            .appendingPathComponent("logs/browseros-companion.log")
        try FileManager.default.createDirectory(
            at: logURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: logURL)
        try handle.seekToEnd()
        task.standardOutput = handle
        task.standardError = handle
        task.terminationHandler = { [weak self] process in
            Task { @MainActor in
                guard let self, self.serverTask === process else { return }
                self.serverTask = nil
                self.serverLogHandle = nil
                self.serverRunning = false
                self.ownsServerProcess = false
                self.onStatusChange?()
                NSLog("[ServerManager] Companion exited with status \(process.terminationStatus)")
            }
        }
        try task.run()
        serverTask = task
        serverLogHandle = handle
        ownsServerProcess = true
        NSLog("[ServerManager] Started companion pid=\(task.processIdentifier)")
    }

    private func healthCheck() async -> Bool {
        guard let url = URL(string: ProjectPaths.browserOSHealthURL) else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200...299).contains(http.statusCode),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return false }
            return object["status"] as? String == "ok" && object["cdpConnected"] as? Bool == true
        } catch {
            return false
        }
    }

    private func resolveBunPath() -> String? {
        let environment = ProcessInfo.processInfo.environment
        let candidates = [
            environment["TRIOS_BUN_PATH"],
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun"
        ].compactMap { $0 }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private func stopOwnedServer() {
        startupTask?.cancel()
        startupTask = nil
        stopOwnedProcess()
    }

    private func stopOwnedProcess() {
        if ownsServerProcess, let task = serverTask, task.isRunning {
            task.terminate()
        }
        serverTask = nil
        serverLogHandle = nil
        ownsServerProcess = false
        serverRunning = false
        onStatusChange?()
    }

    // MARK: - Funnel

    /// Tailscale `serve` requires admin privileges. The app must NOT silently
    /// invoke `sudo`; instead it tries a non-privileged tailscale binary and, if
    /// that fails, prompts the user with the exact privileged command to run
    /// manually or via a dedicated privileged helper tool (future: SMJobBless).
    func toggleFunnel() {
        let tailscalePath = ProcessInfo.processInfo.environment["TRIOS_TAILSCALE_PATH"] ?? "/opt/homebrew/bin/tailscale"
        if funnelRunning {
            funnelTask?.terminate()
            funnelTask = nil
            funnelRunning = false
            runTailscaleFunnelCommand(
                tailscalePath: tailscalePath,
                args: ["serve", "--https=443", "off"],
                userPrompt: "To stop the public funnel, run:\nsudo \(tailscalePath) serve --https=443 off"
            )
            onStatusChange?()
        } else {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: tailscalePath)
            task.arguments = ["serve", "--https=443", "http://127.0.0.1:\(ProjectPaths.mcpPort)"]
            do {
                try task.run()
                funnelTask = task
                funnelRunning = true
                task.terminationHandler = { [weak self] _ in
                    DispatchQueue.main.async {
                        self?.funnelRunning = false
                        self?.onStatusChange?()
                    }
                }
                onStatusChange?()
            } catch {
                // Tailscale serve requires root; do not escalate automatically.
                let prompt = """
                Failed to start funnel: \(error.localizedDescription)
                Tailscale serve requires admin privileges. Run manually in Terminal:
                sudo \(tailscalePath) serve --https=443 http://127.0.0.1:\(ProjectPaths.mcpPort)
                """
                showAlert(prompt)
            }
        }
    }

    private func runTailscaleFunnelCommand(tailscalePath: String, args: [String], userPrompt: String) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: tailscalePath)
        task.arguments = args
        do {
            try task.run()
        } catch {
            showAlert(userPrompt)
        }
    }

    // MARK: - Cleanup

    func terminateAll() {
        stopOwnedServer()
        funnelTask?.terminate()
        funnelTask = nil
        funnelRunning = false
    }

    // MARK: - Helpers

    private func showAlert(_ message: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.alertStyle = .warning
        alert.runModal()
    }
}

private enum ServerManagerError: LocalizedError {
    case bunNotFound
    case entrypointNotFound(String)

    var errorDescription: String? {
        switch self {
        case .bunNotFound:
            return "bun was not found; set TRIOS_BUN_PATH"
        case .entrypointNotFound(let path):
            return "BrowserOS companion entrypoint not found at \(path)"
        }
    }
}
