import Foundation

protocol ChatTransportProtocol: Sendable {
    func sendMessage(body: Data) async throws -> AsyncStream<SSEEvent>
    func cancel() async
}

protocol ChatParserProtocol: Sendable {
    func parse(_ event: SSEEvent) async -> ParserAction?
    func reset() async
}

struct ChatConversation: Identifiable, Codable, Equatable {
    let id: UUID
    var title: String
    var isPinned: Bool
    var icon: String
    let updatedAt: Date
    var unreadCount: Int
    var isReserved: Bool

    init(id: UUID, title: String, isPinned: Bool = false, icon: String = "message.fill", updatedAt: Date = Date(), unreadCount: Int = 0, isReserved: Bool = false) {
        self.id = id
        self.title = title
        self.isPinned = isPinned
        self.icon = icon
        self.updatedAt = updatedAt
        self.unreadCount = unreadCount
        self.isReserved = isReserved
    }
}

extension ChatConversation {
    /// Stable sentinel for the Trinity Queen direct-line conversation.
    /// Derived from a deterministic UUIDv5 namespace so it never collide with
    /// random user-created conversations.
    static let trinityQueenId = UUID(uuidString: "E621E1F8-C36C-495A-93FC-0C247A3E6E5F")!

    static var trinityQueen: ChatConversation {
        ChatConversation(
            id: trinityQueenId,
            title: "Trinity Queen",
            isPinned: true,
            icon: "crown.fill",
            updatedAt: Date(),
            unreadCount: 0,
            isReserved: true
        )
    }
}

/// Per-conversation overrides for output budget, context-window margin, and
/// the preferred provider/model tuple. `nil` means "use the global default
/// from ModelConfigurationStore".
struct ConversationSettings: Codable, Equatable, Sendable {
    var requestedOutputTokens: Int?
    var contextWindowMargin: Double?
    var provider: ModelProvider?
    var baseURL: String?
    var model: String?

    static let `default` = ConversationSettings(
        requestedOutputTokens: nil,
        contextWindowMargin: nil,
        provider: nil,
        baseURL: nil,
        model: nil
    )
}

/// A constraint that limits warmup, context routing, and failover to a single
/// pinned provider/baseURL/model tuple. Used when a conversation has an active
/// model/provider override so automatic layers do not silently escape it.
struct ConversationModelConstraint: Equatable, Sendable {
    let candidate: CrossProviderModelCandidate

    init(provider: ModelProvider, baseURL: String, model: String) {
        self.candidate = CrossProviderModelCandidate(
            provider: provider,
            baseURL: baseURL,
            model: model
        )
    }
}

protocol ChatPersisterProtocol: Sendable {
    func save(messages: [ChatMessage], conversationId: UUID) async
    func load(conversationId: UUID) async -> [ChatMessage]
    func saveSettings(_ settings: ConversationSettings, conversationId: UUID) async
    func loadSettings(conversationId: UUID) async -> ConversationSettings
    func clear(conversationId: UUID) async
    func renameConversation(id: UUID, title: String) async
    func currentConversationId() async -> UUID
    func setCurrentConversationId(_ id: UUID) async
    func listAllConversations() async -> [ChatConversation]
}

protocol ChatHealthCheckProtocol: Sendable {
    func check() async -> Bool
}
