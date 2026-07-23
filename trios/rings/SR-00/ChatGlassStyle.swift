import Foundation

struct ChatGlassProfile: Equatable {
    let darkWashOpacity: Double
    let sidebarOverlayOpacity: Double
    let contentOverlayOpacity: Double
    let ambientBloomOpacity: Double
    let usesOpaqueContentFill: Bool
}

enum ChatGlassStyle {
    private static let theme = TriosVisualTheme.current

    static let shared = ChatGlassProfile(
        darkWashOpacity: theme.windowWashOpacity,
        sidebarOverlayOpacity: theme.sidebarBlackOpacity,
        contentOverlayOpacity: theme.contentBlackOpacity,
        ambientBloomOpacity: theme.ambientBloomOpacity,
        usesOpaqueContentFill: theme.usesOpaqueContentFill
    )

    static func profile(for mode: ChatWorkspaceMode) -> ChatGlassProfile {
        shared
    }
}
