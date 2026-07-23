import Foundation

struct ChatStatusBarMetrics: Equatable {
    let horizontalInset: Double
    let topInset: Double
    let bottomInset: Double
    let contentHorizontalPadding: Double
    let height: Double
    let cornerRadius: Double
    let borderWidth: Double
    let blackOverlayOpacity: Double
    let usesNativeBackdropBlur: Bool
    let usesOpaqueFill: Bool
}

enum ChatStatusBarStyle {
    private static let theme = TriosVisualTheme.current

    static func metrics(for mode: ChatWorkspaceMode) -> ChatStatusBarMetrics {
        let composer = ChatComposerStyle.metrics(for: mode)

        switch mode {
        case .compact:
            return ChatStatusBarMetrics(
                horizontalInset: composer.horizontalInset,
                topInset: 8,
                bottomInset: 8,
                contentHorizontalPadding: 11,
                height: 32,
                cornerRadius: 14,
                borderWidth: 1,
                blackOverlayOpacity: composer.blackOverlayOpacity,
                usesNativeBackdropBlur: theme.usesNativeBackdropBlur,
                usesOpaqueFill: theme.usesOpaqueContentFill
            )
        case .expanded:
            return ChatStatusBarMetrics(
                horizontalInset: composer.horizontalInset,
                topInset: 8,
                bottomInset: 8,
                contentHorizontalPadding: 14,
                height: 36,
                cornerRadius: 16,
                borderWidth: 1,
                blackOverlayOpacity: composer.blackOverlayOpacity,
                usesNativeBackdropBlur: theme.usesNativeBackdropBlur,
                usesOpaqueFill: theme.usesOpaqueContentFill
            )
        }
    }
}
