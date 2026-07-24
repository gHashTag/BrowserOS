import Foundation

actor ConversationPersister: ChatPersisterProtocol {
    private let defaults: UserDefaults
    private let keyPrefix = "trios.conversation."
    private let titleKeyPrefix = "trios.conversationTitle."
    private let currentIdKey = "trios.currentConversationId"

    init(suiteName: String? = nil) {
        if let suiteName, let suiteDefaults = UserDefaults(suiteName: suiteName) {
            defaults = suiteDefaults
        } else {
            defaults = .standard
        }
    }

    func save(messages: [ChatMessage], conversationId: UUID) async {
        let key = keyPrefix + conversationId.uuidString
        if let data = try? JSONEncoder().encode(messages) {
            defaults.set(data, forKey: key)
        }
    }

    func load(conversationId: UUID) async -> [ChatMessage] {
        let key = keyPrefix + conversationId.uuidString
        guard let data = defaults.data(forKey: key),
              let messages = try? JSONDecoder().decode([ChatMessage].self, from: data) else {
            return []
        }
        return messages
    }

    func clear(conversationId: UUID) async {
        let key = keyPrefix + conversationId.uuidString
        defaults.removeObject(forKey: key)
        defaults.removeObject(forKey: titleKey(for: conversationId))
    }

    func renameConversation(id: UUID, title: String) async {
        defaults.set(
            ConversationTitlePolicy.normalized(title),
            forKey: titleKey(for: id)
        )
    }

    func currentConversationId() async -> UUID {
        guard let str = defaults.string(forKey: currentIdKey),
              let id = UUID(uuidString: str) else {
            let newId = UUID()
            defaults.set(newId.uuidString, forKey: currentIdKey)
            return newId
        }
        return id
    }

    func setCurrentConversationId(_ id: UUID) async {
        defaults.set(id.uuidString, forKey: currentIdKey)
    }

    func listAllConversations() async -> [ChatConversation] {
        var result: [ChatConversation] = []
        for key in defaults.dictionaryRepresentation().keys {
            guard key.hasPrefix(keyPrefix) else { continue }
            let idStr = String(key.dropFirst(keyPrefix.count))
            guard let id = UUID(uuidString: idStr) else { continue }
            let messages = await load(conversationId: id)
            let generatedTitle = messages.first(where: { $0.role == .user })?
                .content
                .prefix(40)
                .trimmingCharacters(in: .whitespacesAndNewlines)
                ?? "Empty chat"
            let title = defaults.string(forKey: titleKey(for: id))
                ?? String(generatedTitle)
            let updated = messages.last?.timestamp ?? Date()
            result.append(ChatConversation(id: id, title: title, updatedAt: updated))
        }
        return result.sorted { $0.updatedAt > $1.updatedAt }
    }

    private func titleKey(for id: UUID) -> String {
        titleKeyPrefix + id.uuidString
    }
}
