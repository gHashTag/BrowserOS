// AGENT-V-WAIVER: https://github.com/browseros-ai/BrowserOS/issues/2023
// Reason: Queen direct-chat hardening — encrypt the current conversation id in
// UserDefaults and migrate any legacy plaintext value.
import Foundation

actor ConversationPersister: ChatPersisterProtocol {
    private let defaults: UserDefaults
    private let keyPrefix = "trios.conversation."
    private let titleKeyPrefix = "trios.conversationTitle."
    private let settingsKeyPrefix = "trios.conversationSettings."
    private let currentIdKey = "trios.currentConversationId.encrypted"
    private let legacyCurrentIdKey = "trios.currentConversationId"

    init(suiteName: String? = nil) {
        if let suiteName, let suiteDefaults = UserDefaults(suiteName: suiteName) {
            defaults = suiteDefaults
        } else {
            defaults = .standard
        }
    }

    func save(messages: [ChatMessage], conversationId: UUID) async {
        let key = keyPrefix + conversationId.uuidString
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let plaintext = try encoder.encode(messages)
            let ciphertext = try ConversationEncryption.shared.encrypt(plaintext)
            defaults.set(ciphertext, forKey: key)
        } catch {
            NSLog("[ConversationPersister] Failed to encrypt conversation \(conversationId): \(error)")
        }
    }

    func load(conversationId: UUID) async -> [ChatMessage] {
        let key = keyPrefix + conversationId.uuidString
        guard let ciphertext = defaults.data(forKey: key) else { return [] }
        do {
            let plaintext = try ConversationEncryption.shared.decrypt(ciphertext)
            let messages = try JSONDecoder().decode([ChatMessage].self, from: plaintext)
            return messages
        } catch {
            NSLog("[ConversationPersister] Failed to decrypt conversation \(conversationId): \(error)")
            return []
        }
    }

    func saveSettings(_ settings: ConversationSettings, conversationId: UUID) async {
        let key = settingsKey(for: conversationId)
        do {
            let plaintext = try JSONEncoder().encode(settings)
            let ciphertext = try ConversationEncryption.shared.encrypt(plaintext)
            defaults.set(ciphertext, forKey: key)
        } catch {
            NSLog("[ConversationPersister] Failed to encrypt settings for \(conversationId): \(error)")
        }
    }

    func loadSettings(conversationId: UUID) async -> ConversationSettings {
        let key = settingsKey(for: conversationId)
        guard let ciphertext = defaults.data(forKey: key) else { return .default }
        do {
            let plaintext = try ConversationEncryption.shared.decrypt(ciphertext)
            return try JSONDecoder().decode(ConversationSettings.self, from: plaintext)
        } catch {
            NSLog("[ConversationPersister] Failed to decrypt settings for \(conversationId): \(error)")
            return .default
        }
    }

    func clear(conversationId: UUID) async {
        guard conversationId != ChatConversation.trinityQueenId else {
            NSLog("[ConversationPersister] clear ignored for reserved Trinity Queen conversation")
            return
        }
        let key = keyPrefix + conversationId.uuidString
        defaults.removeObject(forKey: key)
        defaults.removeObject(forKey: titleKey(for: conversationId))
        defaults.removeObject(forKey: settingsKey(for: conversationId))
    }

    func renameConversation(id: UUID, title: String) async {
        let normalized = ConversationTitlePolicy.normalized(title)
        do {
            let plaintext = Data(normalized.utf8)
            let ciphertext = try ConversationEncryption.shared.encrypt(plaintext)
            defaults.set(ciphertext, forKey: titleKey(for: id))
        } catch {
            NSLog("[ConversationPersister] Failed to encrypt title for \(id): \(error)")
        }
    }

    private func loadTitle(for id: UUID) -> String? {
        guard let ciphertext = defaults.data(forKey: titleKey(for: id)) else { return nil }
        do {
            let plaintext = try ConversationEncryption.shared.decrypt(ciphertext)
            return String(data: plaintext, encoding: .utf8)
        } catch {
            return nil
        }
    }

    func currentConversationId() async -> UUID {
        // Prefer the encrypted current-conversation key.
        if let ciphertext = defaults.data(forKey: currentIdKey) {
            do {
                let plaintext = try ConversationEncryption.shared.decrypt(ciphertext)
                guard let str = String(data: plaintext, encoding: .utf8),
                      let id = UUID(uuidString: str) else {
                    throw ConversationEncryptionError.openFailure
                }
                return id
            } catch {
                NSLog("[ConversationPersister] Failed to decrypt current conversation id: \(error)")
            }
        }

        // Migration: if the legacy plaintext key exists, encrypt and remove it.
        if let str = defaults.string(forKey: legacyCurrentIdKey),
           let id = UUID(uuidString: str) {
            do {
                let plaintext = Data(id.uuidString.utf8)
                let ciphertext = try ConversationEncryption.shared.encrypt(plaintext)
                defaults.set(ciphertext, forKey: currentIdKey)
                defaults.removeObject(forKey: legacyCurrentIdKey)
                return id
            } catch {
                NSLog("[ConversationPersister] Failed to migrate plaintext current conversation id: \(error)")
            }
        }

        let newId = UUID()
        await setCurrentConversationId(newId)
        return newId
    }

    func setCurrentConversationId(_ id: UUID) async {
        do {
            let plaintext = Data(id.uuidString.utf8)
            let ciphertext = try ConversationEncryption.shared.encrypt(plaintext)
            defaults.set(ciphertext, forKey: currentIdKey)
            defaults.removeObject(forKey: legacyCurrentIdKey)
        } catch {
            NSLog("[ConversationPersister] Failed to encrypt current conversation id: \(error). Falling back to plaintext.")
            defaults.set(id.uuidString, forKey: legacyCurrentIdKey)
        }
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
            let title = loadTitle(for: id) ?? String(generatedTitle)
            let updated = messages.last?.timestamp ?? Date()
            let isReserved = id == ChatConversation.trinityQueenId
            result.append(
                ChatConversation(
                    id: id,
                    title: title,
                    isPinned: isReserved,
                    icon: isReserved ? "crown.fill" : "message.fill",
                    updatedAt: updated,
                    unreadCount: 0,
                    isReserved: isReserved
                )
            )
        }
        return result.sorted { $0.updatedAt > $1.updatedAt }
    }

    private func titleKey(for id: UUID) -> String {
        titleKeyPrefix + id.uuidString
    }

    private func settingsKey(for id: UUID) -> String {
        settingsKeyPrefix + id.uuidString
    }
}
