import Foundation

@main
struct ChatWorkspaceLayoutTest {
    static func main() {
        let compact = ChatWorkspaceLayout.metrics(width: 759, sidebarCollapsed: false)
        expect(compact.mode == .compact, "759 is compact")
        expect(compact.sidebarWidth == 0, "compact has no sidebar")

        let expanded = ChatWorkspaceLayout.metrics(width: 760, sidebarCollapsed: false)
        expect(expanded.mode == .expanded, "760 is expanded")
        expect(expanded.sidebarWidth == 272, "expanded sidebar width")
        expect(expanded.contentMaxWidth == 900, "readable content cap")

        let collapsed = ChatWorkspaceLayout.metrics(width: 1440, sidebarCollapsed: true)
        expect(collapsed.mode == .expanded, "collapsed remains expanded mode")
        expect(collapsed.sidebarWidth == 0, "collapsed sidebar hidden")
        expect(collapsed.contentMaxWidth == 900, "collapsed content cap")

        print("All ChatWorkspaceLayout tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
