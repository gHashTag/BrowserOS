import Foundation

struct ChatComposerMetrics: Equatable {
    let horizontalInset: Double
    let bottomInset: Double
    let contentPadding: Double
    let cornerRadius: Double
    let editorMinimumHeight: Double
    let editorMaximumHeight: Double
    let blackOverlayOpacity: Double
    let showsPersistentShortcutStrip: Bool
    let usesInlineStatus: Bool
}

enum ChatComposerStyle {
    private static let theme = TriosVisualTheme.current

    static func metrics(for mode: ChatWorkspaceMode) -> ChatComposerMetrics {
        switch mode {
        case .compact:
            return ChatComposerMetrics(
                horizontalInset: 10,
                bottomInset: 10,
                contentPadding: 12,
                cornerRadius: 22,
                editorMinimumHeight: 42,
                editorMaximumHeight: 110,
                blackOverlayOpacity: theme.composerBlackOpacity,
                showsPersistentShortcutStrip: false,
                usesInlineStatus: true
            )
        case .expanded:
            return ChatComposerMetrics(
                horizontalInset: 16,
                bottomInset: 18,
                contentPadding: 14,
                cornerRadius: 24,
                editorMinimumHeight: 48,
                editorMaximumHeight: 132,
                blackOverlayOpacity: theme.composerBlackOpacity,
                showsPersistentShortcutStrip: false,
                usesInlineStatus: true
            )
        }
    }
}
