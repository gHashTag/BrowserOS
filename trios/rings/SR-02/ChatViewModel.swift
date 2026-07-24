// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: FULLSCREEN-CHAT-001 exposes persisted task selection to adaptive UI.
// Follow-up: seal against .trinity/specs/fullscreen-chat-history.md.
import Foundation
import SwiftUI

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

    @Published var messages: [ChatMessage] = []
    @Published var state: ConversationState = .idle
    @Published var inputText: String = ""
    @Published var isServerReachable: Bool = false
    @Published var isA2ARegistered: Bool = false
    @Published var conversations: [ChatConversation] = []
    @Published var showHistory = false
    @Published var messageHistory: [String] = []  // Hotkey history (↑↓ navigation)
    @Published private(set) var tokenUsage = TokenUsageLedger()
    @Published private(set) var recalledMemories: [AgentMemoryMatch] = []
    @Published private(set) var memoryControlRevision: UInt64 = 0

    let queenStatusVM = QueenStatusViewModel()
    let modelStore: ModelConfigurationStore
    let todoPlanner: TODOPlanner

    private let transport: ChatTransportProtocol
    private let healthCheck: ChatHealthCheckProtocol
    private let parser: ChatParserProtocol
    private let persister: ChatPersisterProtocol
    private let stateMachine: ConversationStateMachine
    private let memoryService: AgentMemoryService
    let a2aClient: A2ARegistryClient?

    @Published private(set) var conversationId: UUID = UUID()
    private var messageCache: [UUID: Int] = [:]
    private var a2aRouter: A2AMessageRouter?
    private var a2aStreamTask: Task<Void, Never>?
    private var healthCheckTask: Task<Void, Never>?
    private var initializationTask: Task<Void, Never>?
    private var lastSendTime: Date = .distantPast
    private var pendingEstimatedInputTokens = 0
    private var pendingEstimatedOutput = ""
    private var pendingUsageActive = false
    private var receivedProviderUsage = false
    private var pendingMemoryTurn: PendingAgentMemoryTurn?
    private var activeMemoryWrites: [UUID: ActiveAgentMemoryWrite] = [:]
    private var memoryClearCounts: [UUID: Int] = [:]
    private var streamGeneration: UInt64 = 0
    private var memoryWriteRevisions: [UUID: UInt64] = [:]
    private var historyWriteRevisions: [UUID: UInt64] = [:]
    private var historyDeletionCounts: [UUID: Int] = [:]
    private var isConversationTransitioning = false

    init(
        transport: ChatTransportProtocol,
        healthCheck: ChatHealthCheckProtocol,
        parser: ChatParserProtocol,
        persister: ChatPersisterProtocol,
        stateMachine: ConversationStateMachine,
        a2aClient: A2ARegistryClient? = nil,
        modelStore: ModelConfigurationStore,
        memoryService: AgentMemoryService,
        todoPlanner: TODOPlanner
    ) {
        NSLog("ChatViewModel.init starting")
        self.transport = transport
        self.healthCheck = healthCheck
        self.parser = parser
        self.persister = persister
        self.stateMachine = stateMachine
        self.a2aClient = a2aClient
        self.modelStore = modelStore
        self.memoryService = memoryService
        self.todoPlanner = todoPlanner
        NSLog("ChatViewModel.init properties set")

        initializationTask = Task { [weak self] in
            guard let self else { return }
            NSLog("ChatViewModel.init Task started")
            await setupConversationId()
            await loadHistory()
            await todoPlanner.load(conversationId: conversationId)
            await loadConversations()
            await checkHealth()
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

    func loadHistory() async {
        let history = await persister.load(conversationId: conversationId)
        history.forEach { $0.isStreaming = false }
        messages = history
        rebuildCache()
    }

    func loadConversations() async {
        conversations = await persister.listAllConversations()
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

    func switchConversation(id: UUID) async {
        await awaitInitialization()
        guard beginConversationTransition() else { return }
        defer { endConversationTransition() }
        invalidateActiveStream()
        await performConversationSwitch(id: id)
    }

    private func performConversationSwitch(id: UUID) async {
        // Cancel any in-flight stream before loading a different conversation;
        // otherwise late SSE events could corrupt the newly loaded messages.
        await cancelPendingTurn()
        await transport.cancel()
        _ = await stateMachine.transition(to: .idle)
        state = await stateMachine.currentState()

        recalledMemories = []
        memoryControlRevision &+= 1
        conversationId = id
        await persister.setCurrentConversationId(id)
        await loadHistory()
        await todoPlanner.load(conversationId: id)
        await loadConversations()
        tokenUsage.reset()
        showHistory = false
    }

    func sendMessage(
        appendUser: Bool = true,
        onAccepted: (() -> Void)? = nil
    ) async {
        await awaitInitialization()
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isConversationTransitioning else { return }

        let now = Date()
        guard now.timeIntervalSince(lastSendTime) >= 0.5 else {
            NSLog("[TriosChat] debounce blocked")
            return
        }
        lastSendTime = now

        NSLog("[TriosChat] sendMessage start: \"\(text.prefix(40))\"")

        // Save to message history for ↑↓ hotkey navigation
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

        // Exclude the current user message from previousConversation: the server
        // receives it separately via the `message` field, and duplicating it
        // confuses the model and the UI.
        let historyForRequest = Array(messages.dropLast())
        beginUsageEstimate(message: text, history: historyForRequest)

        guard let requestBody = try? ChatRequestBuilder(
            conversationId: conversationId,
            message: text,
            mode: "agent",
            origin: "sidepanel",
            userSystemPrompt: memoryService.promptContext(
                for: recalledMemories
            ),
            previousConversation: historyForRequest,
            browserContext: nil,
            modelConfiguration: modelStore.runtimeConfiguration
        ).build() else {
            NSLog("[TriosChat] ChatRequestBuilder failed")
            await failPendingTurn(message: "Failed to build request")
            guard isGenerationCurrent(generation) else { return }
            _ = await stateMachine.transition(to: .error("Failed to build request"))
            guard isGenerationCurrent(generation) else { return }
            let currentState = await stateMachine.currentState()
            guard isGenerationCurrent(generation) else { return }
            state = currentState
            clearPendingUsage()
            return
        }
        NSLog("[TriosChat] request body built, size: \(requestBody.count)")

        await parser.reset()

        do {
            let stream = try await transport.sendMessage(body: requestBody)
            guard isCurrentStream(generation) else { return }
            await todoPlanner.markExecutionStarted(
                detail: "Response stream opened"
            )
            NSLog("[TriosChat] transport stream opened")
            var receivedTerminalEvent = false
            for await event in stream {
                guard isCurrentStream(generation) else { break }
                switch event {
                case .finish, .abort, .error:
                    receivedTerminalEvent = true
                default:
                    break
                }
                NSLog("[TriosChat] SSE event: \(event)")
                await handleEvent(
                    event,
                    expectedGeneration: generation
                )
            }
            guard isCurrentStream(generation) else { return }
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
                return
            }
            await completePendingTurnIfNeeded()
            guard isGenerationCurrent(generation) else { return }
            finalizeEstimatedUsageIfNeeded()
            NSLog("[TriosChat] stream ended normally")
            _ = await stateMachine.transition(to: .idle)
            guard isGenerationCurrent(generation) else { return }
            let currentState = await stateMachine.currentState()
            guard isGenerationCurrent(generation) else { return }
            state = currentState
            await saveHistory(expectedGeneration: generation)
        } catch {
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

            NSLog("[TriosChat] transport error: \(error.localizedDescription)")
            clearPendingUsage()
            let errorMsg = ChatMessage(role: .system, content: "[!] \(error.localizedDescription)")
            messages.append(errorMsg)
            rebuildCache()
            let historySnapshot = captureHistorySnapshot()
            await failPendingTurn(message: error.localizedDescription)
            await persistHistorySnapshot(historySnapshot)
            guard isGenerationCurrent(generation) else { return }
            _ = await stateMachine.transition(to: .error(error.localizedDescription))
            guard isGenerationCurrent(generation) else { return }
            let currentState = await stateMachine.currentState()
            guard isGenerationCurrent(generation) else { return }
            state = currentState
            await saveHistory(expectedGeneration: generation)
        }
    }

    func cancelStreaming() {
        finalizeAssistantStreamingState()
        let historySnapshot = captureHistorySnapshot()
        invalidateActiveStream()
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
        await sendMessage(appendUser: false)
    }

    func sendFeedback(messageId: UUID, isPositive: Bool) async {
        NSLog("[TriosChat] feedback for \(messageId): \(isPositive ? "👍" : "👎")")
        // TODO: wire to server feedback endpoint when available
    }

    func checkHealth() async {
        let reachable = await healthCheck.check()
        isServerReachable = reachable
    }

    func newConversation() {
        guard beginConversationTransition() else { return }
        let newConversationId = UUID()
        invalidateActiveStream()
        Task {
            await awaitInitialization()
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

    func registerA2A() async {
        guard let client = a2aClient else { return }
        do {
            try await client.register()
            await client.startHeartbeat(interval: 30)
            startA2AStream()
            isA2ARegistered = true
        } catch {
            isA2ARegistered = false
        }
    }

    func unregisterA2A() async {
        stopA2AStream()
        guard let client = a2aClient else { return }
        await client.stopHeartbeat()
        do {
            try await client.unregister()
            isA2ARegistered = false
        } catch {
            isA2ARegistered = false
        }
    }

    func startA2AStream() {
        guard let client = a2aClient else { return }
        a2aRouter = A2AMessageRouter(viewModel: self)
        a2aStreamTask?.cancel()
        a2aStreamTask = Task {
            do {
                let stream = try await client.messageStream()
                for await message in stream {
                    a2aRouter?.route(message)
                }
            } catch {
                // Silent — stream will retry on next registration
            }
        }
    }

    func stopA2AStream() {
        a2aStreamTask?.cancel()
        a2aStreamTask = nil
        a2aRouter = nil
    }

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
            // Silent failure — A2A is best-effort until server routes are live
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
            // Do NOT clear isStreaming here — text may be finished but tool calls
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

    init(
        conversationId: UUID,
        message: String,
        mode: String,
        origin: String,
        userSystemPrompt: String?,
        previousConversation: [ChatMessage],
        browserContext: BrowserContext?,
        modelConfiguration: ModelRuntimeConfiguration? = nil
    ) {
        self.conversationId = conversationId
        self.message = message
        self.mode = mode
        self.origin = origin
        self.userSystemPrompt = userSystemPrompt
        self.previousConversation = previousConversation
        self.browserContext = browserContext
        self.modelConfiguration = modelConfiguration
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

        // System memory prompt
        let systemContent = userSystemPrompt.map { "\(memoryPrompt)\n\($0)" } ?? memoryPrompt
        messages.append(["role": "system", "content": systemContent])

        // Rich conversation history with segments and tool calls
        for msg in previousConversation {
            var content = msg.content

            // Append reasoning segments as visible memory
            let reasoning = msg.segments.compactMap {
                if case .reasoning(let text) = $0 { return text }
                return nil
            }
            if !reasoning.isEmpty {
                content += "\n\n[Internal reasoning]: " + reasoning.joined(separator: "\n")
            }

            // Append tool calls as memory
            if !msg.toolCalls.isEmpty {
                let tools = msg.toolCalls.map { tc in
                    var s = "Tool: \(tc.name)(\(tc.arguments))"
                    if let out = tc.output { s += " -> \(out)" }
                    return s
                }.joined(separator: "\n")
                content += "\n\n[Tools used]:\n" + tools
            }

            // Append error segments
            let errors = msg.segments.compactMap {
                if case .error(let text) = $0 { return text }
                return nil
            }
            if !errors.isEmpty {
                content += "\n\n[Errors]: " + errors.joined(separator: "; ")
            }

            messages.append(["role": msg.role.rawValue, "content": content])
        }

        // Current user message
        messages.append(["role": "user", "content": message])

        let homeDir = FileManager.default.homeDirectoryForCurrentUser.path

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
