// AGENT-V-WAIVER: https://github.com/browseros-ai/BrowserOS/issues/2023
// Reason: Queen direct-chat hardening — resilient A2A stream reconnect loop with
// exponential backoff to survive transient registry/network errors.
import Foundation

/// Delegate for UI-layer updates from QueenBackgroundService.
/// The delegate is held weakly so view models can come and go without
/// killing the background service.
@MainActor
protocol QueenBackgroundServiceDelegate: AnyObject {
    /// Called when an inbound A2A message should be appended to the Queen
    /// conversation timeline.
    func queenBackgroundService(
        _ service: QueenBackgroundService,
        didReceiveA2AMessage message: ChatMessage
    )

    /// Called when the proposal list or audit state changed.
    func queenBackgroundServiceDidUpdateState(_ service: QueenBackgroundService)
}

/// App-level background service that owns long-running Queen agents.
/// It outlives any single ChatViewModel so that switching conversations
/// or closing/reopening the panel does not stop A2A listening or the
/// self-improvement audit loop.
@MainActor
final class QueenBackgroundService: ObservableObject {
    static let shared = QueenBackgroundService()

    @Published private(set) var isRunning = false
    @Published private(set) var isA2ARegistered = false
    @Published private(set) var lastAudit: QueenAuditEvent?
    @Published private(set) var proposals: [QueenProposal] = []

    /// How often the Queen wakes, walks the delegation registry, and writes a
    /// report to the master chat. Default is 30 minutes (1800 s). Override at
    /// launch with the `TRIOS_QUEEN_REPORT_SECONDS` environment variable.
    @Published var reportingIntervalSeconds: TimeInterval = {
        if let raw = ProcessInfo.processInfo.environment["TRIOS_QUEEN_REPORT_SECONDS"],
           let seconds = TimeInterval(raw), seconds > 0 {
            return seconds
        }
        return 30 * 60
    }()

    private var queenService: QueenSelfImprovementService?
    private var a2aClient: A2ARegistryClient?
    private var persister: ChatPersisterProtocol?
    private var auditLoopTask: Task<Void, Never>?
    private var a2aStreamTask: Task<Void, Never>?
    private var a2aRouter: A2AMessageRouter?
    private var a2aReconnectAttempt = 0
    private let maxA2AReconnectAttempts = 5
    private var a2aStreamHealthy = false

    /// Background task that wakes the Queen on `reportingIntervalSeconds` and
    /// walks the delegation registry to produce a conversational report.
    private var reportLoopTask: Task<Void, Never>?

    /// Snapshot of the last report's state fingerprint. When a new wake
    /// produces the same signature the Queen says so in one line instead of
    /// repeating the previous report.
    private var lastReportSignature: String?

    /// Text of the most recent registry report — the full prose when the
    /// swarm changed, or the "nothing has changed" one-liner when it did
    /// not. The self-test reads this to log what the Queen actually said
    /// without parsing the chat transcript.
    @Published private(set) var lastReportText: String?

    /// Whether at least one report has been posted since `start()`. The first
    /// report in a process is always full — "nothing has changed" is only
    /// possible after a prior report in the same process.
    private var hasReportedInProcess = false

    /// Whether the most recent report was the "nothing has changed" one-liner
    /// rather than a full digest. The self-test reads this to distinguish a
    /// deduped report from a full one without parsing prose.
    @Published private(set) var lastReportWasOneLiner: Bool?

    weak var delegate: QueenBackgroundServiceDelegate?

    private init() {}

    // MARK: - Autonomous Chat Operations

    /// List every persisted conversation, including the reserved Queen chat.
    func listChats() async -> [ChatConversation] {
        var all = await persister?.listAllConversations() ?? []
        if !all.contains(where: { $0.id == ChatConversation.trinityQueenId }) {
            all.insert(.trinityQueen, at: 0)
            await persister?.save(messages: [], conversationId: ChatConversation.trinityQueenId)
        }
        return all
    }

    /// Create a new conversation and return its id. Does not switch the UI.
    func createChat(title: String? = nil) async -> UUID {
        let id = UUID()
        let chat = ChatConversation(
            id: id,
            title: title ?? "New Chat",
            isPinned: false,
            icon: "message.fill",
            updatedAt: Date(),
            unreadCount: 0,
            isReserved: false
        )
        await persister?.save(messages: [], conversationId: id)
        if let title, !title.isEmpty {
            await persister?.renameConversation(id: id, title: ConversationTitlePolicy.normalized(title))
        }
        await appendQueenSystemMessage("Created conversation \(id.uuidString.prefix(8)) — \(chat.title)")
        return id
    }

