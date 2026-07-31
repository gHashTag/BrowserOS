// AGENT-V-WAIVER: https://github.com/browseros-ai/BrowserOS/issues/2023
// Reason: Queen direct-chat hardening  -  safety-budget enforcement, human-in-the-loop
// confirmation, and repo-agnostic PR creation for Queen-generated proposals.
// Follow-up: seal against .trinity/specs/queen-proposal-applier.md.
// Previous waiver: https://github.com/gHashTag/trios/issues/T27-EPIC-001 (fullscreen chat history).
import Combine
import Foundation
import SwiftUI

/// Observable progress state for recovery export/import operations.
@MainActor
final class SessionRecoveryProgress: ObservableObject {
    @Published var isActive = false
    @Published var currentFile: String = ""
    @Published var completedFiles: Int = 0
    @Published var totalFiles: Int = 0
    @Published var fractionCompleted: Double = 0
    @Published var operation: SessionRecoveryOperation = .none

    enum SessionRecoveryOperation: String {
        case none
        case export
        case `import`
    }

    func start(operation: SessionRecoveryOperation, totalFiles: Int) {
        self.operation = operation
        self.isActive = true
        self.totalFiles = totalFiles
        self.completedFiles = 0
        self.fractionCompleted = 0
        self.currentFile = ""
    }

    func advance(file: String) {
        self.currentFile = file
        self.completedFiles += 1
        if totalFiles > 0 {
            self.fractionCompleted = Double(completedFiles) / Double(totalFiles)
        }
    }

    func finish() {
        self.isActive = false
        self.fractionCompleted = 1
        self.currentFile = ""
    }

    func reset() {
        self.operation = .none
        self.isActive = false
        self.currentFile = ""
        self.completedFiles = 0
        self.totalFiles = 0
        self.fractionCompleted = 0
    }
}

private struct PendingAgentMemoryTurn {
    let conversationId: UUID
    let sourceMessageId: UUID
    let goal: String
    let streamGeneration: UInt64
    let memoryWriteRevision: UInt64
    var shouldRemember: Bool
    var assistantMessageId: UUID?
}

private struct ActiveAgentMemoryWrite {
    let conversationId: UUID
    let sourceMessageId: UUID
    let task: Task<AgentMemoryRecord?, Never>
}

private struct ConversationHistorySnapshot {
    let conversationId: UUID
    let messages: [ChatMessage]
    let writeRevision: UInt64
}

@MainActor
final class ChatViewModel: ObservableObject {
    private static let unterminatedStreamError =
        "Response stream ended before a terminal event"

    @Published var messages: [ChatMessage] = .init()
    @Published var state: ConversationState = .idle
    @Published var inputText: String = ""
    @Published var isServerReachable: Bool = false
    @Published var isA2ARegistered: Bool = false
    @Published var conversations: [ChatConversation] = .init()
    @Published var showHistory = false
    @Published var messageHistory: [String] = .init()  // Hotkey history ((up/down) navigation)
    @Published private(set) var tokenUsage = TokenUsageLedger()
    @Published private(set) var recalledMemories: [AgentMemoryMatch] = []
    @Published private(set) var memoryControlRevision: UInt64 = 0
    @Published var recoveryProgress = SessionRecoveryProgress()
    @Published var contextUtilizationPercent: Double?
    @Published var contextRoutingLabel: String?
    @Published var requestError: String?
    @Published var streamingContextDecision: StreamingContextDecision?
    @Published var isStreamPausedForContext: Bool = false
    @Published var streamingContextWarning: String?
    @Published var streamingContextPauseLabel: String?
    @Published var canContinueOnLargerModel: Bool = false
    @Published var canSummarizeStreamSoFar: Bool = false
    @Published var streamingBudgetStatus: StreamingBudgetStatus?

    let queenStatusVM = QueenStatusViewModel()
    let modelStore: ModelConfigurationStore
    let todoPlanner: TODOPlanner
    /// Injected rather than reached for, so a test can hand over a store built
    /// on a temporary directory. Five call sites used SkillStore.shared, which
    /// reads the real .claude/skills and writes the real disabled-skill state:
    /// covering the Queen saying "that skill is switched off" meant switching a
    /// real one off on whoever ran the suite. Defaulting to .shared keeps every
    /// existing caller unchanged.
    let skillStore: SkillStore
    /// Injected for the same reason as the skill store above: eighteen call
    /// sites reached for the singleton, which reads and writes the real
    /// .trinity/state/queen_delegation.json. Every command that makes the
    /// Queen do something - delegate, accept, review, cancel - goes through it,
    /// so none of them could be tested without leaving tasks behind on whoever
    /// ran the suite. Views and main.swift keep observing .shared; it is only
    /// this view model's own use that is now handed in.
    let delegationRegistry: QueenDelegationRegistry
    /// How the Queen reads the contract an issue already states.
    ///
    /// Injected because reaching straight into GitHubAPIClient made delegation
    /// a network call, and the harness delegates - so the suite started going
    /// to github.com and stopped finishing. Every other dependency here is
    /// handed in; this one had no business being the exception.
    let fetchIssueBody: @Sendable (IssueReference) async -> String?

    private let transport: ChatTransportProtocol
    private let healthCheck: ChatHealthCheckProtocol
    private let parser: ChatParserProtocol
    private(set) var persister: ChatPersisterProtocol
    private let stateMachine: ConversationStateMachine
    private let memoryService: AgentMemoryService
    let a2aClient: A2ARegistryClient?

    @Published private(set) var conversationId: UUID = UUID()
    /// Per-conversation overrides for output budget and context-window margin.
    /// `nil` values fall back to the global defaults in `ModelConfigurationStore`.
    @Published private(set) var conversationSettings: [UUID: ConversationSettings] = [:]
    private var messageCache: [UUID: Int] = [:]
    private var healthCheckTask: Task<Void, Never>?
    private var initializationTask: Task<Void, Never>?
    private(set) var queenBackgroundService: QueenBackgroundService?
    private var lastSendTime: Date = .distantPast
    private var pendingEstimatedInputTokens = 0
    private var pendingEstimatedOutput = ""
    private var pendingUsageActive = false
    private var receivedProviderUsage = false
    private var contextWatchdog = StreamingContextWatchdog.shared
    private var activeStreamTask: Task<Void, Never>?
    private var pendingMemoryTurn: PendingAgentMemoryTurn?
    private var activeMemoryWrites: [UUID: ActiveAgentMemoryWrite] = [:]
    private var memoryClearCounts: [UUID: Int] = [:]
    private var streamGeneration: UInt64 = 0
    private var memoryWriteRevisions: [UUID: UInt64] = [:]
    private var historyWriteRevisions: [UUID: UInt64] = [:]
    private var historyDeletionCounts: [UUID: Int] = [:]
    private var isConversationTransitioning = false
    private var stagedProposalIds: Set<UUID> = []
    private var stagedProposalBranches: [UUID: String] = [:]
    /// Runs delegated workers off to one side of the UI. Optional so tests and
    /// the e2e harness can construct a view model without a live transport.
    private(set) var workerRunner: QueenWorkerRunner?
    private var workerObservation: AnyCancellable?
    private var workerLivenessObservation: AnyCancellable?
    /// Working-tree snapshot taken when each worker started, so its edits can be
    /// told apart from everything else happening in the shared checkout.
    private var workerBaselineTrees: [UUID: String] = [:]
    /// Observer concerns already reported, keyed by task, so a warning fires
    /// once rather than on every streamed delta.
    private var announcedConcerns: [UUID: Set<String>] = [:]

