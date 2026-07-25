import Foundation

struct SessionRecoveryRedactionResult: Sendable, Equatable {
    let text: String
    let count: Int
}

enum SessionRecoveryRedactor {
    private struct Rule {
        let pattern: String
        let replacement: String
    }

    private static let rules: [Rule] = [
        Rule(
            pattern: #"(?i)((?:OPENAI|ANTHROPIC|OPENROUTER|ZAI|TRIOS|GOOGLE|GITHUB)[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)(?!\[REDACTED\])[^\s"']+"#,
            replacement: "$1[REDACTED]"
        ),
        Rule(
            pattern: #"(?i)((?:authorization|proxy-authorization)\s*[:=]\s*(?>(?:(?:bearer|basic)\s+)?))(?!\[REDACTED\])[^\s"',;}]+"#,
            replacement: "$1[REDACTED]"
        ),
        Rule(
            pattern: #"(?i)(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|cookie|set-cookie)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])([^"'\s,;}]+)(["']?)"#,
            replacement: "$1[REDACTED]$3"
        ),
        Rule(
            pattern: #"(?i)\b(?:sk-(?:(?:proj|ant|or-v1)-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,})\b"#,
            replacement: "[REDACTED]"
        ),
        Rule(
            pattern: #"(?i)(?:bot)?[0-9]{6,12}:[A-Za-z0-9_-]{30,}\b"#,
            replacement: "[REDACTED]"
        )
    ]

    static func redact(_ source: String) -> SessionRecoveryRedactionResult {
        var text = source
        var count = 0
        for rule in rules {
            guard let expression = try? NSRegularExpression(
                pattern: rule.pattern,
                options: []
            ) else { continue }
            let range = NSRange(text.startIndex..<text.endIndex, in: text)
            let matches = expression.numberOfMatches(in: text, options: [], range: range)
            guard matches > 0 else { continue }
            count += matches
            text = expression.stringByReplacingMatches(
                in: text,
                options: [],
                range: range,
                withTemplate: rule.replacement
            )
        }
        return SessionRecoveryRedactionResult(text: text, count: count)
    }
}

struct SessionRecoverySegment: Codable, Sendable, Equatable {
    let kind: String
    let text: String?
    let name: String?
    let arguments: String?
    let result: String?
    let toolCallID: String?

    init(
        kind: String,
        text: String? = nil,
        name: String? = nil,
        arguments: String? = nil,
        result: String? = nil,
        toolCallID: String? = nil
    ) {
        self.kind = kind
        self.text = text
        self.name = name
        self.arguments = arguments
        self.result = result
        self.toolCallID = toolCallID
    }
}

struct SessionRecoveryToolCall: Codable, Sendable, Equatable {
    let id: String
    let name: String
    let arguments: String
    let output: String?
    let isComplete: Bool
}

struct SessionRecoveryTask: Codable, Sendable, Equatable {
    let id: UUID
    let title: String
    let description: String
    let state: String
    let priority: Int
    let assignee: String
    let createdAt: String
    let updatedAt: String
}

struct SessionRecoveryMessage: Codable, Sendable, Equatable {
    let id: UUID
    let role: String
    let content: String
    let timestamp: Date
    let isStreaming: Bool
    let segments: [SessionRecoverySegment]
    let toolCalls: [SessionRecoveryToolCall]
    let task: SessionRecoveryTask?

    init(
        id: UUID,
        role: String,
        content: String,
        timestamp: Date,
        isStreaming: Bool,
        segments: [SessionRecoverySegment] = [],
        toolCalls: [SessionRecoveryToolCall] = [],
        task: SessionRecoveryTask? = nil
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.segments = segments
        self.toolCalls = toolCalls
        self.task = task
    }
}

struct SessionRecoveryConversation: Codable, Sendable, Equatable {
    let id: UUID
    let title: String
    let updatedAt: Date
    let messages: [SessionRecoveryMessage]
}

struct SessionRecoveryBrowserToolCall: Codable, Sendable, Equatable {
    let name: String
    let status: String
    let timestamp: Date
    let result: String?
}

struct SessionRecoveryBrowserMessage: Codable, Sendable, Equatable {
    let id: UUID
    let role: String
    let content: String
    let timestamp: Date
    let toolCalls: [SessionRecoveryBrowserToolCall]
}

struct SessionRecoveryBrowserContext: Codable, Sendable, Equatable {
    let status: String
    let pageID: Int?
    let messages: [SessionRecoveryBrowserMessage]
    let toolCalls: [SessionRecoveryBrowserToolCall]
}

struct SessionRecoveryRuntimeContext: Codable, Sendable, Equatable {
    let appName: String
    let appVersion: String
    let buildVariant: String
    let osVersion: String
    let projectRoot: String
    let activeConversationID: UUID
    let provider: String
    let model: String
    let baseURL: String
    let credentialStatus: String
    let inputTokens: Int
    let outputTokens: Int
    let includesEstimate: Bool
    let triosServerReachable: Bool
    let browserOSConnected: Bool
    let cdpPort: String
    let draft: String
    let encryptionScheme: String?
    let encryptionKeyPath: String?

