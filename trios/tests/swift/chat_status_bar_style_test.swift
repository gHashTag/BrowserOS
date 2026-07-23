import Foundation

@main
struct ChatStatusBarStyleTest {
    static func main() {
        let compact = ChatStatusBarStyle.metrics(for: .compact)
        let expanded = ChatStatusBarStyle.metrics(for: .expanded)
        let compactComposer = ChatComposerStyle.metrics(for: .compact)
        let expandedComposer = ChatComposerStyle.metrics(for: .expanded)

        expect(compact.horizontalInset == compactComposer.horizontalInset, "compact aligns with composer")
        expect(expanded.horizontalInset == expandedComposer.horizontalInset, "expanded aligns with composer")
        expect(compact.blackOverlayOpacity == compactComposer.blackOverlayOpacity, "compact shares glass tone")
        expect(expanded.blackOverlayOpacity == expandedComposer.blackOverlayOpacity, "expanded shares glass tone")
        expect(compact.height == 32, "compact status height")
        expect(expanded.height == 36, "expanded status height")
        expect(compact.cornerRadius == 14, "compact continuous corner")
        expect(expanded.cornerRadius == 16, "expanded continuous corner")
        expect(compact.topInset == 8 && compact.bottomInset == 8, "compact balanced gaps")
        expect(expanded.topInset == 8 && expanded.bottomInset == 8, "expanded balanced gaps")
        expect(compact.borderWidth == 1 && expanded.borderWidth == 1, "complete hairline border")
        expect(compact.usesNativeBackdropBlur && expanded.usesNativeBackdropBlur, "native glass blur")
        expect(!compact.usesOpaqueFill && !expanded.usesOpaqueFill, "no opaque strip")

        print("All ChatStatusBarStyle tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
