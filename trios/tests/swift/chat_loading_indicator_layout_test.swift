import Foundation

@main
struct ChatLoadingIndicatorLayoutTest {
    static func main() {
        expect(ChatLoadingIndicatorLayout.alignment == .center, "indicator is centered")
        expect(ChatLoadingIndicatorLayout.groupsLabelWithDots, "label stays with dots")
        expect(ChatLoadingIndicatorLayout.placement == .messageFlow, "indicator remains in flow")
        expect(ChatLoadingIndicatorLayout.foregroundTone == .white, "indicator foreground is white")
        expect(ChatLoadingIndicatorLayout.visualStyle == .signalPulse, "indicator uses signal pulse style")
        expect(ChatLoadingIndicatorLayout.nodeScale == 1.2, "nodes grow by exactly 20 percent")
        expect(
            abs(ChatLoadingIndicatorLayout.nodeDiameter - 7.2) < 0.000_001,
            "node diameter grows from 6 to 7.2 points"
        )
        expect(ChatLoadingIndicatorLayout.rendersInChatStream, "chat stream owns loading feedback")
        expect(!ChatLoadingIndicatorLayout.rendersInsideAssistantBubble, "assistant bubble has no loader")
        expect(
            !ChatLoadingIndicatorLayout.shouldRenderAssistantBubble(
                isStreaming: true,
                timelineItemCount: 0
            ),
            "empty streaming assistant bubble is hidden"
        )
        expect(
            ChatLoadingIndicatorLayout.shouldRenderAssistantBubble(
                isStreaming: true,
                timelineItemCount: 1
            ),
            "streaming assistant content is visible"
        )
        expect(
            ChatLoadingIndicatorLayout.shouldRenderAssistantBubble(
                isStreaming: false,
                timelineItemCount: 0
            ),
            "completed assistant bubble remains visible"
        )
        print("All ChatLoadingIndicatorLayout tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
