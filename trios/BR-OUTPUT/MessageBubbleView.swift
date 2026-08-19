// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: manual bubble styling fixes on feat/zai-provider before T27 freeze.
// Expires: 2026-12-31
// Follow-up: spec-drive MessageBubbleView and re-seal via /t27-phi-loop.
import SwiftUI

struct MessageBubbleView: View {
    let message: ChatMessage
    let isFirstInGroup: Bool
    let isLastInGroup: Bool
    var isConversationIdle: Bool = true
    var onTaskAction: ((UUID, AgentTaskState) -> Void)?
    var onRegenerate: (() -> Void)?
    var onFeedback: ((Bool) -> Void)?

    @State private var isHovered = false

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if message.role == .assistant {
                avatarView
            } else if message.role == .system {
                EmptyView()
            } else {
                Spacer(minLength: 4)
            }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 2) {
                if isFirstInGroup, let senderName {
                    senderLabel(senderName)
                }

                if message.role == .assistant {
                    assistantContainer
                } else if message.role == .system {
                    systemErrorBadge
                } else {
                    userBubble
                }

                if isLastInGroup {
                    timestampView
                }
            }

            if message.role == .user {
                avatarView
            } else if message.role == .system {
                EmptyView()
            } else {
                Spacer(minLength: 4)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, isFirstInGroup ? 12 : 2)
        .padding(.bottom, isLastInGroup ? 8 : 2)
    }

    // MARK: - Avatar

    private var avatarView: some View {
        Image(systemName: message.role == .user ? "person.fill" : "cpu")
            .font(TriosType.font(12, weight: .medium))
            .foregroundColor(message.role == .user ? .grokText : .grokMuted)
            .frame(width: 24, height: 24)
            .background(
                Circle()
                    .fill(message.role == .user ? Color.grokElevated.opacity(0.6) : Color.grokElevated.opacity(0.3))
            )
    }

    // MARK: - Sender Label

    private var senderName: String? {
        let kind: ChatSenderKind = message.role == .user
            ? .user
            : (message.role == .system ? .system : .assistant)
        return ChatSenderLabelPolicy.label(for: kind)
    }

    private func senderLabel(_ senderName: String) -> some View {
        Text(senderName)
            .font(TriosType.font(11, weight: .medium))
            .foregroundColor(.grokMuted)
            .padding(.bottom, 2)
    }

    // MARK: - Timestamp

    private var timestampView: some View {
        Text(message.timestamp, style: .relative)
            .font(TriosType.font(9))
            .foregroundColor(.grokDim)
            .padding(.top, 2)
    }

    // MARK: - User Message

    private var userBubble: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if !message.content.isEmpty {
                // User messages must render as plain Text. Routing them through
                // RichMessageView's AttributedString(markdown:) path causes glyph
                // substitution on macOS (Latin/Cyrillic chars become placeholder
                // glyphs like "фффф" or "9999").
                Text(message.content)
                    .font(TriosType.font(15, weight: .regular, design: .default))
                    .foregroundColor(.grokText)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.grokElevated.opacity(0.5))
                    .cornerRadius(14, corners: [.topLeft, .topRight, .bottomLeft])
                    .frame(maxWidth: 520, alignment: .trailing)
                    .textSelection(.enabled)
                    .contextMenu {
                        Button("Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(message.content, forType: .string)
                        }
                    }
            }

            if message.isStreaming && message.content.isEmpty {
                TypingIndicatorView()
                    .foregroundColor(.grokText)
            }

            // User messages also get a copy action bar, shown on hover.
            if !message.isStreaming && !message.content.isEmpty {
                HoverCopyBar(content: message.content)
                    .opacity(isHovered ? 1 : 0)
                    .animation(.easeInOut(duration: 0.15), value: isHovered)
            }
        }
        .onHover { hovered in
            isHovered = hovered
        }
    }

    private var systemNotice: (kind: SystemNoticeKind, text: String) {
        SystemNoticeClassifier.classify(message.content)
    }

    private var systemNoticeTint: Color {
        switch systemNotice.kind {
        case .success: return .green
        case .info: return .grokMuted
        case .warning: return .yellow
        case .failure: return .red
        }
    }

    private var systemErrorBadge: some View {
        let notice = systemNotice
        let tint = systemNoticeTint
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: notice.kind.symbolName)
                    .font(TriosType.font(12))
                    .foregroundColor(tint)
                Text(notice.text)
                    .font(TriosType.font(13, weight: .medium, design: .default))
                    .foregroundColor(.grokText)
                    .textSelection(.enabled)
                    .contextMenu {
                        Button("Copy") { copyNotice(notice.text) }
                    }
                if notice.kind.deservesPersistentCopyButton {
                    // A failure is exactly the text a user needs to paste
                    // somewhere. Hiding its copy button behind hover meant the
                    // one message worth copying was the hardest to copy.
                    Button {
                        copyNotice(notice.text)
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .font(TriosType.font(11))
                            .foregroundColor(.grokMuted)
                    }
                    .buttonStyle(.plain)
                    .help("Copy this message")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(tint.opacity(notice.kind == .info ? 0.08 : 0.15))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(tint.opacity(0.4), lineWidth: 1)
            )
            .cornerRadius(10)
            .onHover { hovered in
                isHovered = hovered
            }

            HoverCopyBar(content: notice.text)
                .opacity(isHovered ? 1 : 0)
                .animation(.easeInOut(duration: 0.15), value: isHovered)
        }
    }

    private func copyNotice(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    // MARK: - Assistant Container

    private var assistantContainer: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(assistantTimeline.enumerated()), id: \.offset) { _, item in
                assistantTimelineView(item)
            }

            switch assistantActionPresentation {
            case .primary:
                MessageActionBar(
                    content: message.content,
                    onRegenerate: onRegenerate,
                    onFeedback: onFeedback
                )
            case .hoverCopy:
                HoverCopyBar(content: message.content)
                    .opacity(isHovered ? 1 : 0)
                    .animation(.easeInOut(duration: 0.15), value: isHovered)
            case .none:
                EmptyView()
            }
        }
        .onHover { hovered in
            isHovered = hovered
        }
    }

    private var assistantActionPresentation: AssistantActionPresentation {
        AssistantActionBarPolicy.presentation(
            isStreaming: message.isStreaming,
            hasContent: !message.content.isEmpty,
            isLastInGroup: isLastInGroup,
            isConversationIdle: isConversationIdle
        )
    }

    private var assistantTimeline: [AssistantTimelineItem] {
        AssistantTimelineBuilder.build(
            content: message.content,
            segments: message.segments,
            toolCalls: message.toolCalls
        )
    }

    @ViewBuilder
    private func assistantTimelineView(_ item: AssistantTimelineItem) -> some View {
        switch item {
        case .reasoning(let text):
            ReasoningCollapsibleView(content: text)

        case .text(let text):
            RichMessageView(text: text, isUser: false)
                .font(TriosType.font(15, weight: .regular, design: .default))
                .foregroundColor(.grokText)
                .textSelection(.enabled)
                .contextMenu {
                    Button("Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(text, forType: .string)
                    }
                }
                .frame(maxWidth: 720, alignment: .leading)

        case .toolCall(let id):
            if let toolCall = message.toolCalls.first(where: { $0.id == id }) {
                ToolCallCardView(toolCall: toolCall)
            }

        case .error(let text):
            Text(text)
                .font(TriosType.font(13, weight: .medium))
                .foregroundColor(.red)
                .textSelection(.enabled)
        }
    }
}

