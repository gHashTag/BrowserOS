// AGENT-V-WAIVER: https://github.com/browseros-ai/BrowserOS/issues/2023
// Reason: Queen direct-chat hardening — encrypt the current conversation id in
// UserDefaults and migrate any legacy plaintext value.
import Foundation

actor ConversationPersister: ChatPersisterProtocol {
    private let defaults: UserDefaults
    private let keyPrefix = "trios.conversation."
    private let titleKeyPrefix = "trios.conversationTitle."
    private let settingsKeyPrefix = "trios.conversationSettings."
    /// Prefix prepended to unencrypted fallback payloads so load can tell
    /// them apart from ciphertext.
    private let plaintextMarker = "TRIOS-PLAIN:"
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
        // A conversation whose ciphertext could not be read is not a blank
        // page to write on. `load` returned `[]` for it, so anything that
        // appends here would save a short new history over a long unreadable
        // one - turning "we cannot read this today" into "this is gone".
        if unreadableConversations.contains(conversationId) {
            // The guard protects the BYTES, and it had been reading as though
            // it protected the SLOT. Once `load` has copied the ciphertext
            // aside under a key nothing else writes, the original survives a
            // rewrite, and refusing anyway does not preserve anything - it
            // bricks the conversation for the life of the install.
            //
            // Measured, not reasoned: the reserved Queen conversation
            // E621E1F8-C36C-495A-93FC-0C247A3E6E5F is one of the sixteen. She
            // has therefore been unable to write a single line of her own
            // transcript since 27 July - 92 refusals in one five-hour window,
            // each one a delegation note or a review verdict dropped in
            // silence while the tick reported success. Her chat is empty in the
            // UI for the same reason, and both looked like she had nothing to
            // say.
            //
            // So the refusal now asks the only question that matters: are the
            // bytes actually somewhere else? Byte-for-byte against what is in
            // the slot right now, because "a quarantine key exists" is a weaker
            // claim than "this is the thing it holds".
            guard quarantineHolds(conversationId) else {
                TriosLogBus.shared.warn(
                    .chat,
                    "conversation.persist.write_refused",
                    "Refused to write over conversation \(conversationId): its stored bytes "
                        + "cannot be decrypted and are not safely copied aside, so "
                        + "overwriting them would destroy them",
                    ["conversation": conversationId.uuidString]
                )
                return
            }
            unreadableConversations.remove(conversationId)
            TriosLogBus.shared.info(
                .chat,
                "conversation.persist.reclaimed",
                "Conversation \(conversationId) was unreadable; its bytes are preserved "
                    + "under the quarantine key, so the conversation can be written again",
                ["conversation": conversationId.uuidString]
            )
        }
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let plaintext = try encoder.encode(messages)
            let ciphertext = try ConversationEncryption.shared.encrypt(plaintext)
            defaults.set(ciphertext, forKey: key)
        } catch {
            NSLog("[ConversationPersister] Failed to encrypt conversation \(conversationId): \(error)")
            // Storing nothing silently loses the conversation. Instead, persist
            // the JSON unencrypted with a marker so load can read it back and
            // distinguish it from ciphertext.
            if let plaintext = try? JSONEncoder().encode(messages) {
                let marked = Data(plaintextMarker.utf8) + plaintext
                defaults.set(marked, forKey: key)
                TriosLogBus.shared.warn(
                    .chat,
                    "conversation.persist.encrypt_fallback",
                    "Encryption failed; stored conversation \(conversationId) as plaintext fallback",
                    ["error": error.localizedDescription]
                )
            } else {
                TriosLogBus.shared.error(
                    .chat,
                    "conversation.persist.encode_failed",
                    "Could not encode conversation \(conversationId) for plaintext fallback"
                )
            }
        }
    }

    func load(conversationId: UUID) async -> [ChatMessage] {
        let key = keyPrefix + conversationId.uuidString
        guard let stored = defaults.data(forKey: key) else { return [] }

        // Try decryption first — the normal path when the key is available.
        if let plaintext = try? ConversationEncryption.shared.decrypt(stored) {
            return (try? JSONDecoder().decode([ChatMessage].self, from: plaintext)) ?? []
        }

        // Decryption failed: check whether this is a marked plaintext record
        // written by the fallback path in save.
        if stored.starts(with: Data(plaintextMarker.utf8)) {
            let payload = stored.dropFirst(plaintextMarker.utf8.count)
            if let messages = try? JSONDecoder().decode([ChatMessage].self, from: payload) {
                TriosLogBus.shared.warn(
                    .chat,
                    "conversation.persist.read_plaintext",
                    "Loaded conversation \(conversationId) from unencrypted fallback"
                )
                return messages
            }
        }

        // Unreadable is not empty, and until now the caller could not tell.
        //
        // Sixteen conversations in the release store cannot be decrypted: the
        // key was created on 25 July and overwritten on 27 July, so everything
        // written between those dates is ciphertext nobody holds the key to.
        // Both paths that could overwrite a key have since been closed, so this
        // set will not grow - but it is 23KB to 507KB of real ciphertext, and
        // returning `[]` for it meant the app showed sixteen empty
        // conversations and would cheerfully save new messages over them. That
        // is the difference between data that is currently unreadable and data
        // that is destroyed.
        //
        // The blob is copied aside once, under a key nothing else writes, so a
        // recovered key later still has something to decrypt.
        let quarantine = unreadableKey(for: conversationId)
        if defaults.data(forKey: quarantine) == nil {
            defaults.set(stored, forKey: quarantine)
            TriosLogBus.shared.warn(
                .chat,
                "conversation.persist.quarantined",
                "Conversation \(conversationId) cannot be decrypted; its \(stored.count) bytes "
                    + "are preserved and it will not be written over",
                ["conversation": conversationId.uuidString, "bytes": String(stored.count)]
            )
        }
        unreadableConversations.insert(conversationId)
        TriosLogBus.shared.warn(
            .chat,
            "conversation.persist.decrypt_failed",
            "Could not decrypt or decode conversation \(conversationId)"
        )
        return []
    }

    /// Conversations this process has found unreadable.
    ///
    /// In memory: the quarantine copy on disk is the durable record, and this
    /// is only here so `save` can refuse without re-reading.
    private var unreadableConversations: Set<UUID> = []

    private func unreadableKey(for id: UUID) -> String {
        "trios.conversation.unreadable." + id.uuidString
    }

    /// True when the bytes currently in the conversation's slot are already
    /// held, byte for byte, under its quarantine key.
    ///
    /// Deliberately not "a quarantine copy exists": the copy is written once
    /// and never updated, so a slot that has since changed is a slot whose
    /// present contents nobody has preserved. Compare what would actually be
    /// lost, not what was lost the first time.
    private func quarantineHolds(_ id: UUID) -> Bool {
        guard let preserved = defaults.data(forKey: unreadableKey(for: id)),
              !preserved.isEmpty else { return false }
        guard let stored = defaults.data(forKey: keyPrefix + id.uuidString) else {
            // An empty slot has nothing to destroy.
            return true
        }
        return preserved == stored
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
