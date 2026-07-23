import Foundation

@main
struct ChatGlassStyleTest {
    static func main() {
        let compact = ChatGlassStyle.profile(for: .compact)
        let expanded = ChatGlassStyle.profile(for: .expanded)

        expect(compact == expanded, "compact and expanded share one profile")
        expect(!expanded.usesOpaqueContentFill, "expanded content remains transparent")
        expect(expanded.sidebarOverlayOpacity < 0.25, "sidebar preserves glass")
        expect(expanded.contentOverlayOpacity < 0.25, "conversation preserves glass")
        print("All ChatGlassStyle tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