    init(
        transport: ChatTransportProtocol,
        healthCheck: ChatHealthCheckProtocol,
        parser: ChatParserProtocol,
        persister: ChatPersisterProtocol,
        stateMachine: ConversationStateMachine,
        a2aClient: A2ARegistryClient? = nil,
        modelStore: ModelConfigurationStore,
        memoryService: AgentMemoryService,
        todoPlanner: TODOPlanner,
        workerRunner: QueenWorkerRunner? = nil,
        // Optional rather than defaulting to .shared directly: a default
        // argument is evaluated outside the actor, and SkillStore.shared is
        // main-actor isolated, which Swift 6 rejects. Resolved inside the
        // initialiser, where the isolation already holds.
        skillStore: SkillStore? = nil,
        delegationRegistry: QueenDelegationRegistry? = nil,
        fetchIssueBody: (@Sendable (IssueReference) async -> String?)? = nil
    ) {
        self.skillStore = skillStore ?? .shared
        self.delegationRegistry = delegationRegistry ?? .shared
        self.fetchIssueBody = fetchIssueBody ?? { issue in
            try? await GitHubAPIClient().fetchIssue(
                repo: "\(issue.owner)/\(issue.repo)", number: issue.number
            ).body
        }
        NSLog("ChatViewModel.init starting")
        self.transport = transport
        self.healthCheck = healthCheck
        self.parser = parser
        self.persister = persister
        self.stateMachine = stateMachine

        // Ensure an A2A registry client exists. In the normal app launch path no
        // caller injects one, so create the embedded trios-agent client here with
        // the BrowserOS loopback endpoint and local-auth provider.
        // AGENT-V-WAIVER: QueenBackgroundService startup wiring (Agent V conditional waiver, 2026-07-27).
        let effectiveA2AClient: A2ARegistryClient
        if let client = a2aClient {
            effectiveA2AClient = client
        } else {
            let serverURL = URL(string: ProjectPaths.mcpBaseURL) ?? URL(fileURLWithPath: "/dev/null")
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
            let card = AgentCard(
                id: AgentId("trios-agent"),
                name: "trios",
                description: "Trinity A2A agent embedded in the trios macOS chat app",
                capabilities: [.browserControl, .chat, .fileSystem, .shell, .git, .orchestrator],
                version: version,
                endpoint: nil
            )
            let authProvider = LocalAuthProvider(baseURL: serverURL)
            effectiveA2AClient = A2ARegistryClient(
                serverURL: serverURL,
                agentCard: card,
                localAuthProvider: authProvider
            )
        }
        self.a2aClient = effectiveA2AClient
        self.modelStore = modelStore
        self.memoryService = memoryService
        self.todoPlanner = todoPlanner
        self.queenBackgroundService = QueenBackgroundService.shared
        self.queenBackgroundService?.delegate = self
        self.queenBackgroundService?.configure(
            memoryService: memoryService,
            persister: persister,
            a2aClient: effectiveA2AClient
        )
        NSLog("ChatViewModel.init properties set")
        self.workerRunner = workerRunner
        configureWorkerRunner()

        initializationTask = Task { [weak self] in
            guard let self else { return }
            NSLog("ChatViewModel.init Task started")
            await setupConversationId()
            await loadHistory()
            await todoPlanner.load(conversationId: conversationId)
            await loadConversations()
            await checkHealth()
            let skipA2AStartup = ProcessInfo.processInfo.environment[
                "TRIOS_SKIP_A2A_STARTUP"
            ] == "1"
            if let service = self.queenBackgroundService, !service.isRunning, !skipA2AStartup {
                await service.start()
                NSLog("ChatViewModel A2A background service started")
            } else if skipA2AStartup {
                NSLog("ChatViewModel A2A startup skipped (TRIOS_SKIP_A2A_STARTUP=1)")
            }
            NSLog("ChatViewModel.init Task done")
            initializationTask = nil
        }
        healthCheckTask = Task {
            while !Task.isCancelled {
                await checkHealth()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
        NSLog("ChatViewModel.init finished")
    }

    deinit {
        initializationTask?.cancel()
        healthCheckTask?.cancel()
    }

    func setupConversationId() async {
        conversationId = await persister.currentConversationId()
    }

    /// The output-token budget for the current conversation, falling back to the
    /// global store default when no per-conversation override exists.
    var effectiveConversationOutputTokens: Int? {
        conversationSettings[conversationId]?.requestedOutputTokens ?? modelStore.requestedOutputTokens
    }

    /// The context-window margin for the current conversation, falling back to the
    /// global store default when no per-conversation override exists.
    var effectiveConversationContextMargin: Double {
        conversationSettings[conversationId]?.contextWindowMargin ?? modelStore.contextWindowMargin
    }

    /// True when the current conversation has a per-conversation output-budget override.
    var hasConversationOutputTokensOverride: Bool {
        conversationSettings[conversationId]?.requestedOutputTokens != nil
    }

    /// True when the current conversation has a per-conversation model/provider override.
    var hasConversationModelOverride: Bool {
        let settings = conversationSettings[conversationId] ?? .default
        return settings.provider != nil || settings.model != nil || settings.baseURL != nil
    }

    /// The provider selected for this conversation, falling back to the global default.
    var effectiveConversationProvider: ModelProvider {
        conversationSettings[conversationId]?.provider ?? modelStore.selectedProvider
    }

    /// The model selected for this conversation, falling back to the global default.
    var effectiveConversationModel: String {
        conversationSettings[conversationId]?.model ?? modelStore.selectedModel
    }

    /// The base URL selected for this conversation, falling back to the global default.
    var effectiveConversationBaseURL: String {
        conversationSettings[conversationId]?.baseURL ?? modelStore.baseURL
    }

    /// A conversation-scoped model constraint when the current conversation has
    /// pinned a specific (provider, baseURL, model) tuple. `nil` means routing,
    /// warmup, and failover may consider all eligible candidates.
    var conversationModelConstraint: ConversationModelConstraint? {
        let settings = conversationSettings[conversationId] ?? .default
        guard let provider = settings.provider,
              let baseURL = settings.baseURL,
              let model = settings.model else { return nil }

        // Heal a stale host. A pin exists to keep a conversation on one provider
        // and model; the base URL is infrastructure, not intent. When the user
        // changes the provider's endpoint in settings, a conversation pinned to
        // the old host keeps calling it forever - which showed up as Z.AI code
        // 1113 on a perfectly good key long after the endpoint was corrected.
        if provider == modelStore.selectedProvider, baseURL != modelStore.baseURL {
            TriosLogBus.shared.warn(
                .models,
                "chat.pin.endpoint_healed",
                "Pinned conversation was still using the previous endpoint",
                ["from": baseURL, "to": modelStore.baseURL, "model": model]
            )
            return ConversationModelConstraint(
                provider: provider,
                baseURL: modelStore.baseURL,
                model: model
            )
        }
        return ConversationModelConstraint(provider: provider, baseURL: baseURL, model: model)
    }

    /// Sets (or clears) the per-conversation output-token budget and persists it.
    func setConversationRequestedOutputTokens(_ tokens: Int?) async {
        var settings = conversationSettings[conversationId] ?? .default
        settings.requestedOutputTokens = tokens.map { max(0, $0) }
        conversationSettings[conversationId] = settings
        await persister.saveSettings(settings, conversationId: conversationId)
    }

    /// Sets the per-conversation context-window margin and persists it.
    func setConversationContextWindowMargin(_ margin: Double) async {
        var settings = conversationSettings[conversationId] ?? .default
        settings.contextWindowMargin = max(0.5, min(0.95, margin))
        conversationSettings[conversationId] = settings
        await persister.saveSettings(settings, conversationId: conversationId)
    }

    /// Pins a provider/model/baseURL to the current conversation and persists it.
    func setConversationModelOverride(provider: ModelProvider, baseURL: String, model: String) async {
        var settings = conversationSettings[conversationId] ?? .default
        settings.provider = provider
        settings.baseURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        settings.model = model.trimmingCharacters(in: .whitespacesAndNewlines)
        conversationSettings[conversationId] = settings
        await persister.saveSettings(settings, conversationId: conversationId)
    }

    /// Clears the per-conversation model/provider override for the current conversation.
    func clearConversationModelOverride() async {
        var settings = conversationSettings[conversationId] ?? .default
        settings.provider = nil
        settings.baseURL = nil
        settings.model = nil
        conversationSettings[conversationId] = settings
        await persister.saveSettings(settings, conversationId: conversationId)
    }

    /// Clears the per-conversation output-token budget override for the current conversation.
    func clearConversationOutputTokensOverride() async {
        var settings = conversationSettings[conversationId] ?? .default
        settings.requestedOutputTokens = nil
        conversationSettings[conversationId] = settings
        await persister.saveSettings(settings, conversationId: conversationId)
    }

    /// Loads persisted per-conversation settings when switching conversations.
    private func loadConversationSettings() async {
        let settings = await persister.loadSettings(conversationId: conversationId)
        conversationSettings[conversationId] = settings
    }

    /// Pre-send context status for the current draft, computed synchronously from
    /// the advertised model profile and the effective conversation margin.
    var draftContextStatus: DraftContextStatus? {
        guard !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let profile = ModelContextService.shared.advertisedProfile(
            for: effectiveConversationModel,
            provider: effectiveConversationProvider
        )
        let systemPrompt = memoryService.promptContext(for: recalledMemories)
        return ChatRequestSizer.draftContextUtilization(
            draft: inputText,
            history: messages,
            systemPrompt: systemPrompt,
            modelProfile: profile,
            margin: effectiveConversationContextMargin
        )
    }

    /// Shorthand for the composer utilization badge.
    var draftContextUtilizationPercent: Double? {
        draftContextStatus?.utilizationPercent
    }

    /// True when the draft alone exceeds the usable context window and sending
    /// would result in `.tooLargeEvenEmpty`.
    var isDraftContextLimitExceeded: Bool {
        draftContextStatus?.isTooLarge ?? false
    }

    /// The advertised profile of the model pinned to this conversation, if any.
    /// Used for cause-specific send-button guardrails.
    private var pinnedModelAdvertisedProfile: ModelContextProfile? {
        guard let constraint = conversationModelConstraint else { return nil }
        return ModelContextService.shared.advertisedProfile(
            for: constraint.candidate.model,
            provider: constraint.candidate.provider
        )
    }

    /// A description of why the pinned model cannot send the current draft, if any.
    /// Returns `nil` when there is no pin or the draft fits within both context and
    /// output-budget limits.
    var pinnedSendLimitReason: String? {
        guard let constraint = conversationModelConstraint,
              let profile = pinnedModelAdvertisedProfile else { return nil }
        let margin = effectiveConversationContextMargin
        let usableWindow = Int(Double(profile.maxContextTokens) * margin)
        let draftTokens = TokenEstimator.estimate(inputText)
        let contextExceeded = usableWindow > 0 && draftTokens > usableWindow

        // effectiveConversationOutputTokens already falls back to the store, so
        // the second `?? modelStore.requestedOutputTokens` here was the same
        // fallback written twice. Harmless today because the store value is
        // always nil, which is its own problem, but two statements of one rule
        // is how this file has produced most of its defects.
        let requestedOutput = effectiveConversationOutputTokens ?? 0
        let outputExceeded = requestedOutput > 0 && requestedOutput > profile.maxOutputTokens

        if contextExceeded && outputExceeded {
            return "Pinned to \(constraint.candidate.provider.displayName) / \(constraint.candidate.model): draft exceeds \(formatCompact(usableWindow)) context window and requested \(requestedOutput) output tokens exceeds \(profile.maxOutputTokens) ceiling."
        }
        if contextExceeded {
            return "Pinned to \(constraint.candidate.provider.displayName) / \(constraint.candidate.model): draft exceeds \(formatCompact(usableWindow)) context window."
        }
        if outputExceeded {
            return "Pinned to \(constraint.candidate.provider.displayName) / \(constraint.candidate.model): requested \(requestedOutput) output tokens exceeds \(profile.maxOutputTokens) ceiling."
        }
        return nil
    }

    /// True when the pinned model cannot fit the draft or honor the requested
    /// output budget. When false, the global default would be used or the
    /// conversation is not pinned.
    var isPinnedModelSendBlocked: Bool {
        pinnedSendLimitReason != nil
    }

    private func formatCompact(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
        if value >= 1_000 { return String(format: "%.1fk", Double(value) / 1_000) }
        return "\(value)"
    }

    func loadHistory() async {
        // A worker chat opened mid-run must show what the bee has produced so
        // far. The persisted copy is only written at the start and end of a
        // worker turn, so the runner's live transcript wins while it is active.
        if let runner = workerRunner,
           runner.isRunning(conversationId: conversationId),
           let live = runner.transcripts[conversationId] {
            messages = live
            rebuildCache()
            return
        }
        let history = await persister.load(conversationId: conversationId)
        history.forEach { $0.isStreaming = false }
        messages = history
        rebuildCache()
    }

    func loadConversations() async {
        var loaded = await persister.listAllConversations()
        if !loaded.contains(where: { $0.id == ChatConversation.trinityQueenId }) {
            loaded.insert(.trinityQueen, at: 0)
            // Persist an empty reserved conversation so it survives restarts.
            await persister.save(messages: [], conversationId: ChatConversation.trinityQueenId)
        }
        // Ensure the reserved conversation is always pinned and has the canonical icon/title.
        if let index = loaded.firstIndex(where: { $0.id == ChatConversation.trinityQueenId }) {
            loaded[index].isPinned = true
            loaded[index].icon = "crown.fill"
            loaded[index].title = "Trinity Queen"
        }
        conversations = loaded
    }

    func sessionRecoveryConversations() async -> SessionRecoverySanitized<[SessionRecoveryConversation]> {
        let activeID = conversationId
        let activeMessages = messages
        let activeTitle = conversations.first(where: { $0.id == activeID })?.title
            ?? activeMessages.first(where: { $0.role == .user })?.content
            ?? "New task"
        let activeUpdatedAt = activeMessages.last?.timestamp ?? Date()
        let activeRaw = SessionRecoverySnapshotFactory.conversation(
            id: activeID,
            title: activeTitle,
            updatedAt: activeUpdatedAt,
            messages: activeMessages
        )
        let active = SessionRecoverySanitizer.sanitize(activeRaw)

        let summaries = await persister.listAllConversations()
        var persisted: [SessionRecoveryConversation] = []
        var redactionCount = active.redactionCount
        for summary in summaries where summary.id != activeID {
            let storedMessages = await persister.load(conversationId: summary.id)
            let raw = SessionRecoverySnapshotFactory.conversation(
                id: summary.id,
                title: summary.title,
                updatedAt: summary.updatedAt,
                messages: storedMessages
            )
            let sanitized = SessionRecoverySanitizer.sanitize(raw)
            redactionCount += sanitized.redactionCount
            persisted.append(sanitized.value)
        }

        return SessionRecoverySanitized(
            value: SessionRecoveryConversationMerger.merge(
                persisted: persisted,
                active: active.value
            ),
            redactionCount: redactionCount
        )
    }

    /// Export with progress reporting. Progress is published to
    /// `recoveryProgress` on the main actor.
    func exportRecoveryPackage(
        request: SessionRecoveryPackageRequest,
        to destinationURL: URL
    ) async throws -> SessionRecoveryExportResult {
        recoveryProgress.start(operation: .export, totalFiles: request.conversations.count + 1)
        defer { recoveryProgress.finish() }

        return try await Task.detached(priority: .userInitiated) {
            try SessionRecoveryPackageWriter().write(
                request: request,
                to: destinationURL
            )
        }.value
    }

    /// Imports a Trinity recovery ZIP into the local encrypted conversation store.
    /// The active conversation is switched to the recovered active conversation.
    /// Duplicate handling defaults to `.skip` when no resolver is supplied.
    func importRecoveryPackage(
        from url: URL,
        resolvingDuplicates resolver: ((UUID, String) async -> SessionRecoveryDuplicateResolution)? = nil
    ) async throws -> SessionRecoveryImportSummary {
        await awaitInitialization()

        recoveryProgress.start(operation: .import, totalFiles: 1)
        defer { recoveryProgress.finish() }

        let result = try await Task.detached(priority: .userInitiated) {
            try SessionRecoveryPackageReader.read(from: url)
        }.value

        let existing = await persister.listAllConversations()
        let existingByID = Dictionary(uniqueKeysWithValues: existing.map { ($0.id, $0) })

        var importedMessages = 0
        var successCount = 0
        var savedIDs: [UUID] = []

        for recoveryConversation in result.conversations {
            let id = recoveryConversation.id
            let messages = SessionRecoverySnapshotFactory.chatMessage(from: recoveryConversation)
            importedMessages += messages.count

            let resolution: SessionRecoveryDuplicateResolution
            if existingByID[id] != nil {
                resolution = await resolver?(id, recoveryConversation.title) ?? .skip
            } else {
                resolution = .replace
            }

            let messagesToSave: [ChatMessage]
            switch resolution {
            case .replace:
                messagesToSave = messages
            case .merge:
                let existingMessages = await persister.load(conversationId: id)
                let existingIDs = Set(existingMessages.map { $0.id })
                let newMessages = messages.filter { !existingIDs.contains($0.id) }
                messagesToSave = existingMessages + newMessages
            case .skip:
                messagesToSave = []
            }

            guard !messagesToSave.isEmpty || resolution == .replace else {
                continue
            }

            await persister.save(messages: messagesToSave, conversationId: id)
            await persister.renameConversation(
                id: id,
                title: ConversationTitlePolicy.normalized(recoveryConversation.title)
            )
            savedIDs.append(id)
            successCount += 1
        }

        let activeID = result.activeConversationID
        if result.conversations.contains(where: { $0.id == activeID && savedIDs.contains($0.id) }) {
            conversationId = activeID
            await persister.setCurrentConversationId(activeID)
            await loadHistory()
            await todoPlanner.load(conversationId: activeID)
        }
        await loadConversations()

        return SessionRecoveryImportSummary(
            conversationCount: result.conversations.count,
            successCount: successCount,
            failureCount: result.conversations.count - successCount,
            messageCount: importedMessages,
            activeConversationID: activeID,
            failedConversationIDs: []
        )
    }

    func switchConversation(id: UUID) async {
        await awaitInitialization()
        guard beginConversationTransition() else { return }
        defer { endConversationTransition() }
        invalidateActiveStream()
        await performConversationSwitch(id: id)
    }

    private func performConversationSwitch(id: UUID) async {
        // A turn in flight is about to be cancelled. Save what it produced to
        // the conversation it belongs to first: clicking another chat used to
        // destroy a nearly-finished answer with nothing left behind, which is
        // how the Queen appeared to simply stop.
        await preserveInterruptedTurn(reason: "you opened another chat")
        // Cancel any in-flight stream before loading a different conversation;
        // otherwise late SSE events could corrupt the newly loaded messages.
        await cancelPendingTurn()
        await transport.cancel()
        _ = await stateMachine.transition(to: .idle)
        state = await stateMachine.currentState()

        recalledMemories = []
        memoryControlRevision &+= 1
        streamingContextWarning = nil
        streamingContextPauseLabel = nil
        streamingContextDecision = nil
        streamingBudgetStatus = nil
        isStreamPausedForContext = false
        canContinueOnLargerModel = false
        canSummarizeStreamSoFar = false
        conversationId = id
        await persister.setCurrentConversationId(id)
        await loadHistory()
        await todoPlanner.load(conversationId: id)
        await loadConversationSettings()
        applyConversationModelOverrideIfNeeded()
        await loadConversations()
        tokenUsage.reset()
        showHistory = false
    }

    /// Applies a per-conversation provider/model/baseURL override without mutating
    /// the global defaults, so switching back restores the previous selection.
    private func applyConversationModelOverrideIfNeeded() {
        let settings = conversationSettings[conversationId] ?? .default
        guard let provider = settings.provider,
              let model = settings.model,
              let baseURL = settings.baseURL else { return }
        modelStore.applySelection(provider: provider, baseURL: baseURL, model: model)
    }

    /// Execute a Queen slash command locally, switching to the Queen conversation
    /// if necessary so the result is visible in the chat timeline.
    func runQueenCommand(_ text: String) async {
        await awaitInitialization()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.hasPrefix("/") else { return }
        if conversationId != ChatConversation.trinityQueenId {
            await switchConversation(id: ChatConversation.trinityQueenId)
        }
        let command = QueenCommandParser.parse(trimmed)
        await executeQueenCommand(command, originalText: trimmed)
    }

    func sendMessage(
        text customText: String? = nil,
        appendUser: Bool = true,
        imageAttachments: [ChatComposerAttachment] = [],
        onAccepted: (() -> Void)? = nil
    ) async {
        await awaitInitialization()
        let text = (customText ?? inputText).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isConversationTransitioning else { return }

        let now = Date()
        guard now.timeIntervalSince(lastSendTime) >= 0.5 else {
            NSLog("[TriosChat] debounce blocked")
            return
        }
        lastSendTime = now
        contextUtilizationPercent = nil
        contextRoutingLabel = nil
        requestError = nil
        streamingContextWarning = nil
        streamingContextPauseLabel = nil
        streamingContextDecision = nil
        streamingBudgetStatus = nil
        isStreamPausedForContext = false
        canContinueOnLargerModel = false
        canSummarizeStreamSoFar = false

        // Trinity Queen conversation intercepts slash commands locally.
        if conversationId == ChatConversation.trinityQueenId, text.hasPrefix("/") {
            let command = QueenCommandParser.parse(text)
            inputText = ""
            await executeQueenCommand(command, originalText: text)
            return
        }

        // Log only text-derived facts here. Reading modelStore from this point in
        // the send path perturbs the streaming turn, so provider and model are
        // recorded by the routing and transport events instead.
        TriosLogBus.shared.info(
            .chat,
            "chat.send.start",
            "Sending a message",
            ["chars": String(text.count)]
        )

        // Save to message history for (up/down) hotkey navigation
        messageHistory.append(text)
        if messageHistory.count > 50 {  // Limit history to 50 messages
            messageHistory.removeFirst()
        }

        let memoryGoal = memorySafeGoal(from: text)
        let shouldRemember = isEligibleForLongTermMemory(text)
            && !isMemoryClearInProgress(conversationId)
        let sourceMessageId: UUID
        if appendUser {
            let userMessage = ChatMessage(role: .user, content: text)
            sourceMessageId = userMessage.id
            messages.append(userMessage)
            rebuildCache()
        } else if let existingUser = messages.last(where: { $0.role == .user }) {
            sourceMessageId = existingUser.id
        } else {
            sourceMessageId = UUID()
        }
        inputText = ""

        let ok = await stateMachine.tryTransition(to: .streaming(messageId: UUID()))
        guard ok else {
            NSLog("[TriosChat] stateMachine blocked transition, aborting")
            if appendUser {
                messages.removeLast()
                rebuildCache()
            }
            inputText = text
            return
        }
        state = await stateMachine.currentState()
        NSLog("[TriosChat] state transitioned to streaming")
        onAccepted?()

        streamGeneration &+= 1
        let generation = streamGeneration
        pendingMemoryTurn = PendingAgentMemoryTurn(
            conversationId: conversationId,
            sourceMessageId: sourceMessageId,
            goal: memoryGoal,
            streamGeneration: generation,
            memoryWriteRevision: memoryWriteRevision(
                for: conversationId
            ),
            shouldRemember: shouldRemember,
            assistantMessageId: nil
        )

        await todoPlanner.startPlan(
            conversationId: conversationId,
            goal: memoryGoal
        )
        guard isCurrentStream(generation) else { return }

        let recallRevision = memoryControlRevision
        let recalled = await memoryService.recall(
            for: memoryGoal,
            limit: 3
        )
        guard isCurrentStream(generation) else { return }
        recalledMemories = recallRevision == memoryControlRevision ? recalled : []

        // Exclude only the current user message from previousConversation: the server
        // receives it separately via the `message` field, and duplicating it
        // confuses the model and the UI. When continuing from a paused stream,
        // the current user message is not the last message, so a simple dropLast()
        // would incorrectly drop the partial assistant response (INV-9).
        var historyForRequest = messages.filter { $0.id != sourceMessageId }
        beginUsageEstimate(message: text, history: historyForRequest)

        let requestAttachments: [ChatRequestAttachment]
        do {
            requestAttachments = try imageAttachments.compactMap { attachment in
                guard attachment.kind == .image,
                      let mediaType = attachment.mediaType,
                      !mediaType.isEmpty else {
                    return nil
                }
                let decrypted = try attachment.loadDecryptedData()
                let base64 = decrypted.base64EncodedString()
                return ChatRequestAttachment(
                    kind: "image",
                    mediaType: mediaType,
                    dataURL: "data:\(mediaType);base64,\(base64)"
                )
            }
        } catch {
            NSLog("[TriosChat] failed to decrypt image attachments: \(error.localizedDescription)")
            await failPendingTurn(message: "Failed to read image attachment")
            guard isGenerationCurrent(generation) else { return }
            _ = await stateMachine.transition(to: .error("Failed to read image attachment"))
            guard isGenerationCurrent(generation) else { return }
            let currentState = await stateMachine.currentState()
            guard isGenerationCurrent(generation) else { return }
            state = currentState
            clearPendingUsage()
            return
        }

        var didFailover = false

        // Capture the initial selection before any automatic switching. This is
        // what we restore to if a failover fails.
        let initialProvider = modelStore.selectedProvider
        let initialBaseURL = modelStore.baseURL
        let initialModel = modelStore.selectedModel

        // When a conversation model pin is active, warmup, routing, and all forms
        // of automatic failover must stay inside the pinned boundary.
        let constraint = conversationModelConstraint

        // Preflight health check: if the selected model is known unhealthy, switch
        // to the first healthy fallback before burning a real request. When a pin
        // is active we skip this step so we do not silently switch models.
        let preflightModel = await runPreflightHealthCheck(generation: generation)
        // This comparison was computed but never consumed. Routing decisions are
        // exactly what the LOGS tab needs in order to explain a surprising send.
        if preflightModel != modelStore.selectedModel {
            TriosLogBus.shared.info(
                .health,
                "chat.route.preflight_switch",
                "Preflight health check switched the model before sending",
                ["from": modelStore.selectedModel, "to": preflightModel]
            )
        }

        // Predictive warmup cache: if a fresh (or recently-stale) background
        // winner is available, apply it immediately without paying probe latency
        // on the send path. A stale winner triggers a coalesced background
        // refresh for future sends.
        var warmupSwitched = false
        var warmupCandidate: CrossProviderModelCandidate?
        if modelStore.isAdaptiveProviderWarmupEnabled,
           modelStore.isPredictiveWarmupEnabled,
           constraint == nil,
           let selection = await modelStore.cachedOrStaleWarmupWinner(
               tier: modelStore.preferredCostTier,
               strictQuotaGating: modelStore.isStrictQuotaGatingEnabled,
               maxStaleness: modelStore.predictiveWarmupMaxStaleness
           ) {
            let current = CrossProviderModelCandidate(
                provider: modelStore.selectedProvider,
                baseURL: modelStore.baseURL,
                model: modelStore.selectedModel
            )
            if selection.winner.selected != current {
                warmupCandidate = selection.winner.selected
                TriosLogBus.shared.info(
                    .models,
                    "chat.route.warmup_switch",
                    "Predictive warmup switched the routing target",
                    [
                        "served_stale": String(selection.isStale),
                        "to_provider": selection.winner.selected.provider.rawValue,
                        "to_model": selection.winner.selected.model,
                        "reason": selection.winner.reason
                    ]
                )
                modelStore.applySelection(
                    provider: selection.winner.selected.provider,
                    baseURL: selection.winner.selected.baseURL,
                    model: selection.winner.selected.model
                )
                warmupSwitched = true
                let prefix = selection.isStale ? "[↻ stale]" : "[↻]"
                let banner = ChatMessage(role: .system, content: "\(prefix) \(selection.winner.reason)")
                messages.append(banner)
                rebuildCache()
                let historySnapshot = captureHistorySnapshot()
                await persistHistorySnapshot(historySnapshot)
            }
            if selection.isStale {
                modelStore.refreshWarmupCacheInBackground()
            }
        }

        // Adaptive provider warmup: race lightweight probes across eligible
        // providers and switch to the best live candidate before the real send.
        // A conversation pin narrows the candidate set to the pinned tuple.
        if !warmupSwitched && modelStore.isAdaptiveProviderWarmupEnabled {
            let warmupResult = await modelStore.runAdaptiveWarmup(constrainedTo: constraint)
            warmupSwitched = warmupResult.didSwitch
            if warmupSwitched {
                let banner = ChatMessage(role: .system, content: "[↻] \(warmupResult.reason)")
                messages.append(banner)
                rebuildCache()
                let historySnapshot = captureHistorySnapshot()
                await persistHistorySnapshot(historySnapshot)
            }
        }

        var activeProvider = modelStore.selectedProvider
        var activeBaseURL = modelStore.baseURL
        var activeModel = modelStore.selectedModel

        let systemPrompt = memoryService.promptContext(for: recalledMemories)
        let currentMessage = ChatMessage(role: .user, content: text)
        let routingDecision = await modelStore.resolveContextRoutingDecision(
            conversationId: conversationId,
            messages: historyForRequest,
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            requestedOutputTokens: effectiveConversationOutputTokens,
            candidates: modelStore.warmupCandidates(constrainedTo: constraint),
            margin: effectiveConversationContextMargin,
            constrainedTo: constraint
        )

        // Re-estimate input tokens after any routing/trimming so the stream
        // watchdog and the utilization badge see the actual request, not the
        // pre-routing estimate (Cycle 31 learned-limit sync).
        let resolvedHistory: [ChatMessage]
        switch routingDecision {
        case .trimHistory(let policy):
            resolvedHistory = await ChatRequestSizer.shared.trimmedMessages(
                from: historyForRequest,
                policy: policy
            )
        default:
            resolvedHistory = historyForRequest
        }
        let resolvedInputEstimate = TokenEstimator.estimate(
            messages: resolvedHistory,
            systemPrompt: systemPrompt
        ) + TokenEstimator.estimate(currentMessage.content)
        pendingEstimatedInputTokens = resolvedInputEstimate

        switch routingDecision {
        case .useCurrent:
            contextRoutingLabel = nil
        case .routeTo(let candidate):
            let reason = modelStore.lastContextRoutingReason ?? "routed to \(candidate.model)"
            modelStore.applyContextRoutedSelection(
                candidate: candidate,
                reason: reason
            )
            activeProvider = candidate.provider
            activeBaseURL = candidate.baseURL
            activeModel = candidate.model
            contextRoutingLabel = reason
        case .trimHistory(let policy):
            historyForRequest = await ChatRequestSizer.shared.trimmedMessages(
                from: historyForRequest,
                policy: policy
            )
            contextRoutingLabel = "trimmed \(policy.droppedMessageCount) turns"
        case .tooLargeEvenEmpty:
            let errorMessage = "This message is too long for every available model's context window."
            requestError = errorMessage
            contextRoutingLabel = "too large to send"
            contextUtilizationPercent = await modelStore.contextWindowUtilizationPercent(
                for: activeModel,
                provider: activeProvider,
                baseURL: activeBaseURL
            )
            _ = await stateMachine.transition(to: .error(errorMessage))
            state = await stateMachine.currentState()
            await saveHistory(expectedGeneration: generation)
            return
        }

        contextUtilizationPercent = await modelStore.contextWindowUtilizationPercent(
            for: activeModel,
            provider: activeProvider,
            baseURL: activeBaseURL
        )

        let streamStart = Date()
        do {
            let latency = try await executeStream(
                generation: generation,
                text: text,
                memoryGoal: memoryGoal,
                historyForRequest: historyForRequest,
                requestAttachments: requestAttachments,
                activeProvider: activeProvider,
                activeBaseURL: activeBaseURL,
                activeModel: activeModel
            )
            let didPause = latency.didPauseForContext
            await modelStore.recordSendOutcome(
                model: activeModel,
                provider: activeProvider,
                baseURL: activeBaseURL,
                success: !didPause,
                reason: didPause ? "context limit" : nil,
                latencyMs: latency.totalMs,
                timeToFirstTokenMs: latency.timeToFirstTokenMs,
                observedOutputTokens: latency.observedOutputTokens,
                observedTotalTokens: latency.observedTotalTokens,
                finishReason: latency.finishReason
            )
            await modelStore.recordCircuitBreakerSuccess(provider: activeProvider, baseURL: activeBaseURL)
            if let warmupCandidate, !didPause {
                await modelStore.recordCachedWinnerOutcome(success: true, candidate: warmupCandidate)
            }
        } catch {
            guard isCurrentStream(generation) else { return }
            let isCancellation = (error as? URLError)?.code == .cancelled
            if let warmupCandidate, !isCancellation {
                let failureKind = (error as? TransportError)?.circuitBreakerFailureKind
                await modelStore.recordCachedWinnerOutcome(
                    success: false,
                    candidate: warmupCandidate,
                    kind: failureKind
                )
            }
            let failureMs = Int(max(0, Date().timeIntervalSince(streamStart) * 1000))
            // One automatic model failover for provider-side model failures.
            // Mark the (provider, baseURL, model) tuple that failed as unhealthy so
            // the same model on another provider is not wrongly skipped.
            modelStore.markUnhealthy(provider: activeProvider, baseURL: activeBaseURL, model: activeModel)

            if let transportError = error as? TransportError,
               transportError.isEligibleForCrossProviderFailover {
                await modelStore.recordCircuitBreakerFailure(
                    provider: activeProvider,
                    baseURL: activeBaseURL,
                    model: activeModel,
                    transportError: transportError
                )
            }

            // Same-provider model failover is disabled when a conversation pin
            // is active because switching models would violate the pinned boundary.
            if !didFailover,
               constraint == nil,
               let transportError = error as? TransportError,
               (transportError.isModelUnavailableError || transportError.isInvalidModelError),
               let nextModel = await modelStore.selectNextModel() {
                didFailover = true
                finalizeAssistantStreamingState()
                clearPendingUsage()
                await modelStore.recordSendOutcome(
                    model: activeModel,
                    provider: activeProvider,
                    baseURL: activeBaseURL,
                    success: false,
                    reason: transportError.localizedDescription,
                    latencyMs: failureMs,
                    observedOutputTokens: nil,
                    observedTotalTokens: nil,
                    finishReason: nil
                )
                let failoverMsg = "Model `\(activeModel)` failed; retrying with `\(nextModel)`…"
                let banner = ChatMessage(role: .system, content: "[↻] \(failoverMsg)")
                messages.append(banner)
                rebuildCache()
                let historySnapshot = captureHistorySnapshot()
                await persistHistorySnapshot(historySnapshot)
                let failoverStreamStart = Date()
                do {
                    let latency = try await executeStream(
                        generation: generation,
                        text: text,
                        memoryGoal: memoryGoal,
                        historyForRequest: historyForRequest,
                        requestAttachments: requestAttachments,
                        activeProvider: activeProvider,
                        activeBaseURL: activeBaseURL,
                        activeModel: nextModel
                    )
                    await modelStore.recordSendOutcome(
                        model: nextModel,
                        provider: activeProvider,
                        baseURL: activeBaseURL,
                        success: true,
                        reason: nil,
                        latencyMs: latency.totalMs,
                        timeToFirstTokenMs: latency.timeToFirstTokenMs,
                        observedOutputTokens: latency.observedOutputTokens,
                        observedTotalTokens: latency.observedTotalTokens,
                        finishReason: latency.finishReason
                    )
                    await modelStore.recordCircuitBreakerSuccess(provider: activeProvider, baseURL: activeBaseURL)
                    return
                } catch {
                    let failoverFailureMs = Int(max(0, Date().timeIntervalSince(failoverStreamStart) * 1000))
                    await modelStore.recordSendOutcome(
                        model: nextModel,
                        provider: activeProvider,
                        baseURL: activeBaseURL,
                        success: false,
                        reason: (error as? TransportError)?.localizedDescription,
                        latencyMs: failoverFailureMs,
                        observedOutputTokens: nil,
                        observedTotalTokens: nil,
                        finishReason: nil
                    )
                    // Restore the original selection so the next turn does not
                    // silently inherit a failed fallback.
                    modelStore.restoreSelection(provider: initialProvider, baseURL: initialBaseURL, model: initialModel)
                }
            }

            // Cross-provider failover: if the same-provider fallback failed (or was
            // not possible), try one other eligible provider before giving up.
            if modelStore.isCrossProviderFailoverEnabled,
               let transportError = error as? TransportError,
               transportError.isEligibleForCrossProviderFailover,
               let candidate = await modelStore.selectFirstHealthyCrossProviderModel(constrainedTo: constraint) {
                let crossStreamStart = Date()
                let failoverMsg = "Provider `\(activeProvider.displayName)` failed; switching to `\(candidate.provider.displayName)/\(candidate.model)`…"
                let banner = ChatMessage(role: .system, content: "[↻] \(failoverMsg)")
                messages.append(banner)
                rebuildCache()
                let historySnapshot = captureHistorySnapshot()
                await persistHistorySnapshot(historySnapshot)
                do {
                    let latency = try await executeStream(
                        generation: generation,
                        text: text,
                        memoryGoal: memoryGoal,
                        historyForRequest: historyForRequest,
                        requestAttachments: requestAttachments,
                        activeProvider: candidate.provider,
                        activeBaseURL: candidate.baseURL,
                        activeModel: candidate.model
                    )
                    await modelStore.recordSendOutcome(
                        model: candidate.model,
                        provider: candidate.provider,
                        baseURL: candidate.baseURL,
                        success: true,
                        reason: nil,
                        latencyMs: latency.totalMs,
                        timeToFirstTokenMs: latency.timeToFirstTokenMs,
                        observedOutputTokens: latency.observedOutputTokens,
                        observedTotalTokens: latency.observedTotalTokens,
                        finishReason: latency.finishReason
                    )
                    await modelStore.recordCircuitBreakerSuccess(provider: candidate.provider, baseURL: candidate.baseURL)
                    return
                } catch {
                    let crossFailureMs = Int(max(0, Date().timeIntervalSince(crossStreamStart) * 1000))
                    await modelStore.recordSendOutcome(
                        model: candidate.model,
                        provider: candidate.provider,
                        baseURL: candidate.baseURL,
                        success: false,
                        reason: (error as? TransportError)?.localizedDescription,
                        latencyMs: crossFailureMs,
                        observedOutputTokens: nil,
                        observedTotalTokens: nil,
                        finishReason: nil
                    )
                    if let transportError = error as? TransportError,
                       transportError.isEligibleForCrossProviderFailover {
                        await modelStore.recordCircuitBreakerFailure(
                            provider: candidate.provider,
                            baseURL: candidate.baseURL,
                            model: candidate.model,
                            transportError: transportError
                        )
                    }
                    // Revert to the original provider so the next turn does not
                    // silently stay on a failed cross-provider candidate.
                    modelStore.restoreSelection(provider: initialProvider, baseURL: initialBaseURL, model: initialModel)
                }
            }

            if !didFailover {
                await modelStore.recordSendOutcome(
                    model: activeModel,
                    provider: activeProvider,
                    baseURL: activeBaseURL,
                    success: false,
                    reason: (error as? TransportError)?.localizedDescription,
                    latencyMs: failureMs,
                    observedOutputTokens: nil,
                    observedTotalTokens: nil,
                    finishReason: nil
                )
            }

            guard isCurrentStream(generation) else { return }
            finalizeAssistantStreamingState()
            // Manual cancellation is not a user-visible error.
            if let urlError = error as? URLError, urlError.code == .cancelled {
                let historySnapshot = captureHistorySnapshot()
                NSLog("[TriosChat] stream cancelled by user")
                await cancelPendingTurn()
                await persistHistorySnapshot(historySnapshot)
                guard isGenerationCurrent(generation) else { return }
                _ = await stateMachine.transition(to: .idle)
                guard isGenerationCurrent(generation) else { return }
                let currentState = await stateMachine.currentState()
                guard isGenerationCurrent(generation) else { return }
                state = currentState
                await saveHistory(expectedGeneration: generation)
                return
            }

            let errorDetail = formatRequestError(error)
            TriosLogBus.shared.error(
                .chat,
                "chat.transport.error",
                errorDetail,
                ["raw_error": String(describing: error).prefix(500).description]
            )
            clearPendingUsage()
            let errorMsg = ChatMessage(role: .system, content: "[!] \(errorDetail)")
            messages.append(errorMsg)
            rebuildCache()
            let historySnapshot = captureHistorySnapshot()
            await failPendingTurn(message: errorDetail)
            await persistHistorySnapshot(historySnapshot)
            guard isGenerationCurrent(generation) else { return }
            _ = await stateMachine.transition(to: .error(errorDetail))
            guard isGenerationCurrent(generation) else { return }
            let currentState = await stateMachine.currentState()
            guard isGenerationCurrent(generation) else { return }
            state = currentState
            await saveHistory(expectedGeneration: generation)
        }
    }

    /// Latency measurements for a completed stream.
    private struct StreamLatency {
        let totalMs: Int
        let timeToFirstTokenMs: Int?
        /// True when the stream paused because it hit the context/output limit;
        /// the caller must record this as a non-success outcome.
        let didPauseForContext: Bool
        /// Observed output tokens if a usage event arrived; used for limit learning.
        let observedOutputTokens: Int?
        /// Observed total tokens if a usage event arrived; used for limit learning.
        let observedTotalTokens: Int?
        /// Provider `finish_reason` from the terminal SSE event.
        let finishReason: String?
    }

    /// Attempts a single streaming request. On success it finalizes the turn and
    /// persists history and returns request latency measurements. On failure it
    /// throws the underlying error so the caller can decide whether to failover
    /// or surface the error to the user.
    private func executeStream(
        generation: UInt64,
        text: String,
        memoryGoal: String,
        historyForRequest: [ChatMessage],
        requestAttachments: [ChatRequestAttachment],
        activeProvider: ModelProvider,
        activeBaseURL: String,
        activeModel: String
    ) async throws -> StreamLatency {
        guard isGenerationCurrent(generation) else {
            return StreamLatency(totalMs: 0, timeToFirstTokenMs: nil, didPauseForContext: false,
                observedOutputTokens: nil,
                observedTotalTokens: nil,
                finishReason: nil)
        }
        let runtimeConfiguration = await modelStore.runtimeConfiguration
        guard let requestBody = try? ChatRequestBuilder(
            conversationId: conversationId,
            message: text,
            mode: "agent",
            origin: "sidepanel",
            userSystemPrompt: composedSystemPrompt(),
            previousConversation: historyForRequest,
            browserContext: nil,
            modelConfiguration: runtimeConfiguration,
            attachments: requestAttachments
        ).build() else {
            NSLog("[TriosChat] ChatRequestBuilder failed")
            throw ChatViewModelError.requestBuildFailed
        }
        // Log the target that is actually about to be called. Reading it from
        // the built configuration - not from settings - is the point: a pinned
        // conversation, a warmup switch, or a stale override can all send a
        // request somewhere other than what the Models tab displays, and
        // without this the only symptom is an opaque provider error.
        TriosLogBus.shared.info(
            .chat,
            "chat.request.target",
            "Request target resolved",
            [
                "provider": runtimeConfiguration.provider.rawValue,
                "model": runtimeConfiguration.model,
                "base_url": runtimeConfiguration.baseURL,
                "has_key": runtimeConfiguration.apiKey == nil ? "no" : "yes",
                "bytes": String(requestBody.count)
            ]
        )
        // Log what the payload ACTUALLY carries, not what we intended to send.
        // The previous line reported the resolved configuration, which is why a
        // request that reached the server without provider/model/apiKey still
        // looked correct in the log.
        if let sent = try? JSONSerialization.jsonObject(with: requestBody) as? [String: Any] {
            TriosLogBus.shared.info(
                .chat,
                "chat.request.payload",
                "Payload fields",
                [
                    "provider": (sent["provider"] as? String) ?? "ABSENT",
                    "model": (sent["model"] as? String) ?? "ABSENT",
                    "base_url": (sent["baseUrl"] as? String) ?? "ABSENT",
                    "api_key": sent["apiKey"] == nil ? "ABSENT" : "present",
                    "keys": sent.keys.sorted().joined(separator: ","),
                    // Proving the Queen can see her own skills needs evidence
                    // from the wire, not from the code that builds it. This is
                    // the same class of check as logging the resolved target:
                    // the layer above can look correct while the payload is not.
                    "system_chars": String(systemPromptCharacterCount(in: sent)),
                    "system_skills": String(systemPromptSkillCount(in: sent))
                ]
            )
        }
        NSLog("[TriosChat] request body built, size: \(requestBody.count), attachments: \(requestAttachments.count)")

        await parser.reset()

        let isWatchdogEnabled = modelStore.isStreamingContextWatchdogEnabled
        if isWatchdogEnabled {
            let profile = await ModelContextService.shared.profile(
                for: activeModel,
                provider: activeProvider,
                baseURL: activeBaseURL
            )
            await contextWatchdog.beginStream(
                modelProfile: profile,
                estimatedInputTokens: pendingEstimatedInputTokens,
                margin: effectiveConversationContextMargin
            )
        }

        let streamStart = Date()
        let stream = try await transport.sendMessage(body: requestBody)
        var timeToFirstTokenMs: Int? = nil
        guard isCurrentStream(generation) else {
            if isWatchdogEnabled { await contextWatchdog.endStream() }
            return StreamLatency(
                totalMs: Int(max(0, Date().timeIntervalSince(streamStart) * 1000)),
                timeToFirstTokenMs: nil,
                didPauseForContext: false,
                observedOutputTokens: nil,
                observedTotalTokens: nil,
                finishReason: nil
            )
        }
        // The answer itself is a step. Naming it means a turn with no tool calls
        // still shows "Understand request -> Compose answer" rather than a
        // single stalled row.
        await todoPlanner.beginStep(
            title: TODOPlanDeriver.title(for: .composing),
            detail: "Response stream opened"
        )
        NSLog("[TriosChat] transport stream opened")
        var receivedTerminalEvent = false
        var streamFinishReason: String? = nil
        var observedOutputTokens: Int? = nil
        var observedTotalTokens: Int? = nil
        for await event in stream {
            guard isCurrentStream(generation) else { break }
            if timeToFirstTokenMs == nil, event.isFirstToken {
                timeToFirstTokenMs = Int(max(0, Date().timeIntervalSince(streamStart) * 1000))
            }
            switch event {
            case .finish(_, let reason):
                receivedTerminalEvent = true
                streamFinishReason = reason
            case .abort, .error:
                receivedTerminalEvent = true
            case .usage(let inputTokens, let outputTokens, let totalTokens):
                if outputTokens > 0 {
                    observedOutputTokens = outputTokens
                }
                let resolvedTotal = totalTokens > 0
                    ? totalTokens
                    : (inputTokens + outputTokens > 0 ? inputTokens + outputTokens : 0)
                if resolvedTotal > 0 {
                    observedTotalTokens = resolvedTotal
                }
            default:
                break
            }
            NSLog("[TriosChat] SSE event: \(event)")
            // Apply the delta to messages BEFORE checking the watchdog so the
            // final delta that triggers the limit is preserved in the partial
            // response (INV-2, INV-9).
            await handleEvent(
                event,
                expectedGeneration: generation
            )
            let decision = await feedWatchdog(event: event)
            switch decision {
            case .ok:
                break
            case .approachingLimit(let remaining, let kind):
                showApproachingContextLimitWarning(remaining: remaining, kind: kind)
            case .limitReached(let partialText, let suggestedAction):
                await pauseStreamForContextLimit(
                    generation: generation,
                    partialText: partialText,
                    suggestedAction: suggestedAction
                )
                await contextWatchdog.endStream()
                let tokens = await contextWatchdog.estimatedTokens()
                return StreamLatency(
                    totalMs: Int(max(0, Date().timeIntervalSince(streamStart) * 1000)),
                    timeToFirstTokenMs: timeToFirstTokenMs,
                    didPauseForContext: true,
                    observedOutputTokens: tokens.output,
                    observedTotalTokens: tokens.input + tokens.output,
                    finishReason: streamFinishReason
                )
            }
        }
        let totalMs = Int(max(0, Date().timeIntervalSince(streamStart) * 1000))
        guard isCurrentStream(generation) else {
            return StreamLatency(totalMs: totalMs, timeToFirstTokenMs: timeToFirstTokenMs, didPauseForContext: false,
                observedOutputTokens: nil,
                observedTotalTokens: nil,
                finishReason: nil)
        }
        guard receivedTerminalEvent else {
            finalizeAssistantStreamingState()
            NSLog(
                "[TriosChat] unterminated stream: %@",
                Self.unterminatedStreamError
            )
            await applyAction(
                .streamError(Self.unterminatedStreamError),
                expectedGeneration: generation
            )
            return StreamLatency(totalMs: totalMs, timeToFirstTokenMs: timeToFirstTokenMs, didPauseForContext: false,
                observedOutputTokens: nil,
                observedTotalTokens: nil,
                finishReason: nil)
        }
        await completePendingTurnIfNeeded()
        if isWatchdogEnabled { await contextWatchdog.endStream() }
        guard isGenerationCurrent(generation) else {
            return StreamLatency(totalMs: totalMs, timeToFirstTokenMs: timeToFirstTokenMs, didPauseForContext: false,
                observedOutputTokens: nil,
                observedTotalTokens: nil,
                finishReason: nil)
        }
        finalizeEstimatedUsageIfNeeded()
        NSLog("[TriosChat] stream ended normally")
        _ = await stateMachine.transition(to: .idle)
        guard isGenerationCurrent(generation) else {
            return StreamLatency(totalMs: totalMs, timeToFirstTokenMs: timeToFirstTokenMs, didPauseForContext: false,
                observedOutputTokens: nil,
                observedTotalTokens: nil,
                finishReason: nil)
        }
        let currentState = await stateMachine.currentState()
        guard isGenerationCurrent(generation) else {
            return StreamLatency(totalMs: totalMs, timeToFirstTokenMs: timeToFirstTokenMs, didPauseForContext: false,
                observedOutputTokens: nil,
                observedTotalTokens: nil,
                finishReason: nil)
        }
        state = currentState
        await saveHistory(expectedGeneration: generation)
        return StreamLatency(
            totalMs: totalMs,
            timeToFirstTokenMs: timeToFirstTokenMs,
            didPauseForContext: false,
            observedOutputTokens: observedOutputTokens,
            observedTotalTokens: observedTotalTokens,
            finishReason: streamFinishReason
        )
    }

    private func runPreflightHealthCheck(generation: UInt64) async -> String {
        guard isCurrentStream(generation) else { return modelStore.selectedModel }
        // End-to-end tests exercise the chat plumbing, not the machine's model
        // inventory. Without this guard the preflight probed whatever Ollama
        // happened to have installed and, when the selected model was missing,
        // appended a "[/] Model ... unavailable; switching" banner - a third
        // message that broke "messages contains exactly user + assistant" about
        // one run in three, depending on the probe cache.
        guard ProcessInfo.processInfo.environment["TRIOS_E2E_DISABLE_WARMUP"] != "1" else {
            return modelStore.selectedModel
        }
        // A pinned conversation model must not be silently replaced by a healthy
        // same-provider fallback during preflight.
        guard conversationModelConstraint == nil else { return modelStore.selectedModel }
        let result = await modelStore.healthStatus(for: modelStore.selectedModel)
        guard case .unavailable = result.health else { return modelStore.selectedModel }

        let currentModel = modelStore.selectedModel
        guard let healthyModel = await modelStore.selectFirstHealthyModel() else {
            return currentModel
        }

        let banner = ChatMessage(
            role: .system,
            content: "[↻] Model `\(currentModel)` is unavailable; switching to `\(healthyModel)`…"
        )
        messages.append(banner)
        rebuildCache()
        let historySnapshot = captureHistorySnapshot()
        await persistHistorySnapshot(historySnapshot)
        return healthyModel
    }

    /// Length of the system message actually present in the built payload.
    private func systemPromptCharacterCount(in body: [String: Any]) -> Int {
        systemMessageText(in: body).count
    }

    /// How many `/skill` names survived into the payload.
    private func systemPromptSkillCount(in body: [String: Any]) -> Int {
        let text = systemMessageText(in: body)
        guard !text.isEmpty else { return 0 }
        return text
            .components(separatedBy: .newlines)
            .filter { $0.trimmingCharacters(in: .whitespaces).hasPrefix("/") }
            .count
    }

    private func systemMessageText(in body: [String: Any]) -> String {
        guard let messages = body["messages"] as? [[String: Any]] else { return "" }
        return messages
            .filter { ($0["role"] as? String) == "system" }
            .compactMap { $0["content"] as? String }
            .joined(separator: "\n")
    }

    private enum ChatViewModelError: Error {
        case requestBuildFailed
    }

    func cancelStreaming() {
        finalizeAssistantStreamingState()
        let historySnapshot = captureHistorySnapshot()
        invalidateActiveStream()
        streamingContextWarning = nil
        streamingContextPauseLabel = nil
        streamingContextDecision = nil
        streamingBudgetStatus = nil
        isStreamPausedForContext = false
        canContinueOnLargerModel = false
        canSummarizeStreamSoFar = false
        Task {
            await awaitInitialization()
            await persistHistorySnapshot(historySnapshot)
            await cancelPendingTurn()
            clearPendingUsage()
            await transport.cancel()
            _ = await stateMachine.transition(to: .idle)
            state = await stateMachine.currentState()
        }
    }

    func regenerateLastResponse() async {
        guard let lastUserIndex = messages.lastIndex(where: { $0.role == .user }),
              lastUserIndex < messages.count - 1 else {
            NSLog("[TriosChat] regenerate: no user message or no assistant response to regenerate")
            return
        }
        let userText = messages[lastUserIndex].content
        messages.removeSubrange((lastUserIndex + 1)...)
        rebuildCache()
        inputText = userText
        // Re-send the existing user message without appending a duplicate.
        await sendMessage(text: userText, appendUser: false)
    }

    func sendFeedback(messageId: UUID, isPositive: Bool) async {
        NSLog("[TriosChat] feedback for \(messageId): \(isPositive ? "thumbs-up" : "thumbs-down")")

        guard let url = URL(
            string: "\(ProjectPaths.mcpBaseURL)/chat/\(conversationId.uuidString)/messages/\(messageId.uuidString)/feedback"
        ) else {
            NSLog("[TriosChat] feedback aborted: invalid URL")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30

        let body: [String: Bool] = ["isPositive": isPositive]
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        } catch {
            NSLog("[TriosChat] feedback body encoding failed: \(error.localizedDescription)")
            return
        }

        let retrier = NetworkRetrier(policy: NetworkRetryPolicy.default)
        let feedbackRequest = request
        do {
            let (_, response) = try await retrier.execute(
                url: url,
                description: "feedback POST \(url.absoluteString)"
            ) {
                try await URLSession.shared.data(for: feedbackRequest)
            }
            guard let httpResponse = response as? HTTPURLResponse,
                  (200...299).contains(httpResponse.statusCode) else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                NSLog("[TriosChat] feedback server returned \(status)")
                return
            }
            NSLog("[TriosChat] feedback stored on server")
        } catch {
            NSLog("[TriosChat] feedback request failed: \(formatRequestError(error))")
        }
    }

    func checkHealth() async {
        let reachable = await healthCheck.check()
        isServerReachable = reachable
    }

    private func formatRequestError(_ error: Error) -> String {
        if let transportError = error as? TransportError {
            let providerMsg = transportError.providerErrorMessage
            let fallback = modelStore.fallbackSuggestion
            switch transportError {
            case _ where transportError.isBalanceError:
                return [
                    "Insufficient balance or no resource package.",
                    providerMsg,
                    fallback,
                    "Pick a different model (`/doctor --model <model>`) or recharge your provider account."
                ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            case _ where transportError.isAuthError:
                return [
                    "Authentication failed for \(modelStore.selectedProvider.displayName).",
                    providerMsg,
                    "Check the API key in TriOS model settings or macOS Keychain."
                ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            case _ where transportError.isContextLengthError:
                return [
                    "The conversation is too long for \(modelStore.selectedModel).",
                    providerMsg,
                    "Start a new chat or reduce context via `/doctor --context`."
                ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            case _ where transportError.isInvalidModelError:
                return [
                    "Model '\(modelStore.selectedModel)' is unavailable or invalid.",
                    providerMsg,
                    fallback,
                    "Switch models or run `/doctor --model <model>`."
                ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            case _ where transportError.isRateLimitError:
                return [
                    "Rate limit hit on \(modelStore.selectedProvider.displayName).",
                    providerMsg,
                    fallback,
                    "Retrying briefly; switch to a cheaper model if it persists."
                ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            case _ where transportError.isModelUnavailableError:
                return [
                    "Model provider temporarily unavailable.",
                    providerMsg,
                    fallback,
                    "Retrying; use `/doctor --model <model>` to force a fallback."
                ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            default:
                return transportError.localizedDescription
            }
        }
        if let retryError = error as? RetryError {
            return retryError.localizedDescription
        }
        if let a2aError = error as? A2AError {
            return a2aError.localizedDescription
        }
        if let urlError = error as? URLError {
            var parts: [String] = []
            parts.append("URLError code \(urlError.code.rawValue): \(urlError.localizedDescription)")
            if let failingURL = urlError.failingURL {
                parts.append("URL: \(failingURL.absoluteString)")
            }
            return parts.joined(separator: " | ")
        }
        return error.localizedDescription
    }

    func newConversation() {
        guard beginConversationTransition() else { return }
        let newConversationId = UUID()
        invalidateActiveStream()
        streamingContextWarning = nil
        streamingContextPauseLabel = nil
        streamingContextDecision = nil
        streamingBudgetStatus = nil
        isStreamPausedForContext = false
        canContinueOnLargerModel = false
        canSummarizeStreamSoFar = false
        Task {
            await awaitInitialization()
            await preserveInterruptedTurn(reason: "you started a new chat")
            await cancelPendingTurn()
            await transport.cancel()
            _ = await stateMachine.transition(to: .idle)
            state = await stateMachine.currentState()
            conversationId = newConversationId
            messages = []
            messageCache = [:]
            tokenUsage.reset()
            clearPendingUsage()
            recalledMemories = []
            memoryControlRevision &+= 1
            await todoPlanner.load(conversationId: newConversationId)
            await persister.setCurrentConversationId(newConversationId)
            // Persist it empty, the way the Queen's reserved conversation is.
            // Without this the chat exists only as a UUID in memory: the user
            // presses New Chat, lands somewhere that works, and sees nothing
            // added to the sidebar, because listAllConversations only returns
            // what has been saved. It appeared after the first message, which
            // reads as "creating chats is broken" rather than "creating chats
            // is deferred". It matters more now the Queen opens one per issue -
            // a chat she cannot see is a bee she cannot supervise.
            await persister.save(messages: [], conversationId: newConversationId)
            await loadConversations()
            endConversationTransition()
        }
    }

    func deleteConversation(id: UUID) async {
        await awaitInitialization()
        guard beginConversationTransition() else { return }
        defer { endConversationTransition() }
        let retainedHistorySnapshot: ConversationHistorySnapshot?
        if id == conversationId {
            finalizeAssistantStreamingState()
            retainedHistorySnapshot = captureHistorySnapshot()
            invalidateActiveStream()
        } else {
            retainedHistorySnapshot = nil
        }
        await performConversationDeletion(
            id: id,
            retainedHistorySnapshot: retainedHistorySnapshot
        )
    }

    private func performConversationDeletion(
        id: UUID,
        retainedHistorySnapshot: ConversationHistorySnapshot?
    ) async {
        if id == conversationId {
            await cancelPendingTurn()
            await transport.cancel()
            _ = await stateMachine.transition(to: .idle)
            state = await stateMachine.currentState()
            await waitForMemoryWrite(conversationId: id)
            do {
                try await todoPlanner.deleteConversationData(
                    conversationId: id
                )
            } catch {
                let message = "Conversation was not deleted because private data cleanup failed."
                let receipt = ChatMessage(
                    role: .system,
                    content: "[!] \(message)"
                )
                messages.append(receipt)
                rebuildCache()
                let failureSnapshot: ConversationHistorySnapshot
                if let retainedHistorySnapshot {
                    failureSnapshot = ConversationHistorySnapshot(
                        conversationId:
                            retainedHistorySnapshot.conversationId,
                        messages:
                            retainedHistorySnapshot.messages + [receipt],
                        writeRevision:
                            retainedHistorySnapshot.writeRevision
                    )
                } else {
                    finalizeAssistantStreamingState()
                    failureSnapshot = captureHistorySnapshot()
                }
                await persistHistorySnapshot(failureSnapshot)
                _ = await stateMachine.transition(to: .error(message))
                state = await stateMachine.currentState()
                return
            }
            await clearPersistedConversationHistory(conversationId: id)
            conversationId = UUID()
            await persister.setCurrentConversationId(conversationId)
            messages = []
            tokenUsage.reset()
            clearPendingUsage()
            pendingMemoryTurn = nil
            recalledMemories = []
            memoryControlRevision &+= 1
            advanceMemoryWriteRevision(for: id)
            await todoPlanner.load(conversationId: conversationId)
            rebuildCache()
        } else {
            do {
                await waitForMemoryWrite(conversationId: id)
                try await todoPlanner.deleteConversationData(
                    conversationId: id
                )
                await clearPersistedConversationHistory(conversationId: id)
            } catch {
                NSLog(
                    "[TriosChat] conversation deletion blocked: %@",
                    error.localizedDescription
                )
                return
            }
        }
        await loadConversations()
    }

    // MARK: - A2A Actions

    func updateTaskState(id: UUID, state: AgentTaskState) async {
        guard let client = a2aClient else { return }
        do {
            try await client.updateTaskState(id: id, state: state)
            if let index = messages.firstIndex(where: { $0.task?.id == id }) {
                if var task = messages[index].task {
                    task.state = state
                    messages[index].task = task
                    objectWillChange.send()
                }
            }
        } catch {
            // Silent
        }
    }

    func sendA2AMessage(type: A2AMessageType, to recipient: AgentId? = nil, payload: Data) async {
        guard let client = a2aClient else { return }
        let message = A2AMessage(
            sender: AgentId("trios-agent"),
            recipient: recipient,
            type: type,
            payload: payload
        )
        do {
            try await client.sendMessage(message)
        } catch {
            // Silent failure  -  A2A is best-effort until server routes are live
        }
    }

    private func handleEvent(
        _ event: SSEEvent,
        expectedGeneration: UInt64
    ) async {
        guard isCurrentStream(expectedGeneration) else { return }
        guard let action = await parser.parse(event) else { return }
        guard isCurrentStream(expectedGeneration) else { return }
        await applyAction(
            action,
            expectedGeneration: expectedGeneration
        )
    }

    private func applyAction(
        _ action: ParserAction,
        expectedGeneration: UInt64
    ) async {
        guard isCurrentStream(expectedGeneration) else { return }

        switch action {
        case .appendMessage(let message):
            messages.append(message)
            rebuildCache()
            if message.role == .assistant,
               var pending = pendingMemoryTurn,
               pending.streamGeneration == streamGeneration {
                pending.assistantMessageId = message.id
                pendingMemoryTurn = pending
            }
            _ = await stateMachine.transition(to: .streaming(messageId: message.id))
            guard isCurrentStream(expectedGeneration) else { return }
            let currentState = await stateMachine.currentState()
            guard isCurrentStream(expectedGeneration) else { return }
            state = currentState

        case .appendText(let messageId, let delta):
            guard let index = messageCache[messageId] else { return }
            messages[index].content += delta
            if let lastIndex = messages[index].segments.indices.last,
               case .text(let existing) = messages[index].segments[lastIndex] {
                messages[index].segments[lastIndex] = .text(existing + delta)
            } else {
                messages[index].segments.append(.text(delta))
            }
            messages[index].isStreaming = true
            if pendingUsageActive {
                pendingEstimatedOutput += delta
            }
            objectWillChange.send()

        case .finishMessage(let messageId):
            guard let _ = messageCache[messageId] else { return }
            // Do NOT clear isStreaming here  -  text may be finished but tool calls
            // or reasoning may still be in progress. isStreaming is cleared on
            // streamComplete / streamAborted so the reaction bar only appears
            // after the *entire* assistant turn is done.
            objectWillChange.send()

        case .startSegment(let messageId, let segment):
            guard let index = messageCache[messageId] else { return }
            messages[index].segments.append(segment)
            objectWillChange.send()

        case .appendToSegment(let messageId, let kind, let delta):
            guard let index = messageCache[messageId] else { return }
            if let lastIndex = messages[index].segments.indices.last {
                switch (kind, messages[index].segments[lastIndex]) {
                case (.text, .text(let existing)):
                    messages[index].segments[lastIndex] = .text(existing + delta)
                case (.reasoning, .reasoning(let existing)):
                    messages[index].segments[lastIndex] = .reasoning(existing + delta)
                default:
                    break
                }
            }
            if pendingUsageActive {
                pendingEstimatedOutput += delta
            }
            objectWillChange.send()

        case .addToolCall(let messageId, let toolCall):
            guard let index = messageCache[messageId] else { return }
            messages[index].toolCalls.append(toolCall)
            messages[index].segments.append(.toolCall(id: toolCall.id))
            // The Queen is told by name which tools she must not call, and
            // nothing can stop her: the client sends no tool list and the agent
            // server takes no filter, so refusing one is a change to that
            // server's API rather than something available here. What is
            // available is noticing. An unenforceable rule that is at least
            // observed is a different thing from one nobody would ever know was
            // broken - and if this line never fires, that is evidence about the
            // instruction the next person can act on.
            if QueenDelegationPolicy.isForbiddenQueenToolCall(
                conversationId: conversationId,
                queenConversationId: ChatConversation.trinityQueenId,
                tool: toolCall.name
            ) {
                TriosLogBus.shared.error(
                    .queen,
                    "queen.tool.forbidden",
                    "The Queen called a tool she is told not to call",
                    ["tool": toolCall.name]
                )
            }
            await todoPlanner.markToolActivity(name: toolCall.name)
            guard isCurrentStream(expectedGeneration) else { return }
            objectWillChange.send()

        case .appendToolInput(let messageId, let toolCallId, let delta):
            guard let index = messageCache[messageId] else { return }
            if let toolIndex = messages[index].toolCalls.firstIndex(where: { $0.id == toolCallId }) {
                messages[index].toolCalls[toolIndex].arguments += delta
            }
            objectWillChange.send()

        case .finalizeToolInput(let messageId, let toolCallId, let arguments):
            guard let index = messageCache[messageId] else { return }
            if let toolIndex = messages[index].toolCalls.firstIndex(where: { $0.id == toolCallId }) {
                messages[index].toolCalls[toolIndex].arguments = arguments
                // Arguments are complete now, so the step can name its target.
                await todoPlanner.refineStepTitle(
                    toolName: messages[index].toolCalls[toolIndex].name,
                    arguments: arguments
                )
            }
            objectWillChange.send()

        case .setToolOutput(let messageId, let toolCallId, let output):
            guard let index = messageCache[messageId] else { return }
            if let toolIndex = messages[index].toolCalls.firstIndex(where: { $0.id == toolCallId }) {
                messages[index].toolCalls[toolIndex].output = output
                messages[index].toolCalls[toolIndex].isComplete = true
            }
            objectWillChange.send()

        case .setToolError(let messageId, let toolCallId, let error):
            guard let index = messageCache[messageId] else { return }
            if let toolIndex = messages[index].toolCalls.firstIndex(where: { $0.id == toolCallId }) {
                messages[index].toolCalls[toolIndex].output = "Error: \(error)"
                messages[index].toolCalls[toolIndex].isComplete = true
            }
            objectWillChange.send()

        case .recordUsage(let inputTokens, let outputTokens, let totalTokens):
            guard !receivedProviderUsage else { return }
            let resolvedOutput = inputTokens + outputTokens > 0 ? outputTokens : totalTokens
            tokenUsage.record(
                inputTokens: inputTokens,
                outputTokens: resolvedOutput,
                source: .provider
            )
            receivedProviderUsage = true

        case .streamComplete:
            finalizeAssistantStreamingState()
            finalizeEstimatedUsageIfNeeded()
            let historySnapshot = captureHistorySnapshot()
            await completePendingTurnIfNeeded()
            await persistHistorySnapshot(historySnapshot)
            guard isGenerationCurrent(expectedGeneration) else { return }
            _ = await stateMachine.transition(to: .idle)
            guard isGenerationCurrent(expectedGeneration) else { return }
            let currentState = await stateMachine.currentState()
            guard isGenerationCurrent(expectedGeneration) else { return }
            state = currentState
            await saveHistory(expectedGeneration: expectedGeneration)

        case .streamAborted:
            finalizeAssistantStreamingState()
            clearPendingUsage()
            let historySnapshot = captureHistorySnapshot()
            await cancelPendingTurn()
            await persistHistorySnapshot(historySnapshot)
            guard isGenerationCurrent(expectedGeneration) else { return }
            _ = await stateMachine.transition(to: .idle)
            guard isGenerationCurrent(expectedGeneration) else { return }
            let currentState = await stateMachine.currentState()
            guard isGenerationCurrent(expectedGeneration) else { return }
            state = currentState
            await saveHistory(expectedGeneration: expectedGeneration)

        case .streamError(let message):
            finalizeAssistantStreamingState()
            clearPendingUsage()
            let errorMsg = ChatMessage(role: .system, content: "[!] \(message)")
            messages.append(errorMsg)
            rebuildCache()
            let historySnapshot = captureHistorySnapshot()
            await failPendingTurn(message: message)
            await persistHistorySnapshot(historySnapshot)
            guard isGenerationCurrent(expectedGeneration) else { return }
            _ = await stateMachine.transition(to: .error(message))
            guard isGenerationCurrent(expectedGeneration) else { return }
            let currentState = await stateMachine.currentState()
            guard isGenerationCurrent(expectedGeneration) else { return }
            state = currentState
            await saveHistory(expectedGeneration: expectedGeneration)
        }
    }

    /// Feeds text/reasoning deltas to the context watchdog and returns its
    /// decision. Non-content events leave the watchdog unchanged. Also publishes
    /// a live `streamingBudgetStatus` so the UI can render a progress bar.
    private func feedWatchdog(event: SSEEvent) async -> StreamingContextDecision {
        let decision: StreamingContextDecision
        switch event {
        case .textDelta(_, let delta),
             .reasoningDelta(_, let delta):
            decision = await contextWatchdog.append(deltaText: delta)
        default:
            decision = .ok
        }
        await refreshStreamingBudgetStatus()
        return decision
    }

    /// Recomputes the published streaming-budget status from the watchdog.
    private func refreshStreamingBudgetStatus() async {
        guard let ratios = await contextWatchdog.budgetRatios() else {
            streamingBudgetStatus = nil
            return
        }
        let dominantRatio = max(ratios.outputRatio, ratios.totalRatio)
        let limitKind: StreamingContextLimitKind = ratios.totalRatio >= ratios.outputRatio
            ? .totalContext
            : .outputTokens
        let kind: StreamingBudgetStatus.Kind
        if dominantRatio >= 0.95 {
            kind = .critical
        } else if dominantRatio >= 0.80 {
            kind = .warning
        } else {
            kind = .safe
        }
        streamingBudgetStatus = StreamingBudgetStatus(
            outputUsed: ratios.outputUsed,
            outputCeiling: ratios.outputCeiling,
            totalUsed: ratios.totalUsed,
            totalCeiling: ratios.totalCeiling,
            outputRatio: ratios.outputRatio,
            totalRatio: ratios.totalRatio,
            kind: kind,
            limitKind: limitKind
        )
    }

    /// Shows a transient warning when the response approaches a limit.
    /// The warning is not persisted as a history message (INV-10).
    private func showApproachingContextLimitWarning(
        remaining: Int,
        kind: StreamingContextLimitKind
    ) {
        let kindText = kind == .outputTokens ? "output" : "context"
        streamingContextWarning = "Response is approaching the \(kindText) limit (~\(remaining) tokens remaining)."
        streamingContextDecision = .approachingLimit(remainingTokens: remaining, kind: kind)
    }

    /// Pauses the current stream and transitions to a state where the user must
    /// choose how to continue after a context limit is reached.
    private func pauseStreamForContextLimit(
        generation: UInt64,
        partialText: String,
        suggestedAction: StreamingContextSuggestedAction
    ) async {
        // The caller already verified this generation is current. Do NOT re-check
        // after invalidating the stream, because invalidateActiveStream bumps
        // streamGeneration and would make the guard fail (INV-8).
        invalidateActiveStream()
        finalizeAssistantStreamingState()
        await transport.cancel()
        await completePendingTurnIfNeeded()

        let messageId = latestAssistantMessageId() ?? UUID()
        _ = await stateMachine.transition(to: .awaitingContextDecision(
            messageId: messageId,
            partialText: partialText
        ))
        let currentState = await stateMachine.currentState()
        state = currentState
        isStreamPausedForContext = true
        streamingContextDecision = .limitReached(
            partialText: partialText,
            suggestedAction: suggestedAction
        )
        streamingContextPauseLabel = contextLimitPauseLabel(for: suggestedAction)
        updateContextActionAvailability(suggestedAction: suggestedAction, partialText: partialText)
        // Save the paused state directly; do not use saveHistory(expectedGeneration:)
        // because invalidateActiveStream has bumped streamGeneration.
        let snapshot = captureHistorySnapshot()
        await persistHistorySnapshot(snapshot)
    }

    /// Returns a user-facing label describing which limit was hit.
    private func contextLimitPauseLabel(
        for suggestedAction: StreamingContextSuggestedAction
    ) -> String {
        switch suggestedAction {
        case .continueOnLargerModel:
            return "Response reached the output limit. Continue on a larger model?"
        case .summarizeSoFar:
            return "Response reached the context limit. Summarize and continue?"
        case .stopHere:
            return "Response reached the context limit."
        }
    }

    /// Updates the availability flags for the context-limit action bar based on
    /// the suggested action and the current partial text.
    private func updateContextActionAvailability(
        suggestedAction: StreamingContextSuggestedAction,
        partialText: String
    ) {
        let trimmedPartial = partialText.trimmingCharacters(in: .whitespacesAndNewlines)
        canSummarizeStreamSoFar = !trimmedPartial.isEmpty && trimmedPartial.count >= 32
        switch suggestedAction {
        case .continueOnLargerModel:
            canContinueOnLargerModel = true
        default:
            canContinueOnLargerModel = false
        }
    }

    /// Returns the UUID of the most recent assistant message, if any.
    private func latestAssistantMessageId() -> UUID? {
        guard let last = messages.last(where: { $0.role == .assistant }) else { return nil }
        return last.id
    }

    /// User chose to continue the partial response on a larger model.
    func continueStreamOnLargerModel(_ candidate: CrossProviderModelCandidate? = nil) async {
        guard case .awaitingContextDecision = await stateMachine.currentState() else { return }
        let constraint = conversationModelConstraint
        let chosenCandidate: CrossProviderModelCandidate
        if let candidate = candidate {
            // A manually supplied candidate must still respect the conversation pin.
            if let constraint, candidate != constraint.candidate { return }
            chosenCandidate = candidate
        } else {
            let continuationOutputTokens = await modelStore.effectiveRequestedOutputTokens(
                for: modelStore.selectedModel,
                provider: modelStore.selectedProvider,
                baseURL: modelStore.baseURL
            ) ?? effectiveConversationOutputTokens ?? 1024
            guard let largerCandidate = await modelStore.selectLargerModelCandidate(
                estimatedInput: pendingEstimatedInputTokens,
                outputTokens: continuationOutputTokens,
                constrainedTo: constraint
            ) else { return }
            chosenCandidate = largerCandidate
        }
        modelStore.applyContextRoutedSelection(
            candidate: chosenCandidate,
            reason: "continued on larger model \(chosenCandidate.model)"
        )
        contextRoutingLabel = "continued on \(chosenCandidate.model)"
        isStreamPausedForContext = false
        streamingContextDecision = nil
        streamingContextWarning = nil
        streamingBudgetStatus = nil
        canContinueOnLargerModel = false
        canSummarizeStreamSoFar = false
        _ = await stateMachine.transition(to: .idle)
        state = await stateMachine.currentState()

        guard let lastUserMessage = messages.last(where: { $0.role == .user })?.content else { return }
        await sendMessage(text: lastUserMessage, appendUser: false)
    }

    /// User chose to summarize the partial response so far.
    func summarizeStreamSoFar() async {
        guard case .awaitingContextDecision(let messageId, _) = await stateMachine.currentState() else { return }
        guard let index = messageCache[messageId] else { return }
        let partial = messages[index].content
        let summaryPrompt = "Summarize the following assistant response so far in 2-3 sentences, preserving key facts:\n\n\"\"\"\n\(partial)\n\"\"\""

        isStreamPausedForContext = false
        streamingContextDecision = nil
        streamingContextWarning = nil
        streamingBudgetStatus = nil
        canContinueOnLargerModel = false
        canSummarizeStreamSoFar = false
        _ = await stateMachine.transition(to: .idle)
        state = await stateMachine.currentState()

        await sendMessage(text: summaryPrompt, appendUser: true)
    }

    /// User chose to keep the partial response and stop.
    func stopStreamAndKeepPartial() async {
        guard case .awaitingContextDecision(let messageId, _) = await stateMachine.currentState() else { return }
        guard let index = messageCache[messageId] else { return }
        messages[index].isStreaming = false
        messages[index].content += "\n\n[Response truncated by context limit]"
        rebuildCache()

        isStreamPausedForContext = false
        streamingContextDecision = nil
        streamingContextWarning = nil
        streamingBudgetStatus = nil
        canContinueOnLargerModel = false
        canSummarizeStreamSoFar = false
        _ = await stateMachine.transition(to: .idle)
        state = await stateMachine.currentState()
        let historySnapshot = captureHistorySnapshot()
        await persistHistorySnapshot(historySnapshot)
        await saveHistory(expectedGeneration: streamGeneration)
    }

    func searchMemories(_ query: String) async -> [AgentMemoryMatch] {
        let revision = memoryControlRevision
        let matches = await memoryService.recall(for: query, limit: 20)
        return revision == memoryControlRevision ? matches : []
    }

    func recentMemories(limit: Int = 20) async throws -> [AgentMemoryMatch] {
        let revision = memoryControlRevision
        let matches = try await memoryService.recentMemories(limit: limit)
        return revision == memoryControlRevision ? matches : []
    }

    func forgetMemory(id: UUID) async throws -> Bool {
        let deleted = try await memoryService.forgetMemory(id: id)
        memoryControlRevision &+= 1
        recalledMemories.removeAll { $0.record.id == id }
        return deleted
    }

    func clearCurrentConversationMemories() async throws -> Int {
        try await clearConversationMemories(
            conversationId: conversationId
        )
    }

    func clearConversationMemories(
        conversationId targetConversationId: UUID
    ) async throws -> Int {
        beginMemoryClear(conversationId: targetConversationId)
        defer {
            endMemoryClear(conversationId: targetConversationId)
        }
        memoryControlRevision &+= 1
        advanceMemoryWriteRevision(for: targetConversationId)
        if var pending = pendingMemoryTurn,
           pending.conversationId == targetConversationId {
            pending.shouldRemember = false
            pendingMemoryTurn = pending
        }

        await waitForMemoryWrite(conversationId: targetConversationId)
        let deleted = try await memoryService.clearConversationMemories(
            conversationId: targetConversationId
        )
        memoryControlRevision &+= 1
        recalledMemories.removeAll {
            $0.record.conversationId == targetConversationId
        }
        return deleted
    }

    private func completePendingTurnIfNeeded() async {
        guard let initialPending = pendingMemoryTurn else { return }
        await todoPlanner.completePlan()

        guard let pending = pendingMemoryTurn,
              isSamePendingTurn(pending, initialPending) else {
            return
        }
        guard pending.streamGeneration == streamGeneration,
              pending.memoryWriteRevision == memoryWriteRevision(
                  for: pending.conversationId
              ),
              !isMemoryClearInProgress(pending.conversationId),
              pending.shouldRemember,
              let assistantMessageId = pending.assistantMessageId,
              let assistant = messages.first(where: {
                  $0.id == assistantMessageId && $0.role == .assistant
              }) else {
            clearPendingTurnIfMatching(pending)
            return
        }
        let directContent = assistant.content
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let segmentContent = assistant.segments.compactMap { segment -> String? in
            guard case .text(let text) = segment else { return nil }
            return text
        }
        .joined()
        .trimmingCharacters(in: .whitespacesAndNewlines)
        let result = directContent.isEmpty ? segmentContent : directContent
        guard !result.isEmpty else {
            clearPendingTurnIfMatching(pending)
            return
        }

        let writeTask = Task { [memoryService] in
            await memoryService.rememberCompletedTurn(
                conversationId: pending.conversationId,
                sourceMessageId: pending.sourceMessageId,
                goal: pending.goal,
                assistantResult: result
            )
        }
        activeMemoryWrites[pending.sourceMessageId] = ActiveAgentMemoryWrite(
            conversationId: pending.conversationId,
            sourceMessageId: pending.sourceMessageId,
            task: writeTask
        )
        let stored = await writeTask.value
        clearActiveMemoryWriteIfMatching(
            conversationId: pending.conversationId,
            sourceMessageId: pending.sourceMessageId
        )
        let stillAllowed =
            pending.memoryWriteRevision == memoryWriteRevision(
                for: pending.conversationId
            )
            && !isMemoryClearInProgress(pending.conversationId)
        clearPendingTurnIfMatching(pending)

        if !stillAllowed, let stored {
            do {
                _ = try await memoryService.forgetMemory(id: stored.id)
            } catch {
                NSLog(
                    "[AgentMemory] post-clear cleanup failed: %@",
                    error.localizedDescription
                )
            }
        }
    }

    /// Keeps a partial answer when its turn is about to be cancelled.
    ///
    /// The stream itself cannot outlive the switch: the planner, the memory
    /// turn, the usage ledger and the state machine are all single-slot and
    /// conversation-scoped, so two live turns would corrupt each other. What
    /// can be saved is the work already streamed, and a line saying why it
    /// stopped - a silent void reads as a crash.
    private func preserveInterruptedTurn(reason: String) async {
        guard case .streaming = state else { return }
        guard messages.contains(where: { $0.role == .assistant && $0.isStreaming }) else { return }

        finalizeAssistantStreamingState()
        messages.append(ChatMessage(
            role: .system,
            content: "[interrupted] This answer stopped because \(reason). "
                + "Everything above was kept; send again to continue."
        ))
        rebuildCache()
        let snapshot = captureHistorySnapshot()
        await persistHistorySnapshot(snapshot)
        TriosLogBus.shared.warn(
            .chat,
            "chat.turn.interrupted",
            "A streaming turn was cut short",
            ["conversation": conversationId.uuidString, "reason": reason]
        )
    }

    private func cancelPendingTurn() async {
        guard pendingMemoryTurn != nil else { return }
        pendingMemoryTurn = nil
        await todoPlanner.cancelPlan()
    }

    private func failPendingTurn(message: String) async {
        guard pendingMemoryTurn != nil else { return }
        pendingMemoryTurn = nil
        await todoPlanner.failPlan(message: message)
    }

    private func invalidateActiveStream() {
        streamGeneration &+= 1
    }

    private func isCurrentStream(_ generation: UInt64) -> Bool {
        isGenerationCurrent(generation)
            && pendingMemoryTurn?.streamGeneration == generation
    }

    private func isGenerationCurrent(_ generation: UInt64) -> Bool {
        generation == streamGeneration
    }

    private func memoryWriteRevision(for conversationId: UUID) -> UInt64 {
        memoryWriteRevisions[conversationId] ?? 0
    }

    private func advanceMemoryWriteRevision(for conversationId: UUID) {
        memoryWriteRevisions[conversationId] =
            memoryWriteRevision(for: conversationId) &+ 1
    }

    private func historyWriteRevision(for conversationId: UUID) -> UInt64 {
        historyWriteRevisions[conversationId] ?? 0
    }

    private func advanceHistoryWriteRevision(for conversationId: UUID) {
        historyWriteRevisions[conversationId] =
            historyWriteRevision(for: conversationId) &+ 1
    }

    private func isHistoryDeletionInProgress(
        _ conversationId: UUID
    ) -> Bool {
        (historyDeletionCounts[conversationId] ?? 0) > 0
    }

    private func beginHistoryDeletion(conversationId: UUID) {
        historyDeletionCounts[conversationId, default: 0] += 1
        advanceHistoryWriteRevision(for: conversationId)
    }

    private func endHistoryDeletion(conversationId: UUID) {
        let remaining = (historyDeletionCounts[conversationId] ?? 1) - 1
        if remaining > 0 {
            historyDeletionCounts[conversationId] = remaining
        } else {
            historyDeletionCounts.removeValue(forKey: conversationId)
        }
    }

    private func isMemoryClearInProgress(_ conversationId: UUID) -> Bool {
        (memoryClearCounts[conversationId] ?? 0) > 0
    }

    private func beginMemoryClear(conversationId: UUID) {
        memoryClearCounts[conversationId, default: 0] += 1
    }

    private func endMemoryClear(conversationId: UUID) {
        let remaining = (memoryClearCounts[conversationId] ?? 1) - 1
        if remaining > 0 {
            memoryClearCounts[conversationId] = remaining
        } else {
            memoryClearCounts.removeValue(forKey: conversationId)
        }
    }

    private func waitForMemoryWrite(conversationId: UUID) async {
        let writes = activeMemoryWrites.values.filter {
            $0.conversationId == conversationId
        }
        for write in writes {
            _ = await write.task.value
            clearActiveMemoryWriteIfMatching(
                conversationId: write.conversationId,
                sourceMessageId: write.sourceMessageId
            )
        }
    }

    private func clearActiveMemoryWriteIfMatching(
        conversationId: UUID,
        sourceMessageId: UUID
    ) {
        guard let activeMemoryWrite = activeMemoryWrites[sourceMessageId],
              activeMemoryWrite.conversationId == conversationId,
              activeMemoryWrite.sourceMessageId == sourceMessageId else {
            return
        }
        activeMemoryWrites.removeValue(forKey: sourceMessageId)
    }

    private func isSamePendingTurn(
        _ lhs: PendingAgentMemoryTurn,
        _ rhs: PendingAgentMemoryTurn
    ) -> Bool {
        lhs.streamGeneration == rhs.streamGeneration
            && lhs.sourceMessageId == rhs.sourceMessageId
    }

    private func clearPendingTurnIfMatching(
        _ pending: PendingAgentMemoryTurn
    ) {
        guard let current = pendingMemoryTurn,
              isSamePendingTurn(current, pending) else {
            return
        }
        pendingMemoryTurn = nil
    }

    private func finalizeAssistantStreamingState() {
        for index in messages.indices
        where messages[index].role == .assistant
            && messages[index].isStreaming {
            messages[index].isStreaming = false
        }
    }

    private func beginConversationTransition() -> Bool {
        guard !isConversationTransitioning else { return false }
        isConversationTransitioning = true
        return true
    }

    private func endConversationTransition() {
        isConversationTransitioning = false
    }

    private func awaitInitialization() async {
        if let initializationTask {
            await initializationTask.value
        }
    }

    private func memorySafeGoal(from text: String) -> String {
        let marker = "<local_attachments>"
        let userText = text.components(separatedBy: marker).first ?? text
        let normalized = userText
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return normalized.isEmpty ? "Inspect attached files" : normalized
    }

    private func isEligibleForLongTermMemory(_ text: String) -> Bool {
        let lowercased = text.lowercased()
        let excludedMarkers = [
            "<local_attachments>",
            "<browser_context>",
            "```",
            "diff --git ",
            "-----begin file-----",
            "-----end file-----"
        ]
        return !excludedMarkers.contains(where: lowercased.contains)
    }

    private func beginUsageEstimate(message: String, history: [ChatMessage]) {
        let context = history.map(\.content).joined(separator: "\n") + "\n" + message
        pendingEstimatedInputTokens = TokenEstimator.estimate(context)
        pendingEstimatedOutput = ""
        pendingUsageActive = true
        receivedProviderUsage = false
    }

    private func finalizeEstimatedUsageIfNeeded() {
        guard pendingUsageActive else { return }
        if !receivedProviderUsage {
            tokenUsage.record(
                inputTokens: pendingEstimatedInputTokens,
                outputTokens: TokenEstimator.estimate(pendingEstimatedOutput),
                source: .estimate
            )
        }
        clearPendingUsage()
    }

    private func clearPendingUsage() {
        pendingEstimatedInputTokens = 0
        pendingEstimatedOutput = ""
        pendingUsageActive = false
        receivedProviderUsage = false
    }

    func rebuildCache() {
        // Stable sort: timestamp is primary, original index is tie-breaker.
        // Without a tie-breaker, Array.sort is unstable and messages created in
        // the same millisecond can appear out of order.
        let indexed = messages.enumerated().map { (index: $0, message: $1) }
        let sorted = indexed.sorted { a, b in
            if a.message.timestamp != b.message.timestamp {
                return a.message.timestamp < b.message.timestamp
            }
            return a.index < b.index
        }
        messages = sorted.map { $0.message }

        deduplicateMessages()

        messageCache = [:]
        for (index, message) in messages.enumerated() {
            messageCache[message.id] = index
        }
    }

    func deduplicateMessages() {
        var seenIds = Set<UUID>()
        messages = messages.filter { msg in
            guard !seenIds.contains(msg.id) else { return false }
            seenIds.insert(msg.id)
            return true
        }
    }

    private func saveHistory(expectedGeneration: UInt64) async {
        guard isGenerationCurrent(expectedGeneration) else { return }
        let targetConversationId = conversationId
        let snapshot = messages
        await persister.save(
            messages: snapshot,
            conversationId: targetConversationId
        )
        guard isGenerationCurrent(expectedGeneration),
              conversationId == targetConversationId else {
            return
        }
        await loadConversations()
    }

    private func captureHistorySnapshot() -> ConversationHistorySnapshot {
        ConversationHistorySnapshot(
            conversationId: conversationId,
            messages: messages,
            writeRevision: historyWriteRevision(for: conversationId)
        )
    }

    private func persistHistorySnapshot(
        _ snapshot: ConversationHistorySnapshot
    ) async {
        guard snapshot.writeRevision == historyWriteRevision(
                  for: snapshot.conversationId
              ),
              !isHistoryDeletionInProgress(snapshot.conversationId) else {
            return
        }

        await persister.save(
            messages: snapshot.messages,
            conversationId: snapshot.conversationId
        )

        guard snapshot.writeRevision == historyWriteRevision(
                  for: snapshot.conversationId
              ),
              !isHistoryDeletionInProgress(snapshot.conversationId) else {
            await persister.clear(conversationId: snapshot.conversationId)
            return
        }

        if conversationId == snapshot.conversationId {
            await loadConversations()
        }
    }

    private func clearPersistedConversationHistory(
        conversationId: UUID
    ) async {
        beginHistoryDeletion(conversationId: conversationId)
        defer {
            endHistoryDeletion(conversationId: conversationId)
        }
        await persister.clear(conversationId: conversationId)
    }
    
    // MARK: - Conversation Management

    func renameConversation(_ id: UUID, to newName: String) async {
        let title = ConversationTitlePolicy.normalized(newName)
        if let index = conversations.firstIndex(where: { $0.id == id }) {
            conversations[index].title = title
        }
        await persister.renameConversation(id: id, title: title)
        await loadConversations()
    }

    func togglePin(_ id: UUID) {
        guard id != ChatConversation.trinityQueenId else {
            NSLog("[TriosChat] togglePin ignored for reserved Trinity Queen conversation")
            return
        }
        if let index = conversations.firstIndex(where: { $0.id == id }) {
            conversations[index].isPinned.toggle()
            objectWillChange.send()
        }
    }

    func createNewConversation() {
        guard beginConversationTransition() else { return }
        let newConv = ChatConversation(
            id: UUID(),
            title: "New Chat",
            isPinned: false,
            icon: "message.fill",
            updatedAt: Date(),
            unreadCount: 0
        )
        invalidateActiveStream()
        Task {
            await awaitInitialization()
            await preserveInterruptedTurn(reason: "you started a new chat")
            await cancelPendingTurn()
            await transport.cancel()
            _ = await stateMachine.transition(to: .idle)
            state = await stateMachine.currentState()
            conversations.insert(newConv, at: 0)
            conversationId = newConv.id
            messages = []
            messageCache = [:]
            tokenUsage.reset()
            clearPendingUsage()
            recalledMemories = []
            memoryControlRevision &+= 1
            objectWillChange.send()
            await todoPlanner.load(conversationId: newConv.id)
            await persister.setCurrentConversationId(newConv.id)
            await loadConversations()
            endConversationTransition()
        }
    }

    func selectConversation(_ id: UUID) {
        guard beginConversationTransition() else { return }
        invalidateActiveStream()
        Task {
            await awaitInitialization()
            await performConversationSwitch(id: id)
            endConversationTransition()
        }
    }

    func deleteConversation(_ id: UUID) {
        guard id != ChatConversation.trinityQueenId else {
            NSLog("[TriosChat] deleteConversation ignored for reserved Trinity Queen conversation")
            Task {
                await appendSystemMessageToQueenChat(
                    "This conversation is the Trinity Queen direct line and cannot be deleted."
                )
            }
            return
        }
        guard beginConversationTransition() else { return }
        let retainedHistorySnapshot: ConversationHistorySnapshot?
        if id == conversationId {
            finalizeAssistantStreamingState()
            retainedHistorySnapshot = captureHistorySnapshot()
            invalidateActiveStream()
        } else {
            retainedHistorySnapshot = nil
        }
        Task {
            await awaitInitialization()
            await performConversationDeletion(
                id: id,
                retainedHistorySnapshot: retainedHistorySnapshot
            )
            endConversationTransition()
        }
    }

    /// Puts a correction where the worker will read it.
    ///
    /// Written straight through the persister rather than into `messages`,
    /// because the worker's conversation is usually not the one on screen and
    /// touching the visible transcript for a different chat is how two
    /// conversations end up sharing a history.
    private func appendCorrectionToWorkerChat(task: DelegatedTask, text: String) async {
        let note = ChatMessage(
            role: .system,
            content: QueenObserver.correctionText(concerns: [text])
        )
        var history = await persister.load(conversationId: task.conversationId)
        history.append(note)
        await persister.save(messages: history, conversationId: task.conversationId)
    }

    /// The Queen's chat as last known, when the user is looking somewhere else.
    ///
    /// Kept because the obvious version loses messages. Load, append, save has
    /// two suspension points, and bees do not report politely one at a time -
    /// six finishing together each loaded the same history, appended their own
    /// line and saved, so five were overwritten. Six notices arrived and she
    /// heard two. A supervisor silently missing four bees is worse than one
    /// reporting late.
    ///
    /// Appending to an array held here is synchronous on the main actor, so no
    /// two callers can interleave between reading and writing it. Only the save
    /// suspends, and by then every caller's line is already in the array.
    private var queenChatWhileAway: [ChatMessage]?
    /// The tail of the queue of writes to her chat, so two reports arriving at
    /// once cannot land out of order and lose one.
    private var queenChatSaveChain: Task<Void, Never>?

    func appendSystemMessageToQueenChat(_ content: String) async {
        let message = ChatMessage(role: .system, content: content)
        if conversationId == ChatConversation.trinityQueenId {
            // Her chat is open, so `messages` is the live copy and the cache
            // would only go stale behind it.
            queenChatWhileAway = nil
            messages.append(message)
            rebuildCache()
            await saveHistory(expectedGeneration: streamGeneration)
            await loadConversations()
            return
        }

        if queenChatWhileAway == nil {
            let loaded = await persister.load(conversationId: ChatConversation.trinityQueenId)
            // Re-check: a second caller may have filled it while this one was
            // suspended, and overwriting would drop whatever it had appended.
            if queenChatWhileAway == nil { queenChatWhileAway = loaded }
        }
        queenChatWhileAway?.append(message)
        await persistQueenChatWhileAway(fallback: message)
        await loadConversations()
    }

    /// Serialises the writes to the Queen's chat, and takes the snapshot at the
    /// moment each one runs rather than when it was queued.
    ///
    /// The buffer above already stopped concurrent reports from overwriting each
    /// other in memory - every bee appends to the same array on the main actor,
    /// so the array is always complete. What was still lost was the file: each
    /// caller passed its own whole-array snapshot to `save`, the saves raced,
    /// and the winner was whichever finished last, not whichever held the most.
    /// Six bees reporting at once persisted three, and the Queen was missing
    /// half her fleet with nothing anywhere saying so.
    ///
    /// Found by running six reports concurrently under a parallel build - it
    /// survived every idle run, which is why a fixed sleep had been enough to
    /// hide it.
    private func persistQueenChatWhileAway(fallback: ChatMessage) async {
        let previous = queenChatSaveChain
        let save = Task { @MainActor [weak self] in
            await previous?.value
            guard let self else { return }
            let snapshot = self.queenChatWhileAway ?? [fallback]
            await self.persister.save(
                messages: snapshot,
                conversationId: ChatConversation.trinityQueenId
            )
        }
        queenChatSaveChain = save
        await save.value
        if queenChatSaveChain == save { queenChatSaveChain = nil }
    }

    // MARK: - Queen Slash Commands

    private func executeQueenCommand(_ command: QueenCommand, originalText: String) async {
        switch command {
        case .help:
            await appendSystemMessageToQueenChat(QueenCommandParser.helpText)
        case .status:
            let a2aStatus = queenBackgroundService?.isA2ARegistered ?? false
            await appendSystemMessageToQueenChat(
                "Server: \(isServerReachable ? "online" : "offline"). " +
                "A2A: \(a2aStatus ? "registered" : "unregistered"). " +
                "Conversations: \(conversations.count)."
            )
        case .agents:
            await listQueenAgents()
        case .chats:
            await listQueenChats()
        case .switchChat(let id):
            await switchConversation(id: id)
            await appendSystemMessageToQueenChat("Switched to conversation \(id.uuidString.prefix(8))")
        case .newChat(let title):
            if let id = await queenBackgroundService?.createChat(title: title) {
                await switchConversation(id: id)
                await appendSystemMessageToQueenChat("Created and switched to conversation \(id.uuidString.prefix(8))")
            } else {
                newConversation()
                if let title, !title.isEmpty {
                    await renameConversation(conversationId, to: title)
                }
                await appendSystemMessageToQueenChat("Created new conversation")
            }
        case .deleteChat(let id):
            deleteConversation(id)
            await appendSystemMessageToQueenChat("Deleted conversation \(id.uuidString.prefix(8))")
        case .delegate(let agent, let task):
            await delegateTaskToAgent(agentIdString: agent, taskDescription: task)
        case .delegateIssue(let issue, let worker, let title, let paths, let skill, let criteria):
            await delegateIssueToWorker(
                issue: issue,
                worker: worker,
                title: title,
                paths: paths,
                skill: skill,
                criteria: criteria
            )
        case .cancelTask(let issue, let reason):
            await cancelDelegatedTask(issue: issue, reason: reason)
        case .verifyCriterion(let issue, let criterion, let verdict):
            await recordCriterionVerdict(issue: issue, criterion: criterion, verdict: verdict)
        case .approveDelegation(let issue):
            await approveDelegation(issue: issue)
        case .openPullRequest(let issue):
            await openPullRequestForTask(issue: issue)
        case .swarm:
            await reportSwarm()
        case .review(let issue, let decision, let note):
            await reviewDelegatedTask(issue: issue, decision: decision, note: note)
        case .broadcast(let message):
            await broadcastToAgents(message)
        case .audit:
            await runQueenEvolution()
        case .memory:
            await recallQueenMemory()
        case .evolve:
            await runQueenEvolution()
        case .proposals:
            await listQueenProposals()
        case .evolveApply(let id, let confirmed):
            if confirmed {
                guard stagedProposalIds.contains(id) else {
                    await appendSystemMessageToQueenChat(
                        "Proposal \(id.uuidString.prefix(8)) has not been staged. Run `/apply \(id.uuidString)` first."
                    )
                    return
                }
                await applyQueenProposal(id: id, confirmed: true)
            } else {
                await applyQueenProposal(id: id, confirmed: false)
            }
        case .evolveReject(let id):
            await rejectQueenProposal(id: id)
        case .doctor(let model):
            let output: String
            if let model = model, !model.isEmpty {
                // Persist the requested model so the next chat turn also uses it.
                modelStore.selectModel(model)
                output = await queenStatusVM.runSkillReturningOutput(
                    name: "/doctor",
                    arguments: ["--model", model]
                )
            } else {
                output = await queenStatusVM.runSkillReturningOutput(name: "/doctor")
            }
            await appendSystemMessageToQueenChat("`/doctor` result:\n\(output)")
        case .tri:
            let output = await queenStatusVM.runSkillReturningOutput(name: "/tri")
            await appendSystemMessageToQueenChat("`/tri` result:\n\(output)")
        case .godMode:
            let output = await queenStatusVM.runSkillReturningOutput(name: "/god-mode")
            await appendSystemMessageToQueenChat("`/god-mode` result:\n\(output)")
        case .bridge:
            let output = await queenStatusVM.runSkillReturningOutput(name: "/bridge")
            await appendSystemMessageToQueenChat("`/bridge` result:\n\(output)")
        case .skills:
            await reportSkills()
        case .selfAudit:
            await runSelfAudit()
        case .salience:
            await reportSalience()
        case .runSkill(let command, let arguments):
            await runQueenSkill(command: command, arguments: arguments)
        case .unknown:
            await appendSystemMessageToQueenChat(
                SystemNoticeClassifier.warningMarker
                    + "I do not know `\(originalText)`.\n\(QueenCommandParser.helpText)"
            )
        }
    }

    private func listQueenAgents() async {
        let agents = await queenBackgroundService?.listAgents() ?? []
        let lines = agents.map { "* \($0.id.rawValue): \($0.name)" }
        let text = lines.isEmpty ? "No online agents discovered." : lines.joined(separator: "\n")
        await appendSystemMessageToQueenChat("Online agents:\n\(text)")
    }

    private func listQueenChats() async {
        let chats = await queenBackgroundService?.listChats() ?? conversations
        let lines = chats.map { conv in
            let pin = conv.isReserved ? "[QUEEN]" : (conv.isPinned ? "[PIN]" : "  ")
            return "\(pin) \(conv.id.uuidString.prefix(8))  -  \(conv.title)"
        }
        await appendSystemMessageToQueenChat("Conversations:\n\(lines.joined(separator: "\n"))")
    }

    /// Opens a worker chat for a GitHub issue and isolates it on its own
    /// GitButler virtual branch.
    ///
    /// This is the Queen's one act of creation: she does not write code, she
    /// opens a conversation, gives it a boundary, and reviews what comes back.
    private func delegateIssueToWorker(
        issue: IssueReference,
        worker: String,
        title: String,
        paths: [String] = [],
        skill: String? = nil,
        criteria: [String] = []
    ) async {
        let registry = delegationRegistry

        if let existing = registry.task(forIssue: issue) {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "\(issue.slug) is already delegated to \(existing.worker). "
                    + "Open that chat rather than starting a second one."
            )
            return
        }
        // The Queen proposes, the person decides. Checked before every other
        // refusal so the answer is about consent rather than capacity - being
        // told "three workers are busy" when the real problem is that nobody
        // agreed to this work would send the user to fix the wrong thing.
        if let reason = QueenDelegationPolicy.approvalBlockReason(
            issue: issue, approved: registry.approvedIssues
        ) {
            await postQueenNotice(SystemNoticeClassifier.warningMarker + reason)
            return
        }
        if let reason = registry.delegationBlockReason(paths: paths) {
            await postQueenNotice(SystemNoticeClassifier.warningMarker + "Cannot delegate: \(reason)")
            return
        }
        // Refuse to *start* work past the ceiling. Stopping a bee already
        // running would leave the repository half-edited; declining to open a
        // new one is a decision that can be taken safely at any moment.
        let spent = registry.spentToday()
        if case .exhausted(let overBy) = SwarmBudget.default.verdict(spentToday: spent) {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "I am not opening new work today. The swarm has spent about "
                    + "\(ModelPricing.format(spent)), which is \(ModelPricing.format(overBy)) past "
                    + "the daily ceiling. Anything already running continues."
            )
            return
        }

        // No contract on the command line? Read the one the issue already
        // states. Requiring it to be retyped is why every delegation in this
        // project's history went out with nothing to judge it by - the flag
        // existed, and in practice nobody used it.
        var criteria = criteria
        if criteria.isEmpty {
            if let body = await fetchIssueBody(issue) {
                criteria = QueenTaskSpec.criteriaFromIssue(body: body)
                if !criteria.isEmpty {
                    TriosLogBus.shared.info(
                        .queen, "queen.spec.fromIssue", "Read the contract from the issue",
                        ["issue": issue.slug, "criteria": String(criteria.count)]
                    )
                }
            } else {
                // Not fatal. A task with no criteria is still delegated, and the
                // specification says plainly that nothing here can be judged
                // finished - the honest state, not a silent one.
                TriosLogBus.shared.warn(
                    .queen, "queen.spec.issueUnreadable",
                    "Could not read the issue, so there is no contract",
                    ["issue": issue.slug]
                )
            }
        }

        // Create the worker's own conversation. The persister materialises a
        // conversation the moment messages are saved against a fresh id.
        let conversationId = UUID()

        guard let task = registry.delegate(
            issue: issue,
            title: title,
            worker: worker,
            conversationId: conversationId,
            ownedPaths: paths,
            acceptanceCriteria: criteria
        ) else {
            await postQueenNotice(SystemNoticeClassifier.failureMarker + (registry.lastError ?? "Delegation was refused."))
            return
        }

        // The virtual branch is what keeps two bees off each other's files.
        if let branch = task.virtualBranch {
            if let reason = await createVirtualBranch(named: branch) {
                registry.transition(taskID: task.id, to: .cancelled)
                await postQueenNotice(
                    SystemNoticeClassifier.failureMarker
                        + "Could not create the virtual branch `\(branch)`, so the delegation "
                        + "was rolled back. git said: \(reason)"
                )
                return
            }
        }

        // Brief the worker in its own chat. Deliberately a subset of context:
        // the issue, the branch, the boundary - never the Queen's history.
        // A named skill is handed over whole. Refused rather than silently
        // ignored: a worker briefed without the procedure it was promised looks
        // like it disobeyed.
        var skillBody: String?
        if let skill {
            guard let descriptor = skillStore.skill(named: skill),
                  skillStore.isEnabled(descriptor),
                  let body = try? String(contentsOfFile: descriptor.path, encoding: .utf8) else {
                registry.transition(taskID: task.id, to: .cancelled)
                await postQueenNotice(
                    SystemNoticeClassifier.warningMarker
                        + "I did not open this one. You asked for `\(skill)` and I either do not "
                        + "have it or it is switched off, and briefing a worker without the "
                        + "procedure you named would look like it ignored you."
                )
                return
            }
            skillBody = body
        }
        let brief = QueenBriefing.text(for: task, skillBody: skillBody)
        // Materialise the chat before naming it. renameConversation renames a
        // record that exists; the comment above claimed the persister creates
        // one "the moment messages are saved against a fresh id", which is true
        // and is the problem - nothing was saved yet, so the rename landed on
        // nothing and the chat stayed out of the sidebar until the bee spoke.
        //
        // A delegated chat nobody can see is a bee nobody can supervise, which
        // is the whole point of the Queen having chats at all.
        await persister.save(messages: [], conversationId: conversationId)
        await persister.renameConversation(
            id: conversationId,
            title: "\(issue.slug) \(title)"
        )
        await loadConversations()
        registry.transition(taskID: task.id, to: .running)

        // Actually start the bee. Saving the briefing and stopping there left a
        // chat that looked delegated and did nothing, which is worse than
        // refusing to delegate at all.
        guard let runner = workerRunner else {
            registry.transition(taskID: task.id, to: .failed)
            await postQueenNotice(
                SystemNoticeClassifier.failureMarker
                    + "Delegation aborted: no worker runner is configured, so \(worker) could not be started."
            )
            await loadConversations()
            return
        }
        // Take the baseline before the bee touches anything.
        workerBaselineTrees[conversationId] = await QueenBranchCommitter.snapshotWorkingTree()
        runner.start(task: task, brief: brief)

        await postQueenNotice(
            SystemNoticeClassifier.successMarker
                + "\(worker) is on \(issue.slug) now. It has its own chat and its own "
                + "branch `\(task.virtualBranch ?? "-")`, so whatever it edits grows apart "
                + "from your working tree until you decide otherwise. "
                + "That puts \(registry.running.count) of "
                + "\(QueenDelegationPolicy.maximumConcurrentWorkers) slots in use."
        )
        await loadConversations()
    }

    /// Creates the branch that isolates a task's edits.
    ///
    /// Deliberately `git branch` and not `git checkout -b`: creating the ref
    /// must not move HEAD. The checkout is shared by the user, the build, and
    /// every other worker, so switching it on delegation silently dragged the
    /// whole repository onto one bee's branch - the exact conflict the branch
    /// was supposed to prevent.
    /// Returns nil when the branch exists afterwards, or git's own complaint
    /// when it does not.
    ///
    /// It used to return Bool and throw away what git said, so a failed
    /// delegation told the user only that the branch could not be created -
    /// never that the name was already taken, or that HEAD was unborn, or
    /// whichever of those it actually was. The compiler had been reporting the
    /// discarded result on every build; the value it named was the answer to
    /// the question the failure message could not answer.
    private func createVirtualBranch(named name: String) async -> String? {
        await Task.detached(priority: .utility) {
            let existing = QueenStatusViewModel.runProcess(
                "/usr/bin/git",
                arguments: ["branch", "--list", name],
                workDir: ProjectPaths.root,
                timeout: 10
            )
            // Reconnecting to an existing task must not be treated as an error.
            if existing.contains(name) { return nil }
            let attempt = QueenStatusViewModel.runProcess(
                "/usr/bin/git",
                arguments: ["branch", name, "HEAD"],
                workDir: ProjectPaths.root,
                timeout: 20
            )
            let created = QueenStatusViewModel.runProcess(
                "/usr/bin/git",
                arguments: ["branch", "--list", name],
                workDir: ProjectPaths.root,
                timeout: 10
            )
            if created.contains(name) { return nil }
            // git is usually loud about why, but a timeout or a killed process
            // leaves nothing to quote, and "" would read as success upstream.
            let reason = attempt.trimmingCharacters(in: .whitespacesAndNewlines)
            return reason.isEmpty ? "git branch produced no output and no branch" : reason
        }.value
    }

    // MARK: - Worker Runner

    private func configureWorkerRunner() {
        guard let runner = workerRunner else { return }

        // A worker chat opened while its turn is in flight must show the live
        // stream, not the snapshot that happened to be persisted last.
        // The status pills read `runningConversationIds` through this view model,
        // and a worker finishing changes that set without touching anything the
        // views observe. It is @Published, but publishing to nobody: the runner
        // is held as a plain property here and no view subscribes to it. So a
        // bee that stopped kept its green "Working" pill until some unrelated
        // change forced a redraw - the supervisor surface confidently reporting
        // a worker that was not there.
        workerLivenessObservation = runner.$runningConversationIds
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.objectWillChange.send() }

        workerObservation = runner.$transcripts
            .receive(on: RunLoop.main)
            .sink { [weak self] transcripts in
                guard let self else { return }
                guard let live = transcripts[self.conversationId] else { return }
                // Never fight the main send path for the same conversation.
                guard self.workerRunner?.isRunning(conversationId: self.conversationId) == true else { return }
                self.messages = live
                self.rebuildCache()
            }

        runner.onModelResolved = { [delegationRegistry] task, provider, model in
            delegationRegistry.recordModel(
                taskID: task.id,
                provider: provider,
                model: model
            )
        }

        // The observer reads the stream while it is still moving. The review
        // loop is post-mortem by construction; this is the only place a bee can
        // be stopped before it wastes the whole turn.
        runner.onProgress = { [weak self] task, transcript in
            self?.observeWorker(task: task, transcript: transcript)
        }

        runner.onFinish = { [weak self] task, failure, usage in
            guard let self else { return }
            Task { await self.handleWorkerFinished(task: task, failure: failure, usage: usage) }
        }

        // The Queen reports to herself on a timer. Wired here rather than in the
        // composition root so the scheduler never outlives the chat it posts to.
        // The policy asks for weights; the learner supplies them. Installed once
        // here so `QueenDelegationPolicy` stays pure and testable without it.
        QueenDelegationPolicy.learnedWeight = { feature in
            MainActor.assumeIsolated { SalienceLearner.shared.weight(for: feature) }
        }

        let scheduler = QueenReviewScheduler.shared
        scheduler.tasks = { [delegationRegistry] in delegationRegistry.tasks }
        scheduler.report = { [weak self] digest in
            await self?.appendSystemMessageToQueenChat(digest)
        }
        // The wake is also when housekeeping happens: a supervisor that only
        // reports, and never acts on what it sees, is a nicer log.
        scheduler.spentToday = { [delegationRegistry] in delegationRegistry.spentToday() }
        scheduler.beforeReport = { [weak self, delegationRegistry] in
            await self?.reapStalledWorkers()
            await self?.pollPullRequests()
            delegationRegistry.pruneArchive()
        }
        scheduler.start()
    }

    private func handleWorkerFinished(
        task: DelegatedTask,
        failure: String?,
        usage: QueenWorkerRunner.WorkerUsage
    ) async {
        let registry = delegationRegistry
        registry.recordUsage(
            taskID: task.id,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            toolCalls: usage.toolCalls
        )

        var notice: String
        if let failure {
            notice = "\(task.worker) failed on \(task.issue.slug): \(failure)"
        } else {
            notice = "\(task.worker) finished \(task.issue.slug) and is awaiting your review."
        }

        // Attribute whatever the worker changed to its own branch. Until this
        // runs, the branch is an empty ref and the edits sit loose in the shared
        // working tree with nothing tying them to the issue.
        if failure == nil, let branch = task.virtualBranch {
            // Ask git what changed before committing, and judge the boundary on
            // that rather than on the names of the tools the worker called.
            // Names cannot see a shell write - filesystem_bash is neither
            // write-named nor path-argumented - so until now a worker could
            // `echo >` its way outside its lane and the only sign was the file
            // quietly not appearing on the branch, because the committer drops
            // what it may not carry. Dropped without a word looks like the work
            // was never done.
            //
            // Here rather than in observeWorker: that runs on every SSE delta,
            // and one git invocation per token costs more than the warning is
            // worth. This is once, when the turn ends.
            let measured = await QueenBranchCommitter.changedPaths(
                since: workerBaselineTrees[task.conversationId]
            )
            // An empty transcript on purpose. Anything the tool names could see
            // has already been announced during the turn by observeWorker, and
            // saying it twice at the end reads as two separate problems. What
            // is added here is only what names could not see.
            let strays = QueenObserver.outOfBoundsPaths(
                in: QueenWorkerTranscript(),
                ownedPaths: task.ownedPaths,
                observedWrites: measured.map {
                    QueenBranchCommitter.projectRelative($0)
                }
            )
            if !strays.isEmpty {
                notice += "\n\(task.worker) wrote outside its boundary, so those files "
                    + "will not be on the branch: " + strays.joined(separator: ", ")
                TriosLogBus.shared.error(
                    .queen,
                    "queen.observer.outOfBounds",
                    "A worker wrote outside its boundary",
                    ["issue": task.issue.slug, "paths": strays.joined(separator: ",")]
                )
            }

            // What she can settle on evidence, she settles now. A criterion
            // naming a file is answered by whether that file changed; one
            // naming none is left unchecked, so the gate still stops on the
            // questions a person has to answer and no longer stops on the ones
            // nobody needed to be asked.
            let evidenceVerdicts = QueenAcceptancePolicy.mechanicalVerdicts(
                criteria: task.acceptanceCriteria,
                changedPaths: measured.map { QueenBranchCommitter.projectRelative($0) }
            )
            for (criterion, verdict) in evidenceVerdicts {
                registry.recordVerdict(taskID: task.id, criterion: criterion, verdict: verdict)
            }
            if !evidenceVerdicts.isEmpty {
                TriosLogBus.shared.info(
                    .queen, "queen.review.evidence", "Judged what the files show",
                    [
                        "issue": task.issue.slug,
                        "judged": String(evidenceVerdicts.count),
                        "of": String(task.acceptanceCriteria.count)
                    ]
                )
            }

            let outcome = await QueenBranchCommitter.commitWorkerChanges(
                branch: branch,
                baselineTree: workerBaselineTrees[task.conversationId],
                message: "queen(\(task.issue.slug)): \(task.title)",
                ownedPaths: task.ownedPaths
            )
            notice += "\n" + outcome.summary
            registry.recordCommittedFiles(taskID: task.id, count: outcome.fileCount)
            TriosLogBus.shared.info(
                .queen,
                outcome.committed ? "queen.branch.committed" : "queen.branch.empty",
                outcome.summary,
                ["issue": task.issue.slug, "branch": branch]
            )

            // Ask a reviewer agent for verdicts on criteria the files alone
            // could not settle. A path check answers "does the file exist";
            // it cannot answer "does the change do what the criterion asks".
            // Without a reviewer those criteria stayed "never checked", which
            // blocked acceptance on the right question but left the user with
            // no answer to it. The reviewer fills the gap; the parser is
            // conservative, so a garbled response still leaves the criterion
            // unchecked rather than guessing it passed.
            let current = registry.task(forIssue: task.issue) ?? task
            let unanswered = current.acceptanceCriteria.filter {
                current.criterionVerdicts[$0] == nil
            }
            if !unanswered.isEmpty {
                let diffText = await diffForReview(
                    baselineTree: workerBaselineTrees[task.conversationId],
                    ownedPaths: task.ownedPaths
                )
                await requestReviewerVerdicts(
                    for: task,
                    criteria: unanswered,
                    diff: diffText
                )
            }
        }
        workerBaselineTrees[task.conversationId] = nil
        // Transition only after the branch is tallied. Announcing
        // `awaitingReview` first meant the wake could describe a task whose
        // commit had not run yet and report it as having changed nothing.
        registry.transition(taskID: task.id, to: failure == nil ? .awaitingReview : .failed)
        // The notice belongs in the Queen's chat even when she is not the open
        // conversation, otherwise a result reported while the user is reading a
        // worker chat is lost.
        await appendSystemMessageToQueenChat(notice)
        await autoAcceptIfUnambiguous(taskID: task.id)
        await loadConversations()
    }

    // MARK: - Reviewer Agent

    /// The diff of what the worker changed, limited to its owned paths.
    ///
    /// Read after the commit so the reviewer sees the same changes that
    /// landed on the branch. Empty when the baseline was never captured or
    /// git produced nothing — the reviewer still gets the criteria, and an
    /// empty diff is itself information.
    private func diffForReview(
        baselineTree: String?,
        ownedPaths: [String]
    ) async -> String {
        guard let baselineTree else { return "" }
        return await Task.detached(priority: .utility) {
            var args = ["diff", baselineTree]
            if !ownedPaths.isEmpty {
                args.append("--")
                args.append(contentsOf: ownedPaths.map {
                    QueenDelegationPolicy.normalizePath($0)
                })
            }
            return QueenStatusViewModel.runProcess(
                "/usr/bin/git",
                arguments: args,
                workDir: ProjectPaths.root,
                timeout: 30
            )
        }.value
    }

    /// Asks a reviewer agent for per-criterion verdicts on a finished task.
    ///
    /// Runs after mechanical verdicts have settled what the files show; this
    /// is for the criteria a path check cannot answer. The reviewer's response
    /// is parsed conservatively — anything the parser could not match stays
    /// absent, which reads as `unchecked`. An empty or garbled response
    /// changes nothing, which is the correct outcome: an unexamined criterion
    /// is not a pass.
    private func requestReviewerVerdicts(
        for task: DelegatedTask,
        criteria: [String],
        diff: String
    ) async {
        let brief = QueenReviewVerdictRequest.brief(
            criteria: criteria,
            diff: diff
        )

        let response = await sendOneShotReviewerRequest(brief) ?? ""

        let verdicts = QueenReviewVerdictRequest.parse(response, criteria: criteria)
        let registry = delegationRegistry
        var recorded = 0
        for (criterion, verdict) in verdicts {
            if registry.recordVerdict(
                taskID: task.id, criterion: criterion, verdict: verdict
            ) {
                recorded += 1
            }
        }

        TriosLogBus.shared.info(
            .queen,
            "queen.review.verdicts",
            "Reviewer returned \(recorded) verdict(s) for \(criteria.count) criterion(s)",
            [
                "issue": task.issue.slug,
                "asked": String(criteria.count),
                "parsed": String(verdicts.count),
                "recorded": String(recorded),
                "response_chars": String(response.count)
            ]
        )
    }

    /// Sends a one-shot prompt to the model and collects the text response.
    ///
    /// No prior context, no persistence, no conversation in the sidebar. The
    /// reviewer's job is to read the criteria and the diff and return
    /// verdicts, not to carry on a conversation or use tools. A fresh parser
    /// per call so the reviewer's stream cannot interfere with the main
    /// chat's parse state.
    private func sendOneShotReviewerRequest(_ prompt: String) async -> String? {
        let configuration = await modelStore.runtimeConfiguration

        guard let body = try? ChatRequestBuilder(
            conversationId: UUID(),
            message: prompt,
            mode: "agent",
            origin: "sidepanel",
            userSystemPrompt: Self.reviewerSystemPrompt,
            previousConversation: [],
            browserContext: nil,
            modelConfiguration: configuration,
            attachments: nil,
            workingDirectory: ProjectPaths.root
        ).build() else { return nil }

        let streamParser = UIMessageStreamParser()
        var transcript = QueenWorkerTranscript(
            seed: [ChatMessage(role: .user, content: prompt)]
        )

        do {
            let stream = try await transport.sendMessage(body: body)
            for await event in stream {
                if Task.isCancelled { break }
                if let action = await streamParser.parse(event) {
                    transcript.apply(action)
                }
            }
        } catch {
            TriosLogBus.shared.warn(
                .queen,
                "queen.review.transport_error",
                "Reviewer request failed: \(error.localizedDescription)",
                [:]
            )
            return nil
        }

        let text = transcript.assistantText
        return text.isEmpty ? nil : text
    }

    /// Standing orders for the reviewer agent.
    ///
    /// Separate from the worker's system prompt because the reviewer's role is
    /// different: it judges, it does not build. Letting it call tools would
    /// turn a one-shot verdict into another worker, which is exactly the kind
    /// of scope expansion the boundary exists to prevent.
    private static let reviewerSystemPrompt = """
        You are a code reviewer. You read acceptance criteria and a diff and \
        return a verdict for each criterion. You do not edit code, run \
        commands, or delegate. Give each criterion its own line with the \
        number, the verdict word (met, unmet, or could not check), and one \
        sentence explaining why.
        """

    /// Closes a task the Queen can judge on her own.
    ///
    /// Only when the bee stayed inside an explicit boundary, actually committed
    /// something, and cost nothing unusual. Everything else waits for a human,
    /// because an orchestrator that rubber-stamps its own workers has no
    /// reviewer at all. Off unless `TRIOS_QUEEN_AUTONOMY=1`.
    private func autoAcceptIfUnambiguous(taskID: UUID) async {
        guard ProcessInfo.processInfo.environment["TRIOS_QUEEN_AUTONOMY"] == "1" else { return }
        let registry = delegationRegistry
        guard let task = registry.tasks.first(where: { $0.id == taskID }) else { return }
        guard QueenDelegationPolicy.qualifiesForAutoAccept(
            task,
            committedFiles: task.committedFiles ?? 0
        ) else { return }
        guard registry.transition(taskID: task.id, to: .accepted) else { return }

        await appendSystemMessageToQueenChat(
            SystemNoticeClassifier.successMarker
                + "I accepted \(task.issue.slug) myself. \(task.worker) stayed inside "
                + "\(task.ownedPaths.joined(separator: ", ")) and committed "
                + "\(task.committedFiles ?? 0) file(s)"
                + (task.totalTokens > 0 ? " for \(task.totalTokens) tokens" : "")
                + " - no boundary crossed, no unusual cost, so there was nothing for you "
                + "to judge. I only close the unambiguous ones; anything that looks like a "
                + "judgement call still waits for you. Undo with "
                + "/review \(task.issue.slug) reject <why>."
        )
        registry.pruneArchive()
        TriosLogBus.shared.info(
            .queen,
            "queen.auto_accept",
            "Accepted without a human",
            ["issue": task.issue.slug, "files": String(task.committedFiles ?? 0)]
        )
    }

    /// Reports a worker going wrong, once per kind of concern per task.
    ///
    /// Repeating the same warning on every SSE delta would bury the chat, so
    /// each concern is announced the first time it appears and then stays quiet.
    private func observeWorker(task: DelegatedTask, transcript: QueenWorkerTranscript) {
        let concerns = QueenObserver.evaluate(
            transcript: transcript,
            ownedPaths: task.ownedPaths,
            totalTokens: transcript.inputTokens + transcript.outputTokens
        )
        guard !concerns.isEmpty else { return }

        var announced = announcedConcerns[task.id] ?? []
        let fresh = concerns.filter { !announced.contains($0.kind.rawValue) }
        guard !fresh.isEmpty else { return }
        fresh.forEach { announced.insert($0.kind.rawValue) }
        announcedConcerns[task.id] = announced

        let body = fresh.map(\.explanation).joined(separator: "\n")
        Task { [weak self] in
            guard let self else { return }
            // The correction goes to the worker, not only to the report. Telling
            // the user about a bee heading the wrong way and saying nothing to
            // the bee is observation, not supervision - it leaves the only
            // available fix as a decision about wreckage.
            //
            // It cannot interrupt a stream in flight; it lands in the worker's
            // conversation, which is what it reads on its next turn. Steering
            // between deltas would need the transport to support it, and
            // claiming otherwise here would be a comment that lies.
            await self.appendCorrectionToWorkerChat(task: task, text: body)
            delegationRegistry.recordIntervention(taskID: task.id, text: body)

            let count = delegationRegistry.task(forIssue: task.issue)?
                .interventions.count ?? 1
            await self.appendSystemMessageToQueenChat(
                SystemNoticeClassifier.warningMarker
                    + "Watching \(task.worker) on \(task.issue.slug):\n\(body)\n"
                    + "I have said this in its chat - correction \(count) for this task. "
                    + "Nothing is cancelled: while it is still running there is something "
                    + "to steer, and after it finishes the only choice left is whether to "
                    + "keep the wreckage."
            )
        }
        for concern in fresh {
            TriosLogBus.shared.warn(
                .queen,
                "queen.observer.\(concern.kind.rawValue)",
                concern.explanation,
                ["issue": task.issue.slug, "worker": task.worker]
            )
        }
    }

    /// Cancels bees that stopped without saying so, and reports each one.
    ///
    /// A task stuck in `running` forever occupies a worker slot and hides real
    /// capacity, so the swarm quietly shrinks to nothing.
    func reapStalledWorkers(now: Date = Date()) async {
        let registry = delegationRegistry
        let stalled = registry.stalled(now: now)
        guard !stalled.isEmpty else { return }

        for task in stalled {
            // Only reap what has genuinely stopped. A long stream is not a stall.
            guard workerRunner?.isRunning(conversationId: task.conversationId) != true else { continue }

            // Try to finish the work before writing it off. A silent worker is
            // a chat left mid-sentence, and closing it converts "unfinished"
            // into "abandoned" while learning nothing about why it stopped.
            let alreadyTried = task.resumeAttempts ?? 0
            if alreadyTried < QueenDelegationPolicy.maxResumeAttempts, let runner = workerRunner {
                let attempt = registry.recordResumeAttempt(taskID: task.id)
                let brief = QueenBriefing.text(for: task)
                    + "\n\nYour stream stopped without a result. Continue from where you "
                    + "left off in this same chat and on the same branch - do not start "
                    + "over. If you cannot finish, say plainly what blocked you."
                workerBaselineTrees[task.conversationId] = await QueenBranchCommitter.snapshotWorkingTree()
                runner.start(task: task, brief: brief)
                await appendSystemMessageToQueenChat(
                    SystemNoticeClassifier.infoMarker
                        + "\(task.worker) went quiet on \(task.issue.slug), so I restarted it "
                        + "in the same chat - attempt \(attempt) of "
                        + "\(QueenDelegationPolicy.maxResumeAttempts). Same branch, so it "
                        + "continues rather than competing with its own earlier work."
                )
                TriosLogBus.shared.info(
                    .queen,
                    "queen.worker.resumed",
                    "Restarted a silent worker",
                    ["issue": task.issue.slug, "worker": task.worker, "attempt": "\(attempt)"]
                )
                continue
            }

            guard registry.transition(taskID: task.id, to: .cancelled) else { continue }
            await appendSystemMessageToQueenChat(
                SystemNoticeClassifier.warningMarker
                    + "I closed \(task.issue.slug). \(task.worker) went silent and did not "
                    + "come back after \(alreadyTried) restart"
                    + (alreadyTried == 1 ? "" : "s") + ", so this is not a stall I can "
                    + "clear by asking again. Its branch and chat survive, so nothing is "
                    + "lost - but treat the task as unanswered rather than attempted."
            )
            TriosLogBus.shared.warn(
                .queen,
                "queen.worker.reaped",
                "Cancelled a stalled worker after exhausting restarts",
                ["issue": task.issue.slug, "worker": task.worker, "attempts": "\(alreadyTried)"]
            )
        }
        registry.pruneArchive()
    }

    /// A word from the Queen, which belongs in the Queen's chat.
    ///
    /// This used to append to `messages` - whatever conversation happens to be
    /// open. Every caller reached through /delegate is fine, because
    /// runQueenCommand switches to her chat first. The callers that are not are
    /// the ones that matter: a worker finishing, the observer noticing a stray
    /// write, the review scheduler waking. Those fire while the user is
    /// watching a bee, and her words landed in that bee's chat - the supervisor
    /// talking into the wrong room, and her own chat silent about work she was
    /// supervising.
    ///
    /// Not private, so a test can call it with some other conversation open.
    /// The routing is the whole behaviour and there is no other way in: every
    /// caller that reaches it through a command has already switched away from
    /// the case worth proving.
    func postQueenNotice(_ text: String) async {
        await appendSystemMessageToQueenChat(text)
    }

    // MARK: - Review Loop

    private func reportSwarm() async {
        let registry = delegationRegistry
        guard !registry.tasks.isEmpty else {
            await postQueenNotice(SystemNoticeClassifier.infoMarker
                    + "The hive is empty. Give me an issue and a worker - "
                    + "/delegate owner/repo#N queen-swift --paths rings/SR-02 Fix the thing - "
                    + "and I will open it a chat and a branch of its own.")
            return
        }
        let lines = registry.tasks.map { task in
            let marker = task.state.needsQueenAttention ? "!" : " "
            return "\(marker) \(task.issue.slug)  \(task.state.rawValue)  \(task.worker)  "
                + "\(task.virtualBranch ?? "-")  -  \(task.title)"
        }
        let waiting = registry.reviewQueue.count
        await postQueenNotice(
            SystemNoticeClassifier.infoMarker
                + "\(registry.running.count) of "
                + "\(QueenDelegationPolicy.maximumConcurrentWorkers) slots busy, "
                + "\(waiting) waiting on you.\n" + lines.joined(separator: "\n")
        )
    }

    /// Accepts or returns a worker's result.
    ///
    /// Rejection re-briefs the same worker in the same chat on the same branch,
    /// because starting a second chat for one issue is how two bees end up
    /// fighting over the same change.
    private func reviewDelegatedTask(
        issue: IssueReference,
        decision: ReviewDecision,
        note: String
    ) async {
        let registry = delegationRegistry
        guard let task = registry.task(forIssue: issue) else {
            await postQueenNotice(SystemNoticeClassifier.warningMarker + "\(issue.slug) has no open task to review.")
            return
        }
        guard task.state == .awaitingReview else {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "\(issue.slug) is \(task.state.rawValue), not awaiting review. Nothing to decide yet."
            )
            return
        }

        // Every decision is a labelled example: accepting means the ranking did
        // not need to shout, sending it back means it did.
        SalienceLearner.shared.record(task: task, neededUser: decision == .reject)

        switch decision {
        case .accept:
            // Acceptance is checked against the contract before it is checked
            // against anything else. This is the whole point of writing criteria
            // down: without it the Queen signs off on an impression, and the
            // specification becomes decoration that made the brief longer.
            if let reason = QueenAcceptancePolicy.acceptanceBlockReason(
                criteria: task.acceptanceCriteria, recorded: task.criterionVerdicts
            ) {
                // Logged as well as said. The refusal is the contract doing its
                // job, and until it was visible outside her chat every run that
                // hit it looked identical to a run where nothing happened.
                TriosLogBus.shared.warn(
                    .queen, "queen.accept.blocked", "Acceptance blocked by the contract",
                    [
                        "issue": issue.slug,
                        "reason": reason,
                        "criteria": String(task.acceptanceCriteria.count),
                        "verdicts": String(task.criterionVerdicts.count)
                    ]
                )
                await postQueenNotice(
                    SystemNoticeClassifier.warningMarker
                        + "Not accepting \(issue.slug) yet. \(reason)\n\n"
                        + QueenAcceptancePolicy.table(
                            criteria: task.acceptanceCriteria, recorded: task.criterionVerdicts
                        )
                        + "\n\nRecord what you found with "
                        + "`/verify \(issue.slug) <criterion text> met|unmet`."
                )
                return
            }
            guard registry.transition(taskID: task.id, to: .accepted) else {
                await postQueenNotice(SystemNoticeClassifier.failureMarker + (registry.lastError ?? "Could not accept \(issue.slug)."))
                return
            }
            let tail = note.isEmpty ? "" : "\n\(note)"
            // The table, not a sentence saying it went well. A reviewer reading
            // this later should see what was checked, not that someone was
            // satisfied.
            let evidence = task.acceptanceCriteria.isEmpty
                ? ""
                : "\n\n" + QueenAcceptancePolicy.table(
                    criteria: task.acceptanceCriteria, recorded: task.criterionVerdicts
                )
            await postQueenNotice(
                SystemNoticeClassifier.successMarker
                    + "Accepted \(issue.slug) from \(task.worker).\(evidence)\nIts work is on "
                    + "`\(task.virtualBranch ?? "-")`. It stays open until its pull "
                    + "request merges - acceptance is my opinion, a merge is a fact.\(tail)"
            )
            // Acceptance now proposes the work, rather than leaving a reviewed
            // branch sitting for someone to remember. The gate that matters
            // already happened: you approved the task before it opened, and the
            // criteria decided this acceptance. Making the person who wrote
            // neither of those type one more command adds a step without adding
            // a decision.
            //
            // It still refuses on its own terms - no branch, no commits, or a
            // pull request already open - and says why.
            await openPullRequestForTask(issue: issue)
        case .reject:
            guard !note.isEmpty else {
                await postQueenNotice(
                    SystemNoticeClassifier.warningMarker
                        + "Rejecting \(issue.slug) needs a reason: /review \(issue.slug) reject <why>."
                )
                return
            }
            guard registry.transition(taskID: task.id, to: .rejected) else {
                await postQueenNotice(SystemNoticeClassifier.failureMarker + (registry.lastError ?? "Could not reject \(issue.slug)."))
                return
            }
            guard let runner = workerRunner,
                  registry.transition(taskID: task.id, to: .running) else {
                await postQueenNotice(
                    SystemNoticeClassifier.failureMarker
                        + "Rejected \(issue.slug), but the worker could not be restarted."
                )
                return
            }
            let rebrief = QueenBriefing.text(for: task)
                + "\n\nThe Queen returned your previous attempt. Reason: \(note)"
            workerBaselineTrees[task.conversationId] = await QueenBranchCommitter.snapshotWorkingTree()
            runner.start(task: task, brief: rebrief)
            await postQueenNotice(SystemNoticeClassifier.infoMarker
                    + "Sent \(issue.slug) back to \(task.worker) with your reason: \(note). "
                    + "Same chat, same branch - it picks up where it left off rather than "
                    + "starting a second attempt that would fight the first one for the "
                    + "same files.")
        }
        await loadConversations()
    }

    /// Opens a pull request for a task's branch, on request.
    ///
    /// Deliberately a command rather than a step of acceptance. Acceptance is
    /// the Queen's judgement and happens unattended; opening a pull request
    /// publishes work to a place other people read. Those should not be the
    /// same event until someone decides they should be.
    func openPullRequestForTask(issue: IssueReference) async {
        TriosLogBus.shared.info(
            .queen, "queen.pr.attempt", "Trying to open a pull request", ["issue": issue.slug]
        )
        let registry = delegationRegistry
        guard let task = registry.anyTask(forIssue: issue) else {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker + "I have no task for \(issue.slug)."
            )
            return
        }
        if let reason = QueenDelegationPolicy.pullRequestBlockReason(for: task) {
            TriosLogBus.shared.warn(
                .queen, "queen.pr.refused", "Refused to open a pull request",
                ["issue": issue.slug, "reason": reason]
            )
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "Not opening a pull request for \(issue.slug): \(reason)"
            )
            return
        }
        guard let branch = task.virtualBranch else {
            // Used to return without a word, which is how this step stayed
            // invisible: the cycle simply stopped and nothing said so.
            TriosLogBus.shared.error(
                .queen, "queen.pr.noBranch", "The task has no branch to propose",
                ["issue": issue.slug]
            )
            return
        }

        // Publish it first. GitHub cannot open a pull request from a branch it
        // has never seen, and until now nothing in the delegation path pushed:
        // the bee committed locally, the Queen asked for a pull request, and
        // the cycle stopped one step short of the only thing it is for.
        if let pushFailure = await QueenBranchCommitter.pushBranch(branch) {
            TriosLogBus.shared.error(
                .queen, "queen.pr.pushFailed", "Could not publish the branch",
                ["issue": issue.slug, "branch": branch, "detail": pushFailure]
            )
            await postQueenNotice(
                SystemNoticeClassifier.failureMarker
                    + "Could not publish `\(branch)`, so there is no pull request for "
                    + "\(issue.slug) yet. git said: \(pushFailure)"
            )
            return
        }

        // Where the branch is, not where the issue is. Those differ here and the
        // mismatch is what stopped the cycle: the branch lives in the checkout's
        // own origin, the issue in another repository entirely, and GitHub
        // cannot open a pull request from a ref it has never seen.
        guard let prRepo = QueenBranchCommitter.originRepository() else {
            TriosLogBus.shared.error(
                .queen, "queen.pr.noRepository", "Could not derive the branch's repository",
                ["issue": issue.slug, "branch": branch]
            )
            await postQueenNotice(
                SystemNoticeClassifier.failureMarker
                    + "I could not work out which repository `\(branch)` belongs to, so there "
                    + "is no pull request for \(issue.slug)."
            )
            return
        }

        do {
            let pr = try await GitHubAPIClient().createPR(
                repo: prRepo,
                title: task.title,
                body: "For \(issue.url)\n\nOpened by the Queen for \(task.worker).",
                head: branch,
                base: QueenBranchCommitter.baseBranch()
            )
            registry.recordPullRequest(taskID: task.id, number: pr.number)
            await postQueenNotice(
                SystemNoticeClassifier.successMarker
                    + "Opened #\(pr.number) for \(issue.slug) from `\(branch)`. "
                    + "The task stays open until that merges - a closed pull request "
                    + "that never merged is not the same as landed work."
            )
            TriosLogBus.shared.info(
                .queen, "queen.pr.opened", "Opened a pull request",
                ["issue": issue.slug, "pr": "\(pr.number)", "branch": branch]
            )
        } catch {
            TriosLogBus.shared.error(
                .queen, "queen.pr.failed", "Could not open a pull request",
                ["issue": issue.slug, "branch": branch, "error": "\(error)"]
            )
            await postQueenNotice(
                SystemNoticeClassifier.failureMarker
                    + "Could not open a pull request for \(issue.slug): \(error.localizedDescription)"
            )
        }
    }

    /// Asks the forge what happened to each open pull request and settles the
    /// tasks waiting on them.
    ///
    /// This is the step that makes archiving a fact rather than an opinion. It
    /// only ever asks about tasks that actually have a pull request, so a swarm
    /// that never opens one costs nothing and behaves exactly as before.
    func pollPullRequests() async {
        let registry = delegationRegistry
        let waiting = registry.tasks.filter {
            $0.pullRequestNumber != nil && $0.state == .accepted
        }
        guard !waiting.isEmpty else { return }

        // The repository the pull requests are in, which is the checkout's
        // origin - not the issue's. Creating them was already corrected for
        // this; polling and merging still asked the issue's repository about a
        // number that only exists in the other one.
        guard let prRepo = QueenBranchCommitter.originRepository() else { return }
        let client = GitHubAPIClient()
        for task in waiting {
            guard let number = task.pullRequestNumber else { continue }
            let pullRequest: GitHubPullRequest
            do {
                pullRequest = try await client.fetchPullRequest(
                    repo: prRepo, number: number
                )
            } catch {
                // A forge that cannot be reached says nothing about the work.
                // Leaving the task where it is beats guessing in either
                // direction; the next poll asks again.
                TriosLogBus.shared.warn(
                    .queen, "queen.pr.poll_failed", "Could not read a pull request",
                    ["issue": task.issue.slug, "pr": "\(number)"]
                )
                continue
            }

            // An open pull request for accepted work is the Queen's to finish.
            // She reviewed it against the criteria; waiting for a human to press
            // the same button she already decided on is ceremony, not oversight.
            // The forge is still the authority - branch protection or a red
            // check refuses, and the task just stays open until the next poll.
            if QueenDelegationPolicy.outcome(
                merged: pullRequest.isMerged, closedUnmerged: pullRequest.isClosedUnmerged
            ) == .pending {
                let merged = (try? await client.mergePullRequest(
                    repo: prRepo,
                    number: number,
                    title: "\(task.title) (\(task.issue.slug))"
                )) ?? false
                if merged {
                    TriosLogBus.shared.info(
                        .queen, "queen.pr.merged", "Merged a reviewed pull request",
                        ["issue": task.issue.slug, "pr": "\(number)"]
                    )
                    registry.transition(taskID: task.id, to: .merged)
                    await appendSystemMessageToQueenChat(
                        SystemNoticeClassifier.successMarker
                            + "Merged #\(number) for \(task.issue.slug). The work is in, and "
                            + "the chat is archived because the forge says so - not because "
                            + "I liked the result."
                    )
                    continue
                }
            }

            let outcome = QueenDelegationPolicy.outcome(
                merged: pullRequest.isMerged,
                closedUnmerged: pullRequest.isClosedUnmerged
            )
            guard let next = QueenDelegationPolicy.nextState(for: outcome),
                  registry.transition(taskID: task.id, to: next) else { continue }

            switch outcome {
            case .landed:
                await appendSystemMessageToQueenChat(
                    SystemNoticeClassifier.successMarker
                        + "#\(number) merged, so \(task.issue.slug) is done and its chat is "
                        + "archived. That is the forge saying the work landed, not me saying "
                        + "I liked it."
                )
            case .abandoned:
                await appendSystemMessageToQueenChat(
                    SystemNoticeClassifier.warningMarker
                        + "#\(number) was closed without merging, so \(task.issue.slug) is "
                        + "back in the review queue. Nothing landed - the branch still holds "
                        + "the work, and it needs a decision rather than an archive."
                )
            case .pending:
                break
            }
            TriosLogBus.shared.info(
                .queen, "queen.pr.polled", "Read a pull request outcome",
                ["issue": task.issue.slug, "pr": "\(number)", "outcome": outcome.rawValue]
            )
        }
        registry.pruneArchive()
    }

    /// Records what was found when one acceptance criterion was checked.
    func recordCriterionVerdict(
        issue: IssueReference,
        criterion: String,
        verdict: QueenCriterionVerdict
    ) async {
        let registry = delegationRegistry
        guard let task = registry.task(forIssue: issue) else {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker + "I have no task for \(issue.slug)."
            )
            return
        }
        guard registry.recordVerdict(taskID: task.id, criterion: criterion, verdict: verdict) else {
            // Refused rather than filed under a criterion that does not exist.
            // A verdict nobody can see is worse than no verdict, because the
            // table would then show unchecked while someone believes they
            // answered it.
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "No criterion on \(issue.slug) reads \"\(criterion)\". The ones that exist:\n"
                    + QueenAcceptancePolicy.table(
                        criteria: task.acceptanceCriteria, recorded: task.criterionVerdicts
                    )
            )
            return
        }
        let updated = registry.task(forIssue: issue) ?? task
        await postQueenNotice(
            SystemNoticeClassifier.infoMarker
                + "Recorded.\n"
                + QueenAcceptancePolicy.table(
                    criteria: updated.acceptanceCriteria, recorded: updated.criterionVerdicts
                )
        )
    }

    /// Records that the user agreed to a piece of work.
    func approveDelegation(issue: IssueReference) async {
        delegationRegistry.approve(issue: issue)
        await postQueenNotice(
            SystemNoticeClassifier.successMarker
                + "Noted - I may open a chat for \(issue.slug). I will not start "
                + "anything else without asking."
        )
    }

    // MARK: - Self-audit

    /// Reads the repository for the defect shape that keeps recurring here and
    /// reports a ranked roadmap.
    ///
    /// Runs `grep` rather than asking a model, because "what should we improve"
    /// produces plausible roadmaps and no findings, while a symbol nobody calls
    /// is a fact.
    func runSelfAudit() async {
        await postQueenNotice(
            SystemNoticeClassifier.infoMarker
                + "Reading my own code. This takes a moment - I am counting call sites, "
                + "not asking anyone's opinion."
        )
        let findings = await Task.detached(priority: .utility) {
            Self.auditRepository(root: ProjectPaths.root)
        }.value
        await postQueenNotice(
            SystemNoticeClassifier.infoMarker
                + QueenSelfAudit.report(findings: findings, now: Date())
        )
        // The audit says what is wrong; this says what she would do about it.
        // Since she may no longer open a chat unasked, proposing is the only
        // way she moves the project at all - without it the consent gate makes
        // her passive rather than careful.
        let options = QueenEvolutionOptions.options(from: findings)
        await postQueenNotice(
            SystemNoticeClassifier.infoMarker + QueenEvolutionOptions.message(for: options)
        )
        TriosLogBus.shared.info(
            .queen,
            "queen.selfaudit",
            "Self-audit complete",
            ["findings": String(findings.count), "options": String(options.count)]
        )
    }

    /// How often each function declared in the Queen's own files is mentioned
    /// anywhere in her subsystem.
    ///
    /// Scoped by filename rather than by symbol prefix, because Swift methods
    /// are named after what they do and no `func Queen...` convention exists to
    /// match on. Files called Queen*, Skill* or Swarm* are the same "her own
    /// organs" boundary the type scan uses, arrived at from the other side.
    nonisolated static func functionOccurrences(
        root: String,
        scopes: [String]
    ) -> [String: Int] {
        let declared = QueenStatusViewModel.runProcess(
            "/bin/sh",
            arguments: [
                "-c",
                "grep -rhoE 'func [a-z][A-Za-z0-9_]*' "
                    + "\(root)/rings/SR-00/Queen*.swift \(root)/rings/SR-01/Skill*.swift "
                    + "\(root)/rings/SR-02/Queen*.swift \(root)/BR-OUTPUT/Queen*.swift "
                    + "2>/dev/null | sed 's/func //' | sort -u"
            ],
            workDir: root,
            timeout: 30
        )
        // Three characters or fewer are too common to count honestly - `id`
        // appears everywhere and means nothing here.
        let names = declared
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.count > 3 }
        guard !names.isEmpty else { return [:] }

        let uses = QueenStatusViewModel.runProcess(
            "/usr/bin/grep",
            arguments: ["-rhowE", names.joined(separator: "|")] + scopes,
            workDir: root,
            timeout: 120
        )
        var counts: [String: Int] = [:]
        // Every declared name starts at zero, so one that appears nowhere is
        // reported rather than missing from the dictionary entirely - absent
        // and zero are different answers and this one must be zero.
        for name in names { counts[name] = 0 }
        for line in uses.components(separatedBy: .newlines) {
            let word = line.trimmingCharacters(in: .whitespaces)
            guard counts[word] != nil else { continue }
            counts[word, default: 0] += 1
        }
        return counts
    }

    /// Counts declarations against occurrences for the public surface of the
    /// Queen's own subsystem.
    nonisolated static func auditRepository(root: String) -> [QueenSelfAudit.Finding] {
        // Scoped to her own organs on purpose. An audit of the whole app returns
        // a wall of results nobody reads; an audit of the thing being changed
        // this week returns items someone will act on.
        let scopes = [
            "\(root)/rings/SR-00", "\(root)/rings/SR-01",
            "\(root)/rings/SR-02", "\(root)/BR-OUTPUT"
        ]
        // Types, not functions. Swift methods are named after what they do, so
        // matching `func Queen...` matched nothing at all and the first audit
        // reported a clean bill of health it had not earned.
        let declarationPattern = "(struct|class|enum|actor) (Queen|Skill|Swarm)[A-Za-z0-9_]*"
        let declared = QueenStatusViewModel.runProcess(
            "/usr/bin/grep",
            arguments: ["-rhoE", declarationPattern] + scopes,
            workDir: root,
            timeout: 30
        )

        var symbols: Set<String> = []
        for line in declared.components(separatedBy: .newlines) {
            guard let symbol = line.split(separator: " ").last.map(String.init),
                  symbol.count > 3 else { continue }
            symbols.insert(symbol)
        }

        // One occurrence is the declaration itself. Two is a declaration plus a
        // single mention, which for a type usually means only its own file
        // refers to it.
        var occurrences: [String: Int] = [:]
        for symbol in symbols.sorted() {
            let uses = QueenStatusViewModel.runProcess(
                "/usr/bin/grep",
                arguments: ["-rhow", symbol] + scopes,
                workDir: root,
                timeout: 20
            )
            occurrences[symbol] = uses.components(separatedBy: .newlines).filter { !$0.isEmpty }.count
        }

        // Functions as well as types now, in one pass rather than one grep per
        // name: there are 208 of them against 45 types, and 208 subprocesses is
        // a button nobody presses twice.
        //
        // Counting a bare word rather than `name(` is the whole reason this is
        // trustworthy. A scan I kept privately for a week matched only calls
        // written with a parenthesis, so it missed `plan { ... }` written as a
        // trailing closure and `Button(action: copyDiff)` written as a value -
        // both everyday Swift - and called three live functions dead. This
        // counts the identifier wherever it appears, which is what the type
        // scan above has always done.
        occurrences.merge(Self.functionOccurrences(root: root, scopes: scopes)) { a, _ in a }

        // The ranking rule lives in QueenSelfAudit.deadSymbols, which has tests
        // and, until now, no caller: this function counted occurrences and then
        // applied the same threshold inline. Two implementations of one idea,
        // and the one that ran was the one nothing checked. Whichever of them
        // drifted, the audit would have kept reporting confidently.
        var findings: [QueenSelfAudit.Finding] = []
        for symbol in QueenSelfAudit.deadSymbols(declarations: occurrences) {
            findings.append(QueenSelfAudit.Finding(
                severity: .dead,
                kind: "zero-call-sites",
                subject: symbol,
                explanation: "It is declared once and referenced nowhere else, so whatever "
                    + "it does, nothing asks it to.",
                proposal: "Either wire it to a caller or delete it - a capability with no "
                    + "path to it is worse than an absent one, because it reads as done."
            ))
        }
        return findings
    }

    /// What the Queen has learned about which signals actually need the user.
    ///
    /// The learner was writing to disk with nothing reading it back out in
    /// words - which is the same zero-call-site shape `/roadmap` exists to
    /// catch, written by the hand that built the detector.
    private func reportSalience() async {
        let learner = SalienceLearner.shared
        let lines = QueenSalience.Feature.allCases.map { feature -> String in
            let weight = learner.weight(for: feature)
            let source = abs(weight - feature.prior) < 0.001 ? "prior" : "learned"
            return String(
                format: "  %@  weight %.1f (%@, started at %.0f)  -  %@",
                feature.rawValue, weight, source, feature.prior,
                learner.evidence(for: feature)
            )
        }
        let drifted = learner.drift()
        let driftLine: String
        if drifted.isEmpty {
            driftLine = "\n\nNothing has moved off my starting estimates yet. "
                + "Come back after a week of real reviews and this line will say "
                + "what changed."
        } else {
            let moves = drifted.map {
                String(
                    format: "%@ %.0f -> %.1f after %d",
                    $0.feature.rawValue, $0.from, $0.to, $0.seen
                )
            }
            driftLine = "\n\nMoved so far: " + moves.joined(separator: "; ") + "."
        }

        await postQueenNotice(
            SystemNoticeClassifier.infoMarker
                + "How loudly each signal shouts when I order your review queue. "
                + "A weight starts as my estimate and becomes the rate at which "
                + "tasks carrying that signal actually needed you, once I have seen "
                + "\(learner.minimumObservations) of them - a threshold I derive from "
                + "how finely the estimates are trying to distinguish, not a number I "
                + "picked.\n" + lines.joined(separator: "\n") + driftLine
        )
    }

    // MARK: - Skills

    /// Recalled memory plus, in the Queen's chat, her standing orders.
    ///
    /// Without this the model driving the Queen had no idea she had skills,
    /// workers or commands: she could only run a skill if the user already knew
    /// its exact name and typed it. A capability the agent cannot see is a
    /// capability it does not have.
    private func composedSystemPrompt() -> String? {
        let memory = memoryService.promptContext(for: recalledMemories)
        guard conversationId == ChatConversation.trinityQueenId else { return memory }

        let registry = delegationRegistry
        let store = skillStore
        let charter = QueenSystemPrompt.text(
            skills: store.enabled,
            disabledSkills: store.skills
                .filter { !store.isEnabled($0) }
                .map(\.id),
            runningWorkers: registry.running.count,
            awaitingReview: registry.reviewQueue.count
        )
        guard let memory, !memory.isEmpty else { return charter }
        return charter + "\n\n" + memory
    }

    private func reportSkills() async {
        let store = skillStore
        store.reload()
        guard !store.skills.isEmpty else {
            await postQueenNotice(
                SystemNoticeClassifier.infoMarker
                    + "I have no skills installed. They live in .claude/skills/<name>/SKILL.md; "
                    + "write one and it appears here without a rebuild."
            )
            return
        }
        // Stamped, because this listing lives in the transcript forever while
        // the toggles behind it keep moving. An undated snapshot is read later
        // as a standing fact - which is exactly how a switched-on skill got
        // reported as switched off from scrollback.
        let stamp = DateFormatter()
        stamp.dateFormat = "HH:mm"
        let asOf = stamp.string(from: Date())
        let lines = store.skills.map { skill -> String in
            let mark = store.isEnabled(skill) ? " " : "off"
            return "\(mark) \(skill.id)  (\(skill.source.displayName))  -  \(skill.description)"
        }
        await postQueenNotice(
            SystemNoticeClassifier.infoMarker
                + "As of \(asOf): \(store.enabled.count) of \(store.skills.count) skills are available to me. "
                + "Each one is a rehearsed procedure rather than something I improvise, which is "
                + "why switching one off narrows what I can do rather than how well I do it. "
                + "Manage them in the Skills tab.\n"
                + lines.joined(separator: "\n")
        )
    }

    private func runQueenSkill(command: String, arguments: [String]) async {
        let store = skillStore
        guard let skill = store.skill(named: command) else {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "There is no skill called `\(command)`. Say /skills to see what I have."
            )
            return
        }
        guard store.isEnabled(skill) else {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "`\(command)` is switched off in the Skills tab, so I left it alone."
            )
            return
        }
        await postQueenNotice(
            SystemNoticeClassifier.infoMarker
                + "Running `\(command)`: \(skill.description)"
        )
        let output = await store.run(command, arguments: arguments)
        await postQueenNotice(SystemNoticeClassifier.infoMarker + "`\(command)` said:\n\(output)")
    }

    /// Stops a worker and says so.
    ///
    /// Exposed as a command and as a button, because the moment you want it is
    /// the moment the observer has just told you a bee is looping - and hunting
    /// for the right syntax then is how a wasted turn becomes a wasted ten.
    func cancelDelegatedTask(issue: IssueReference, reason: String) async {
        let registry = delegationRegistry
        guard let task = registry.task(forIssue: issue) else {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker + "\(issue.slug) has no open task to stop."
            )
            return
        }
        // A cancel is the strongest label there is: it needed you badly enough
        // that you stopped it mid-flight.
        SalienceLearner.shared.record(task: task, neededUser: true)
        workerRunner?.stop(conversationId: task.conversationId)
        guard registry.transition(taskID: task.id, to: .cancelled) else {
            await postQueenNotice(
                SystemNoticeClassifier.failureMarker
                    + (registry.lastError ?? "Could not stop \(issue.slug).")
            )
            return
        }
        let because = reason.isEmpty ? "" : " Reason: \(reason)."
        await postQueenNotice(
            SystemNoticeClassifier.warningMarker
                + "Stopped \(task.worker) on \(issue.slug).\(because) Its chat and branch "
                + "survive, so whatever it managed before I cut it is still there to look at. "
                + "Re-delegate when you want another attempt."
        )
        TriosLogBus.shared.warn(
            .queen,
            "queen.worker.cancelled",
            "Worker stopped by request",
            ["issue": issue.slug, "worker": task.worker]
        )
        await loadConversations()
    }

    private func delegateTaskToAgent(agentIdString: String, taskDescription: String) async {
        await queenBackgroundService?.delegateTask(agentId: agentIdString, description: taskDescription)
    }

    private func broadcastToAgents(_ message: String) async {
        await queenBackgroundService?.broadcast(message: message)
    }

    private func recallQueenMemory() async {
        let goal = "Queen self-improvement and recent system activity"
        let matches = await memoryService.recall(for: goal, limit: 5)
        let lines = matches.map { "* \($0.record.displayBody.prefix(120))" }
        let text = lines.isEmpty ? "No recent memory entries found." : lines.joined(separator: "\n")
        await appendSystemMessageToQueenChat("Recalled memory:\n\(text)")
    }

    private func runQueenEvolution() async {
        guard let service = queenBackgroundService else {
            await appendSystemMessageToQueenChat("Queen background service is not available.")
            return
        }
        await service.runAudit()
        if let event = service.lastAudit {
            let proposalLines = service.proposals.filter { $0.status == .pending }.map {
                "* \($0.id.uuidString.prefix(8))  -  \($0.targetFile): \($0.rationale.prefix(80))"
            }
            let proposalText = proposalLines.isEmpty ? "No pending proposals." : proposalLines.joined(separator: "\n")
            await appendSystemMessageToQueenChat(
                "Audit complete: \(event.findings.joined(separator: "; "))\n\nPending proposals:\n\(proposalText)"
            )
        }
    }

    private func listQueenProposals() async {
        guard let service = queenBackgroundService else {
            await appendSystemMessageToQueenChat("Queen background service is not available.")
            return
        }
        let pending = service.proposals.filter { $0.status == .pending }
        let lines = pending.map {
            "\($0.id.uuidString)  -  \($0.targetFile)\n  Trigger: \($0.trigger)\n  Rationale: \($0.rationale.prefix(120))"
        }
        let text = lines.isEmpty ? "No pending proposals. Run /evolve to generate some." : lines.joined(separator: "\n\n")
        await appendSystemMessageToQueenChat("Pending Queen proposals:\n\(text)")
    }

    private func applyQueenProposal(id: UUID, confirmed: Bool) async {
        guard let service = queenBackgroundService else {
            await appendSystemMessageToQueenChat("Queen background service is not available.")
            return
        }
        guard let proposal = service.approveProposal(id: id) else {
            await appendSystemMessageToQueenChat("Proposal \(id.uuidString.prefix(8)) not found or already processed.")
            return
        }

        if !confirmed {
            await appendSystemMessageToQueenChat(
                "Proposal \(proposal.id.uuidString.prefix(8)) approved. Staging preview (build only)..."
            )
            let result = await QueenProposalApplier.shared.apply(
                proposal,
                projectRoot: ProjectPaths.root,
                confirmed: false
            )
            if result.success, let branchName = result.branchName {
                stagedProposalIds.insert(proposal.id)
                stagedProposalBranches[proposal.id] = branchName
                await appendSystemMessageToQueenChat(
                    result.summary + "\n\nTo land this change, run `/apply \(proposal.id.uuidString) confirm`."
                )
            } else {
                await appendSystemMessageToQueenChat(result.summary)
            }
            return
        }

        await appendSystemMessageToQueenChat(
            "Proposal \(proposal.id.uuidString.prefix(8)) confirmed. Committing, pushing, and opening draft PR..."
        )
        let reuseBranch = stagedProposalBranches[proposal.id]
        let result = await QueenProposalApplier.shared.apply(
            proposal,
            projectRoot: ProjectPaths.root,
            confirmed: true,
            reuseBranch: reuseBranch
        )
        stagedProposalIds.remove(proposal.id)
        stagedProposalBranches.removeValue(forKey: proposal.id)
        await appendSystemMessageToQueenChat(result.summary)
    }

    private func rejectQueenProposal(id: UUID) async {
        guard let service = queenBackgroundService else {
            await appendSystemMessageToQueenChat("Queen background service is not available.")
            return
        }
        service.rejectProposal(id: id)
        await appendSystemMessageToQueenChat("Proposal \(id.uuidString.prefix(8)) rejected and removed from pending queue.")
    }
}

