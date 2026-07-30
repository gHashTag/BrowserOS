import XCTest
@testable import TriOSKit

final class ConversationEncryptionTests: XCTestCase {
    private var suiteName: String { "test.ai.browseros.trios.conversation" }

    override func setUp() {
        super.setUp()
        UserDefaults().removePersistentDomain(forName: suiteName)
        // The legacy conversation encryption key lives in the app sandbox, not
        // the Keychain, so no Keychain cleanup is required.
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    // MARK: - Encryption roundtrip

    func testEncryptDecryptRoundtrip() throws {
        let plaintext = Data("hello, encrypted world".utf8)
        let encrypted = try ConversationEncryption.shared.encrypt(plaintext)
        XCTAssertNotEqual(encrypted, plaintext)
        let decrypted = try ConversationEncryption.shared.decrypt(encrypted)
        XCTAssertEqual(decrypted, plaintext)
    }

    func testSamePlaintextProducesDifferentCiphertext() throws {
        let plaintext = Data("deterministic?".utf8)
        let first = try ConversationEncryption.shared.encrypt(plaintext)
        let second = try ConversationEncryption.shared.encrypt(plaintext)
        XCTAssertNotEqual(first, second, "AES-GCM nonce should be random")
    }

    func testDecryptTamperedCiphertextFails() throws {
        let plaintext = Data("tamper me".utf8)
        var encrypted = try ConversationEncryption.shared.encrypt(plaintext)
        encrypted[encrypted.count - 1] ^= 0xFF
        XCTAssertThrowsError(try ConversationEncryption.shared.decrypt(encrypted)) { error in
            XCTAssertTrue(error is ConversationEncryptionError)
        }
    }

    // MARK: - Persister integration

    func testSaveAndLoadEncryptedMessages() async {
        let persister = ConversationPersister(suiteName: suiteName)
        let id = UUID()
        let messages = [
            ChatMessage(role: .user, content: "secret message", timestamp: Date(timeIntervalSince1970: 1_000_000))
        ]
        await persister.save(messages: messages, conversationId: id)
        let loaded = await persister.load(conversationId: id)
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.content, "secret message")
    }

    func testEncryptedTitleRoundtrip() async {
        let persister = ConversationPersister(suiteName: suiteName)
        let id = UUID()
        await persister.renameConversation(id: id, title: "Top Secret Project")
        let conversations = await persister.listAllConversations()
        XCTAssertTrue(conversations.contains { $0.id == id && $0.title == "Top Secret Project" })
    }

    func testRawUserDefaultsDataIsNotPlaintext() async {
        let persister = ConversationPersister(suiteName: suiteName)
        let id = UUID()
        await persister.save(messages: [
            ChatMessage(role: .user, content: "plain secret", timestamp: Date())
        ], conversationId: id)

        let key = "trios.conversation." + id.uuidString
        guard let stored = UserDefaults(suiteName: suiteName)?.data(forKey: key) else {
            XCTFail("No stored data")
            return
        }
        let asString = String(data: stored, encoding: .utf8)
        XCTAssertNil(asString, "Encrypted blob should not be valid UTF-8 plaintext JSON")
        XCTAssertFalse(stored.contains(Data("plain secret".utf8)), "Plaintext should not appear in stored data")
    }

    // MARK: - Conversation settings persistence

    func testConversationSettingsRoundtrip() async {
        let persister = ConversationPersister(suiteName: suiteName)
        let id = UUID()
        var settings = ConversationSettings()
        settings.requestedOutputTokens = 4096
        settings.contextWindowMargin = 0.75

        await persister.saveSettings(settings, conversationId: id)
        let loaded = await persister.loadSettings(conversationId: id)

        XCTAssertEqual(loaded.requestedOutputTokens, 4096)
        XCTAssertEqual(loaded.contextWindowMargin, 0.75)
    }

    func testConversationSettingsModelOverrideRoundtrip() async {
        let persister = ConversationPersister(suiteName: suiteName)
        let id = UUID()
        var settings = ConversationSettings()
        settings.provider = .openrouter
        settings.baseURL = "https://openrouter.ai/api/v1"
        settings.model = "anthropic/claude-sonnet-4.5"

        await persister.saveSettings(settings, conversationId: id)
        let loaded = await persister.loadSettings(conversationId: id)

        XCTAssertEqual(loaded.provider, .openrouter)
        XCTAssertEqual(loaded.baseURL, "https://openrouter.ai/api/v1")
        XCTAssertEqual(loaded.model, "anthropic/claude-sonnet-4.5")
    }

    func testConversationSettingsDefaultWhenNoneSaved() async {
        let persister = ConversationPersister(suiteName: suiteName)
        let id = UUID()
        let loaded = await persister.loadSettings(conversationId: id)
        XCTAssertEqual(loaded, ConversationSettings())
        XCTAssertNil(loaded.requestedOutputTokens)
        XCTAssertNil(loaded.contextWindowMargin)
        XCTAssertNil(loaded.provider)
        XCTAssertNil(loaded.baseURL)
        XCTAssertNil(loaded.model)
    }

    func testConversationSettingsEncryptedInUserDefaults() async {
        let persister = ConversationPersister(suiteName: suiteName)
        let id = UUID()
        var settings = ConversationSettings()
        settings.requestedOutputTokens = 2048
        settings.provider = .anthropic
        settings.baseURL = "https://api.anthropic.com/v1"
        settings.model = "claude-opus-4-5"
        await persister.saveSettings(settings, conversationId: id)

        let key = "trios.conversation.settings." + id.uuidString
        guard let stored = UserDefaults(suiteName: suiteName)?.data(forKey: key) else {
            XCTFail("No stored settings data")
            return
        }
        let asString = String(data: stored, encoding: .utf8)
        XCTAssertNil(asString, "Encrypted settings blob should not be valid UTF-8 plaintext JSON")
        XCTAssertFalse(stored.contains(Data("2048".utf8)), "Plaintext token value should not appear in stored data")
        XCTAssertFalse(stored.contains(Data("anthropic".utf8)), "Plaintext provider should not appear in stored data")
        XCTAssertFalse(stored.contains(Data("claude-opus-4-5".utf8)), "Plaintext model should not appear in stored data")
    }

    func testConversationSettingsClearedWithConversation() async {
        let persister = ConversationPersister(suiteName: suiteName)
        let id = UUID()
        var settings = ConversationSettings()
        settings.requestedOutputTokens = 8192
        await persister.saveSettings(settings, conversationId: id)
        await persister.clear(conversationId: id)

        let loaded = await persister.loadSettings(conversationId: id)
        XCTAssertEqual(loaded, ConversationSettings())
    }
}

private extension Data {
    func contains(_ other: Data) -> Bool {
        guard other.count <= self.count else { return false }
        for start in 0...(self.count - other.count) {
            if self.subdata(in: start..<(start + other.count)) == other {
                return true
            }
        }
        return false
    }
}
