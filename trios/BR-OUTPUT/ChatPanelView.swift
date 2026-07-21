import SwiftUI

struct ChatPanelView: View {
    @ObservedObject var viewModel: ChatViewModel
    @StateObject private var browserOSVM = BrowserOSChatViewModel()
    @State private var isNearBottom = true
    @State private var scrollOffset: CGFloat = 0
    @State private var contentHeight: CGFloat = 0
    @State private var isInputFocused = false

    var body: some View {
        VStack(spacing: 0) {
            unifiedMessageArea
            unifiedInputBar
        }
        .background(Color.clear)
        .onAppear {
            browserOSVM.startPageDetection()
        }
        .onDisappear {
            browserOSVM.stopPageDetection()
        }
    }

    // MARK: - Unified Messages / Empty State

    private var unifiedMessageArea: some View {
        ScrollViewReader { proxy in
            ScrollView {
                scrollOffsetTracker

                if viewModel.messages.isEmpty && browserOSVM.messages.isEmpty {
                    emptyStateView
                } else {
                    messageStack
                }
            }
            .coordinateSpace(name: "scrollArea")
            .onPreferenceChange(ScrollOffsetPreferenceKey.self) { offset in
                scrollOffset = offset
            }
            .onPreferenceChange(ScrollContentHeightPreferenceKey.self) { totalHeight in
                contentHeight = totalHeight
                // If scroll offset + viewport height is close to total content height, we're near bottom
                let viewportHeight = scrollOffset.isZero ? totalHeight : abs(scrollOffset)
                isNearBottom = abs(totalHeight - viewportHeight) < 100
            }
            .onChange(of: viewModel.messages.count) {
                if isNearBottom, let last = viewModel.messages.last {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
            .onChange(of: viewModel.messages.last?.content) {
                if isNearBottom, let last = viewModel.messages.last {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
            .onChange(of: browserOSVM.messages.count) {
                if isNearBottom, let last = browserOSVM.messages.last {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    private var scrollOffsetTracker: some View {
        GeometryReader { geo in
            Color.clear
                .preference(key: ScrollOffsetPreferenceKey.self, value: geo.frame(in: .named("scrollArea")).minY)
        }
        .frame(height: 0)
    }

    private var contentHeightTracker: some View {
        GeometryReader { geo in
            Color.clear
                .preference(
                    key: ScrollContentHeightPreferenceKey.self,
                    value: geo.frame(in: .named("scrollArea")).maxY
                )
        }
        .frame(height: 0)
    }

    private var messageStack: some View {
        LazyVStack(spacing: 0) {
            localMessageList
            if shouldShowBrowserSeparator {
                browserSeparator
            }
            browserMessageList
            typingIndicatorArea
            contentHeightTracker
        }
    }

    private var shouldShowBrowserSeparator: Bool {
        // Only separate when there is actual BrowserOS activity (messages
        // or an active command/stream), not when the pane is merely idle.
        if !browserOSVM.messages.isEmpty { return !viewModel.messages.isEmpty }
        return browserOSVM.isStreaming && !viewModel.messages.isEmpty
    }

    private var browserSeparator: some View {
        HStack(spacing: 8) {
            Rectangle()
                .fill(Color.grokDivider.opacity(0.5))
                .frame(height: 1)
            Image(systemName: "globe")
                .font(.system(size: 10))
                .foregroundColor(.grokDim)
            Text("BrowserOS")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.grokDim)
            Rectangle()
                .fill(Color.grokDivider.opacity(0.5))
                .frame(height: 1)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // CRITICAL: snapshot the array once. Indexing the live
    // `viewModel.messages` by an enumerated index crashes
    // (EXC_BREAKPOINT) when the array mutates mid-render
    // (streaming append, regenerate, conversation switch) -
    // the snapshot index then exceeds the shrunk live array.
    private var localMessageList: some View {
        let localMessages = viewModel.messages
        return ForEach(Array(localMessages.enumerated()), id: \.element.id) { index, message in
            let isFirstInGroup = index == 0 || localMessages[index - 1].role != message.role
            let isLastInGroup = index == localMessages.count - 1 || localMessages[index + 1].role != message.role

            MessageBubbleView(
                message: message,
                isFirstInGroup: isFirstInGroup,
                isLastInGroup: isLastInGroup,
                isConversationIdle: viewModel.state == .idle,
                onTaskAction: { taskId, state in
                    Task { await viewModel.updateTaskState(id: taskId, state: state) }
                },
                onRegenerate: {
                    Task { await viewModel.regenerateLastResponse() }
                },
                onFeedback: { isPositive in
                    Task { await viewModel.sendFeedback(messageId: message.id, isPositive: isPositive) }
                }
            )
            .id(message.id)
        }
    }

    private var browserMessageList: some View {
        let browserMessages = browserOSVM.messages
        return ForEach(Array(browserMessages.enumerated()), id: \.element.id) { index, message in
            let isFirst = index == 0 || browserMessages[index - 1].role != message.role
            let isLast = index == browserMessages.count - 1 || browserMessages[index + 1].role != message.role
            BrowserOSMessageBubble(
                message: message,
                isFirstInGroup: isFirst,
                isLastInGroup: isLast,
                isConversationIdle: !browserOSVM.isStreaming
            )
            .id(message.id)
        }
    }

    // Typing indicators: only while actively streaming, not on error/idle.
    // Show a labeled wrapper so the user knows *which* agent is typing.
    private var typingIndicatorArea: some View {
        VStack(alignment: .leading, spacing: 2) {
            if case .streaming = viewModel.state {
                typingIndicatorRow(label: "TRIOS Agent")
                    .id("typing-local")
            }
            if browserOSVM.isStreaming {
                typingIndicatorRow(label: "BrowserOS Agent")
                    .id("typing-browseros")
            }
        }
    }

    private func typingIndicatorRow(label: String) -> some View {
        HStack(spacing: 8) {
            TypingIndicatorView()
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.grokDim)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private var emptyStateView: some View {
        VStack(spacing: 24) {
            Spacer()

            logoView(size: CGSize(width: 52, height: 44))

            Text("TRIOS")
                .font(.system(size: 36, weight: .bold, design: .default))
                .foregroundColor(.grokText)

            Text("How can I help?")
                .font(.system(size: 16, weight: .regular, design: .default))
                .foregroundColor(.grokMuted)

            VStack(spacing: 8) {
                suggestedPromptChip("Open google.com in BrowserOS")
                suggestedPromptChip("Take a screenshot of current page")
                suggestedPromptChip("Run /doctor to check build health")
                suggestedPromptChip("Show Queen status overview")
                suggestedPromptChip("Clear this conversation /new")
            }
            .padding(.top, 8)

            statusHintList
                .padding(.top, 16)

            Spacer()
        }
        .padding(.vertical, 60)
    }

    private var statusHintList: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !viewModel.isServerReachable {
                emptyStateHint(
                    icon: "exclamationmark.triangle.fill",
                    text: "BrowserOS Agent offline. Start: BROWSEROS_SERVER_PORT=\(ProjectPaths.mcpPort) bun run --cwd apps/server start:ci",
                    color: .yellow
                )
            }
            if !isAPIKeyConfigured {
                emptyStateHint(
                    icon: "key.fill",
                    text: "Set TRIOS_API_KEY for paid providers. Ollama works without a key.",
                    color: .grokDim
                )
            }
        }
        .padding(.horizontal, 24)
    }

    private func emptyStateHint(icon: String, text: String, color: Color) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 11))
                .foregroundColor(color)
                .padding(.top, 2)
            Text(text)
                .font(.system(size: 12))
                .foregroundColor(.grokDim)
                .multilineTextAlignment(.leading)
            Spacer()
        }
    }

    private func suggestedPromptChip(_ text: String) -> some View {
        Button(action: {
            if text.hasSuffix("/new") {
                viewModel.newConversation()
                browserOSVM.messages.removeAll()
                return
            }
            viewModel.inputText = text
            triggerSend()
        }) {
            Text(text)
                .font(.system(size: 12))
                .foregroundColor(.grokDim)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Color.grokElevated.opacity(0.5))
                .cornerRadius(16)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Unified Input Bar

    private var unifiedInputBar: some View {
        VStack(spacing: 0) {
            Divider().overlay(Color.grokDivider)
            HStack(spacing: 12) {
                connectionStatusDot

                ZStack(alignment: .topLeading) {
                    MacTextEditor(
                        text: $viewModel.inputText,
                        isFocused: $isInputFocused,
                        onSubmit: { triggerSend() }
                    )
                    .frame(minHeight: 28, maxHeight: 120)
                    .onAppear {
                        DispatchQueue.main.async {
                            isInputFocused = true
                        }
                    }

                    if viewModel.inputText.isEmpty {
                        Text(inputPlaceholder)
                            .font(.system(size: NSFont.systemFontSize))
                            .foregroundColor(.grokDim)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 4)
                            .allowsHitTesting(false)
                    }
                }

                Button(action: {
                    NSLog("[ChatPanel] send button clicked")
                    triggerSend()
                }) {
                    Image(systemName: sendButtonIcon)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(sendButtonForeground)
                        .frame(width: 32, height: 32)
                        .background(
                            Circle()
                                .fill(sendButtonBackground)
                        )
                }
                .buttonStyle(PlainButtonStyle())
                .disabled(sendButtonDisabled)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            if let hint = statusHint {
                statusHintBar(hint)
            }
        }
        .padding(.bottom, 20)
    }

    private var inputPlaceholder: String {
        if !viewModel.isServerReachable {
            return "Server offline — check BrowserOS Agent..."
        }
        if !isAPIKeyConfigured {
            return "Add TRIOS_API_KEY to send to paid providers..."
        }
        return "Ask anything..."
    }

    private var connectionStatusDot: some View {
        StatusDot(
            isOn: viewModel.isServerReachable,
            label: nil,
            color: viewModel.isServerReachable ? .green : .red
        )
        .help(viewModel.isServerReachable
            ? "BrowserOS Agent server is reachable on port \(ProjectPaths.mcpPort)"
            : "BrowserOS Agent server is not reachable on port \(ProjectPaths.mcpPort)")
    }

    private var isAPIKeyConfigured: Bool {
        guard let key = ProcessInfo.processInfo.environment["TRIOS_API_KEY"] else { return false }
        return !key.isEmpty
    }

    private var statusHint: StatusHint? {
        if !viewModel.isServerReachable {
            return StatusHint(
                icon: "exclamationmark.triangle.fill",
                text: "BrowserOS Agent offline — start it or check port \(ProjectPaths.mcpPort).",
                color: .yellow
            )
        }
        if !isAPIKeyConfigured {
            return StatusHint(
                icon: "key.fill",
                text: "No TRIOS_API_KEY. Local Ollama works; paid providers need a key.",
                color: .grokDim
            )
        }
        return nil
    }

    private func statusHintBar(_ hint: StatusHint) -> some View {
        HStack(spacing: 6) {
            Image(systemName: hint.icon)
                .font(.system(size: 10))
                .foregroundColor(hint.color)
            Text(hint.text)
                .font(.system(size: 11))
                .foregroundColor(.grokDim)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private var sendButtonIcon: String {
        let isSending = viewModel.state != .idle || browserOSVM.isStreaming
        return isSending ? "stop.fill" : "arrow.up"
    }

    private var sendButtonForeground: Color {
        let trimmed = viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        if viewModel.state != .idle || browserOSVM.isStreaming { return .grokText }
        return trimmed.isEmpty ? .grokDim : .grokText
    }

    private var sendButtonBackground: Color {
        let trimmed = viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        if viewModel.state != .idle || browserOSVM.isStreaming { return Color.red.opacity(0.25) }
        return trimmed.isEmpty ? Color.clear : Color.grokElevated
    }

    private var sendButtonDisabled: Bool {
        let trimmed = viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty && viewModel.state == .idle && !browserOSVM.isStreaming
    }

    private func triggerSend() {
        let text = viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        NSLog("[ChatPanel] triggerSend called, text='\(text.prefix(40))', isEmpty=\(text.isEmpty)")

        // If streaming is active, the send button becomes a stop button.
        if viewModel.state != .idle || browserOSVM.isStreaming {
            NSLog("[ChatPanel] stopping active stream")
            viewModel.cancelStreaming()
            browserOSVM.cancelStreaming()
            return
        }

        guard !text.isEmpty else { return }

        if browserOSVM.isLikelyCommand(text) {
            NSLog("[ChatPanel] routing to BrowserOS command")
            viewModel.inputText = ""
            browserOSVM.sendMessage(text)
        } else {
            NSLog("[ChatPanel] routing to ChatViewModel.sendMessage")
            Task { await viewModel.sendMessage() }
        }
    }
}

// MARK: - MacTextEditor (NSTextView Wrapper)

final class ChatInputTextView: NSTextView {
    var onSubmit: (() -> Void)?

    // Use the standard responder command path for Enter instead of raw keyDown.
    // Intercepting keyDown breaks input-method composition on non-US layouts
    // (observed as Latin chars being replaced by placeholder Cyrillic glyphs).
    override func doCommand(by selector: Selector) {
        switch selector {
        case #selector(NSResponder.insertNewline(_:)),
             #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)),
             #selector(NSTextView.insertLineBreak(_:)):
            if NSEvent.modifierFlags.contains(.shift) {
                super.doCommand(by: selector)
                return
            }
            NSLog("[ChatInput] Enter command triggered - calling onSubmit")
            onSubmit?()
            return
        default:
            super.doCommand(by: selector)
        }
    }
}

struct MacTextEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    var onSubmit: () -> Void

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.hasHorizontalScroller = false
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder

        let textView = ChatInputTextView()
        textView.onSubmit = onSubmit
        textView.isRichText = false
        textView.isEditable = true
        textView.isSelectable = true
        textView.isFieldEditor = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.font = NSFont.systemFont(ofSize: NSFont.systemFontSize)
        textView.textColor = NSColor.white
        textView.insertionPointColor = NSColor.white
        textView.string = text
        textView.delegate = context.coordinator
        textView.autoresizingMask = [.width, .height]

        // Register for WindowManager first-responder hook
        WindowManager.inputFirstResponder = textView

        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        guard let textView = nsView.documentView as? ChatInputTextView else { return }
        if textView.string != text {
            let selected = textView.selectedRanges
            textView.string = text
            textView.selectedRanges = selected
        }
        if isFocused, let window = textView.window, window.firstResponder != textView {
            window.makeFirstResponder(textView)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MacTextEditor

        init(_ parent: MacTextEditor) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }
    }
}

// MARK: - Scroll Offset Tracking

struct ScrollOffsetPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

struct ScrollContentHeightPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

// MARK: - Logo Helper

private func logoView(size: CGSize) -> some View {
    Group {
        if let svgURL = Bundle.main.url(forResource: "logo", withExtension: "svg"),
           let nsImage = NSImage(contentsOf: svgURL) {
            Image(nsImage: nsImage)
                .resizable()
                .renderingMode(.template)
                .aspectRatio(contentMode: .fit)
                .frame(width: size.width, height: size.height)
                .foregroundColor(.grokText)
        } else if let pngURL = Bundle.main.url(forResource: "logo", withExtension: "png"),
                  let nsImage = NSImage(contentsOf: pngURL) {
            Image(nsImage: nsImage)
                .resizable()
                .renderingMode(.template)
                .aspectRatio(contentMode: .fit)
                .frame(width: size.width, height: size.height)
                .foregroundColor(.grokText)
        } else if FileManager.default.fileExists(atPath: ProjectPaths.logoSVG),
                  let nsImage = NSImage(contentsOfFile: ProjectPaths.logoSVG) {
            Image(nsImage: nsImage)
                .resizable()
                .renderingMode(.template)
                .aspectRatio(contentMode: .fit)
                .frame(width: size.width, height: size.height)
                .foregroundColor(.grokText)
        } else if FileManager.default.fileExists(atPath: ProjectPaths.logoPNG) {
            Image(nsImage: NSImage(contentsOfFile: ProjectPaths.logoPNG) ?? NSImage())
                .resizable()
                .renderingMode(.template)
                .aspectRatio(contentMode: .fit)
                .frame(width: size.width, height: size.height)
                .foregroundColor(.grokText)
        }
    }
}

// MARK: - BrowserOS Message Bubble

private struct BrowserOSMessageBubble: View {
    let message: BrowserOSChatMessage
    let isFirstInGroup: Bool
    let isLastInGroup: Bool
    let isConversationIdle: Bool

    private var isError: Bool {
        message.role == .system
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if message.role == .user || isError { Spacer(minLength: 4) }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 2) {
                if isFirstInGroup {
                    senderLabel
                }

                if isError {
                    errorBadge
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        RichMessageView(text: message.content, isUser: message.role == .user)
                            .font(.system(size: 14, weight: .regular, design: .default))
                            .padding(12)
                            .background(
                                message.role == .user
                                    ? Color.grokElevated.opacity(0.8)
                                    : Color.grokSurface.opacity(0.6)
                            )
                            .foregroundColor(.grokText)
                            .cornerRadius(16)
                        if !message.toolCalls.isEmpty {
                            ForEach(message.toolCalls, id: \.name) { tool in
                                BrowserOSToolCallCard(tool: tool)
                            }
                        }
                    }
                }

                if isLastInGroup {
                    timestampView
                }
            }

            if message.role == .assistant { avatarView }
            else { Spacer(minLength: 4) }
        }
        .padding(.horizontal, 12)
        .padding(.top, isFirstInGroup ? 12 : 2)
        .padding(.bottom, isLastInGroup ? 8 : 2)
    }

    private var avatarView: some View {
        Image(systemName: "person.fill")
            .font(.system(size: 12, weight: .medium))
            .foregroundColor(.grokMuted)
            .frame(width: 24, height: 24)
            .background(Circle().fill(Color.grokElevated.opacity(0.3)))
    }

    private var senderLabel: some View {
        Text(isError ? "TRIOS Agent" : (message.role == .user ? "You" : "TRIOS Agent"))
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(.grokMuted)
            .padding(.bottom, 2)
    }

    private var timestampView: some View {
        Text(message.timestamp, style: .relative)
            .font(.system(size: 9))
            .foregroundColor(.grokDim)
            .padding(.top, 2)
    }

    private var errorBadge: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 12))
                .foregroundColor(.yellow)
            Text(BrowserOSMessageBubble.cleanErrorContent(message.content))
                .font(.system(size: 13, weight: .medium, design: .default))
                .foregroundColor(.grokText)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.red.opacity(0.15))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.red.opacity(0.4), lineWidth: 1)
        )
        .cornerRadius(10)
    }

    private static func cleanErrorContent(_ content: String) -> String {
        var cleaned = content
        if cleaned.hasPrefix("[!] ") {
            cleaned = String(cleaned.dropFirst(4))
        }
        cleaned = cleaned.replacingOccurrences(of: "⚠️ ", with: "")
        return cleaned
    }
}

