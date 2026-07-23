import Foundation

@main
struct TriosVisualThemeTest {
    static func main() {
        let theme = TriosVisualTheme.current

        let transparentBlackLayers = [
            theme.rootBlackOpacity,
            theme.surfaceBlackOpacity,
            theme.elevatedBlackOpacity,
            theme.strongBlackOpacity,
            theme.nativeMaterialTintOpacity,
            theme.windowWashOpacity,
            theme.sidebarBlackOpacity,
            theme.contentBlackOpacity,
            theme.composerBlackOpacity
        ]

        expect(
            transparentBlackLayers.allSatisfy { $0 > 0 && $0 < 1 },
            "every black layer remains transparent"
        )
        expect(theme.strongBlackOpacity > theme.elevatedBlackOpacity, "strong surface hierarchy")
        expect(theme.elevatedBlackOpacity > theme.surfaceBlackOpacity, "elevated surface hierarchy")
        expect(theme.composerBlackOpacity == theme.contentBlackOpacity, "composer matches the content glass")
        expect(theme.borderWhiteOpacity <= 0.20, "glass border stays subtle")
        expect(theme.dividerWhiteOpacity <= theme.borderWhiteOpacity, "divider is quieter than border")
        expect(theme.ambientBloomOpacity < 0.10, "ambient color does not turn glass grey")
        expect(theme.usesNativeBackdropBlur, "native backdrop blur remains enabled")
        expect(!theme.usesOpaqueContentFill, "opaque content fill remains disabled")

        print("All TriosVisualTheme tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
