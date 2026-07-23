import Foundation

@main
struct AssistantActionBarPolicyTest {
    static func main() {
        let primary = AssistantActionBarPolicy.presentation(
            isStreaming: false,
            hasContent: true,
            isLastInGroup: true,
            isConversationIdle: true
        )
        expect(primary == .primary, "completed final response uses primary actions")
        expect(primary.copyActionCount == 1, "primary actions expose one copy command")

        let hover = AssistantActionBarPolicy.presentation(
            isStreaming: true,
            hasContent: true,
            isLastInGroup: true,
            isConversationIdle: false
        )
        expect(hover == .hoverCopy, "active response uses hover copy fallback")
        expect(hover.copyActionCount == 1, "hover fallback exposes one copy command")

        let nonFinal = AssistantActionBarPolicy.presentation(
            isStreaming: false,
            hasContent: true,
            isLastInGroup: false,
            isConversationIdle: true
        )
        expect(nonFinal == .hoverCopy, "non-final response uses hover copy fallback")

        let empty = AssistantActionBarPolicy.presentation(
            isStreaming: false,
            hasContent: false,
            isLastInGroup: true,
            isConversationIdle: true
        )
        expect(empty == .none, "empty response has no actions")
        expect(empty.copyActionCount == 0, "empty response has no copy command")

        print("All AssistantActionBarPolicy tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