extension ChatViewModel: QueenBackgroundServiceDelegate {
    func queenBackgroundService(
        _ service: QueenBackgroundService,
        didReceiveA2AMessage message: ChatMessage
    ) {
        guard conversationId == ChatConversation.trinityQueenId else {
            Task {
                await loadConversations()
            }
            return
        }

        // QueenBackgroundService already persisted the inbound A2A message to the
        // persister before calling the delegate. Reload the canonical history so we
        // never double-write the same message, then append only if the delegate
        // message is not already present.
        Task {
            let history = await persister.load(conversationId: ChatConversation.trinityQueenId)
            var updated = history
            if !history.contains(where: { $0.id == message.id }) {
                updated.append(message)
                await persister.save(messages: updated, conversationId: ChatConversation.trinityQueenId)
            }
            messages = updated
            rebuildCache()
            await loadConversations()
        }
    }

    func queenBackgroundServiceDidUpdateState(_ service: QueenBackgroundService) {
        isA2ARegistered = service.isA2ARegistered
    }
}

struct ChatRequestAttachment: Equatable, Sendable {
    let kind: String
    let mediaType: String
    let dataURL: String
}

struct ChatRequestBuilder {
    let conversationId: UUID
    let message: String
    let mode: String
    let origin: String
    let userSystemPrompt: String?
    let previousConversation: [ChatMessage]
    let browserContext: BrowserContext?
    let modelConfiguration: ModelRuntimeConfiguration?
    let attachments: [ChatRequestAttachment]?
    /// Where the agent's file tools start. `nil` means the user's home
    /// directory, which suits a general assistant. A delegated worker must be
    /// pointed at the repository its branch lives in: left at home, one bee
    /// found an unrelated old checkout under ~/gitbutler and edited that
    /// instead, so its branch here stayed empty.
    let workingDirectory: String?

