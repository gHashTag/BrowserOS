import Foundation
import SwiftUI
import Combine

@MainActor
class BrowserOSChatViewModel: ObservableObject {
    
    @Published var messages: [BrowserOSChatMessage] = .init()
    @Published var isStreaming: Bool = false
    @Published var isBrowserOSConnected: Bool = false
    @Published var queenStatus: QueenStatus = .idle
    @Published var toolCalls: [ToolCallRecord] = .init()
    
    @Published var currentPageId: Int? = nil
    @Published var inputText: String = ""

    private let mcpClient: TriosMCPClient
    private let llmClient = LLMClient()
    private var cancellables = Set<AnyCancellable>()
    private var streamingTask: Task<Void, Never>?
    private var sessionStartTime: Date = Date()
    private var pageDetectionTask: Task<Void, Never>?
    private var lastSendTime: Date = .distantPast

    enum QueenStatus: String {
        case idle = "idle"
        case alive = "alive"
        case working = "working"
        case error = "error"
    }
    
    struct ToolCallRecord: Identifiable {
        let id = UUID()
        let name: String
        let status: ToolStatus
        let timestamp: Date
        let result: String?
        
        enum ToolStatus {
            case running, completed, failed
        }
    }
    
    init() {
        self.mcpClient = TriosMCPClient()
        setupHealthCheck()
    }
    
    private func setupHealthCheck() {
        Task {
            _ = await mcpClient.checkHealth()
            Timer.publish(every: 5, on: .main, in: .common)
                .autoconnect()
                .sink { [weak self] _ in
                    Task {
                        await self?.updateConnectionStatus()
                    }
                }
                .store(in: &cancellables)
        }
    }
    
    private func updateConnectionStatus() async {
        let connected = await mcpClient.checkHealth()
        self.isBrowserOSConnected = connected
        if connected && queenStatus == .idle {
            self.queenStatus = .alive
        } else if !connected {
            self.queenStatus = .error
        }
    }
    
    func cancelStreaming() {
        streamingTask?.cancel()
        streamingTask = nil
        isStreaming = false
        queenStatus = isBrowserOSConnected ? .alive : .error
        NSLog("[BrowserOSChatViewModel] streaming cancelled")
    }

    func sendMessage(_ text: String) {
        let now = Date()
        guard now.timeIntervalSince(lastSendTime) >= 0.5 else {
            NSLog("[BrowserOSChatViewModel] debounce blocked")
            return
        }
        lastSendTime = now

        let userMessage = BrowserOSChatMessage(role: .user, content: text, timestamp: now)
        messages.append(userMessage)
        sortMessages()
        if isLikelyCommand(text) {
            if let (toolName, args) = parseIntent(text, pageId: nil) {
                executeBrowserOSCommand(toolName: toolName, args: args, originalText: text)
            } else {
                showUsageHint()
            }
        } else {
            sendToLLM(text)
        }
    }

    private func sendToLLM(_ text: String) {
        isStreaming = true
        queenStatus = .working

        streamingTask?.cancel()
        streamingTask = Task {
            do {
                let history: [LLMClient.Message] = messages.map { msg in
                    let role: String
                    switch msg.role {
                    case .user: role = "user"
                    case .assistant: role = "assistant"
                    case .system: role = "system"
                    case .tool: role = "assistant"
                    }
                    return LLMClient.Message(role: role, content: msg.content)
                }

                let reply = try await llmClient.complete(messages: history)

                let agentMessage = BrowserOSChatMessage(
                    role: .assistant,
                    content: reply,
                    timestamp: Date()
                )
                messages.append(agentMessage)
                sortMessages()
                queenStatus = .alive

            } catch {
                let errorMessage = BrowserOSChatMessage(
                    role: .system,
                    content: "Agent error: \(error.localizedDescription)",
                    timestamp: Date()
                )
                messages.append(errorMessage)
                sortMessages()
                queenStatus = .error
            }
            isStreaming = false
        }
    }

    func isLikelyCommand(_ text: String) -> Bool {
        ChatLogic.isLikelyCommand(text)
    }

    private func showUsageHint() {
        isStreaming = true
        let response = """
        BrowserOS Agent ready. Available commands:
        - open [url] - navigate to page
        - click - click element
        - screenshot - capture page
        - extract - get page content
        - shell [command] - run shell command
        """
        let agentMessage = BrowserOSChatMessage(
            role: .assistant,
            content: response,
            timestamp: Date()
        )
        messages.append(agentMessage)
        sortMessages()
        isStreaming = false
    }

