// AGENT-V-WAIVER: T27-EPIC-001 BrowserClaw companion lifecycle recovery.
// AGENT-V-WAIVER (2026-08-22): supervisor consolidation. This class used to be
// a SECOND, independent spawner of the same agent server - its own launch
// shape (env vars instead of the canonical CLI args), its own health rule
// (cdpConnected==true, so a healthy browserless server read as DOWN and every
// boot spawned three doomed children into the taken port), and NSLog-only
// telemetry invisible to the log bus. Measured on 2026-08-22: it preempted the
// watchdog's restart with zero bus events. It now delegates measurement and
// spawning to AgentServerLauncher (single spawn path, pid-attributed answers)
// and keeps only the menu-facing state plus the funnel.
import Cocoa
import Foundation

/// Renders agent-server state for the menu and manages the Tailscale funnel.
/// All health measurement and spawning is delegated to `AgentServerLauncher`,
/// the single authority over the server process.
@MainActor
final class ServerManager {
    private var funnelTask: Process?
    private var startupTask: Task<Void, Never>?
    private(set) var serverRunning = false
    /// The pid `/health` attributed its answer to, when the server is new
    /// enough to report one. Menu display only.
    private(set) var servingPID: Int32?
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
            stopServer()
        } else {
            startIfNeeded()
        }
    }

    private func ensureServerRunning() async {
        // One spawn path for the whole app. The launcher measures (probe
        // outcome, child fate, pid attribution) and reports on the log bus;
        // this class only renders the outcome.
        let state = await AgentServerLauncher.startIfNeeded()
        NSLog("[ServerManager] Agent server: \(state)")
        await refreshServerState()
    }

    /// Re-measures the port and updates the menu-facing state.
    private func refreshServerState() async {
        if case .answering(let pid) = await AgentServerLauncher.probeHealth(
            port: ProjectPaths.mcpPort
        ) {
            serverRunning = true
            servingPID = pid
        } else {
            serverRunning = false
            servingPID = nil
        }
        onStatusChange?()
    }

    /// Stops the server by its measured identity: `/health` names the serving
    /// pid, and that pid gets SIGTERM. Note the app's own watchdog
    /// (`AgentServerLauncher.superviseForever`) will restart the server within
    /// its watch interval - a menu stop is a restart, not an off switch, for
    /// as long as the app lives.
    private func stopServer() {
        startupTask?.cancel()
        startupTask = nil
        Task { [weak self] in
            guard let self else { return }
            if case .answering(let pid?) = await AgentServerLauncher.probeHealth(
                port: ProjectPaths.mcpPort
            ) {
                kill(pid, SIGTERM)
                NSLog("[ServerManager] Sent SIGTERM to the serving process pid=\(pid)")
            } else {
                NSLog(
                    "[ServerManager] Stop requested but no attributable server answers on \(ProjectPaths.mcpPort)"
                )
            }
            await self.refreshServerState()
        }
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

    /// App-quit teardown. The server is deliberately left running: the old
    /// code only ever killed a process it had spawned itself, and the
    /// dominant reality (watchdog-spawned servers) was always left alive for
    /// the next app instance to adopt. Killing an attributed pid here would
    /// orphan the lane with no watchdog left to restart it.
    func terminateAll() {
        startupTask?.cancel()
        startupTask = nil
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