    /// Append a message to any conversation from the background.
    func postToChat(id: UUID, role: ChatRole, content: String) async {
        let message = ChatMessage(role: role, content: content)
        var history = await persister?.load(conversationId: id) ?? []
        history.append(message)
        await persister?.save(messages: history, conversationId: id)
        if id == ChatConversation.trinityQueenId {
            delegate?.queenBackgroundService(self, didReceiveA2AMessage: message)
        }
    }

    /// Assign a task to an online agent via A2A.
    func delegateTask(agentId: String, description: String) async {
        guard let client = a2aClient else {
            await appendQueenSystemMessage("A2A client not configured; cannot delegate task.")
            return
        }
        let task = AgentTask(
            id: UUID(),
            title: description,
            description: description,
            state: .pending,
            priority: .medium,
            assignee: AgentId(agentId),
            createdAt: ISO8601DateFormatter().string(from: Date()),
            updatedAt: ISO8601DateFormatter().string(from: Date()),
            result: nil
        )
        do {
            try await client.assignTask(task, to: AgentId(agentId))
            await appendQueenSystemMessage("Delegated task to \(agentId): \(description)")
        } catch {
            await appendQueenSystemMessage("Failed to delegate task to \(agentId): \(error.localizedDescription)")
        }
    }

    /// Broadcast a message to all online agents.
    func broadcast(message: String) async {
        guard let client = a2aClient else {
            await appendQueenSystemMessage("A2A client not configured; cannot broadcast.")
            return
        }
        do {
            let payload = Data("[Queen broadcast] \(message)".utf8)
            try await client.broadcast(payload: payload)
            await appendQueenSystemMessage("Broadcast sent to all online agents.")
        } catch {
            await appendQueenSystemMessage("Failed to broadcast: \(error.localizedDescription)")
        }
    }

    /// List online agents via A2A.
    /// - Parameter silent: When `true`, errors are logged but not posted to the
    ///   Queen chat. Background status polls use silent mode to avoid spamming the timeline.
    func listAgents(silent: Bool = false) async -> [AgentCard] {
        guard let client = a2aClient else { return [] }
        do {
            return try await client.listAgents()
        } catch {
            if !silent {
                await appendQueenSystemMessage("Failed to list agents: \(error.localizedDescription)")
            } else {
                NSLog("[QueenBackgroundService] Silent agent-list failure: \(error)")
            }
            return []
        }
    }

    /// Identical banners already posted this session, so a restart loop cannot
    /// stack three copies of the same warning in one transcript.
    private var postedSystemBanners: Set<String> = []

    private func appendQueenSystemMessage(_ content: String, deduplicate: Bool = false) async {
        if deduplicate {
            guard postedSystemBanners.insert(content).inserted else {
                TriosLogBus.shared.debug(
                    .queen,
                    "queen.banner.suppressed",
                    "Duplicate system banner suppressed",
                    ["banner": String(content.prefix(120))]
                )
                return
            }
        }
        await postToChat(id: ChatConversation.trinityQueenId, role: .system, content: content)
    }

    /// Inject dependencies. Must be called once before `start()`.
    func configure(
        memoryService: AgentMemoryService,
        persister: ChatPersisterProtocol,
        a2aClient: A2ARegistryClient?
    ) {
        guard queenService == nil else { return }
        let service = QueenSelfImprovementService(
            memoryService: memoryService,
            persister: persister,
            a2aClient: a2aClient
        )
        self.queenService = service
        self.a2aClient = a2aClient
        self.persister = persister
        self.proposals = service.proposals
    }

    /// Start all background loops: audit, A2A heartbeat, A2A message stream.
    func start() async {
        guard queenService != nil else {
            NSLog("[QueenBackgroundService] start() called before configure()")
            return
        }
        await stop()
        isRunning = true

        await registerA2A()
        startAuditLoop()
        startReportLoop()

        // Publish initial state so any observing view model is in sync.
        objectWillChange.send()
    }

    /// Stop all background loops. Called on app termination.
    func stop() async {
        isRunning = false
        auditLoopTask?.cancel()
        auditLoopTask = nil
        reportLoopTask?.cancel()
        reportLoopTask = nil
        lastReportSignature = nil
        hasReportedInProcess = false
        lastReportWasOneLiner = nil
        a2aStreamTask?.cancel()
        a2aStreamTask = nil
        a2aRouter = nil
        await unregisterA2A()
    }