// MARK: - Corner Radius Extension (macOS compatible)

extension View {
    func cornerRadius(_ radius: CGFloat, corners: RectCorner) -> some View {
        clipShape(RoundedCorner(radius: radius, corners: corners))
    }
}

struct RectCorner: OptionSet {
    let rawValue: Int
    static let topLeft = RectCorner(rawValue: 1 << 0)
    static let topRight = RectCorner(rawValue: 1 << 1)
    static let bottomLeft = RectCorner(rawValue: 1 << 2)
    static let bottomRight = RectCorner(rawValue: 1 << 3)
    static let allCorners: RectCorner = [.topLeft, .topRight, .bottomLeft, .bottomRight]
}

struct RoundedCorner: Shape {
    var radius: CGFloat = .infinity
    var corners: RectCorner = .allCorners

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.size.width
        let h = rect.size.height
        let r = min(min(radius, h / 2), w / 2)

        let topLeft: CGFloat = corners.contains(.topLeft) ? r : 0
        let topRight: CGFloat = corners.contains(.topRight) ? r : 0
        let bottomLeft: CGFloat = corners.contains(.bottomLeft) ? r : 0
        let bottomRight: CGFloat = corners.contains(.bottomRight) ? r : 0

        path.move(to: CGPoint(x: w / 2.0, y: 0))
        path.addLine(to: CGPoint(x: w - topRight, y: 0))
        path.addArc(center: CGPoint(x: w - topRight, y: topRight), radius: topRight,
                    startAngle: Angle(degrees: -90), endAngle: Angle(degrees: 0), clockwise: false)
        path.addLine(to: CGPoint(x: w, y: h - bottomRight))
        path.addArc(center: CGPoint(x: w - bottomRight, y: h - bottomRight), radius: bottomRight,
                    startAngle: Angle(degrees: 0), endAngle: Angle(degrees: 90), clockwise: false)
        path.addLine(to: CGPoint(x: bottomLeft, y: h))
        path.addArc(center: CGPoint(x: bottomLeft, y: h - bottomLeft), radius: bottomLeft,
                    startAngle: Angle(degrees: 90), endAngle: Angle(degrees: 180), clockwise: false)
        path.addLine(to: CGPoint(x: 0, y: topLeft))
        path.addArc(center: CGPoint(x: topLeft, y: topLeft), radius: topLeft,
                    startAngle: Angle(degrees: 180), endAngle: Angle(degrees: 270), clockwise: false)
        path.closeSubpath()
        return path
    }
}

