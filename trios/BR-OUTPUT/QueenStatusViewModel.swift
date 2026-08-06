// AGENT-V-WAIVER: https://github.com/browseros-ai/BrowserOS/issues/2023
// Reason: Queen direct-chat hardening — observe live online A2A agents via the
// background service instead of relying solely on local process status.
import Foundation
import SwiftUI

enum ComponentStatus: String {
    case healthy = "ok"
    case warning = "warn"
    case down = "down"
    case unknown = "unknown"
}

struct StatusComponent: Identifiable {
    let id = UUID()
    let name: String
    let icon: String
    let status: ComponentStatus
    let detail: String
    let actionLabel: String?
}

struct SkillRun: Identifiable {
    let id = UUID()
    let name: String
    let lastRun: Date?
    let success: Bool?
    let isRunning: Bool
}

/// Agent control model for A2A agent lifecycle management.
struct AgentInfo: Identifiable {
    let id = UUID()
    let name: String
    let status: ComponentStatus
    let pid: Int?
    let uptime: String
    let lastAction: String?
}

struct SelfImprovementStatus {
    let score: Int
    let openIssues: Int
    let lastAuditAgo: String
    let safetyBudget: String
    let lastCritique: String
    let pendingPRs: Int
}

struct AuditRecord {
    let timestamp: Date
    let findings: Int
    let passed: Bool
}

@MainActor
final class QueenStatusViewModel: ObservableObject {
    @Published var components: [StatusComponent] = .init()
    @Published var skills: [SkillRun] = .init()
    @Published var agents: [AgentInfo] = .init()
    @Published var lastLogLines: [String] = .init()
    @Published var isRunningAction: Bool = false
    @Published var overallStatus: ComponentStatus = .unknown
    @Published var selfImprovement: SelfImprovementStatus? = nil
    @Published var auditHistory: [AuditRecord] = .init()
    @Published var onlineAgents: [AgentCard] = .init()

    private let projectRoot = ProjectPaths.root
    private let statePath = ProjectPaths.trinityState
    private let logPath = ProjectPaths.trinityLog

    private var refreshTimer: Timer?
    private var logTimer: Timer?
    private var a2aAgentTimer: Timer?

    init() {
        if ProcessInfo.processInfo.environment[
            "TRIOS_DISABLE_STATUS_MONITORING"
        ] == "1" {
            return
        }
        startTimers()
        // Defer first refresh so init doesn't block the main thread
        DispatchQueue.main.async { [weak self] in
            self?.refreshAll()
        }
    }

    deinit {
        refreshTimer?.invalidate()
        logTimer?.invalidate()
        a2aAgentTimer?.invalidate()
    }