    /// Run one audit cycle and refresh published state.
    func runAudit() async {
        await queenService?.runAudit()
        refreshPublishedState()
    }

    func approveProposal(id: UUID) -> QueenProposal? {
        guard let proposal = queenService?.approveProposal(id: id) else { return nil }
        refreshPublishedState()
        return proposal
    }

    func rejectProposal(id: UUID) {
        queenService?.rejectProposal(id: id)
        refreshPublishedState()
    }

    // MARK: - A2A lifecycle

    private func registerA2A() async {
        guard let client = a2aClient else { return }
        let maxAttempts = 5
        var lastError: Error?
        for attempt in 1...maxAttempts {
            do {
                try await client.register()
                await client.startHeartbeat(interval: 30)
                startA2AStream()
                isA2ARegistered = true
                TriosLogBus.shared.info(
                    .a2a,
                    "a2a.register.ok",
                    "A2A registered",
                    ["attempt": String(attempt)]
                )
                return
            } catch {
                isA2ARegistered = false
                lastError = error
                let delay = min(Double(attempt) * 2.0, 30.0)
                TriosLogBus.shared.warn(
                    .a2a,
                    "a2a.register.retry",
                    "A2A registration attempt failed",
                    [
                        "attempt": "\(attempt)/\(maxAttempts)",
                        "retry_in_s": String(format: "%.0f", delay),
                        "error": String(describing: error)
                    ]
                )
                if attempt < maxAttempts {
                    try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                }
            }
        }
        let message = Self.a2aRegistrationFailureMessage(
            attempts: maxAttempts,
            error: lastError
        )
        TriosLogBus.shared.error(
            .a2a,
            "a2a.register.failed",
            message,
            ["error": lastError.map { String(describing: $0) } ?? "unknown"]
        )
        await appendQueenSystemMessage(message, deduplicate: true)
    }

    /// Builds a message that names the actual failure instead of always blaming
    /// startup timing. A 403 means the registry is up and rejecting us, which is
    /// a completely different fix from "wait for the registry".
    static func a2aRegistrationFailureMessage(attempts: Int, error: Error?) -> String {
        let prefix = "A2A registration failed after \(attempts) attempts."
        guard let error else {
            return "\(prefix) Run `/status` to check the registry."
        }
        if case let A2AError.invalidResponse(status, body) = error {
            switch status {
            case 401, 403:
                return "\(prefix) The registry is reachable but rejected the local " +
                    "authorization token (HTTP \(status)). Re-pair TriOS with the " +
                    "BrowserOS Agent server; waiting will not help."
            case 404:
                return "\(prefix) The registry answered HTTP 404 for /a2a/register. " +
                    "The server is running an incompatible A2A route set."
            default:
                let detail = body.map { ": \($0.prefix(200))" } ?? ""
                return "\(prefix) Registry responded HTTP \(status)\(detail)."
            }
        }
        return "\(prefix) \(error.localizedDescription) Run `/status` to check the registry."
    }

    private func unregisterA2A() async {
        a2aStreamTask?.cancel()
        a2aStreamTask = nil
        a2aRouter = nil
        guard let client = a2aClient else { return }
        await client.stopHeartbeat()
        do {
            try await client.unregister()
            isA2ARegistered = false
        } catch {
            isA2ARegistered = false
        }
    }

