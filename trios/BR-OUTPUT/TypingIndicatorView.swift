import SwiftUI

struct TypingIndicatorView: View {
    var color: Color = .white

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let nodeCount = 3
    private let railWidth = 34.0
    private let pulseInterval = 0.32

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { context in
            signal(at: context.date)
        }
        .frame(width: railWidth, height: 16)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Agent is working")
    }

    private func signal(at date: Date) -> some View {
        let activeNode = reduceMotion
            ? -1
            : Int(date.timeIntervalSinceReferenceDate / pulseInterval) % nodeCount

        return ZStack {
            Capsule()
                .fill(color.opacity(0.26))
                .frame(width: railWidth - ChatLoadingIndicatorLayout.nodeDiameter, height: 1)

            HStack(spacing: 6.2) {
                ForEach(0..<nodeCount, id: \.self) { index in
                    signalNode(isActive: index == activeNode)
                }
            }
        }
    }

    private func signalNode(isActive: Bool) -> some View {
        ZStack {
            Circle()
                .stroke(color.opacity(isActive ? 0.72 : 0), lineWidth: 1)
                .frame(
                    width: ChatLoadingIndicatorLayout.nodeDiameter * 1.8,
                    height: ChatLoadingIndicatorLayout.nodeDiameter * 1.8
                )

            Circle()
                .fill(color)
                .frame(
                    width: ChatLoadingIndicatorLayout.nodeDiameter,
                    height: ChatLoadingIndicatorLayout.nodeDiameter
                )
                .opacity(isActive ? 1 : 0.52)
                .scaleEffect(isActive ? 1.12 : 1)
        }
        .frame(
            width: ChatLoadingIndicatorLayout.nodeDiameter * 1.8,
            height: ChatLoadingIndicatorLayout.nodeDiameter * 1.8
        )
        .animation(.easeInOut(duration: 0.18), value: isActive)
    }
}