private struct BrowserOSToolCallCard: View {
    let tool: BrowserOSToolCall
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: "hammer.fill")
                    .foregroundColor(.grokMuted)
                    .font(.caption)
                Text(tool.name)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.grokText)
                Spacer()
                Button(action: { isExpanded.toggle() }) {
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption2)
                        .foregroundColor(.grokMuted)
                }
                .buttonStyle(.plain)
            }
            if isExpanded, let result = tool.result {
                Text(result)
                    .font(.system(size: 11))
                    .foregroundColor(.grokMuted)
                    .padding(6)
                    .background(Color.grokElevated.opacity(0.4))
                    .cornerRadius(6)
            }
        }
        .padding(8)
        .background(Color.grokSurface.opacity(0.4))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.grokBorder.opacity(0.3), lineWidth: 1)
        )
    }
}

// MARK: - Status Dot

private struct StatusDot: View {
    let isOn: Bool
    let label: String?
    let color: Color

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(isOn ? color : Color.grokDim)
                .frame(width: 6, height: 6)
            if let label = label {
                Text(label)
                    .font(.system(size: 11, weight: .medium, design: .default))
                    .foregroundColor(.grokMuted)
            }
        }
    }
}

// MARK: - Status Hint Model

private struct StatusHint: Equatable {
    let icon: String
    let text: String
    let color: Color
}