    private func executeBrowserOSCommand(toolName: String, args: [String: Any], originalText: String) {
        isStreaming = true
        queenStatus = .working

        streamingTask?.cancel()
        streamingTask = Task {
            do {
                // Auto-detect page ID before executing browser tools
                let pageId = await ensurePageId()
                var finalArgs = args
                if let pageId = pageId, finalArgs["page"] == nil {
                    finalArgs["page"] = pageId
                }

                let record = ToolCallRecord(
                    name: toolName,
                    status: .running,
                    timestamp: Date(),
                    result: nil
                )
                toolCalls.append(record)

                let response = try await mcpClient.callTool(
                    name: toolName,
                    arguments: finalArgs
                )

                let resultText = extractResultText(response)

                if let index = toolCalls.lastIndex(where: { $0.name == toolName && $0.status == .running }) {
                    toolCalls[index] = ToolCallRecord(
                        name: toolName,
                        status: .completed,
                        timestamp: toolCalls[index].timestamp,
                        result: resultText
                    )
                }

                let agentMessage = BrowserOSChatMessage(
                    role: .assistant,
                    content: resultText,
                    timestamp: Date(),
                    toolCalls: [BrowserOSToolCall(name: toolName, result: resultText)]
                )
                messages.append(agentMessage)
                sortMessages()

                queenStatus = .alive

            } catch {
                let errorMessage = BrowserOSChatMessage(
                    role: .system,
                    content: "BrowserOS Error: \(error.localizedDescription)",
                    timestamp: Date()
                )
                messages.append(errorMessage)
                sortMessages()
                queenStatus = .error
            }

            isStreaming = false
        }
    }

    private func parseIntent(_ text: String, pageId: Int?) -> (String, [String: Any])? {
        ChatLogic.parseIntent(text, pageId: pageId)
    }

    private func ensurePageId() async -> Int? {
        if let cached = currentPageId { return cached }
        return await detectPageId()
    }

    private func detectPageId() async -> Int? {
        do {
            // The `get_active_page` tool returns the currently focused tab, e.g.
            // "Active page: 29 (tab 1197258256)...". Using the first entry from
            // `list_pages` picked an inactive/closed tab and caused CDP timeouts.
            // AGENT-V-WAIVER: active-page detection fix (Agent V conditional waiver, 2026-07-27).
            let activeText = try await mcpClient.getActivePage()
            if let id = ChatLogic.activePageId(in: activeText) {
                currentPageId = id
                return id
            }
            NSLog("[BrowserOSChatViewModel] No active page id in get_active_page output: \(activeText.prefix(200))")
        } catch {
            NSLog("[BrowserOSChatViewModel] Page detection failed: \(error)")
        }
        return nil
    }

    func startPageDetection() {
        pageDetectionTask?.cancel()
        pageDetectionTask = Task {
            while !Task.isCancelled {
                if currentPageId == nil {
                    _ = await detectPageId()
                }
                try? await Task.sleep(nanoseconds: 10_000_000_000) // 10 seconds
            }
        }
    }

    func stopPageDetection() {
        pageDetectionTask?.cancel()
        pageDetectionTask = nil
    }
    
    private func extractResultText(_ response: MCPResponse) -> String {
        if let error = response.error {
            return "MCP error \(error.code): \(error.message)"
        }
        guard let result = response.result else { return "No result" }
        return result.content.compactMap { $0.text }.joined(separator: "\n")
    }
    
    var sessionDuration: String {
        let interval = Date().timeIntervalSince(sessionStartTime)
        let minutes = Int(interval) / 60
        return minutes > 0 ? "\(minutes)m" : "\(Int(interval))s"
    }
    
    var queenStatusText: String {
        "[Q] \(queenStatus.rawValue) \(sessionDuration)"
    }

    /// Keep chat history strictly in chronological order regardless of async
    /// completion order. Must be called after every `messages.append`.
    private func sortMessages() {
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
    }

    /// Remove duplicate messages by UUID, preserving the first occurrence.
    private func deduplicateMessages() {
        var seen = Set<UUID>()
        messages = messages.filter { msg in
            guard !seen.contains(msg.id) else { return false }
            seen.insert(msg.id)
            return true
        }
    }
}

struct BrowserOSChatMessage: Identifiable {
    let id = UUID()
    let role: ChatRole
    let content: String
    let timestamp: Date
    var toolCalls: [BrowserOSToolCall] = []
    
    enum ChatRole {
        case user, assistant, system, tool
    }
}

struct BrowserOSToolCall {
    let name: String
    let result: String?
}