import SwiftUI
import AppKit

struct GlassmorphismBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .fullScreenUI
    var blending: NSVisualEffectView.BlendingMode = .behindWindow
    var cornerRadius: CGFloat = 20
    private let theme = TriosVisualTheme.current

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = blending
        view.state = theme.usesNativeBackdropBlur ? .active : .inactive
        view.wantsLayer = true
        view.layer?.cornerRadius = cornerRadius
        view.layer?.masksToBounds = true
        view.appearance = NSAppearance(named: .darkAqua)

        // Central black tint over the live native backdrop blur.
        let tint = NSView()
        tint.identifier = NSUserInterfaceItemIdentifier("TriosGlassTint")
        tint.wantsLayer = true
        tint.layer?.backgroundColor = NSColor.black.withAlphaComponent(theme.nativeMaterialTintOpacity).cgColor
        tint.layer?.cornerRadius = cornerRadius
        tint.layer?.masksToBounds = true
        tint.autoresizingMask = [.width, .height]
        view.addSubview(tint)

        // Frosted edge stroke
        let border = NSView()
        border.identifier = NSUserInterfaceItemIdentifier("TriosGlassBorder")
        border.wantsLayer = true
        border.layer?.borderWidth = 0.5
        border.layer?.borderColor = NSColor.white.withAlphaComponent(theme.borderWhiteOpacity).cgColor
        border.layer?.cornerRadius = cornerRadius
        border.layer?.masksToBounds = true
        border.autoresizingMask = [.width, .height]
        view.addSubview(border)

        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        nsView.material = material
        nsView.blendingMode = blending
        nsView.state = theme.usesNativeBackdropBlur ? .active : .inactive
        nsView.layer?.cornerRadius = cornerRadius
        for subview in nsView.subviews {
            subview.layer?.cornerRadius = cornerRadius
            switch subview.identifier?.rawValue {
            case "TriosGlassTint":
                subview.layer?.backgroundColor = NSColor.black.withAlphaComponent(theme.nativeMaterialTintOpacity).cgColor
            case "TriosGlassBorder":
                subview.layer?.borderColor = NSColor.white.withAlphaComponent(theme.borderWhiteOpacity).cgColor
            default:
                break
            }
        }
    }
}

/// One edge-to-edge glass surface shared by compact and full-screen layouts.
/// The native material keeps real backdrop blur while the soft blooms preserve
/// the recognizable green and warm tint when macOS moves the window to its own
/// full-screen Space.
struct UnifiedTriosGlassBackground: View {
    private let profile = ChatGlassStyle.shared

    var body: some View {
        ZStack {
            GlassmorphismBackground(
                material: .fullScreenUI,
                blending: .behindWindow,
                cornerRadius: 0
            )

            LinearGradient(
                colors: [
                    Color.black.opacity(profile.darkWashOpacity),
                    Color.clear,
                    Color.black.opacity(profile.darkWashOpacity * 0.7)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            GeometryReader { geometry in
                let bloomSize = max(360, geometry.size.width * 0.62)

                Circle()
                    .fill(Color(red: 0.18, green: 0.68, blue: 0.34).opacity(profile.ambientBloomOpacity))
                    .frame(width: bloomSize, height: bloomSize)
                    .blur(radius: 110)
                    .offset(
                        x: geometry.size.width * 0.38,
                        y: geometry.size.height * 0.08
                    )

                Circle()
                    .fill(Color(red: 0.75, green: 0.34, blue: 0.48).opacity(profile.ambientBloomOpacity * 0.8))
                    .frame(width: bloomSize * 0.82, height: bloomSize * 0.82)
                    .blur(radius: 120)
                    .offset(
                        x: geometry.size.width * 0.68,
                        y: -geometry.size.height * 0.12
                    )

                Circle()
                    .fill(Color(red: 0.30, green: 0.46, blue: 0.75).opacity(profile.ambientBloomOpacity * 0.45))
                    .frame(width: bloomSize * 0.72, height: bloomSize * 0.72)
                    .blur(radius: 125)
                    .offset(
                        x: -geometry.size.width * 0.16,
                        y: geometry.size.height * 0.64
                    )
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct GlassmorphismCard<Content: View>: View {
    let cornerRadius: CGFloat
    let content: Content

    init(cornerRadius: CGFloat = 16, @ViewBuilder content: () -> Content) {
        self.cornerRadius = cornerRadius
        self.content = content()
    }

    var body: some View {
        content
            .padding()
            .background(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .fill(Color.grokSurface)
                    .background(
                        GlassmorphismBackground(material: .popover, blending: .withinWindow, cornerRadius: cornerRadius)
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .stroke(Color.grokBorder, lineWidth: 1)
            )
    }
}
