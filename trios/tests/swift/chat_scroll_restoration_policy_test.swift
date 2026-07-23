import Foundation

@main
struct ChatScrollRestorationPolicyTest {
    static func main() {
        expect(ChatScrollRestorationPolicy.shouldRequestBottom(wasChatActive: false, isChatActive: true), "return to chat")
        expect(!ChatScrollRestorationPolicy.shouldRequestBottom(wasChatActive: true, isChatActive: true), "chat stays active")
        expect(!ChatScrollRestorationPolicy.shouldRequestBottom(wasChatActive: true, isChatActive: false), "leaving chat")
        expect(ChatScrollRestorationPolicy.target == .finalContentAnchor, "final anchor target")
        print("All ChatScrollRestorationPolicy tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
