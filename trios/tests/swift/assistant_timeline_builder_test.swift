import Foundation

@main
struct AssistantTimelineBuilderTest {
    static func main() {
        let tools = [
            ToolCall(id: "read", name: "filesystem_read", arguments: "{}", output: "ok", isComplete: true),
            ToolCall(id: "edit", name: "filesystem_edit", arguments: "{}", output: "ok", isComplete: true)
        ]

        let streamed = AssistantTimelineBuilder.build(
            content: "I will inspect.Done.",
            segments: [.text("I will inspect."), .toolCall(id: "read"), .toolCall(id: "edit"), .text("Done.")],
            toolCalls: tools
        )
        expect(streamed == [.text("I will inspect."), .toolCall(id: "read"), .toolCall(id: "edit"), .text("Done.")], "stream order")

        let legacy = AssistantTimelineBuilder.build(
            content: "Final answer",
            segments: [.reasoning("Checked files")],
            toolCalls: tools
        )
        expect(legacy == [.reasoning("Checked files"), .toolCall(id: "read"), .toolCall(id: "edit"), .text("Final answer")], "legacy tools before answer")

        let noDuplicates = streamed.filter {
            if case .toolCall = $0 { return true }
            return false
        }
        expect(noDuplicates.count == 2, "tool cards are unique")

        let encoded = try! JSONEncoder().encode(MessageSegment.toolCall(id: "read"))
        let decoded = try! JSONDecoder().decode(MessageSegment.self, from: encoded)
        expect(decoded == .toolCall(id: "read"), "tool reference codec")
        print("All AssistantTimelineBuilder tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