    private func startA2AStream() {
        guard let client = a2aClient else { return }
        a2aStreamTask?.cancel()
        a2aStreamTask = nil
        a2aRouter = nil
        a2aReconnectAttempt = 0
        a2aStreamHealthy = false

        let router = A2AMessageRouter(delegate: self)
        a2aRouter = router

        a2aStreamTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                guard self.a2aReconnectAttempt < self.maxA2AReconnectAttempts else {
                    let exhaustedMessage = "A2A stream reconnect budget exhausted. Run /status to check registry health."
                    TriosLogBus.shared.error(
                        .a2a,
                        "a2a.stream.exhausted",
                        exhaustedMessage
                    )
                    await self.appendQueenSystemMessage(exhaustedMessage, deduplicate: true)
                    self.isA2ARegistered = false
                    break
                }

                do {
                    let stream = try await client.messageStream()
                    self.a2aStreamHealthy = true
                    self.a2aReconnectAttempt = 0
                    for await message in stream {
                        guard !Task.isCancelled else { break }
                        self.a2aStreamHealthy = true
                        self.a2aReconnectAttempt = 0
                        router.route(message)
                    }
                } catch {
                    self.a2aStreamHealthy = false
                    if Task.isCancelled { break }
                    self.a2aReconnectAttempt += 1
                    let delay = min(UInt64(pow(2.0, Double(self.a2aReconnectAttempt))) * 1_000_000_000, 30_000_000_000)
                    let delaySeconds = Double(delay) / 1_000_000_000
                    NSLog("[QueenBackgroundService] A2A stream error (attempt \(self.a2aReconnectAttempt)/\(self.maxA2AReconnectAttempts)): \(error). Retrying in \(delaySeconds)s.")
                    try? await Task.sleep(nanoseconds: delay)
                }
            }
            self.a2aStreamTask = nil
            self.a2aRouter = nil
        }
    }

    // MARK: - Registry report loop

    /// Starts the periodic wake that walks the delegation registry and writes a
    /// conversational report to the Queen chat.
    ///
    /// Separate from the audit loop because they answer different questions: the
    /// audit asks "where is the codebase weak?" while this loop asks "what is
    /// the swarm doing?" Running them on different cadences lets the Queen
    /// report twice as often as she audits — a supervisor checks in often but
    /// thinks deeply less frequently.
    private func startReportLoop() {
        reportLoopTask?.cancel()
        reportLoopTask = Task { [weak self, interval = reportingIntervalSeconds] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                guard let self, self.isRunning else { return }
                await self.walkRegistryAndReport()
            }
        }
    }

    /// Walks the delegation registry and posts a conversational report to the
    /// Queen chat.
    ///
    /// This is what the acceptance criteria describe: the Queen wakes, looks at
    /// every task, and says what she sees — not as a table but as prose that
    /// explains what moved, what is stuck, and what she proposes. When the
    /// swarm has not changed since the last wake, she says so in one line
    /// instead of repeating herself.
    func walkRegistryAndReport() async {
        let registry = QueenDelegationRegistry.shared

        // Housekeeping before reporting, so the digest describes the swarm
        // after reaping rather than before — the same policy the existing
        // review scheduler follows.
        _ = registry.archiveTerminalTasks()

        let now = Date()
        let swarm = registry.open
        let stalled = QueenReviewDigest.stalled(swarm, now: now)
        let pendingProposals = proposals.filter { $0.status == .pending }
        let spentToday = registry.spentToday(now: now)

        // Build a fingerprint of everything that matters. When it matches the
        // last report, nothing has changed and the Queen says so in one line.
        let signature = Self.registrySignature(
            swarm: swarm, proposals: proposals, spentToday: spentToday
        )
        if hasReportedInProcess && signature == lastReportSignature {
            let oneLiner = SystemNoticeClassifier.infoMarker
                + "Nothing has changed since my last look — all quiet."
            lastReportText = oneLiner
            lastReportWasOneLiner = true
            await appendQueenSystemMessage(oneLiner)
            return
        }
        hasReportedInProcess = true
        lastReportSignature = signature

        // Generate the conversational digest. Returns nil when nothing is
        // running and nothing is waiting — but proposals may still be worth
        // mentioning, so we compose around that.
        let digest = QueenReviewDigest.text(for: swarm, now: now)

        var report = SystemNoticeClassifier.infoMarker

        if let digest {
            report += digest
        } else if pendingProposals.isEmpty {
            report += "I checked the hive at \(Self.reportTimestamp(now)). "
                + "Everything is quiet — no workers running, nothing waiting "
                + "for review."
        } else {
            report += "I checked the hive at \(Self.reportTimestamp(now)). "
                + "No workers are running and nothing is waiting for review, "
                + "but I have some thoughts about the repository."
        }

        if !stalled.isEmpty {
            report += "\n\n" + QueenReviewDigest.stallParagraph(stalled, now: now)
        }

        // Proposals: the Queen's decisions about how to develop the repository.
        // She explains her reasoning, not just the facts — the difference
        // between a dashboard and a supervisor.
        if let proposalsText = Self.proposalsDigest(pendingProposals) {
            report += "\n\n" + proposalsText
        }

        if let budgetNote = QueenReviewDigest.budgetParagraph(
            spentToday: spentToday, budget: .default
        ) {
            report += "\n\n" + budgetNote
        }

        lastReportText = report
        lastReportWasOneLiner = false
        await appendQueenSystemMessage(report)

        TriosLogBus.shared.info(
            .queen,
            "queen.report.posted",
            "Posted a registry report",
            [
                "open": String(swarm.count),
                "stalled": String(stalled.count),
                "proposals": String(pendingProposals.count),
            ]
        )
    }

    /// Reset report tracking so the next `walkRegistryAndReport()` is treated
    /// as the first report in the process — full text, never the one-liner.
    /// The self-test calls this to control walk ordering regardless of whether
    /// the timer loop already fired.
    func resetReportTracking() {
        lastReportSignature = nil
        hasReportedInProcess = false
        lastReportWasOneLiner = nil
    }

    // MARK: - Report helpers

    /// A compact fingerprint of the swarm and proposals, used to detect
    /// "nothing changed since last time."
    ///
    /// Task identity is slug + state (not `updatedAt`, which changes on every
    /// usage record and would make the signature thrash). Proposal identity is
    /// id + status. Spend is rounded so a penny's difference does not count as
    /// movement.
    nonisolated static func registrySignature(
        swarm: [DelegatedTask],
        proposals: [QueenProposal],
        spentToday: Double
    ) -> String {
        let taskPart = swarm
            .map { "\($0.issue.slug):\($0.state.rawValue)" }
            .sorted()
            .joined(separator: "|")
        let proposalPart = proposals
            .map { "\($0.id.uuidString.prefix(8)):\($0.status.rawValue)" }
            .sorted()
            .joined(separator: "|")
        let spendBucket = String(Int(spentToday * 100))
        return "\(taskPart)##\(proposalPart)##\(spendBucket)"
    }

    /// Conversational text about pending improvement proposals.
    ///
    /// The Queen explains *why* she thinks each change matters, not just what
    /// she would change — criterion 3. Returns nil when there are no pending
    /// proposals, so callers can skip the paragraph cleanly.
    nonisolated static func proposalsDigest(
        _ proposals: [QueenProposal]
    ) -> String? {
        let pending = proposals.filter { $0.status == .pending }
        guard !pending.isEmpty else { return nil }

        var lines: [String] = []
        if pending.count == 1, let p = pending.first {
            lines.append(
                "I have a proposal for the repository: \(p.rationale) "
                    + "I would change `\(p.targetFile)` — say "
                    + "`/evolve-apply \(p.id.uuidString.prefix(8))` if you "
                    + "agree, or `/evolve-reject \(p.id.uuidString.prefix(8))` "
                    + "if you do not."
            )
        } else {
            lines.append(
                "I have \(pending.count) proposals for how to develop the "
                    + "repository:"
            )
            for p in pending {
                lines.append(
                    "  - \(p.rationale) I would touch "
                        + "`\(p.targetFile)`."
                )
            }
            lines.append(
                "Use `/evolve-apply <id>` to approve any of them, or "
                    + "`/evolve-list` to see the full patches."
            )
        }
        return lines.joined(separator: "\n")
    }

    nonisolated static func reportTimestamp(_ date: Date) -> String {
        Self.reportTimeFormatter.string(from: date)
    }

    private nonisolated static let reportTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    // MARK: - Audit loop

    private func startAuditLoop() {
        auditLoopTask?.cancel()
        auditLoopTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(
                    nanoseconds: UInt64(QueenSelfImprovementService.defaultInterval * 1_000_000_000)
                )
                guard let self, self.isRunning else { return }
                await self.runAudit()
            }
        }
    }

    private func refreshPublishedState() {
        lastAudit = queenService?.lastAudit
        proposals = queenService?.proposals ?? []
        delegate?.queenBackgroundServiceDidUpdateState(self)
        objectWillChange.send()
    }

    private func appendQueenMessage(_ message: ChatMessage) async {
        let queenId = ChatConversation.trinityQueenId
        var history = await persister?.load(conversationId: queenId) ?? []
        history.append(message)
        await persister?.save(messages: history, conversationId: queenId)
    }
}

// MARK: - A2AMessageRouterDelegate

extension QueenBackgroundService: A2AMessageRouterDelegate {
    func a2aMessageRouter(
        _ router: A2AMessageRouter,
        didProduceQueenMessage message: ChatMessage
    ) {
        Task {
            await appendQueenMessage(message)
            delegate?.queenBackgroundService(self, didReceiveA2AMessage: message)
        }
    }
}
