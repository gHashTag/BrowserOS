import Foundation
import XCTest
@testable import TriOSKit

@MainActor
final class ChatRequestSizerTests: XCTestCase {
    private var sizer: ChatRequestSizer!

    override func setUp() {
        sizer = ChatRequestSizer()
    }

    private func smallProfile() -> ModelContextProfile {
        ModelContextProfile(maxContextTokens: 1_024, maxOutputTokens: 256)
    }

    func testSizeFitsWhenRequestWithinWindow() async {
        let messages = [ChatMessage(role: .user, content: "hello")]
        let current = ChatMessage(role: .user, content: "world")
        let size = await sizer.size(
            messages: messages,
            currentMessage: current,
            systemPrompt: nil,
            modelProfile: smallProfile(),
            requestedOutputTokens: nil,
            margin: 0.85
        )
        XCTAssertTrue(size.fitsCurrentModel)
    }

    func testSizeOverflowsWhenRequestExceedsWindow() async {
        let messages = [ChatMessage(role: .user, content: String(repeating: "a ", count: 5_000))]
        let current = ChatMessage(role: .user, content: "ok")
        let size = await sizer.size(
            messages: messages,
            currentMessage: current,
            systemPrompt: nil,
            modelProfile: smallProfile(),
            requestedOutputTokens: nil,
            margin: 0.85
        )
        XCTAssertFalse(size.fitsCurrentModel)
    }

    func testTrimPreservesSystemPromptAndToolPairs() async {
        let system = "You are helpful."
        let assistant = ChatMessage(
            role: .assistant,
            content: "searching",
            toolCalls: [ToolCall(id: "1", name: "search", arguments: "{}", isComplete: false)]
        )
        let tool = ChatMessage(role: .tool, content: "result")
        let messages = [
            ChatMessage(role: .system, content: system),
            assistant,
            tool
        ]
        let current = ChatMessage(role: .user, content: "next")
        let policy = await sizer.trim(
            messages: messages,
            currentMessage: current,
            systemPrompt: system,
            modelProfile: smallProfile(),
            requestedOutputTokens: nil,
            margin: 0.85,
            minRetainedTurns: 2
        )
        XCTAssertTrue(policy.preservedSystemPrompt)
        XCTAssertEqual(policy.originalMessageCount, 3)
    }

    func testTrimDropsOldestTurnsFirst() async {
        let messages = [
            ChatMessage(role: .user, content: String(repeating: "a ", count: 2_000)),
            ChatMessage(role: .assistant, content: "response"),
            ChatMessage(role: .user, content: String(repeating: "b ", count: 100)),
            ChatMessage(role: .assistant, content: "response")
        ]
        let current = ChatMessage(role: .user, content: "final")
        let policy = await sizer.trim(
            messages: messages,
            currentMessage: current,
            systemPrompt: nil,
            modelProfile: smallProfile(),
            requestedOutputTokens: nil,
            margin: 0.85,
            minRetainedTurns: 2
        )
        let retained = await sizer.trimmedMessages(from: messages, policy: policy)
        XCTAssertTrue(retained.count < messages.count)
        XCTAssertFalse(retained.contains { $0.content.hasPrefix("a ") })
    }

    func testTrimCanDropBelowMinRetainedTurnsWhenNeeded() async {
        let messages = [
            ChatMessage(role: .user, content: "first"),
            ChatMessage(role: .assistant, content: "second")
        ]
        let current = ChatMessage(role: .user, content: String(repeating: "huge ", count: 500))
        let policy = await sizer.trim(
            messages: messages,
            currentMessage: current,
            systemPrompt: nil,
            modelProfile: smallProfile(),
            requestedOutputTokens: nil,
            margin: 0.85,
            minRetainedTurns: 2
        )
        XCTAssertTrue(policy.droppedMessageCount >= 0)
        XCTAssertTrue(policy.retainedMessageCount <= messages.count)
    }

    func testDefaultOutputBudgetCapsAtProfileMaxOutputTokens() {
        let profile = ModelContextProfile(maxContextTokens: 4_096, maxOutputTokens: 512)
        let size = sizer.size(
            messages: [],
            currentMessage: ChatMessage(role: .user, content: "hi"),
            systemPrompt: nil,
            modelProfile: profile,
            requestedOutputTokens: nil,
            margin: 0.85
        )
        XCTAssertEqual(size.requestedOutputTokens, 512)
        XCTAssertTrue(size.fitsCurrentModel)
    }

    func testRequestedOutputTokensClampedByProfileCeiling() {
        let profile = ModelContextProfile(maxContextTokens: 4_096, maxOutputTokens: 1_024)
        let size = sizer.size(
            messages: [],
            currentMessage: ChatMessage(role: .user, content: "hi"),
            systemPrompt: nil,
            modelProfile: profile,
            requestedOutputTokens: 8_192,
            margin: 0.85
        )
        XCTAssertEqual(size.requestedOutputTokens, 1_024)
    }

    func testRequestedOutputTokensBelowCeilingIsHonored() {
        let profile = ModelContextProfile(maxContextTokens: 4_096, maxOutputTokens: 4_096)
        let size = sizer.size(
            messages: [],
            currentMessage: ChatMessage(role: .user, content: "hi"),
            systemPrompt: nil,
            modelProfile: profile,
            requestedOutputTokens: 512,
            margin: 0.85
        )
        XCTAssertEqual(size.requestedOutputTokens, 512)
    }

    func testSizeExposesEffectiveOutputCeiling() {
        let profile = ModelContextProfile(maxContextTokens: 4_096, maxOutputTokens: 2_048)
        let size = sizer.size(
            messages: [],
            currentMessage: ChatMessage(role: .user, content: "hi"),
            systemPrompt: nil,
            modelProfile: profile,
            requestedOutputTokens: 4_096,
            margin: 0.85
        )
        XCTAssertEqual(size.effectiveOutputCeiling, 2_048)
        XCTAssertTrue(size.isOutputBudgetSaturated)
    }

    func testIsOutputBudgetSaturatedWhenRequestedReachesCeiling() {
        let profile = ModelContextProfile(maxContextTokens: 4_096, maxOutputTokens: 1_024)
        XCTAssertTrue(sizer.isOutputBudgetSaturated(requested: 1_024, profile: profile))
        XCTAssertTrue(sizer.isOutputBudgetSaturated(requested: 2_048, profile: profile))
        XCTAssertFalse(sizer.isOutputBudgetSaturated(requested: 512, profile: profile))
        XCTAssertFalse(sizer.isOutputBudgetSaturated(requested: nil, profile: profile))
    }
}