    init(
        appName: String,
        appVersion: String,
        buildVariant: String,
        osVersion: String,
        projectRoot: String,
        activeConversationID: UUID,
        provider: String,
        model: String,
        baseURL: String,
        credentialStatus: String,
        inputTokens: Int,
        outputTokens: Int,
        includesEstimate: Bool,
        triosServerReachable: Bool,
        browserOSConnected: Bool,
        cdpPort: String,
        draft: String,
        encryptionScheme: String? = nil,
        encryptionKeyPath: String? = nil
    ) {
        self.appName = appName
        self.appVersion = appVersion
        self.buildVariant = buildVariant
        self.osVersion = osVersion
        self.projectRoot = projectRoot
        self.activeConversationID = activeConversationID
        self.provider = provider
        self.model = model
        self.baseURL = baseURL
        self.credentialStatus = credentialStatus
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.includesEstimate = includesEstimate
        self.triosServerReachable = triosServerReachable
        self.browserOSConnected = browserOSConnected
        self.cdpPort = cdpPort
        self.draft = draft
        self.encryptionScheme = encryptionScheme
        self.encryptionKeyPath = encryptionKeyPath
    }
}

struct SessionRecoveryLogSource: Sendable, Equatable {
    let url: URL
    let archivePath: String
}

struct SessionRecoveryPackageRequest: Sendable, Equatable {
    let packageID: UUID
    let createdAt: Date
    let activeConversationID: UUID
    let conversations: [SessionRecoveryConversation]
    let browserContext: SessionRecoveryBrowserContext
    let runtimeContext: SessionRecoveryRuntimeContext
    let initialRedactionCount: Int
    let logSources: [SessionRecoveryLogSource]
    let includeSystemProcessLog: Bool
    let systemProcessName: String

    init(
        packageID: UUID = UUID(),
        createdAt: Date = Date(),
        activeConversationID: UUID,
        conversations: [SessionRecoveryConversation],
        browserContext: SessionRecoveryBrowserContext,
        runtimeContext: SessionRecoveryRuntimeContext,
        initialRedactionCount: Int,
        logSources: [SessionRecoveryLogSource],
        includeSystemProcessLog: Bool = true,
        systemProcessName: String = "trios"
    ) {
        self.packageID = packageID
        self.createdAt = createdAt
        self.activeConversationID = activeConversationID
        self.conversations = conversations
        self.browserContext = browserContext
        self.runtimeContext = runtimeContext
        self.initialRedactionCount = initialRedactionCount
        self.logSources = logSources
        self.includeSystemProcessLog = includeSystemProcessLog
        self.systemProcessName = systemProcessName
    }
}

struct SessionRecoveryExportResult: Sendable, Equatable {
    let archiveURL: URL
    let fileCount: Int
    let redactionCount: Int
    let archiveSize: Int64
}

struct SessionRecoverySanitized<Value> {
    let value: Value
    let redactionCount: Int
}

enum SessionRecoverySanitizer {
    static func sanitize(_ message: SessionRecoveryMessage) -> SessionRecoverySanitized<SessionRecoveryMessage> {
        var redactionCount = 0

        func clean(_ value: String) -> String {
            let result = SessionRecoveryRedactor.redact(value)
            redactionCount += result.count
            return result.text
        }

        let segments = message.segments.map { segment in
            SessionRecoverySegment(
                kind: segment.kind,
                text: segment.text.map(clean),
                name: segment.name.map(clean),
                arguments: segment.arguments.map(clean),
                result: segment.result.map(clean),
                toolCallID: segment.toolCallID.map(clean)
            )
        }
        let toolCalls = message.toolCalls.map { toolCall in
            SessionRecoveryToolCall(
                id: clean(toolCall.id),
                name: clean(toolCall.name),
                arguments: clean(toolCall.arguments),
                output: toolCall.output.map(clean),
                isComplete: toolCall.isComplete
            )
        }
        let task = message.task.map { task in
            SessionRecoveryTask(
                id: task.id,
                title: clean(task.title),
                description: clean(task.description),
                state: task.state,
                priority: task.priority,
                assignee: clean(task.assignee),
                createdAt: task.createdAt,
                updatedAt: task.updatedAt
            )
        }
        let sanitized = SessionRecoveryMessage(
            id: message.id,
            role: message.role,
            content: clean(message.content),
            timestamp: message.timestamp,
            isStreaming: message.isStreaming,
            segments: segments,
            toolCalls: toolCalls,
            task: task
        )
        return SessionRecoverySanitized(value: sanitized, redactionCount: redactionCount)
    }

