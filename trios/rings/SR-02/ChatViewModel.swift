import Foundation
import SwiftUI

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var state: ConversationState = .idle
    @Published var inputText: String = ""
    @Published var isServerReachable: Bool = false
    @Published var isA2ARegistered: Bool = false
    @Published var conversations: [ChatConversation] = []
    @Published var showHistory = false

    let queenStatusVM = QueenStatusViewModel()

    private let transport: ChatTransportProtocol
    private let healthCheck: ChatHealthCheckProtocol
    private let parser: ChatParserProtocol
    private let persister: ChatPersisterProtocol
    private let stateMachine: ConversationStateMachine
    let a2aClient: A2ARegistryClient?

    private var conversationId: UUID = UUID()
    private var messageCache: [UUID: Int] = [:]
    private var a2aRouter: A2AMessageRouter?
    private var a2aStreamTask: Task<Void, Never>?
    private var healthCheckTask: Task<Void, Never>?
    private var lastSendTime: Date = .distantPast

    init(
        transport: ChatTransportProtocol,
        healthCheck: ChatHealthCheckProtocol,
        parser: ChatParserProtocol,
        persister: ChatPersisterProtocol,
        stateMachine: ConversationStateMachine,
        a2aClient: A2ARegistryClient? = nil
    ) {
        NSLog("ChatViewModel.init starting")
        self.transport = transport
        self.healthCheck = healthCheck
        self.parser = parser
        self.persister = persister
        self.stateMachine = stateMachine
        self.a2aClient = a2aClient
        NSLog("ChatViewModel.init properties set")

        Task {
            NSLog("ChatViewModel.init Task started")
            await setupConversationId()
            await loadHistory()
            await checkHealth()
            NSLog("ChatViewModel.init Task done")
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
        healthCheckTask?.cancel()
    }

    func setupConversationId() async {
        conversationId = persister.currentConversationId()
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

    func switchConversation(id: UUID) async {
        // Cancel any in-flight stream before loading a different conversation;
        // otherwise late SSE events could corrupt the newly loaded messages.
        await transport.cancel()
        _ = await stateMachine.transition(to: .idle)
        state = await stateMachine.currentState()

        conversationId = id
        persister.setCurrentConversationId(id)
        await loadHistory()
        await loadConversations()
        showHistory = false
    }

    func sendMessage(appendUser: Bool = true) async {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        let now = Date()
        guard now.timeIntervalSince(lastSendTime) >= 0.5 else {
            NSLog("[TriosChat] debounce blocked")
            return
        }
        lastSendTime = now

        NSLog("[TriosChat] sendMessage start: \"\(text.prefix(40))\"")

        if appendUser {
            let userMessage = ChatMessage(role: .user, content: text)
            messages.append(userMessage)
            rebuildCache()
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

        // Exclude the current user message from previousConversation: the server
        // receives it separately via the `message` field, and duplicating it
        // confuses the model and the UI.
        let historyForRequest = Array(messages.dropLast())

        guard let requestBody = try? ChatRequestBuilder(
            conversationId: conversationId,
            message: text,
            mode: "agent",
            origin: "sidepanel",
            userSystemPrompt: nil,
            previousConversation: historyForRequest,
            browserContext: nil
        ).build() else {
            NSLog("[TriosChat] ChatRequestBuilder failed")
            _ = await stateMachine.transition(to: .error("Failed to build request"))
            state = await stateMachine.currentState()
            return
        }
        NSLog("[TriosChat] request body built, size: \(requestBody.count)")

        await parser.reset()

        do {
            let stream = try await transport.sendMessage(body: requestBody)
            NSLog("[TriosChat] transport stream opened")
            for await event in stream {
                NSLog("[TriosChat] SSE event: \(event)")
                await handleEvent(event)
            }
            NSLog("[TriosChat] stream ended normally")
            _ = await stateMachine.transition(to: .idle)
            state = await stateMachine.currentState()
            await saveHistory()
        } catch {
            // Manual cancellation is not a user-visible error.
            if let urlError = error as? URLError, urlError.code == .cancelled {
                NSLog("[TriosChat] stream cancelled by user")
                _ = await stateMachine.transition(to: .idle)
                state = await stateMachine.currentState()
                await saveHistory()
                return
            }

            NSLog("[TriosChat] transport error: \(error.localizedDescription)")
            let errorMsg = ChatMessage(role: .system, content: "[!] \(error.localizedDescription)")
            messages.append(errorMsg)
            rebuildCache()
            _ = await stateMachine.transition(to: .error(error.localizedDescription))
            state = await stateMachine.currentState()
            await saveHistory()
        }
    }

    func cancelStreaming() {
        Task {
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
        conversationId = UUID()
        messages = []
        messageCache = [:]
        state = .idle
        Task {
            persister.setCurrentConversationId(conversationId)
            await loadConversations()
        }
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

    private func handleEvent(_ event: SSEEvent) async {
        guard let action = await parser.parse(event) else { return }
        await applyAction(action)
    }

    private func applyAction(_ action: ParserAction) async {

        switch action {
        case .appendMessage(let message):
            messages.append(message)
            rebuildCache()
            _ = await stateMachine.transition(to: .streaming(messageId: message.id))
            state = await stateMachine.currentState()

        case .appendText(let messageId, let delta):
            guard let index = messageCache[messageId] else { return }
            messages[index].content += delta
            messages[index].isStreaming = true
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
            objectWillChange.send()

        case .addToolCall(let messageId, let toolCall):
            guard let index = messageCache[messageId] else { return }
            messages[index].toolCalls.append(toolCall)
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

        case .streamComplete:
            if let lastIndex = messages.indices.last,
               messages[lastIndex].role == .assistant {
                messages[lastIndex].isStreaming = false
            }
            _ = await stateMachine.transition(to: .idle)
            state = await stateMachine.currentState()
            await saveHistory()

        case .streamAborted:
            if let lastIndex = messages.indices.last,
               messages[lastIndex].role == .assistant {
                messages[lastIndex].isStreaming = false
            }
            _ = await stateMachine.transition(to: .idle)
            state = await stateMachine.currentState()
            await saveHistory()

        case .streamError(let message):
            let errorMsg = ChatMessage(role: .system, content: "[!] \(message)")
            messages.append(errorMsg)
            rebuildCache()
            _ = await stateMachine.transition(to: .error(message))
            state = await stateMachine.currentState()
            await saveHistory()
        }
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

    private func saveHistory() async {
        await persister.save(messages: messages, conversationId: conversationId)
        await loadConversations()
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

    private var memoryPrompt: String {
        """
        You are TRIOS AGENT, a native macOS AI assistant with full memory of this conversation. \
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

        let apiKey = ProcessInfo.processInfo.environment["TRIOS_API_KEY"]
        let provider = ProcessInfo.processInfo.environment["TRIOS_PROVIDER"] ?? "ollama"
        let defaultModel = Self.defaultModel(for: provider)

        var body: [String: Any] = [
            "conversationId": conversationId.uuidString,
            "message": message,
            "mode": mode,
            "origin": origin,
            "supportsImages": true,
            "provider": provider,
            "model": ProcessInfo.processInfo.environment["TRIOS_MODEL"] ?? defaultModel,
            "baseUrl": ProcessInfo.processInfo.environment["TRIOS_BASE_URL"] ?? "http://127.0.0.1:11434/v1",
            "messages": messages,
            "userWorkingDir": homeDir
        ]

        // Only send apiKey when the caller has configured one. Providers that
        // require authentication will fail fast server-side with a clear error;
        // providers that do not need a key (local Ollama) should not receive
        // an empty field.
        if let apiKey = apiKey, !apiKey.isEmpty {
            body["apiKey"] = apiKey
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
