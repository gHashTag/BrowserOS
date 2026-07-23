import SwiftUI

// MARK: - Central Black Glass Palette

extension Color {
    private static let triosTheme = TriosVisualTheme.current

    static let grokBackground = Color.black.opacity(triosTheme.rootBlackOpacity)
    static let grokSurface = Color.black.opacity(triosTheme.surfaceBlackOpacity)
    static let grokElevated = Color.black.opacity(triosTheme.elevatedBlackOpacity)
    static let grokBorder = Color.white.opacity(triosTheme.borderWhiteOpacity)
    static let grokDivider = Color.white.opacity(triosTheme.dividerWhiteOpacity)
    static let grokText = Color.white
    static let grokMuted = Color.white.opacity(triosTheme.mutedTextWhiteOpacity)
    static let grokDim = Color.white.opacity(triosTheme.dimTextWhiteOpacity)
    static let grokAccent = Color.white

    static let triosGlassStrong = Color.black.opacity(triosTheme.strongBlackOpacity)
    static let triosGlassHighlight = Color.white.opacity(triosTheme.highlightWhiteOpacity)
    static let triosGlassShadow = Color.black.opacity(triosTheme.shadowBlackOpacity)

    // Legacy aliases
    static let triosGold = grokAccent
    static let triosBackground = grokBackground
    static let triosCardBackground = grokSurface
    static let triosReasoningBackground = grokElevated
    static let triosToolBackground = grokElevated
    static let triosSuccessBackground = grokElevated
    static let triosErrorBackground = grokSurface
}

// MARK: - Corner Radius Style

extension View {
    func triosBubble(radius: CGFloat = 18, style: RoundedCornerStyle = .continuous) -> some View {
        clipShape(RoundedRectangle(cornerRadius: radius, style: style))
    }
}
