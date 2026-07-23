import Foundation

/// The single source of truth for neutral TriOS surfaces.
///
/// Every black layer stays translucent so the native macOS material can keep
/// sampling the desktop behind the window. Status, syntax, and diff colors are
/// intentionally not part of this profile because they carry meaning.
struct TriosBlackGlassTheme: Equatable, Sendable {
    let rootBlackOpacity: Double
    let surfaceBlackOpacity: Double
    let elevatedBlackOpacity: Double
    let strongBlackOpacity: Double
    let nativeMaterialTintOpacity: Double
    let windowWashOpacity: Double
    let sidebarBlackOpacity: Double
    let contentBlackOpacity: Double
    let borderWhiteOpacity: Double
    let dividerWhiteOpacity: Double
    let highlightWhiteOpacity: Double
    let shadowBlackOpacity: Double
    let mutedTextWhiteOpacity: Double
    let dimTextWhiteOpacity: Double
    let ambientBloomOpacity: Double
    let usesNativeBackdropBlur: Bool
    let usesOpaqueContentFill: Bool

    var composerBlackOpacity: Double {
        contentBlackOpacity
    }
}

enum TriosVisualTheme {
    /// Adjust the complete neutral UI from this profile. No view should define
    /// its own grey surface or opaque black replacement.
    static let blackGlass = TriosBlackGlassTheme(
        rootBlackOpacity: 0.60,
        surfaceBlackOpacity: 0.46,
        elevatedBlackOpacity: 0.58,
        strongBlackOpacity: 0.74,
        nativeMaterialTintOpacity: 0.30,
        windowWashOpacity: 0.42,
        sidebarBlackOpacity: 0.22,
        contentBlackOpacity: 0.14,
        borderWhiteOpacity: 0.14,
        dividerWhiteOpacity: 0.09,
        highlightWhiteOpacity: 0.08,
        shadowBlackOpacity: 0.42,
        mutedTextWhiteOpacity: 0.62,
        dimTextWhiteOpacity: 0.43,
        ambientBloomOpacity: 0.055,
        usesNativeBackdropBlur: true,
        usesOpaqueContentFill: false
    )

    static let current = blackGlass
}