    init(
        conversationId: UUID,
        message: String,
        mode: String,
        origin: String,
        userSystemPrompt: String?,
        previousConversation: [ChatMessage],
        browserContext: BrowserContext?,
        modelConfiguration: ModelRuntimeConfiguration? = nil,
        attachments: [ChatRequestAttachment]? = nil,
        workingDirectory: String? = nil
    ) {
        self.conversationId = conversationId
        self.message = message
        self.mode = mode
        self.origin = origin
        self.userSystemPrompt = userSystemPrompt
        self.previousConversation = previousConversation
        self.browserContext = browserContext
        self.modelConfiguration = modelConfiguration
        self.attachments = attachments
        self.workingDirectory = workingDirectory
    }

    private var memoryPrompt: String {
        """
        You are \(TriosBranding.displayName), a native macOS AI assistant with full memory of this conversation. \
        You can see all previous messages, reasoning steps, tool calls, and user instructions. \
        Reference prior context naturally. If the user refers to "that", "it", or previous topics, \
        use your memory to understand the reference. Maintain continuity across the entire session.
        """
    }

    /// Return a sensible default model for common providers so that an
    /// unconfigured launch does not immediately fail with a model mismatch
    /// (e.g., Ollama cannot load a cloud-only model name).
    static func defaultModel(for provider: String) -> String {
        switch provider {
        case "zai":
            return "glm-4.6"
        case "openrouter":
            return "anthropic/claude-4-sonnet"
        case "anthropic":
            return "claude-4-sonnet"
        case "openai":
            return "gpt-5"
        case "ollama":
            return "llama3.1"
        default:
            return "llama3.1"
        }
    }

