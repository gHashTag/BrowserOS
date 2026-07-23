import Foundation

@main
struct TriosBrandingTest {
    static func main() {
        expect(TriosBranding.displayName == "Trinity S\u{00B3}AI", "central display name")
        expect(TriosBranding.messagePlaceholder == "Message...", "unbranded composer placeholder")
        expect(TriosBranding.localTypingLabel == nil, "local typing indicator has no duplicate brand")
        expect(TriosBranding.statusProductLabel == nil, "status bar has no duplicate brand")
        expect(ChatSenderLabelPolicy.label(for: .user) == "You", "user label remains visible")
        expect(ChatSenderLabelPolicy.label(for: .assistant) == nil, "assistant label is hidden")
        expect(ChatSenderLabelPolicy.label(for: .system) == nil, "system label is hidden")

        print("All TriosBranding tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