    static func sanitize(_ conversation: SessionRecoveryConversation) -> SessionRecoverySanitized<SessionRecoveryConversation> {
        let title = SessionRecoveryRedactor.redact(conversation.title)
        var redactionCount = title.count
        let messages = conversation.messages.map { message in
            let result = sanitize(message)
            redactionCount += result.redactionCount
            return result.value
        }
        return SessionRecoverySanitized(
            value: SessionRecoveryConversation(
                id: conversation.id,
                title: title.text,
                updatedAt: conversation.updatedAt,
                messages: messages
            ),
            redactionCount: redactionCount
        )
    }
}

enum SessionRecoveryConversationMerger {
    static func merge(
        persisted: [SessionRecoveryConversation],
        active: SessionRecoveryConversation
    ) -> [SessionRecoveryConversation] {
        let remaining = persisted
            .filter { $0.id != active.id }
            .sorted { $0.updatedAt > $1.updatedAt }
        return [active] + remaining
    }
}

enum SessionRecoveryTranscriptBuilder {
    static func build(_ conversation: SessionRecoveryConversation) -> String {
        let formatter = ISO8601DateFormatter()
        var lines = [
            "# Conversation: \(conversation.title)",
            "",
            "- Conversation ID: `\(conversation.id.uuidString)`",
            "- Updated: `\(formatter.string(from: conversation.updatedAt))`",
            "- Messages: \(conversation.messages.count)",
            ""
        ]

        let ordered = conversation.messages.enumerated().sorted { left, right in
            if left.element.timestamp != right.element.timestamp {
                return left.element.timestamp < right.element.timestamp
            }
            return left.offset < right.offset
        }

        for (_, message) in ordered {
            lines.append("## \(displayRole(message.role))")
            lines.append("")
            lines.append("- Message ID: `\(message.id.uuidString)`")
            lines.append("- Timestamp: `\(formatter.string(from: message.timestamp))`")
            lines.append("- Streaming at export: `\(message.isStreaming)`")
            lines.append("")
            if !message.content.isEmpty {
                lines.append(message.content)
                lines.append("")
            }

            for segment in message.segments {
                append(segment: segment, to: &lines)
            }
            for toolCall in message.toolCalls {
                lines.append("### Tool call record: \(toolCall.name)")
                lines.append("")
                lines.append("- ID: `\(toolCall.id)`")
                lines.append("- Complete: `\(toolCall.isComplete)`")
                appendCode(toolCall.arguments, language: "json", to: &lines)
                if let output = toolCall.output {
                    lines.append("#### Result")
                    lines.append("")
                    appendCode(output, language: "text", to: &lines)
                }
            }
            if let task = message.task {
                lines.append("### Agent task")
                lines.append("")
                lines.append("- Title: \(task.title)")
                lines.append("- Description: \(task.description)")
                lines.append("- State: `\(task.state)`")
                lines.append("- Priority: `\(task.priority)`")
                lines.append("- Assignee: `\(task.assignee)`")
                lines.append("")
            }
        }
        return lines.joined(separator: "\n")
    }

    private static func append(segment: SessionRecoverySegment, to lines: inout [String]) {
        switch segment.kind {
        case "text":
            lines.append("### Text segment")
            lines.append("")
            lines.append(segment.text ?? "")
            lines.append("")
        case "reasoning":
            lines.append("### Reasoning")
            lines.append("")
            lines.append(segment.text ?? "")
            lines.append("")
        case "toolCall":
            lines.append("### Tool call reference")
            lines.append("")
            lines.append("`\(segment.toolCallID ?? "unknown")`")
            lines.append("")
        case "toolInput":
            lines.append("### Tool request: \(segment.name ?? "unknown")")
            lines.append("")
            appendCode(segment.arguments ?? "", language: "json", to: &lines)
        case "toolOutput":
            lines.append("### Tool result: \(segment.name ?? "unknown")")
            lines.append("")
            appendCode(segment.result ?? "", language: "text", to: &lines)
        case "error":
            lines.append("### Error")
            lines.append("")
            lines.append(segment.text ?? "")
            lines.append("")
        default:
            lines.append("### Segment: \(segment.kind)")
            lines.append("")
            lines.append(segment.text ?? segment.result ?? segment.arguments ?? "")
            lines.append("")
        }
    }

    private static func appendCode(_ value: String, language: String, to lines: inout [String]) {
        lines.append("```\(language)")
        lines.append(value)
        lines.append("```")
        lines.append("")
    }

    private static func displayRole(_ role: String) -> String {
        switch role.lowercased() {
        case "user": return "User"
        case "assistant": return "Assistant"
        case "system": return "System"
        case "tool": return "Tool"
        default: return role.capitalized
        }
    }
}

enum SessionRecoveryPackageNaming {
    static func fileName(date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return "Trinity-Recovery-\(formatter.string(from: date)).zip"
    }
}
