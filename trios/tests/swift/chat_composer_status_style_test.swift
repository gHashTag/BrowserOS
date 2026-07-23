import Foundation

@main
struct ChatComposerStatusStyleTest {
    static func main() {
        let compact = ChatComposerStatusStyle.metrics(for: .compact)
        let expanded = ChatComposerStatusStyle.metrics(for: .expanded)

        expect(compact.isEmbeddedInComposer, "compact status is embedded")
        expect(expanded.isEmbeddedInComposer, "expanded status is embedded")
        expect(!compact.rendersStandaloneSurface, "compact has no standalone surface")
        expect(!expanded.rendersStandaloneSurface, "expanded has no standalone surface")

        expect(compact.showsModelSelection && expanded.showsModelSelection, "model selection remains visible")
        expect(compact.showsTokenUsage && expanded.showsTokenUsage, "token usage remains visible")
        expect(compact.showsRecoveryAction && expanded.showsRecoveryAction, "recovery remains visible")
        expect(compact.showsConnectionState && expanded.showsConnectionState, "connections remain visible")

        expect(!compact.showsProviderName, "compact hides provider name")
        expect(expanded.showsProviderName, "expanded shows provider name")
        expect(!compact.showsTokenBreakdown, "compact uses total tokens")
        expect(expanded.showsTokenBreakdown, "expanded shows input and output tokens")
        expect(!compact.showsCDPLabel, "compact uses connection dots")
        expect(expanded.showsCDPLabel, "expanded shows CDP label")
        expect(compact.controlHeight == 30, "compact control height")
        expect(expanded.controlHeight == 32, "expanded control height")

        print("All ChatComposerStatusStyle tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
