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

    private var queenService: QueenSelfImprovementService?
    private var a2aClient: A2ARegistryClient?
    private var persister: ChatPersisterProtocol?
    private var auditLoopTask: Task<Void, Never>?
    private var a2aStreamTask: Task<Void, Never>?
    private var a2aRouter: A2AMessageRouter?
    private var a2aReconnectAttempt = 0
    private let maxA2AReconnectAttempts = 5
    private var a2aStreamHealthy = false

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

        // Publish initial state so any observing view model is in sync.
        objectWillChange.send()
    }

    /// Stop all background loops. Called on app termination.
    func stop() async {
        isRunning = false
        auditLoopTask?.cancel()
        auditLoopTask = nil
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
