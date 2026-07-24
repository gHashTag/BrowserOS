import Foundation

@main
struct TodoPanelPolicyTest {
    static func main() {
        let compact = TodoPanelPolicy.metrics(width: 700, mode: .compact)
        expect(!compact.isAvailable, "compact mode has no trailing panel")
        expect(!compact.presentedByDefault, "compact never auto-presents")

        let narrowExpanded = TodoPanelPolicy.metrics(width: 900, mode: .expanded)
        expect(narrowExpanded.isAvailable, "expanded mode offers the panel")
        expect(!narrowExpanded.presentedByDefault, "narrow expanded stays collapsed to protect chat")

        let wide = TodoPanelPolicy.metrics(width: 1440, mode: .expanded)
        expect(wide.isAvailable, "wide expanded offers the panel")
        expect(wide.presentedByDefault, "fullscreen shows the panel by default")

        let boundary = TodoPanelPolicy.metrics(
            width: TodoPanelPolicy.autoPresentThreshold,
            mode: .expanded
        )
        expect(boundary.presentedByDefault, "panel presents at the auto-present threshold")

        expect(wide.minWidth == 240, "bounded min width")
        expect(wide.idealWidth == 300, "bounded ideal width")
        expect(wide.maxWidth == 400, "bounded max width")
        expect(wide.minWidth <= wide.idealWidth && wide.idealWidth <= wide.maxWidth, "width bounds ordered")

        print("All TodoPanelPolicy tests passed.")
    }

    static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
