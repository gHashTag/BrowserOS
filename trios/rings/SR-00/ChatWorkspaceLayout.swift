import Foundation

enum ChatWorkspaceMode: Equatable {
    case compact
    case expanded
}

struct ChatWorkspaceMetrics: Equatable {
    let mode: ChatWorkspaceMode
    let sidebarWidth: Double
    let contentMaxWidth: Double
}

enum ChatWorkspaceLayout {
    static let expandedThreshold: Double = 760
    static let standardSidebarWidth: Double = 272
    static let readableContentMaxWidth: Double = 900

    static func metrics(width: Double, sidebarCollapsed: Bool) -> ChatWorkspaceMetrics {
        let mode: ChatWorkspaceMode = width >= expandedThreshold ? .expanded : .compact
        let sidebarWidth = mode == .expanded && !sidebarCollapsed ? standardSidebarWidth : 0
        return ChatWorkspaceMetrics(
            mode: mode,
            sidebarWidth: sidebarWidth,
            contentMaxWidth: readableContentMaxWidth
        )
    }
}
