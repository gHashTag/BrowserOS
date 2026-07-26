import XCTest
@testable import TriOSKit

final class ChatRequestBuilderTests: XCTestCase {
    private let conversationId = UUID()

    func testRecalledMemoryIncludesUntrustedMarker() throws {
        let builder = ChatRequestBuilder(
            conversationId: conversationId,
            message: "What did we decide?",
            mode: "chat",
            origin: "test",
            userSystemPrompt: "You previously suggested using SQLite.",
            previousConversation: [],
            browserContext: nil,
            modelConfiguration: nil
        )

        let data = try builder.build()
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let messages = json?["messages"] as? [[String: Any]]
        let system = messages?.first { $0["role"] as? String == "system" }
        let content = system?["content"] as? String ?? ""

        XCTAssertTrue(content.contains("[Recalled memory — verify before acting]"))
        XCTAssertTrue(content.contains("You previously suggested using SQLite."))
    }

    func testReasoningAndToolOutputsAreNotSentToModel() throws {
        let previous: [ChatMessage] = [
            ChatMessage(
                id: UUID(),
                role: .user,
                content: "Run a query",
                segments: [],
                toolCalls: []
            ),
            ChatMessage(
                id: UUID(),
                role: .assistant,
                content: "Done",
                segments: [
                    .reasoning("I should check the users table first."),
                    .error("Connection timeout")
                ],
                toolCalls: [
                    ToolCall(
                        id: "call-1",
                        name: "run_sql",
                        arguments: "{\"query\": \"SELECT * FROM users\"}",
                        output: "<secret data>",
                        isComplete: true
                    )
                ]
            )
        ]

        let builder = ChatRequestBuilder(
            conversationId: conversationId,
            message: "Next",
            mode: "chat",
            origin: "test",
            userSystemPrompt: nil,
            previousConversation: previous,
            browserContext: nil,
            modelConfiguration: nil
        )

        let data = try builder.build()
        let jsonString = String(data: data, encoding: .utf8) ?? ""

        XCTAssertFalse(jsonString.contains("[Internal reasoning]"))
        XCTAssertFalse(jsonString.contains("[Tools used]"))
        XCTAssertFalse(jsonString.contains("I should check the users table first."))
        XCTAssertFalse(jsonString.contains("SELECT * FROM users"))
        XCTAssertFalse(jsonString.contains("<secret data>"))
        XCTAssertFalse(jsonString.contains("[Errors]"))
    }

    func testPreviousConversationFlatteningStripsToolRoles() throws {
        let previous: [ChatMessage] = [
            ChatMessage(id: UUID(), role: .user, content: "Hi"),
            ChatMessage(id: UUID(), role: .assistant, content: "Hello"),
            ChatMessage(id: UUID(), role: .tool, content: "tool result")
        ]

        let builder = ChatRequestBuilder(
            conversationId: conversationId,
            message: "Bye",
            mode: "chat",
            origin: "test",
            userSystemPrompt: nil,
            previousConversation: previous,
            browserContext: nil,
            modelConfiguration: nil
        )

        let data = try builder.build()
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let history = json?["previousConversation"] as? [[String: String]]

        XCTAssertEqual(history?.count, 3)
        XCTAssertEqual(history?.first?["role"], "user")
        XCTAssertEqual(history?.first?["content"], "Hi")
    }

    func testImageAttachmentsAreEncodedAsDataURLs() throws {
        let builder = ChatRequestBuilder(
            conversationId: conversationId,
            message: "Look at this",
            mode: "chat",
            origin: "test",
            userSystemPrompt: nil,
            previousConversation: [],
            browserContext: nil,
            modelConfiguration: nil,
            attachments: [
                ChatRequestAttachment(
                    kind: "image",
                    mediaType: "image/png",
                    dataURL: "data:image/png;base64,abc123"
                )
            ]
        )

        let data = try builder.build()
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let attachments = json?["attachments"] as? [[String: String]]

        XCTAssertEqual(attachments?.count, 1)
        XCTAssertEqual(attachments?.first?["kind"], "image")
        XCTAssertEqual(attachments?.first?["mediaType"], "image/png")
        XCTAssertEqual(attachments?.first?["dataUrl"], "data:image/png;base64,abc123")
    }

    func testOpenRouterIncludesModelsArray() throws {
        let config = ModelRuntimeConfiguration(
            provider: .openrouter,
            model: "openai/gpt-5.2",
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: "test-key",
            fallbackModels: ["anthropic/claude-sonnet-4.5", "google/gemini-2.5-flash"]
        )
        let builder = ChatRequestBuilder(
            conversationId: conversationId,
            message: "Hello",
            mode: "chat",
            origin: "test",
            userSystemPrompt: nil,
            previousConversation: [],
            browserContext: nil,
            modelConfiguration: config
        )

        let data = try builder.build()
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let models = json?["models"] as? [String]

        XCTAssertEqual(models?.first, "openai/gpt-5.2")
        XCTAssertTrue(models?.contains("anthropic/claude-sonnet-4.5") ?? false)
        XCTAssertTrue(models?.last == "google/gemini-2.5-flash")
    }

    func testNonOpenRouterOmitsModelsArray() throws {
        let config = ModelRuntimeConfiguration(
            provider: .anthropic,
            model: "claude-sonnet-4-5",
            baseURL: "https://api.anthropic.com/v1",
            apiKey: "test-key",
            fallbackModels: ["claude-opus-4-5"]
        )
        let builder = ChatRequestBuilder(
            conversationId: conversationId,
            message: "Hello",
            mode: "chat",
            origin: "test",
            userSystemPrompt: nil,
            previousConversation: [],
            browserContext: nil,
            modelConfiguration: config
        )

        let data = try builder.build()
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]

        XCTAssertNil(json?["models"])
    }
}