// MARK: - Message Action Bar

private struct MessageActionBar: View {
    let content: String
    var onRegenerate: (() -> Void)?
    var onFeedback: ((Bool) -> Void)?

    @State private var copied = false
    @State private var liked: Bool? = nil

    var body: some View {
        HStack(spacing: 14) {
            Button(action: {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(content, forType: .string)
                copied = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    copied = false
                }
            }) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(TriosType.font(12, weight: .medium, design: .default))
                    .foregroundColor(copied ? .grokText : .grokDim)
            }
            .buttonStyle(PlainButtonStyle())
            .help("Copy")

            Button(action: {
                onRegenerate?()
            }) {
                Image(systemName: "arrow.clockwise")
                    .font(TriosType.font(12, weight: .medium, design: .default))
                    .foregroundColor(.grokDim)
            }
            .buttonStyle(PlainButtonStyle())
            .help("Regenerate")

            Spacer()

            Button(action: {
                liked = liked == true ? nil : true
                onFeedback?(true)
            }) {
                Image(systemName: liked == true ? "hand.thumbsup.fill" : "hand.thumbsup")
                    .font(TriosType.font(12, weight: .medium, design: .default))
                    .foregroundColor(liked == true ? .grokText : .grokDim)
            }
            .buttonStyle(PlainButtonStyle())
            .help("Good response")

            Button(action: {
                liked = liked == false ? nil : false
                onFeedback?(false)
            }) {
                Image(systemName: liked == false ? "hand.thumbsdown.fill" : "hand.thumbsdown")
                    .font(TriosType.font(12, weight: .medium, design: .default))
                    .foregroundColor(liked == false ? .grokText : .grokDim)
            }
            .buttonStyle(PlainButtonStyle())
            .help("Bad response")
        }
        .padding(.top, 4)
    }
}

// MARK: - Hover Copy Bar (ChatGPT / Claude pattern)

private struct HoverCopyBar: View {
    let content: String
    @State private var copied = false

    var body: some View {
        HStack(spacing: 12) {
            Button(action: {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(content, forType: .string)
                copied = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    copied = false
                }
            }) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(TriosType.font(11, weight: .medium, design: .default))
                    .foregroundColor(copied ? .grokText : .grokDim)
            }
            .buttonStyle(PlainButtonStyle())
            .help("Copy")

            Spacer()
        }
        .padding(.top, 2)
    }
}

