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

// MARK: - Typography

/// Every font in the app, and the floor under all of them.
///
/// The app had 618 hard-coded point sizes and 317 of them were 10pt or less -
/// 119 at 9pt, 21 at 8pt, much of it monospaced. macOS calls 11pt "small" and
/// 9pt "mini", sizes meant for a checkbox label, not for the text that says
/// which branch a worker is on. Nothing enforced a minimum because there was
/// nothing to enforce it in: this file is the interface SSOT by L6 and it
/// defined colours and a corner radius, no type at all. So each view picked a
/// number, the numbers drifted down, and the result was an app the operator
/// could not read.
///
/// A single function rather than a named ramp (`.caption`, `.body`, ...) on
/// purpose: the call sites already carry a size each, and a ramp would have
/// meant re-deciding 618 of them by hand - 618 chances to change a layout by
/// accident. Passing the existing number through one function keeps every
/// relative decision the views already made and puts the floor, and the scale,
/// in one place that can be moved.
enum TriosType {
    /// The smallest size any text may render at.
    ///
    /// 11pt is the macOS "small" control size - the smallest the platform
    /// itself uses for text a person is expected to read. Anything below it is
    /// raised to it; sizes above it are left exactly as the view asked.
    static let legibilityFloor: CGFloat = 11

    /// Multiplies every size after the floor is applied.
    ///
    /// Stored rather than constant because "readable" is a property of the
    /// person and the display, not of the code. Clamped so that no setting can
    /// make the app unreadable in the other direction.
    static var scale: CGFloat {
        get {
            let stored = UserDefaults.standard.object(forKey: scaleKey) as? Double
            return min(max(CGFloat(stored ?? 1.0), 0.9), 1.6)
        }
        set { UserDefaults.standard.set(Double(newValue), forKey: scaleKey) }
    }

    static let scaleKey = "trios.type.scale"

    /// The size a view asks for, after the floor and the scale.
    static func size(_ requested: CGFloat) -> CGFloat {
        max(requested, legibilityFloor) * scale
    }

    /// Drop-in replacement for `Font.system(size:weight:design:)`.
    ///
    /// The argument labels match `Font.system` exactly, so the migration was a
    /// textual substitution rather than 618 judgement calls.
    static func font(
        _ size: CGFloat,
        weight: Font.Weight = .regular,
        design: Font.Design = .default
    ) -> Font {
        .system(size: Self.size(size), weight: weight, design: design)
    }
}

// MARK: - Wrapping Row

/// A horizontal row that moves to the next line instead of crushing what it
/// holds.
///
/// `HStack` has one answer when its children do not fit: shrink them, in an
/// order it decides. In the supervisor banner that produced a row reading
/// "branch queen... owns rings/... committ ed 1 fi... spend 41 to..." - four
/// facts, none of them legible, and the word "committed" broken across two
/// lines. Worse than illegible, it was unstable: which field got squeezed
/// depended on how long the others happened to be, so a token count ticking
/// upward re-cut every neighbour and the row appeared to twitch.
///
/// Each subview here is given exactly the size it asks for. When the next one
/// does not fit, the row wraps. Nothing is ever compressed, so a value that
/// changes moves only itself.
struct WrappingHStack: Layout {
    var horizontalSpacing: CGFloat = 10
    var verticalSpacing: CGFloat = 4

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout Void
    ) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        let rows = layout(subviews: subviews, maxWidth: maxWidth)
        let height = rows.reduce(0) { $0 + $1.height } +
            verticalSpacing * CGFloat(max(rows.count - 1, 0))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: min(width, maxWidth), height: height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout Void
    ) {
        let rows = layout(subviews: subviews, maxWidth: bounds.width)
        var y = bounds.minY
        for row in rows {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(
                    at: CGPoint(x: x, y: y + (row.height - size.height) / 2),
                    proposal: ProposedViewSize(size)
                )
                x += size.width + horizontalSpacing
            }
            y += row.height + verticalSpacing
        }
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func layout(subviews: Subviews, maxWidth: CGFloat) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = current.indices.isEmpty
                ? size.width
                : current.width + horizontalSpacing + size.width
            if !current.indices.isEmpty && needed > maxWidth {
                rows.append(current)
                current = Row()
                current.indices = [index]
                current.width = size.width
                current.height = size.height
            } else {
                current.indices.append(index)
                current.width = needed
                current.height = max(current.height, size.height)
            }
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}

// MARK: - Corner Radius Style

extension View {
    func triosBubble(radius: CGFloat = 18, style: RoundedCornerStyle = .continuous) -> some View {
        clipShape(RoundedRectangle(cornerRadius: radius, style: style))
    }
}