    private func startTimers() {
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.refreshAll()
            }
        }
        logTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.loadLogTailAsync()
            }
        }
        a2aAgentTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.loadOnlineAgents()
            }
        }
    }

    private func loadOnlineAgents() async {
        let service = QueenBackgroundService.shared
        // Avoid forcing configuration; if dependencies are not injected yet, return empty.
        guard service.isRunning || service.isA2ARegistered else {
            onlineAgents = []
            return
        }
        onlineAgents = await service.listAgents(silent: true)
    }

    func refreshAll() {
        Task { @MainActor in
            await asyncRefreshAll()
        }
    }

    private func asyncRefreshAll() async {
        // Run all checks concurrently
        async let trios: Void = checkTriosAsync()
        async let mcp: Void = checkMCPAsync()
        async let agent: Void = checkAgentAsync()
        async let cron: Void = checkCronAsync()
        async let a2a: Void = checkA2AAsync()
        async let funnel: Void = checkFunnelAsync()
        async let git: Void = checkGitAsync()
        async let build: Void = checkBuildAsync()
        async let improve: Void = checkSelfImprovementAsync()
        async let mesh: Void = checkMeshAsync()
        async let localAuth: Void = checkLocalAuthAsync()

        _ = await (trios, mcp, agent, cron, a2a, funnel, git, build, improve, mesh, localAuth)

        loadSkills()
        await loadAgents()
        await loadOnlineAgents()
        await loadLogTailAsync()
        computeOverallStatus()
    }

    // MARK: - Component Checks

    // MARK: - Async Component Checks

    private func checkTriosAsync() async {
        let running = await isTriosRunning()
        updateComponent(name: "TRIOS", icon: "macwindow", status: running ? .healthy : .down, detail: running ? "Running" : "Stopped", action: running ? nil : "Start")
    }

    /// Robust check: NSRunningApplication by bundle ID, then pgrep for both `trios` and `trios_app`.
    private func isTriosRunning() async -> Bool {
        // Method 1: NSRunningApplication (catches .app bundle launches where process name is `trios`)
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.browseros.trios")
        if !apps.isEmpty { return true }

        // Method 2: pgrep for both possible binary names
        let r1 = await runAsync("/usr/bin/pgrep", arguments: ["-x", "trios"]).isEmpty == false
        let r2 = await runAsync("/usr/bin/pgrep", arguments: ["-x", "trios_app"]).isEmpty == false
        return r1 || r2
    }

    private func checkMCPAsync() async {
        let code = await runAsync("/usr/bin/curl", arguments: ["-s", "-o", "/dev/null", "-w", "%{http_code}", ProjectPaths.browserOSHealthURL])
        let healthy = code == "200"
        updateComponent(name: "MCP", icon: "server.rack", status: healthy ? .healthy : .down, detail: healthy ? "Online" : "Offline", action: healthy ? "Restart" : "Start")
    }

    private func checkAgentAsync() async {
        let code = await runAsync("/usr/bin/curl", arguments: ["-s", "-o", "/dev/null", "-w", "%{http_code}", ProjectPaths.agentHealthURL])
        let healthy = code == "200"
        updateComponent(name: "Agent", icon: "cpu", status: healthy ? .healthy : .down, detail: healthy ? "Online" : "Offline", action: healthy ? "Restart" : "Start")
    }

    private func checkCronAsync() async {
        let fm = FileManager.default
        guard fm.fileExists(atPath: statePath) else {
            updateComponent(name: "Cron", icon: "clock.arrow.circlepath", status: .unknown, detail: "No state", action: "Run")
            return
        }
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: statePath))
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let ts = json["ts"] as? TimeInterval {
                let lastWake = Date(timeIntervalSince1970: ts)
                let minutes = Int(Date().timeIntervalSince(lastWake) / 60)
                let health = json["health"] as? String ?? "?"
                let build = json["build"] as? String ?? "?"
                let dirty = json["dirty"] as? Int ?? 0

                let status: ComponentStatus
                let detail: String
                if minutes < 20 {
                    status = health == "ok" ? .healthy : .warning
                    detail = "\(minutes)m ago  /  build \(build)  /  dirty \(dirty)"
                } else {
                    status = .warning
                    detail = "\(minutes)m ago (stale)"
                }
                updateComponent(name: "Cron", icon: "clock.arrow.circlepath", status: status, detail: detail, action: "Run")
            } else {
                updateComponent(name: "Cron", icon: "clock.arrow.circlepath", status: .unknown, detail: "Invalid state", action: "Run")
            }
        } catch {
            updateComponent(name: "Cron", icon: "clock.arrow.circlepath", status: .unknown, detail: "Error", action: "Run")
        }
    }

    private func checkMeshAsync() async {
        let code = await runAsync("/usr/bin/curl", arguments: ["-s", "-o", "/dev/null", "-w", "%{http_code}", ProjectPaths.meshHealthURL])
        let healthy = code == "200"
        updateComponent(name: "Mesh", icon: "antenna.radiowaves.left.and.right", status: healthy ? .healthy : .down, detail: healthy ? "Online" : "Offline", action: healthy ? "Restart" : "Start")
    }

    private func checkLocalAuthAsync() async {
        let (state, meta) = await LocalAuthMonitor.shared.status()
        let status: ComponentStatus
        let detail: String
        let action: String?
        switch state {
        case .cached:
            status = .healthy
            if let fetchedAt = meta.fetchedAt {
                detail = "\(timeAgo(fetchedAt)) / \(meta.retry403Count) retries"
            } else {
                detail = "cached"
            }
            action = "Refresh"
        case .refreshing:
            status = .warning
            detail = "refreshing..."
            action = nil
        case .failed:
            status = .down
            detail = meta.lastFailureReason ?? "failed"
            action = "Reset"
        case .missing, .unknown:
            status = .unknown
            detail = "not fetched"
            action = "Refresh"
        }
        updateComponent(name: "Local Auth", icon: "key.horizontal", status: status, detail: detail, action: action)
    }

    private func checkA2AAsync() async {
        let fm = FileManager.default
        let agentsDir = ProjectPaths.claude("agents")
        var count = 0
        if let entries = try? fm.contentsOfDirectory(atPath: agentsDir) {
            count = entries.filter { $0.hasSuffix(".md") }.count
        }
        let detail = count > 0 ? "\(count) agents" : "No agents"
        updateComponent(name: "A2A", icon: "network", status: count > 0 ? .healthy : .warning, detail: detail, action: nil)
    }

    private func checkFunnelAsync() async {
        let running = await runAsync("/usr/bin/pgrep", arguments: ["-x", "tailscale"]).isEmpty == false
        updateComponent(name: "Funnel", icon: "globe", status: running ? .healthy : .warning, detail: running ? "Tailscale active" : "Not running", action: nil)
    }

    private func checkGitAsync() async {
        let branch = await runAsync("/usr/bin/git", arguments: ["branch", "--show-current"])
        let dirty = await runAsync("/usr/bin/git", arguments: ["status", "--porcelain"])
        let dirtyCount = dirty.split(separator: "\n").count
        let status: ComponentStatus = dirtyCount > 0 ? .warning : .healthy
        let detail = "\(branch) / \(dirtyCount) dirty"
        updateComponent(name: "Git", icon: "arrow.triangle.branch", status: status, detail: detail, action: nil)
    }

    private func checkBuildAsync() async {
        // A whole-codebase typecheck is slow by nature; bound it explicitly so a
        // wedged compiler cannot stall the status refresh.
        let result = await runAsync(
            "/usr/bin/swiftc",
            arguments: ["-typecheck", "main.swift", "rings/**/*.swift", "BR-OUTPUT/*.swift"],
            timeout: 60
        )
        let ok = result.trimmingCharacters(in: .whitespaces).isEmpty
        updateComponent(name: "Build", icon: "hammer", status: ok ? .healthy : .down, detail: ok ? "OK" : "Errors", action: nil)
    }

    private func checkSelfImprovementAsync() async {
        let fm = FileManager.default
        let auditDir = "\(projectRoot)/.trinity/audit"
        var findings = 0
        var lastAudit: Date? = nil
        var passed = true

        if let entries = try? fm.contentsOfDirectory(atPath: auditDir) {
            let jsons = entries.filter { $0.hasSuffix(".json") }
            findings = jsons.count
            for name in jsons {
                let path = "\(auditDir)/\(name)"
                if let attr = try? fm.attributesOfItem(atPath: path),
                   let mod = attr[.modificationDate] as? Date {
                    if lastAudit == nil || mod > lastAudit! {
                        lastAudit = mod
                    }
                }
            }
        }

        let budgetPath = "\(projectRoot)/.trinity/state/safety_budget.json"
        var budgetText = "-"
        if let data = try? Data(contentsOf: URL(fileURLWithPath: budgetPath)),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let budget = json["budget"] as? Double,
           let halted = json["halted"] as? Bool {
            budgetText = halted ? "HALTED (\(budget))" : "\(budget)"
            if halted || budget <= 0 { passed = false }
        }

        let ago = lastAudit.map { timeAgo($0) } ?? "Never"
        let critique = findings > 0 ? "\(findings) audits on record" : "No audits yet"

        self.selfImprovement = SelfImprovementStatus(
            score: passed ? 100 : max(0, 100 - findings * 10),
            openIssues: findings,
            lastAuditAgo: ago,
            safetyBudget: budgetText,
            lastCritique: critique,
            pendingPRs: 0
        )

        if let last = lastAudit {
            auditHistory.append(AuditRecord(timestamp: last, findings: findings, passed: passed))
            if auditHistory.count > 10 {
                auditHistory.removeFirst(auditHistory.count - 10)
            }
        }
    }

    private func timeAgo(_ date: Date) -> String {
        let minutes = Int(Date().timeIntervalSince(date) / 60)
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        return "\(hours / 24)d ago"
    }

    private func loadLogTailAsync() async {
        let fm = FileManager.default
        guard fm.fileExists(atPath: logPath),
              let data = fm.contents(atPath: logPath),
              let text = String(data: data, encoding: .utf8) else {
            lastLogLines = ["No cron log found"]
            return
        }
        lastLogLines = text.split(separator: "\n").suffix(20).map { String($0) }
        if lastLogLines.isEmpty {
            lastLogLines = ["Log empty"]
        }
    }

    // MARK: - Agent Management

    /// Async so the per-agent `pgrep`/`ps` probes run off the main actor. The
    /// previous synchronous version issued up to eight blocking subprocesses
    /// while holding the main thread.
    func loadAgents() async {
        let agentNames = ["clade-monitor", "clade-dashboard", "clade-meshd", "cron-queen"]
        var result: [AgentInfo] = []
        for name in agentNames {
            let pid = Int(await runAsync("/usr/bin/pgrep", arguments: ["-x", name], timeout: 5))
            let status: ComponentStatus = pid != nil ? .healthy : .down
            let uptime: String
            if let pid = pid {
                uptime = await runAsync("/bin/ps", arguments: ["-o", "etime=", "-p", String(pid)], timeout: 5)
            } else {
                uptime = "-"
            }
            result.append(AgentInfo(
                name: name,
                status: status,
                pid: pid,
                uptime: uptime,
                lastAction: nil
            ))
        }
        agents = result
    }

    func startAgent(_ name: String) {
        let binMap: [String: (String, [String])] = [
            "clade-monitor": ("/usr/bin/env", ["cargo", "run", "--bin", "clade-monitor"]),
            "clade-dashboard": ("/usr/bin/env", ["cargo", "run", "--bin", "clade-dashboard"]),
            "clade-meshd": ("/usr/bin/env", ["cargo", "run", "--bin", "clade-meshd"]),
        ]
        guard let (exe, args) = binMap[name] else {
            NSLog("[QueenStatus] BLOCKED: unknown agent: \(name)")
            return
        }
        isRunningAction = true
        execDirect(exe, arguments: args)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            Task { @MainActor [weak self] in
                await self?.loadAgents()
                self?.isRunningAction = false
            }
        }
    }

    func stopAgent(_ name: String) {
        let knownAgents: Set<String> = ["clade-monitor", "clade-dashboard", "clade-meshd", "cron-queen"]
        guard knownAgents.contains(name) else {
            NSLog("[QueenStatus] BLOCKED: unknown agent name: \(name)")
            return
        }
        isRunningAction = true
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        task.arguments = ["-x", name]
        do {
            try task.run()
            task.waitUntilExit()
        } catch {
            NSLog("[QueenStatus] Failed to run pkill: \(error)")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            Task { @MainActor [weak self] in
                await self?.loadAgents()
                self?.isRunningAction = false
            }
        }
    }

    func restartAgent(_ name: String) {
        stopAgent(name)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.startAgent(name)
        }
    }

    // MARK: - Shell Helpers

    // MARK: - Tokenized Process Helpers

    /// Runs an executable off the main actor and returns trimmed stdout.
    /// Never invokes a shell. All arguments are passed literally to the process.
    ///
    /// `nonisolated static` is the whole point. This type is `@MainActor`, so an
    /// *instance* method awaited from inside `Task.detached` hops straight back
    /// to the main actor and blocks it. That hop froze the entire UI whenever a
    /// probe was slow - a contended `git status` or the `swiftc -typecheck`
    /// build check was enough to make the app show "Application Not Responding".
    ///
    /// The pipe is drained before waiting on exit, because a child that fills
    /// the pipe buffer blocks forever if you wait first and read afterwards. A
    /// watchdog terminates a child that overruns `timeout`, so no external
    /// command can wedge status reporting again.
    nonisolated static func runProcess(
        _ executable: String,
        arguments: [String],
        workDir: String,
        timeout: TimeInterval = 20
    ) -> String {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: executable)
        task.arguments = arguments
        task.currentDirectoryURL = URL(fileURLWithPath: workDir)

        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe

        do {
            try task.run()
        } catch {
            return ""
        }

        let watchdog = DispatchWorkItem {
            if task.isRunning {
                task.terminate()
                kill(task.processIdentifier, SIGKILL)
                NSLog("[QueenStatus] process.timeout: \(executable) exceeded \(Int(timeout))s")
                TriosLogBus.shared.warn(
                    .queen,
                    "process.timeout",
                    "\(executable) exceeded \(Int(timeout))s",
                    ["executable": executable, "seconds": String(Int(timeout))]
                )
                try? pipe.fileHandleForReading.close()
            }
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: watchdog)

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        watchdog.cancel()

        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    /// Main-actor convenience wrapper. Prefer `runAsync`; this still blocks the
    /// caller, but the watchdog bounds how long it can.
    private func run(_ executable: String, arguments: [String], workDir: String? = nil) -> String {
        Self.runProcess(
            executable,
            arguments: arguments,
            workDir: workDir ?? projectRoot,
            timeout: 5
        )
    }

    private func runAsync(
        _ executable: String,
        arguments: [String],
        workDir: String? = nil,
        timeout: TimeInterval = 20
    ) async -> String {
        let root = workDir ?? projectRoot
        return await Task.detached(priority: .utility) {
            Self.runProcess(executable, arguments: arguments, workDir: root, timeout: timeout)
        }.value
    }

    private func updateComponent(name: String, icon: String, status: ComponentStatus, detail: String, action: String?) {
        if let index = components.firstIndex(where: { $0.name == name }) {
            components[index] = StatusComponent(name: name, icon: icon, status: status, detail: detail, actionLabel: action)
        } else {
            components.append(StatusComponent(name: name, icon: icon, status: status, detail: detail, actionLabel: action))
        }
    }

    private func computeOverallStatus() {
        let statuses = components.map { $0.status }
        if statuses.contains(.down) {
            overallStatus = .down
        } else if statuses.contains(.warning) {
            overallStatus = .warning
        } else if statuses.allSatisfy({ $0 == .healthy }) && !components.isEmpty {
            overallStatus = .healthy
        } else {
            overallStatus = .unknown
        }
    }

    // MARK: - Skills

    private func loadSkills() {
        let skillNames = ["/tri", "/doctor", "/god-mode", "/bridge"]
        var result: [SkillRun] = []
        for name in skillNames {
            if let existing = skills.first(where: { $0.name == name }) {
                result.append(existing)
            } else {
                result.append(SkillRun(name: name, lastRun: nil, success: nil, isRunning: false))
            }
        }
        skills = result
    }

    // MARK: - Actions

    func startTrios() {
        Task { @MainActor in
            guard await !isTriosRunning() else {
                NSLog("[QueenStatus] startTrios blocked: TRIOS is already running")
                refreshAll()
                return
            }
            isRunningAction = true
            // Launch via the .app bundle so macOS single-instance semantics apply
            // and RecursionGuard/NSRunningApplication can detect duplicates.
            let bundlePath = "\(projectRoot)/trios.app"
            execDirect("/usr/bin/open", arguments: [bundlePath])
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                self?.refreshAll()
                self?.isRunningAction = false
            }
        }
    }

    func stopTrios() {
        isRunningAction = true
        // Use pid-based termination instead of `pkill -f` regexes, which can
        // match unrelated processes whose command line contains the same
        // substring. Discover both the bare binary and the .app bundle binary.
        terminateProcesses(named: "trios")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.refreshAll()
            self?.isRunningAction = false
        }
    }

    func restartMCP() {
        isRunningAction = true
        terminateProcesses(named: "bun", matchingArguments: ["start:server"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            let bunPath = ProcessInfo.processInfo.environment["TRIOS_BUN_PATH"] ?? "/opt/homebrew/bin/bun"
            self?.execDirect(bunPath, arguments: ["run", "start:server"], workDir: self?.projectRoot)
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                self?.refreshAll()
                self?.isRunningAction = false
            }
        }
    }

    func restartAgentServer() {
        isRunningAction = true
        terminateProcesses(named: "bun", matchingArguments: ["start:agent"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            let bunPath = ProcessInfo.processInfo.environment["TRIOS_BUN_PATH"] ?? "/opt/homebrew/bin/bun"
            self?.execDirect(bunPath, arguments: ["run", "start:agent"], workDir: self?.projectRoot)
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                self?.refreshAll()
                self?.isRunningAction = false
            }
        }
    }

    /// Terminates processes whose executable base name matches `name` and whose
    /// full argument list contains every token in `matchingArguments`.
    /// Avoids `pkill -f` regexes that can collide with unrelated command lines.
    private func terminateProcesses(named name: String, matchingArguments: [String] = []) {
        let knownPIDs = Self.listMatchingPIDs(named: name, arguments: matchingArguments)
        for pid in knownPIDs {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/kill")
            task.arguments = ["-9", String(pid)]
            do {
                try task.run()
                task.waitUntilExit()
            } catch {
                NSLog("[QueenStatus] Failed to kill pid \(pid): \(error)")
            }
        }
    }

    /// Lists PIDs by scanning `/bin/ps -eo pid,comm,args` and matching the
    /// executable base name plus an optional argument filter.
    private static func listMatchingPIDs(named name: String, arguments: [String]) -> [Int] {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-eo", "pid,comm,args"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
            task.waitUntilExit()
        } catch {
            return []
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let text = String(data: data, encoding: .utf8) else { return [] }

        var pids: [Int] = []
        for line in text.split(separator: "\n").dropFirst() { // skip header
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let tokens = trimmed.split(separator: " ", omittingEmptySubsequences: true)
            guard tokens.count >= 2,
                  let pid = Int(tokens[0]) else { continue }
            let comm = String(tokens[1])
            let args = tokens.dropFirst(2).map(String.init)
            let commMatches = (comm as NSString).lastPathComponent == name
            let argsMatch = arguments.allSatisfy { arg in args.contains(arg) }
            if commMatches && argsMatch {
                pids.append(pid)
            }
        }
        return pids
    }

    func runCron() {
        isRunningAction = true
        guard let cargo = CommandResolver.executableURL(for: "cargo") else {
            NSLog("[QueenStatus] cargo not found; set TRIOS_CARGO_PATH")
            isRunningAction = false
            return
        }
        execDirect(cargo.path, arguments: ["run", "--bin", "clade-monitor"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.refreshAll()
            self?.isRunningAction = false
        }
    }

    func refreshLocalAuth() {
        isRunningAction = true
        Task { @MainActor [weak self] in
            let success = await LocalAuthUIManager.shared.refreshLocalAuth()
            self?.updateComponent(
                name: "Local Auth",
                icon: "key.horizontal",
                status: success ? .healthy : .down,
                detail: success ? "refreshed" : "refresh failed",
                action: success ? "Refresh" : "Reset"
            )
            self?.computeOverallStatus()
            self?.isRunningAction = false
        }
    }

    func resetLocalAuth() {
        isRunningAction = true
        Task { @MainActor [weak self] in
            await LocalAuthUIManager.shared.resetLocalAuth()
            self?.updateComponent(
                name: "Local Auth",
                icon: "key.horizontal",
                status: .unknown,
                detail: "reset",
                action: "Refresh"
            )
            self?.computeOverallStatus()
            self?.isRunningAction = false
        }
    }

    private static let knownSkills: Set<String> = ["/tri", "/doctor", "/god-mode", "/bridge"]

    func runSkill(name: String) {
        guard Self.knownSkills.contains(name) else {
            NSLog("[QueenStatus] BLOCKED: unknown skill: \(name)")
            return
        }
        guard let index = skills.firstIndex(where: { $0.name == name }) else { return }
        skills[index] = SkillRun(name: name, lastRun: skills[index].lastRun, success: skills[index].success, isRunning: true)
        objectWillChange.send()

        guard let claude = CommandResolver.executableURL(for: "claude") else {
            NSLog("[QueenStatus] claude not found; set TRIOS_CLAUDE_PATH")
            if let idx = skills.firstIndex(where: { $0.name == name }) {
                skills[idx] = SkillRun(name: name, lastRun: skills[idx].lastRun, success: false, isRunning: false)
                objectWillChange.send()
            }
            return
        }
        execDirect(claude.path, arguments: [name])
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            if let idx = self?.skills.firstIndex(where: { $0.name == name }) {
                self?.skills[idx] = SkillRun(name: name, lastRun: Date(), success: true, isRunning: false)
                self?.objectWillChange.send()
            }
            self?.refreshAll()
        }
    }

    /// Runs a known Queen skill through the local `claude` CLI, captures stdout/stderr,
    /// and returns the combined output so it can be appended to the Queen chat timeline.
    /// - Parameters:
    ///   - name: The skill name (e.g. `/doctor`).
    ///   - arguments: Extra CLI arguments placed before the skill name (e.g. `["--model", "sonnet"]`).
    ///   - timeout: Maximum seconds to wait for the process.
    /// - Returns: Captured output, plus any timeout/exit status annotations.
    func runSkillReturningOutput(name: String, arguments: [String] = [], timeout: TimeInterval = 30) async -> String {
        guard Self.knownSkills.contains(name) else {
            return "Unknown Queen skill: \(name)"
        }
        guard let claude = CommandResolver.executableURL(for: "claude") else {
            return "Claude CLI not found. Set `TRIOS_CLAUDE_PATH` to run \(name)."
        }
        guard let index = skills.firstIndex(where: { $0.name == name }) else {
            return "Skill \(name) is not initialized."
        }

        skills[index] = SkillRun(name: name, lastRun: skills[index].lastRun, success: skills[index].success, isRunning: true)
        objectWillChange.send()

        let cwd = projectRoot
        let output = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let task = Process()
                task.executableURL = claude
                task.arguments = arguments + [name]
                task.currentDirectoryURL = URL(fileURLWithPath: cwd)
                let outPipe = Pipe()
                let errPipe = Pipe()
                task.standardOutput = outPipe
                task.standardError = errPipe

                var captured = ""
                var timedOut = false
                do {
                    try task.run()
                    let deadline = Date().addingTimeInterval(timeout)
                    while task.isRunning && Date() < deadline {
                        Thread.sleep(forTimeInterval: 0.05)
                    }
                    if task.isRunning {
                        task.terminate()
                        timedOut = true
                        Thread.sleep(forTimeInterval: 0.2)
                    }
                    let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
                    let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
                    let out = String(data: outData, encoding: .utf8) ?? ""
                    let err = String(data: errData, encoding: .utf8) ?? ""
                    captured = out
                    if !err.isEmpty {
                        captured += "\n[stderr]\n" + err
                    }
                    if timedOut {
                        captured += "\n[skill timed out after \(Int(timeout))s]"
                    } else if task.terminationStatus != 0 {
                        captured += "\n[exit code \(task.terminationStatus)]"
                    }
                } catch {
                    captured = "Failed to run \(name): \(error.localizedDescription)"
                }

                continuation.resume(returning: captured)
            }
        }

        if let idx = skills.firstIndex(where: { $0.name == name }) {
            let success = !output.hasPrefix("Failed to run") && !output.contains("[skill timed out")
            skills[idx] = SkillRun(name: name, lastRun: Date(), success: success, isRunning: false)
        }
        objectWillChange.send()
        refreshAll()
        return output
    }

    /// Centralized command validation used by `runCommand` and unit tests.
    /// Keeps policy constants out of the main actor class so they can be tested
    /// without spinning up UI state.
    internal struct CommandSecurityPolicy {
        /// Exact commands allowed for direct execution with no file-system arguments.
        static let exactAllowedCommands: Set<String> = [
            "git status", "git log", "git diff", "git branch",
            "cargo check", "cargo build", "swift --version",
            "pgrep", "ps aux"
        ]

        /// Commands that may read files but only under the project root or the
        /// `.trinity` Application Support directory.
        static let fileCommandNames: Set<String> = ["cat", "ls", "wc", "tail", "head"]

        /// Substrings that are never allowed in user-typed commands, regardless of
        /// allowlist match. These block shell metacharacters, traversal, path
        /// expansion, and dangerous invocations like `pkill -f`.
        static let commandDenylist: [String] = [
            ";", "&&", "||", "|", "`", "$(", "${", ">", "<", "~", "..",
            "rm -rf", "\n", "\r", "$'", "pkill -f", "/bin/zsh -c", "sudo ",
            ">>", "curl -s http://127.0.0.1: |", "bash -c", "sh -c"
        ]

        /// Validates that a user-typed command is allowed by the exact list or
        /// by the file-reader path policy. Returns the command name and its
        /// arguments if valid, otherwise nil.
        static func validate(_ command: String) -> (name: String, arguments: [String])? {
            let trimmed = command.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { return nil }

            for forbidden in commandDenylist where trimmed.contains(forbidden) {
                return nil
            }

            let components = trimmed.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
            let base = components.first.map(String.init) ?? trimmed
            let argument = components.dropFirst().first.map(String.init)

            if exactAllowedCommands.contains(trimmed) {
                return (base, [])
            }

            if fileCommandNames.contains(base),
               let arg = argument,
               !arg.contains(" "),
               isAllowedFilePath(arg) {
                return (base, [arg])
            }

            return nil
        }

        /// Validates that a file-command argument stays within allowed roots and
        /// does not point to well-known sensitive host paths.
        static func isAllowedFilePath(_ argument: String) -> Bool {
            let expanded = (argument as NSString).expandingTildeInPath
            let absolute: String
            if expanded.hasPrefix("/") {
                absolute = expanded
            } else {
                absolute = "\(ProjectPaths.root)/\(expanded)"
            }
            let standardized = (absolute as NSString).standardizingPath
            let lower = standardized.lowercased()

            let forbidden = [
                ".ssh", ".aws", ".gnupg", ".docker", ".kube", ".env", ".envrc",
                ".zshrc", ".bashrc", ".bash_profile", ".profile",
                "authorized_keys", "known_hosts", "login.keychain",
                "/etc/", "/var/", "/tmp/", "/dev/", "/bin/", "/usr/bin/"
            ]
            guard !forbidden.contains(where: { lower.contains($0) }) else { return false }

            let trinityPath = ProjectPaths.trinity
            return standardized.hasPrefix(ProjectPaths.root) || standardized.hasPrefix(trinityPath)
        }
    }

    /// Runs a user-typed command using a fixed executable path and literal argv.
    /// The previous `/usr/bin/env` dispatcher resolved the first token via PATH,
    /// which is PATH-spoofable. We now resolve known commands to absolute system
    /// paths and reject anything else.
    func runCommand(_ cmd: String) {
        let trimmed = cmd.trimmingCharacters(in: .whitespaces)

        // Parse KEY=value env assignments first, then validate only the actual
        // command. This keeps `FOO=bar git status` allowed while preventing
        // attackers from sneaking a new executable in via an env token.
        var envOverrides: [String: String] = [:]
        let commandTokens = trimmed.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        var commandStart = 0
        for (i, token) in commandTokens.enumerated() {
            let parts = token.split(separator: "=", maxSplits: 1)
            if parts.count == 2, !parts[0].isEmpty {
                let key = String(parts[0])
                let value = String(parts[1])
                // Reject values that contain shell metacharacters or traversal.
                guard Self.isSafeEnvValue(value) else {
                    NSLog("[QueenStatus] BLOCKED unsafe env value for \(key)")
                    return
                }
                envOverrides[key] = value
                commandStart = i + 1
            } else {
                break
            }
        }
        guard commandStart < commandTokens.count else {
            NSLog("[QueenStatus] BLOCKED command with only env assignments")
            return
        }

        let commandName = commandTokens[commandStart]
        let arguments = Array(commandTokens[(commandStart + 1)...])
        let commandTail = ([commandName] + arguments).joined(separator: " ")

        // Use the testable security policy to reject dangerous or unlisted input.
        guard let validated = CommandSecurityPolicy.validate(commandTail) else {
            NSLog("[QueenStatus] BLOCKED command: \(trimmed)")
            return
        }

        // The policy returned the canonical base name; the tokenized command
        // name must match it so env assignments cannot switch the executable.
        guard commandName == validated.name else {
            NSLog("[QueenStatus] BLOCKED command name mismatch")
            return
        }

        // File-reader commands already verified their single path above; block
        // any attempt to add extra flags or additional paths.
        if CommandSecurityPolicy.fileCommandNames.contains(commandName), arguments.count != 1 {
            NSLog("[QueenStatus] BLOCKED file command with wrong argument count")
            return
        }

        guard let executableURL = CommandResolver.executableURL(for: commandName) else {
            NSLog("[QueenStatus] BLOCKED unknown executable: \(commandName)")
            return
        }

        // Defensive: every resolved executable must be a regular file (not a
        // symlink) and must not live in a user-writable directory. This blocks
        // PATH-spoofing and symlink-based binary replacement.
        guard Self.isTrustedExecutable(executableURL) else {
            NSLog("[QueenStatus] BLOCKED untrusted executable path: \(executableURL.path)")
            return
        }

        isRunningAction = true
        var environment = ProcessInfo.processInfo.environment
        for (k, v) in envOverrides {
            environment[k] = v
        }
        execDirect(executableURL.path, arguments: arguments, environment: environment)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            Task { @MainActor [weak self] in
                await self?.loadLogTailAsync()
                self?.isRunningAction = false
            }
        }
    }

    /// Validates that an executable path is a regular file and resides under a
    /// trusted system directory. Rejects symlinks and user-writable locations.
    private static func isTrustedExecutable(_ url: URL) -> Bool {
        let fm = FileManager.default
        let path = url.path
        let trustedRoots = ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"]
        guard trustedRoots.contains(where: { path.hasPrefix($0) }) else { return false }
        var isDirectory: ObjCBool = false
        guard fm.fileExists(atPath: path, isDirectory: &isDirectory),
              !isDirectory.boolValue else { return false }
        do {
            let attrs = try fm.attributesOfItem(atPath: path)
            let type = attrs[.type] as? FileAttributeType
            guard type == .typeRegular else { return false }
        } catch {
            return false
        }
        return true
    }

    private func execDirect(_ executable: String, arguments: [String], workDir: String? = nil, environment: [String: String]? = nil) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: executable)
        task.arguments = arguments
        task.currentDirectoryURL = URL(fileURLWithPath: workDir ?? projectRoot)
        if let environment {
            task.environment = environment
        }
        do {
            try task.run()
        } catch {
            NSLog("[QueenStatus] execDirect failed (\(executable)): \(error)")
        }
    }

    /// Allowed env-value characters: alphanumerics, dash, dot, colon, slash,
    /// and underscore. This prevents injecting additional argv tokens or shell
    /// metacharacters through an env assignment like `KEY="1; rm -rf /"`. // AGENT-V-WAIVER: documented dangerous example
    private static func isSafeEnvValue(_ value: String) -> Bool {
        let allowed = CharacterSet.alphanumerics
            .union(CharacterSet(charactersIn: "-./:_"))
        return value.rangeOfCharacter(from: allowed.inverted) == nil
    }

    /// Maps allowed command names to fixed, absolute executables so we never rely
    /// on PATH resolution for the binary itself.
    ///
    /// Internal rather than file-private because `SkillStore` runs skills through
    /// the same allow-list. Two copies of a security boundary is one copy that
    /// gets an exception added to it and nobody notices.
    enum CommandResolver {
        static func executableURL(for name: String) -> URL? {
            switch name {
            case "git": return URL(fileURLWithPath: "/usr/bin/git")
            case "cargo": return resolveCargo()
            case "curl": return URL(fileURLWithPath: "/usr/bin/curl")
            case "swift": return URL(fileURLWithPath: "/usr/bin/swift")
            case "cat": return URL(fileURLWithPath: "/bin/cat")
            case "ls": return URL(fileURLWithPath: "/bin/ls")
            case "wc": return URL(fileURLWithPath: "/usr/bin/wc")
            case "tail": return URL(fileURLWithPath: "/usr/bin/tail")
            case "head": return URL(fileURLWithPath: "/usr/bin/head")
            case "pgrep": return URL(fileURLWithPath: "/usr/bin/pgrep")
            case "ps": return URL(fileURLWithPath: "/bin/ps")
            case "claude": return resolveClaude()
            case "kill": return URL(fileURLWithPath: "/bin/kill")
            default: return nil
            }
        }

        private static func resolveCargo() -> URL? {
            let env = ProcessInfo.processInfo.environment
            let candidates = [
                env["TRIOS_CARGO_PATH"],
                "/usr/local/bin/cargo",
                "/opt/homebrew/bin/cargo"
            ].compactMap { $0 }
            return candidates
                .first { FileManager.default.isExecutableFile(atPath: $0) }
                .map { URL(fileURLWithPath: $0) }
        }

        private static func resolveClaude() -> URL? {
            let env = ProcessInfo.processInfo.environment
            let candidates = [
                env["TRIOS_CLAUDE_PATH"],
                "/usr/local/bin/claude",
                "/opt/homebrew/bin/claude"
            ].compactMap { $0 }
            return candidates
                .first { FileManager.default.isExecutableFile(atPath: $0) }
                .map { URL(fileURLWithPath: $0) }
        }
    }
}
