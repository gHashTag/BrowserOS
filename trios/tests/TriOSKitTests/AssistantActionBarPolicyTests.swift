import XCTest
@testable import TriOSKit

final class AssistantActionBarPolicyTests: XCTestCase {
    func testCompletedFinalResponseUsesPrimaryActions() {
        let primary = AssistantActionBarPolicy.presentation(
            isStreaming: false,
            hasContent: true,
            isLastInGroup: true,
            isConversationIdle: true
        )
        XCTAssertEqual(primary, .primary)
        XCTAssertEqual(primary.copyActionCount, 1)
    }

    func testStreamingResponseUsesHoverCopyFallback() {
        let hover = AssistantActionBarPolicy.presentation(
            isStreaming: true,
            hasContent: true,
            isLastInGroup: true,
            isConversationIdle: false
        )
        XCTAssertEqual(hover, .hoverCopy)
        XCTAssertEqual(hover.copyActionCount, 1)
    }

    func testNonFinalResponseUsesHoverCopyFallback() {
        let nonFinal = AssistantActionBarPolicy.presentation(
            isStreaming: false,
            hasContent: true,
            isLastInGroup: false,
            isConversationIdle: true
        )
        XCTAssertEqual(nonFinal, .hoverCopy)
    }

    func testEmptyResponseHasNoActions() {
        let empty = AssistantActionBarPolicy.presentation(
            isStreaming: false,
            hasContent: false,
            isLastInGroup: true,
            isConversationIdle: true
        )
        XCTAssertEqual(empty, .none)
        XCTAssertEqual(empty.copyActionCount, 0)
    }
}
