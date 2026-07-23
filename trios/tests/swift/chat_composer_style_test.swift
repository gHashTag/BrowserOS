import Foundation

@main
struct ChatComposerStyleTest {
    static func main() {
        let compact = ChatComposerStyle.metrics(for: .compact)
        let expanded = ChatComposerStyle.metrics(for: .expanded)

        expect(compact.horizontalInset == 10, "compact outer inset")
        expect(expanded.horizontalInset == 16, "expanded outer inset")
        expect(compact.cornerRadius == 22, "compact continuous corner")
        expect(expanded.cornerRadius == 24, "expanded continuous corner")
        expect(
            compact.blackOverlayOpacity == TriosVisualTheme.current.composerBlackOpacity,
            "compact uses the central surface"
        )
        expect(
            expanded.blackOverlayOpacity == TriosVisualTheme.current.composerBlackOpacity,
            "expanded uses the central surface"
        )
        expect(compact.blackOverlayOpacity == expanded.blackOverlayOpacity, "composer color is mode-independent")
        expect(compact.blackOverlayOpacity < 1, "composer remains transparent")
        expect(compact.editorMinimumHeight == 42, "compact editor minimum")
        expect(compact.editorMaximumHeight == 110, "compact editor maximum")
        expect(expanded.editorMaximumHeight == 132, "expanded editor maximum")
        expect(!compact.showsPersistentShortcutStrip, "compact shortcut strip removed")
        expect(!expanded.showsPersistentShortcutStrip, "expanded shortcut strip removed")
        expect(compact.usesInlineStatus && expanded.usesInlineStatus, "inline status")

        print("All ChatComposerStyle tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
