// AGENT-V-WAIVER: AGENT-MEMORY-TODO-001
// Reason: Spec-controlled planner motion for the primary chat surface.
// Follow-up: seal against .trinity/specs/agent-memory-todo-planner.md.
import Foundation
import SwiftUI

struct TODOActiveGlowModifier: ViewModifier {
    let isActive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsePhase = false

    func body(content: Content) -> some View {
        content
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(
                        Color.white.opacity(
                            isActive ? (pulsePhase ? 0.20 : 0.10) : 0.08
                        ),
                        lineWidth: 1
                    )
                    .shadow(
                        color: Color.white.opacity(
                            isActive && !reduceMotion ? (pulsePhase ? 0.12 : 0.03) : 0
                        ),
                        radius: pulsePhase ? 12 : 4
                    )
                    .allowsHitTesting(false)
            }
            .onAppear {
                updatePulse()
            }
            .onChange(of: isActive) {
                updatePulse()
            }
            .onChange(of: reduceMotion) {
                updatePulse()
            }
    }

    private func updatePulse() {
        guard isActive, !reduceMotion else {
            pulsePhase = false
            return
        }
        pulsePhase = false
        withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
            pulsePhase = true
        }
    }
}

struct TODOInsertionModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isVisible = false

    func body(content: Content) -> some View {
        content
            .opacity(isVisible ? 1 : 0)
            .offset(x: reduceMotion || isVisible ? 0 : -8)
            .scaleEffect(reduceMotion || isVisible ? 1 : 0.985, anchor: .leading)
            .onAppear {
                if reduceMotion {
                    isVisible = true
                } else {
                    withAnimation(.spring(response: 0.32, dampingFraction: 0.88)) {
                        isVisible = true
                    }
                }
            }
    }
}

struct TODOProgressAnimationModifier: ViewModifier {
    let value: Double

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.32),
                value: value
            )
    }
}

struct TODOCompletionEffectModifier: ViewModifier {
    let isComplete: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var effectIsVisible = false
    @State private var effectProgress = 0.0

    func body(content: Content) -> some View {
        content
            .overlay {
                GeometryReader { geometry in
                    if effectIsVisible {
                        completionOverlay(size: geometry.size)
                    }
                }
                .allowsHitTesting(false)
            }
            .onChange(of: isComplete) {
                guard isComplete else { return }
                playEffect()
            }
    }

    @ViewBuilder
    private func completionOverlay(size: CGSize) -> some View {
        if reduceMotion {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.white.opacity(0.22 * (1 - effectProgress)), lineWidth: 1)
        } else {
            ZStack {
                Rectangle()
                    .fill(
                        LinearGradient(
                            colors: [
                                .clear,
                                Color.white.opacity(0.22 * (1 - effectProgress)),
                                .clear
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(width: 34)
                    .offset(x: (size.width + 68) * effectProgress - 34)

                ForEach(0..<6, id: \.self) { index in
                    let angle = (Double(index) / 6.0) * Double.pi * 2
                    let distance = 15.0 * effectProgress
                    Circle()
                        .fill(Color.white.opacity(0.5 * (1 - effectProgress)))
                        .frame(width: 2.5, height: 2.5)
                        .position(
                            x: size.width - 24 + cos(angle) * distance,
                            y: size.height / 2 + sin(angle) * distance
                        )
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    private func playEffect() {
        effectProgress = 0
        effectIsVisible = true

        withAnimation(.easeOut(duration: reduceMotion ? 0.18 : 0.48)) {
            effectProgress = 1
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + (reduceMotion ? 0.2 : 0.5)) {
            effectIsVisible = false
        }
    }
}

extension View {
    func todoActiveGlow(isActive: Bool) -> some View {
        modifier(TODOActiveGlowModifier(isActive: isActive))
    }

    func todoInsertionEffect() -> some View {
        modifier(TODOInsertionModifier())
    }

    func todoProgressAnimation(value: Double) -> some View {
        modifier(TODOProgressAnimationModifier(value: value))
    }

    func todoCompletionEffect(isComplete: Bool) -> some View {
        modifier(TODOCompletionEffectModifier(isComplete: isComplete))
    }
}