    func build() throws -> Data {
        var messages: [[String: Any]] = []

        // System memory prompt. Recalled context is explicitly marked as untrusted
        // so the model does not treat it as a privileged instruction.
        let systemContent: String
        if let userSystemPrompt = userSystemPrompt, !userSystemPrompt.isEmpty {
            systemContent = "\(memoryPrompt)\n[Recalled memory  -  verify before acting]\n\(userSystemPrompt)"
        } else {
            systemContent = memoryPrompt
        }
        messages.append(["role": "system", "content": systemContent])

        // Conversation history: only the public message content is sent to the
        // model. Reasoning, tool inputs/outputs, and error metadata remain in the
        // local UI store and are not forwarded as prompt context.
        for msg in previousConversation {
            messages.append(["role": msg.role.rawValue, "content": msg.content])
        }

        // Current user message
        messages.append(["role": "user", "content": message])

        let homeDir = workingDirectory
            ?? FileManager.default.homeDirectoryForCurrentUser.path

        let runtimeConfiguration = modelConfiguration ?? .environmentFallback()

        var body: [String: Any] = [
            "conversationId": conversationId.uuidString,
            "message": message,
            "mode": mode,
            "origin": origin,
            "supportsImages": true,
            "messages": messages,
            "userWorkingDir": homeDir
        ]
        runtimeConfiguration.apply(to: &body)

        if let attachments = attachments, !attachments.isEmpty {
            body["attachments"] = attachments.map { attachment in
                [
                    "kind": attachment.kind,
                    "mediaType": attachment.mediaType,
                    "dataUrl": attachment.dataURL
                ]
            }
        }

        // Flatten history for backward-compatible servers.
        // Server-side validators for the legacy previousConversation field only
        // accept user/assistant roles; system/error messages must be translated or
        // omitted to avoid 400 Bad Request.
        if !previousConversation.isEmpty {
            let history = previousConversation.compactMap { msg -> [String: String]? in
                switch msg.role {
                case .user, .assistant:
                    return ["role": msg.role.rawValue, "content": msg.content]
                case .system:
                    // Translate error messages into assistant context so the server
                    // accepts them while preserving the failure signal for the model.
                    return ["role": "assistant", "content": "[SYSTEM ERROR] \(msg.content)"]
                case .tool:
                    return ["role": "assistant", "content": "[TOOL RESULT] \(msg.content)"]
                }
            }
            if !history.isEmpty {
                body["previousConversation"] = history
            }
        }

        if let context = browserContext {
            body["browserContext"] = [
                "url": context.url,
                "title": context.title
            ]
        }

        return try JSONSerialization.data(withJSONObject: body, options: [])
    }
}

struct BrowserContext {
    let url: String
    let title: String
}
