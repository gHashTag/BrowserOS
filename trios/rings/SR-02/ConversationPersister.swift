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
            // The flag records that a load ONCE failed; measure the slot now.
            // A deferred load during the launch gate marks the conversation
            // unreadable, and on 2026-08-21 the flag then outlived the gate:
            // the Queen's slot held fresh ciphertext her quarantine (July
            // bytes) could not vouch for, so every save was refused - eight
            // refusals in ninety seconds, each a dropped line, over a slot
            // that had been readable again since second five.
            //
            // If the slot decrypts today, nothing is being destroyed - but
            // the caller may have built its history on the [] that deferred
            // load returned, so writing its short history over the readable
            // slot would be the truncation this guard exists to prevent.
            // Fold the disk history in front instead, dedupe by id, and
            // write the union.
            if let stored = defaults.data(forKey: key),
               let plaintext = try? ConversationEncryption.shared.decrypt(stored),
               let onDisk = try? JSONDecoder().decode([ChatMessage].self, from: plaintext) {
                unreadableConversations.remove(conversationId)
                let diskIds = Set(onDisk.map(\.id))
                let merged = onDisk + messages.filter { !diskIds.contains($0.id) }
                TriosLogBus.shared.info(
                    .chat,
                    "conversation.persist.rejoined",
                    "Conversation \(conversationId) is readable again; \(onDisk.count) "
                        + "stored message(s) folded in front of the "
                        + "\(merged.count - onDisk.count) new one(s) this save carried",
                    ["conversation": conversationId.uuidString]
                )
                do {
                    let encoder = JSONEncoder()
                    encoder.outputFormatting = .prettyPrinted
                    let data = try encoder.encode(merged)
                    let ciphertext = try ConversationEncryption.shared.encrypt(data)
                    defaults.set(ciphertext, forKey: key)
                } catch {
                    NSLog("[ConversationPersister] Failed to persist rejoined conversation \(conversationId): \(error)")
                }
                return
            }
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
            // So the write asks the only question that matters: are the
            // bytes actually somewhere else? Byte-for-byte against what is in
            // the slot right now, because "a quarantine key exists" is a weaker
            // claim than "this is the thing it holds".
            if quarantineHolds(conversationId) {
                unreadableConversations.remove(conversationId)
                TriosLogBus.shared.info(
                    .chat,
                    "conversation.persist.reclaimed",
                    "Conversation \(conversationId) was unreadable; its bytes are preserved "
                        + "under the quarantine key, so the conversation can be written again",
                    ["conversation": conversationId.uuidString]
                )
            } else if let stored = defaults.data(forKey: key), !stored.isEmpty {
                // Unpreserved bytes used to make this path REFUSE, and a
                // refusal during a key outage is a dropped line: eight in
                // ninety seconds on 2026-08-21, and a measured outage earlier
                // that day ran sixteen minutes. Preserve first, then write -
                // the primary quarantine key is taken (that is how we got
                // here), so the bytes go to the first free spare slot and
                // recovery folds them back when they decrypt again.
                if let spare = spareQuarantineKey(for: conversationId) {
                    defaults.set(stored, forKey: spare)
                    unreadableConversations.remove(conversationId)
                    TriosLogBus.shared.warn(
                        .chat,
                        "conversation.persist.preserved_then_written",
                        "Conversation \(conversationId): its \(stored.count) unreadable "
                            + "bytes are copied to a spare quarantine slot, so this "
                            + "save proceeds instead of dropping the line",
                        ["conversation": conversationId.uuidString, "bytes": String(stored.count)]
                    )
                } else {
                    // Nine slots of preserved history and a tenth arriving:
                    // this is no longer an outage, it is a loop, and the only
                    // safe answer left is the old refusal.
                    TriosLogBus.shared.warn(
                        .chat,
                        "conversation.persist.write_refused",
                        "Refused to write over conversation \(conversationId): its stored "
                            + "bytes cannot be decrypted and every spare quarantine slot "
                            + "already holds an earlier generation",
                        ["conversation": conversationId.uuidString]
                    )
                    return
                }
            } else {
                // An empty slot has nothing to destroy.
                unreadableConversations.remove(conversationId)
            }
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
                // The message carries the thrown reason, not the word
                // "Encryption": all nine fallbacks measured on 2026-08-21
                // were key reads refused during launch or a cool-down, and
                // "Encryption failed" sent the reader to the cipher.
                TriosLogBus.shared.warn(
                    .chat,
                    "conversation.persist.encrypt_fallback",
                    "Could not encrypt conversation \(conversationId) "
                        + "(\(error.localizedDescription)); stored as plaintext fallback",
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
        // A quarantined blob that decrypts TODAY is history someone is
        // waiting for; fold it back in before reading the slot.
        recoverQuarantineIfPossible(conversationId)

        let key = keyPrefix + conversationId.uuidString
        guard let stored = defaults.data(forKey: key) else { return [] }

        // A marked plaintext record is decided by its marker, not by a
        // failed decrypt: checking it first keeps a key outage from turning
        // "this slot is a known fallback" into "this slot cannot be read".
        if stored.starts(with: Data(plaintextMarker.utf8)) {
            let payload = stored.dropFirst(plaintextMarker.utf8.count)
            if let messages = try? JSONDecoder().decode([ChatMessage].self, from: payload) {
                // A fallback slot nobody writes again rests unencrypted
                // forever - measured 2026-08-21: twelve conversations,
                // forty-three list passes each, zero re-encryptions. Heal on
                // read when the key answers now.
                if let ciphertext = try? ConversationEncryption.shared.encrypt(Data(payload)) {
                    defaults.set(ciphertext, forKey: key)
                    TriosLogBus.shared.info(
                        .chat,
                        "conversation.persist.reencrypted",
                        "Conversation \(conversationId) was resting as a plaintext "
                            + "fallback; the key answers again, so it is encrypted once more",
                        ["conversation": conversationId.uuidString]
                    )
                } else {
                    TriosLogBus.shared.warn(
                        .chat,
                        "conversation.persist.read_plaintext",
                        "Loaded conversation \(conversationId) from unencrypted fallback"
                    )
                }
                return messages
            }
        }

        // The normal path when the key is available.
        do {
            let plaintext = try ConversationEncryption.shared.decrypt(stored)
            // A successful read IS the measurement that the slot is readable:
            // clear the unreadable flag here, where the condition is proven,
            // not only in save. The flag latching past the launch gate is how
            // eight Queen saves were refused over a readable slot.
            unreadableConversations.remove(conversationId)
            return (try? JSONDecoder().decode([ChatMessage].self, from: plaintext)) ?? []
        } catch TriOSEncryptionError.keyUnavailableLocked {
            // The key was refused THIS MINUTE; nothing was measured about the
            // ciphertext. Preserve the bytes (quarantine below is written
            // once) and say what actually happened - "could not decrypt"
            // here used to read as data damage and it never was.
            let quarantine = unreadableKey(for: conversationId)
            if defaults.data(forKey: quarantine) == nil {
                defaults.set(stored, forKey: quarantine)
            }
            unreadableConversations.insert(conversationId)
            TriosLogBus.shared.warn(
                .chat,
                "conversation.persist.decrypt_deferred",
                "Conversation \(conversationId) is unread because the encryption key "
                    + "is unavailable right now; its \(stored.count) bytes are preserved "
                    + "and will fold back in when the key answers",
                ["conversation": conversationId.uuidString, "bytes": String(stored.count)]
            )
            return []
        } catch {
            // Fall through to the unreadable path below with the measured
            // fact: the key answered and this ciphertext did not open.
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
            "Conversation \(conversationId): the key answered but this ciphertext "
                + "did not open (wrong key or tampered bytes) - distinct from a key "
                + "that is merely unavailable, which logs decrypt_deferred instead"
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

    /// Where a quarantined blob moves after it has been folded back in. The
    /// bytes are kept - recovery must never be the second way to lose them -
    /// but under a key `recoverQuarantineIfPossible` does not read, so a
    /// recovery cannot run twice and re-prepend old history.
    private func recoveredKey(for id: UUID) -> String {
        "trios.conversation.recovered." + id.uuidString
    }

    /// The first free spare quarantine slot for a later generation of
    /// unreadable bytes. The primary key is written once; a second outage can
    /// strand a second generation, and refusing the write because the primary
    /// slot is taken is how lines got dropped. Suffixes 2-9 bound the family:
    /// ten stranded generations is a loop, not an outage.
    private func spareQuarantineKey(for id: UUID) -> String? {
        for n in 2...9 {
            let candidate = unreadableKey(for: id) + ".\(n)"
            if defaults.data(forKey: candidate) == nil {
                return candidate
            }
        }
        return nil
    }

    /// Every key a quarantined generation may sit under, oldest first.
    private func quarantineCandidateKeys(for id: UUID) -> [String] {
        [unreadableKey(for: id)] + (2...9).map { unreadableKey(for: id) + ".\($0)" }
    }

    /// Folds a quarantined ciphertext back into its conversation when both
    /// sides are readable right now.
    ///
    /// The quarantine copy is written once, when a slot cannot be decrypted,
    /// and until 2026-08-21 nothing ever read it back: a recovered key had
    /// "something to decrypt" and no path that decrypts it. Measured that
    /// day: the Queen's chat was reclaimed and restarted from [] while her
    /// prior transcript sat byte-preserved under the quarantine key - a
    /// transient key refusal had quarantined healthy ciphertext.
    ///
    /// The merge only runs when the quarantined bytes decrypt AND the current
    /// slot is empty, decrypts, or is a marked plaintext fallback. A current
    /// slot that is unreadable and different from the quarantine is left
    /// alone: nothing has preserved it, so nothing may write over it.
    private func recoverQuarantineIfPossible(_ id: UUID) {
        // Every generation that decrypts today, oldest slot first. A save
        // during a key outage may have stranded more than one blob (the
        // primary plus spares), and folding back only the first would leave
        // the rest warehoused forever.
        var decryptable: [(key: String, bytes: Data, messages: [ChatMessage])] = []
        for qKey in quarantineCandidateKeys(for: id) {
            guard let preserved = defaults.data(forKey: qKey), !preserved.isEmpty,
                  let plaintext = try? ConversationEncryption.shared.decrypt(preserved),
                  let msgs = try? JSONDecoder().decode([ChatMessage].self, from: plaintext),
                  !msgs.isEmpty
            else { continue }
            decryptable.append((qKey, preserved, msgs))
        }
        guard !decryptable.isEmpty else { return }

        var current: [ChatMessage] = []
        if let stored = defaults.data(forKey: keyPrefix + id.uuidString),
           !decryptable.contains(where: { $0.bytes == stored }) {
            if stored.starts(with: Data(plaintextMarker.utf8)),
               let msgs = try? JSONDecoder().decode(
                   [ChatMessage].self,
                   from: stored.dropFirst(plaintextMarker.utf8.count)
               ) {
                current = msgs
            } else if let p = try? ConversationEncryption.shared.decrypt(stored),
                      let msgs = try? JSONDecoder().decode([ChatMessage].self, from: p) {
                current = msgs
            } else {
                return
            }
        }

        var merged: [ChatMessage] = []
        var seen: Set<UUID> = []
        for entry in decryptable {
            for message in entry.messages where !seen.contains(message.id) {
                seen.insert(message.id)
                merged.append(message)
            }
        }
        let recoveredCount = merged.count
        for message in current where !seen.contains(message.id) {
            seen.insert(message.id)
            merged.append(message)
        }
        guard let encoded = try? JSONEncoder().encode(merged),
              let ciphertext = try? ConversationEncryption.shared.encrypt(encoded)
        else { return }
        defaults.set(ciphertext, forKey: keyPrefix + id.uuidString)
        for entry in decryptable {
            let suffix = String(entry.key.dropFirst(unreadableKey(for: id).count))
            defaults.set(entry.bytes, forKey: recoveredKey(for: id) + suffix)
            defaults.removeObject(forKey: entry.key)
        }
        unreadableConversations.remove(id)
        TriosLogBus.shared.info(
            .chat,
            "conversation.persist.recovered",
            "Conversation \(id): \(recoveredCount) message(s) from "
                + "\(decryptable.count) quarantined generation(s) decrypted again and "
                + "were folded in front of \(current.count) current one(s); the "
                + "original blobs are kept under the recovered keys",
            [
                "conversation": id.uuidString,
                "recovered": String(recoveredCount),
                "generations": String(decryptable.count),
                "current": String(current.count),
            ]
        )
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
