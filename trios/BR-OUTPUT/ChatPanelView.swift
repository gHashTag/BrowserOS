// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: FULLSCREEN-CHAT-001 resets transient BrowserOS state on task switch.
// Follow-up: seal against .trinity/specs/fullscreen-chat-history.md.
import AppKit
import SwiftUI
import UniformTypeIdentifiers
// Queen Master Chat imports
import Foundation

private enum ChatScrollAnchor {
    static let bottom = "chat-final-content-anchor"
}

struct ChatPanelView: View {
    @ObservedObject var viewModel: ChatViewModel
    @EnvironmentObject private var modelStore: ModelConfigurationStore
    let scrollToBottomRequest: Int
    var workspaceMode: ChatWorkspaceMode = .compact
    @StateObject private var browserOSVM = BrowserOSChatViewModel()
    @StateObject private var queenVM = QueenMasterViewModel()
    @ObservedObject var intelligenceEngine: QueenIntelligenceEngine
    
    init(viewModel: ChatViewModel,
         scrollToBottomRequest: Int,
         workspaceMode: ChatWorkspaceMode = .compact,
         intelligenceEngine: QueenIntelligenceEngine) {
        self.viewModel = viewModel
        self.scrollToBottomRequest = scrollToBottomRequest
        self.workspaceMode = workspaceMode
        self.intelligenceEngine = intelligenceEngine
    }
    @State private var isNearBottom = true
    @State private var scrollOffset: CGFloat = 0
    @State private var contentHeight: CGFloat = 0
    @State private var isInputFocused = false
    @State private var composerEditorHeight: CGFloat = 42
    @State private var showHotkeyHelp = false
    @State private var isExportingRecovery = false
    @State private var recoveryNotice: SessionRecoveryNotice?
    @State private var composerAttachments: [ChatComposerAttachment] = []
    @State private var isAttachmentDropTargeted = false
    @State private var pendingAttachmentImports = 0
    @State private var attachmentNotice: String?
    @State private var attachmentImportGeneration = UUID()
    @StateObject private var scrollManager = SmoothScrollManager()
    @StateObject private var batchUpdater = MessageBatchUpdater()
    @StateObject private var throttle = StreamingThrottle()
    private let attachmentImporter = ChatAttachmentImporter()

    // Manual previous-value tracking for .onChange compatibility with the
    // swiftc-based build path, which does not consistently expose the two-arg
    // (oldValue, newValue) overload across all deployment targets.
    @State private var previousMessageCount = 0
    @State private var previousLastContent: String? = nil
    @State private var previousBrowserMessageCount = 0

    var body: some View {
        VStack(spacing: 0) {
            unifiedMessageArea
            queenActivityFeed
            unifiedInputBar
        }
        .background(Color.clear)
        .onAppear {
            browserOSVM.startPageDetection()
        }
        .onDisappear {
            browserOSVM.stopPageDetection()
        }
        .onReceive(NotificationCenter.default.publisher(for: .exportSessionRecoveryPackage)) { _ in
            exportRecoveryPackage()
        }
        .onChange(of: viewModel.conversationId) {
            browserOSVM.cancelStreaming()
            browserOSVM.messages.removeAll()
            clearComposerAttachments()
        }
        .alert(item: $recoveryNotice) { notice in
            Alert(
                title: Text(notice.title),
                message: Text(notice.message),
                dismissButton: .default(Text("OK"))
            )
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
            .onAppear {
                scrollToBottom(using: proxy, animated: false)
            }
            .onChange(of: scrollToBottomRequest) {
                scrollToBottom(using: proxy, animated: false)
            }
            .onPreferenceChange(ScrollOffsetPreferenceKey.self) { offset in
                scrollOffset = offset
            }
            .onPreferenceChange(ScrollContentHeightPreferenceKey.self) { totalHeight in
                contentHeight = totalHeight
                // If scroll offset + viewport height is close to total content height, we're near bottom
                let viewportHeight = scrollOffset.isZero ? totalHeight : abs(scrollOffset)
                isNearBottom = abs(totalHeight - viewportHeight) < 100
            }
            .onChange(of: viewModel.messages.count) { newCount in
                // Scroll only when a brand-new message is appended.
                if newCount > previousMessageCount && isNearBottom {
                    scrollManager.requestScroll(animated: true)
                }
                previousMessageCount = newCount
            }
            .onChange(of: viewModel.messages.last?.content) { newContent in
                // Throttled scroll during streaming: react only when the last
                // message content actually changed.
                if isNearBottom && newContent != previousLastContent {
                    scrollManager.requestScroll(animated: true)
                }
                previousLastContent = newContent
            }
            .onChange(of: browserOSVM.messages.count) { newCount in
                if newCount > previousBrowserMessageCount && isNearBottom {
                    scrollManager.requestScroll(animated: true)
                }
                previousBrowserMessageCount = newCount
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
            Color.clear
                .frame(height: 1)
                .id(ChatScrollAnchor.bottom)
        }
    }

    private func scrollToBottom(using proxy: ScrollViewProxy, animated: Bool) {
        isNearBottom = true
        DispatchQueue.main.async {
            if animated {
                // Используем smooth scroll с spring animation
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    proxy.scrollTo(ChatScrollAnchor.bottom, anchor: .bottom)
                }
            } else {
                proxy.scrollTo(ChatScrollAnchor.bottom, anchor: .bottom)
            }
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

            if shouldRenderMessageBubble(message) {
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
                // Stable ID prevents view recreation during streaming updates.
                .id("\(message.id.uuidString)-\(message.role.rawValue)")
            }
        }
    }

    private func shouldRenderMessageBubble(_ message: ChatMessage) -> Bool {
        guard message.role == .assistant else { return true }
        let timelineItemCount = AssistantTimelineBuilder.build(
            content: message.content,
            segments: message.segments,
            toolCalls: message.toolCalls
        ).count
        return ChatLoadingIndicatorLayout.shouldRenderAssistantBubble(
            isStreaming: message.isStreaming,
            timelineItemCount: timelineItemCount
        )
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
            if ChatLoadingIndicatorLayout.rendersInChatStream {
                if case .streaming = viewModel.state {
                    typingIndicatorRow(label: TriosBranding.localTypingLabel)
                        .id("typing-local")
                }
                if browserOSVM.isStreaming {
                    typingIndicatorRow(label: "BrowserOS Agent")
                        .id("typing-browseros")
                }
            }
        }
    }

    private func typingIndicatorRow(label: String?) -> some View {
        HStack(spacing: 8) {
            TypingIndicatorView(color: responseIndicatorColor)
            if let label {
                Text(label)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(responseIndicatorColor)
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private var responseIndicatorColor: Color {
        switch ChatLoadingIndicatorLayout.foregroundTone {
        case .white:
            return .white
        }
    }

    private var emptyStateView: some View {
        VStack(spacing: 24) {
            Spacer()

            logoView(size: CGSize(width: 52, height: 44))

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
                viewModel.inputText = ""
                browserOSVM.messages.removeAll()
                clearComposerAttachments()
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

    private var composerMetrics: ChatComposerMetrics {
        ChatComposerStyle.metrics(for: workspaceMode)
    }

    private var composerStatusMetrics: ChatComposerStatusMetrics {
        ChatComposerStatusStyle.metrics(for: workspaceMode)
    }

    private var resolvedEditorHeight: CGFloat {
        min(
            CGFloat(composerMetrics.editorMaximumHeight),
            max(CGFloat(composerMetrics.editorMinimumHeight), composerEditorHeight)
        )
    }

    private var unifiedInputBar: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                if !composerAttachments.isEmpty || pendingAttachmentImports > 0 {
                    composerAttachmentStrip
                }
                composerEditor
                if let attachmentNotice {
                    HStack(spacing: 5) {
                        Image(systemName: "exclamationmark.circle.fill")
                        Text(attachmentNotice)
                            .lineLimit(2)
                    }
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.orange.opacity(0.9))
                    .transition(.opacity)
                }
                composerToolbar
            }
            .padding(CGFloat(composerMetrics.contentPadding))
            .background {
                ZStack {
                    GlassmorphismBackground(
                        material: .underWindowBackground,
                        blending: .withinWindow,
                        cornerRadius: CGFloat(composerMetrics.cornerRadius)
                    )
                    Color.black.opacity(composerMetrics.blackOverlayOpacity)
                }
                .clipShape(
                    RoundedRectangle(
                        cornerRadius: CGFloat(composerMetrics.cornerRadius),
                        style: .continuous
                    )
                )
            }
            .overlay {
                ZStack {
                    RoundedRectangle(
                        cornerRadius: CGFloat(composerMetrics.cornerRadius),
                        style: .continuous
                    )
                    .stroke(Color.grokBorder, lineWidth: 1)

                    if isAttachmentDropTargeted {
                        attachmentDropOverlay
                    }
                }
            }
            .shadow(color: Color.triosGlassShadow, radius: 18, x: 0, y: 8)
            .contentShape(
                RoundedRectangle(
                    cornerRadius: CGFloat(composerMetrics.cornerRadius),
                    style: .continuous
                )
            )
            .onDrop(
                of: [UTType.fileURL.identifier, UTType.image.identifier],
                isTargeted: $isAttachmentDropTargeted,
                perform: importDroppedAttachments
            )
        }
        .padding(.horizontal, CGFloat(composerMetrics.horizontalInset))
        .padding(.bottom, CGFloat(composerMetrics.bottomInset))
        .sheet(isPresented: $showHotkeyHelp) {
            HotkeyHelpOverlay(isPresented: $showHotkeyHelp)
        }
    }

    private var composerAttachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(composerAttachments) { attachment in
                    composerAttachmentCard(attachment)
                }
                if pendingAttachmentImports > 0 {
                    HStack(spacing: 7) {
                        ProgressView()
                            .controlSize(.small)
                            .tint(.white)
                        Text("Adding \(pendingAttachmentImports)")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundColor(.white.opacity(0.7))
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 44)
                    .background(Color.white.opacity(0.055))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
        }
        .frame(height: 46)
        .accessibilityLabel("Pending attachments")
    }

    private func composerAttachmentCard(_ attachment: ChatComposerAttachment) -> some View {
        HStack(spacing: 8) {
            attachmentPreview(attachment)

            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.displayName)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.white.opacity(0.9))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(formatBytes(attachment.byteCount))
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundColor(.white.opacity(0.42))
            }
            .frame(maxWidth: 118, alignment: .leading)

            Button {
                removeAttachment(attachment)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(.white.opacity(0.68))
                    .frame(width: 20, height: 20)
                    .background(Circle().fill(Color.white.opacity(0.07)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(attachment.displayName)")
        }
        .padding(.leading, 4)
        .padding(.trailing, 7)
        .frame(height: 44)
        .background(Color.white.opacity(0.055))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.white.opacity(0.1), lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .help(attachment.url.path)
    }

    @ViewBuilder
    private func attachmentPreview(_ attachment: ChatComposerAttachment) -> some View {
        if attachment.kind == .image, let image = NSImage(contentsOf: attachment.url) {
            Image(nsImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 36, height: 36)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        } else {
            Image(systemName: attachment.kind == .image ? "photo" : "doc.fill")
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(.white.opacity(0.72))
                .frame(width: 36, height: 36)
                .background(Color.white.opacity(0.065))
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
    }

    private var attachmentDropOverlay: some View {
        ZStack {
            RoundedRectangle(
                cornerRadius: CGFloat(composerMetrics.cornerRadius),
                style: .continuous
            )
            .fill(Color.black.opacity(0.78))
            RoundedRectangle(
                cornerRadius: CGFloat(composerMetrics.cornerRadius),
                style: .continuous
            )
            .strokeBorder(
                Color.white.opacity(0.88),
                style: StrokeStyle(lineWidth: 1.5, dash: [7, 5])
            )
            HStack(spacing: 9) {
                Image(systemName: "tray.and.arrow.down.fill")
                    .font(.system(size: 17, weight: .semibold))
                Text("Drop files or images")
                    .font(.system(size: 13, weight: .semibold))
            }
            .foregroundColor(.white)
        }
        .allowsHitTesting(false)
        .transition(.opacity)
    }

    private var composerEditor: some View {
        ZStack(alignment: .topLeading) {
            MacTextEditor(
                text: $viewModel.inputText,
                isFocused: $isInputFocused,
                dynamicHeight: $composerEditorHeight,
                minimumHeight: CGFloat(composerMetrics.editorMinimumHeight),
                maximumHeight: CGFloat(composerMetrics.editorMaximumHeight),
                onSubmit: { triggerSend() },
                onFileDrop: { urls in
                    urls.forEach(importAttachmentURL)
                },
                messageHistory: viewModel.messageHistory,
                onHotkeyPressed: { hotkey in
                    NSLog("[ChatPanel] Hotkey pressed: \(hotkey)")
                    if hotkey == "help" {
                        showHotkeyHelp = true
                    }
                }
            )
            .frame(height: resolvedEditorHeight)
            .onChange(of: viewModel.inputText) { _, newValue in
                NSLog("[ChatPanel] inputText changed: '\(newValue.prefix(40))'")
            }
            .onAppear {
                DispatchQueue.main.async {
                    isInputFocused = true
                }
            }

            if viewModel.inputText.isEmpty {
                Text(inputPlaceholder)
                    .font(.system(size: 15, weight: .regular))
                    .foregroundColor(.white.opacity(0.42))
                    .padding(.horizontal, 1)
                    .padding(.vertical, 5)
                    .allowsHitTesting(false)
            }
        }
    }

    private var composerToolbar: some View {
        HStack(spacing: CGFloat(composerStatusMetrics.itemSpacing)) {
            composerActionMenu
            composerStatusControl

            if workspaceMode == .expanded {
                composerInlineDivider
            }

            composerTokenStatus

            if workspaceMode == .expanded {
                composerInlineDivider
            }

            composerRecoveryControl

            Spacer(minLength: 3)

            composerConnectionStatus

            Button(action: {
                NSLog("[ChatPanel] send button clicked")
                triggerSend()
            }) {
                Image(systemName: sendButtonIcon)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(sendButtonForeground)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(sendButtonBackground))
            }
            .buttonStyle(.plain)
            .disabled(sendButtonDisabled)
            .help(viewModel.state != .idle || browserOSVM.isStreaming ? "Stop response" : "Send message")
        }
        .frame(height: max(34, CGFloat(composerStatusMetrics.controlHeight)))
    }

    private var composerActionMenu: some View {
        Menu {
            Button("Attach files...") {
                chooseAttachments()
            }
            .keyboardShortcut("o", modifiers: [.command, .shift])
            Divider()
            Button("New task") {
                viewModel.newConversation()
                browserOSVM.messages.removeAll()
                clearComposerAttachments()
            }
            Button("Clear input") {
                viewModel.inputText = ""
                clearComposerAttachments()
                isInputFocused = true
            }
            .disabled(viewModel.inputText.isEmpty && composerAttachments.isEmpty)
            Divider()
            Button("Keyboard shortcuts") {
                showHotkeyHelp = true
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(.white.opacity(0.88))
                .frame(width: 32, height: 32)
                .background(Circle().fill(Color.white.opacity(0.075)))
                .overlay {
                    Circle().stroke(Color.white.opacity(0.12), lineWidth: 1)
                }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Composer actions")
    }

    private var composerStatusControl: some View {
        Menu {
            Section(modelStore.selectedProvider.displayName) {
                ForEach(Array(modelStore.availableModels.prefix(24)), id: \.self) { model in
                    Button {
                        modelStore.selectModel(model)
                    } label: {
                        if model == modelStore.selectedModel {
                            Label(model, systemImage: "checkmark")
                        } else {
                            Text(model)
                        }
                    }
                }
            }
            Divider()
            Button("Refresh available models") {
                Task { await modelStore.refreshModels() }
            }
            .disabled(modelStore.selectedProvider.requiresAPIKey && !modelStore.hasAPIKey)
            Button("Manage models & API keys") {
                modelStore.requestModelsTab()
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "cpu")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.white.opacity(0.62))
                Text(composerModelLabel)
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)
            }
            .font(.system(size: 10, design: .monospaced))
            .foregroundColor(.white.opacity(0.72))
            .padding(.horizontal, 9)
            .frame(
                maxWidth: workspaceMode == .expanded ? 260 : 138,
                minHeight: CGFloat(composerStatusMetrics.controlHeight)
            )
            .background(Color.white.opacity(0.045))
            .clipShape(Capsule())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .help(composerStatusHelp)
    }

    private var composerModelLabel: String {
        if composerStatusMetrics.showsProviderName {
            return "\(modelStore.selectedProvider.displayName) - \(modelStore.selectedModel)"
        }
        return modelStore.selectedModel
    }

    private var composerTokenStatus: some View {
        HStack(spacing: 4) {
            Image(systemName: "chart.bar.xaxis")
                .font(.system(size: 10, weight: .medium))
            Text(composerStatusMetrics.showsTokenBreakdown
                ? viewModel.tokenUsage.compactBreakdown
                : viewModel.tokenUsage.compactTotal)
                .fontWeight(.semibold)
                .lineLimit(1)
        }
        .font(.system(size: 9, design: .monospaced))
        .foregroundColor(.white.opacity(0.52))
        .frame(height: CGFloat(composerStatusMetrics.controlHeight))
        .help(viewModel.tokenUsage.detailText)
        .accessibilityLabel("Token usage: \(viewModel.tokenUsage.detailText)")
    }

    private var composerRecoveryControl: some View {
        Button(action: exportRecoveryPackage) {
            HStack(spacing: 5) {
                if isExportingRecovery {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 12, height: 12)
                } else {
                    Image(systemName: "square.and.arrow.down")
                        .font(.system(size: 11, weight: .medium))
                }
                if workspaceMode == .expanded {
                    Text("Recovery")
                }
            }
            .font(.system(size: 9, weight: .semibold, design: .monospaced))
            .foregroundColor(.white.opacity(0.62))
            .frame(minWidth: 24)
            .frame(height: CGFloat(composerStatusMetrics.controlHeight))
        }
        .buttonStyle(.plain)
        .disabled(isExportingRecovery)
        .keyboardShortcut("e", modifiers: [.command, .shift])
        .accessibilityLabel("Export session recovery package")
        .help("Export complete chat, context, tool history, and detailed logs")
    }

    private var composerConnectionStatus: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(viewModel.isServerReachable ? Color.green : Color.red)
                .frame(width: 6, height: 6)
            Circle()
                .fill(browserOSVM.isBrowserOSConnected ? Color.green : Color.orange)
                .frame(width: 6, height: 6)
            if composerStatusMetrics.showsCDPLabel {
                Text("CDP 9102")
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundColor(.white.opacity(0.52))
            }
        }
        .frame(height: CGFloat(composerStatusMetrics.controlHeight))
        .help("Trinity \(viewModel.isServerReachable ? "online" : "offline"); BrowserOS \(browserOSVM.isBrowserOSConnected ? "connected" : "connecting")")
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Trinity \(viewModel.isServerReachable ? "online" : "offline"), BrowserOS \(browserOSVM.isBrowserOSConnected ? "connected" : "connecting")")
    }

    private var composerInlineDivider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.1))
            .frame(width: 1, height: 14)
    }

    private var inputPlaceholder: String {
        if !composerAttachments.isEmpty {
            return "Add instructions..."
        }
        if !viewModel.isServerReachable {
            return "Reconnect BrowserOS Agent..."
        }
        return TriosBranding.messagePlaceholder
    }

    private var composerStatusHelp: String {
        if let hint = statusHint { return hint.text }
        return "\(modelStore.selectedProvider.displayName) / \(modelStore.selectedModel) - \(viewModel.tokenUsage.detailText)"
    }

    private var isAPIKeyConfigured: Bool {
        modelStore.hasAPIKey
    }

    private var statusHint: StatusHint? {
        if !viewModel.isServerReachable {
            return StatusHint(
                icon: "exclamationmark.triangle.fill",
                text: "BrowserOS Agent offline — start it or check port \(ProjectPaths.mcpPort).",
                color: .yellow
            )
        }
        if modelStore.selectedProvider.requiresAPIKey && !isAPIKeyConfigured {
            return StatusHint(
                icon: "key.fill",
                text: "No \(modelStore.selectedProvider.displayName) API key. Open Models to add one securely.",
                color: .grokDim
            )
        }
        return nil
    }

    private var sendButtonIcon: String {
        let isSending = viewModel.state != .idle || browserOSVM.isStreaming
        return isSending ? "stop.fill" : "arrow.up"
    }

    private var sendButtonForeground: Color {
        let trimmed = viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        if viewModel.state != .idle || browserOSVM.isStreaming { return .white }
        return trimmed.isEmpty && composerAttachments.isEmpty ? Color.white.opacity(0.38) : .black
    }

    private var sendButtonBackground: Color {
        let trimmed = viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        if viewModel.state != .idle || browserOSVM.isStreaming { return Color.red.opacity(0.82) }
        return trimmed.isEmpty && composerAttachments.isEmpty ? Color.white.opacity(0.09) : .white
    }

    private var sendButtonDisabled: Bool {
        let trimmed = viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty
            && composerAttachments.isEmpty
            && viewModel.state == .idle
            && !browserOSVM.isStreaming
    }

    private func triggerSend() {
        let text = viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = composerAttachments
        NSLog("[ChatPanel] triggerSend called, textLength=\(text.count), attachments=\(attachments.count)")

        // If streaming is active, the send button becomes a stop button.
        if viewModel.state != .idle || browserOSVM.isStreaming {
            NSLog("[ChatPanel] stopping active stream")
            viewModel.cancelStreaming()
            browserOSVM.cancelStreaming()
            return
        }

        guard !text.isEmpty || !attachments.isEmpty else { return }

        let outboundMessage = ChatComposerAttachmentPolicy.outboundMessage(
            userText: text,
            attachments: attachments
        )

        if attachments.isEmpty && browserOSVM.isLikelyCommand(text) {
            NSLog("[ChatPanel] routing to BrowserOS command")
            viewModel.inputText = ""
            browserOSVM.sendMessage(text)
        } else {
            NSLog("[ChatPanel] routing to ChatViewModel.sendMessage")
            viewModel.inputText = outboundMessage
            Task {
                await viewModel.sendMessage(onAccepted: {
                    clearComposerAttachments()
                })
            }
        }
    }

    private func chooseAttachments() {
        let panel = NSOpenPanel()
        panel.title = "Attach files or images"
        panel.prompt = "Attach"
        panel.allowsMultipleSelection = true
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.item]

        guard panel.runModal() == .OK else { return }
        panel.urls.forEach(importAttachmentURL)
    }

    private func importDroppedAttachments(_ providers: [NSItemProvider]) -> Bool {
        let compatibleProviders = providers.filter {
            $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
                || $0.registeredTypeIdentifiers.contains(where: {
                    UTType($0)?.conforms(to: .image) == true
                })
        }
        guard !compatibleProviders.isEmpty else { return false }

        pendingAttachmentImports += compatibleProviders.count
        attachmentNotice = nil
        let generation = attachmentImportGeneration
        for provider in compatibleProviders {
            attachmentImporter.load(provider: provider) { result in
                guard generation == attachmentImportGeneration else { return }
                pendingAttachmentImports = max(0, pendingAttachmentImports - 1)
                switch result {
                case .success(let attachment):
                    incorporateAttachment(attachment)
                case .failure(let error):
                    attachmentNotice = error.localizedDescription
                }
            }
        }
        return true
    }

    private func importAttachmentURL(_ url: URL) {
        do {
            incorporateAttachment(try attachmentImporter.attachment(from: url))
        } catch {
            attachmentNotice = error.localizedDescription
        }
    }

    private func incorporateAttachment(_ attachment: ChatComposerAttachment) {
        let result = ChatComposerAttachmentPolicy.merge(
            existing: composerAttachments,
            incoming: [attachment]
        )
        composerAttachments = result.attachments
        if result.rejectedDuplicateCount > 0 {
            attachmentNotice = "That file is already attached."
        } else if result.rejectedLimitCount > 0 {
            attachmentNotice = "You can attach up to \(ChatComposerAttachmentPolicy.maximumAttachmentCount) files."
        } else {
            attachmentNotice = nil
        }
    }

    private func removeAttachment(_ attachment: ChatComposerAttachment) {
        composerAttachments.removeAll { $0.id == attachment.id }
        attachmentNotice = nil
    }

    private func clearComposerAttachments() {
        attachmentImportGeneration = UUID()
        composerAttachments.removeAll()
        pendingAttachmentImports = 0
        attachmentNotice = nil
        isAttachmentDropTargeted = false
    }

    private func exportRecoveryPackage() {
        guard !isExportingRecovery else { return }

        let panel = NSSavePanel()
        panel.title = "Export session recovery package"
        panel.message = "Includes all chats, context, tool history, diagnostics, and sanitized logs."
        panel.prompt = "Export"
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        panel.allowedContentTypes = [.zip]
        panel.nameFieldStringValue = SessionRecoveryPackageNaming.fileName()

        guard panel.runModal() == .OK, let destinationURL = panel.url else { return }

        isExportingRecovery = true
        let browserContext = sessionRecoveryBrowserContext()
        let runtimeContext = sessionRecoveryRuntimeContext()
        let logSources = sessionRecoveryLogSources()

        Task {
            let conversations = await viewModel.sessionRecoveryConversations()
            let request = SessionRecoveryPackageRequest(
                activeConversationID: viewModel.conversationId,
                conversations: conversations.value,
                browserContext: browserContext,
                runtimeContext: runtimeContext,
                initialRedactionCount: conversations.redactionCount,
                logSources: logSources
            )

            do {
                let result = try await Task.detached(priority: .userInitiated) {
                    try SessionRecoveryPackageWriter().write(
                        request: request,
                        to: destinationURL
                    )
                }.value
                isExportingRecovery = false
                NSWorkspace.shared.activateFileViewerSelecting([result.archiveURL])
                recoveryNotice = SessionRecoveryNotice(
                    title: "Recovery package exported",
                    message: "Saved \(result.fileCount) files (\(formatBytes(result.archiveSize))). Redacted \(result.redactionCount) secret values."
                )
            } catch {
                isExportingRecovery = false
                recoveryNotice = SessionRecoveryNotice(
                    title: "Export failed",
                    message: error.localizedDescription
                )
            }
        }
    }

    private func sessionRecoveryBrowserContext() -> SessionRecoveryBrowserContext {
        let messages = browserOSVM.messages.map { message in
            SessionRecoveryBrowserMessage(
                id: message.id,
                role: browserRole(message.role),
                content: message.content,
                timestamp: message.timestamp,
                toolCalls: message.toolCalls.map { toolCall in
                    SessionRecoveryBrowserToolCall(
                        name: toolCall.name,
                        status: "completed",
                        timestamp: message.timestamp,
                        result: toolCall.result
                    )
                }
            )
        }
        let toolCalls = browserOSVM.toolCalls.map { toolCall in
            SessionRecoveryBrowserToolCall(
                name: toolCall.name,
                status: browserToolStatus(toolCall.status),
                timestamp: toolCall.timestamp,
                result: toolCall.result
            )
        }
        return SessionRecoveryBrowserContext(
            status: browserOSVM.queenStatus.rawValue,
            pageID: browserOSVM.currentPageId,
            messages: messages,
            toolCalls: toolCalls
        )
    }

    private func sessionRecoveryRuntimeContext() -> SessionRecoveryRuntimeContext {
        SessionRecoveryRuntimeContext(
            appName: TriosBranding.displayName,
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
            buildVariant: ProjectPaths.buildVariant,
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            projectRoot: ProjectPaths.root,
            activeConversationID: viewModel.conversationId,
            provider: modelStore.selectedProvider.displayName,
            model: modelStore.selectedModel,
            baseURL: modelStore.baseURL,
            credentialStatus: modelStore.credentialStatus,
            inputTokens: viewModel.tokenUsage.inputTokens,
            outputTokens: viewModel.tokenUsage.outputTokens,
            includesEstimate: viewModel.tokenUsage.includesEstimate,
            triosServerReachable: viewModel.isServerReachable,
            browserOSConnected: browserOSVM.isBrowserOSConnected,
            cdpPort: "9102",
            draft: viewModel.inputText
        )
    }

    private func sessionRecoveryLogSources() -> [SessionRecoveryLogSource] {
        let trinity = URL(fileURLWithPath: ProjectPaths.trinity, isDirectory: true)
        return [
            SessionRecoveryLogSource(
                url: trinity.appendingPathComponent("logs", isDirectory: true),
                archivePath: "logs/trinity"
            ),
            SessionRecoveryLogSource(
                url: trinity.appendingPathComponent("events", isDirectory: true),
                archivePath: "logs/akashic"
            ),
            SessionRecoveryLogSource(
                url: trinity.appendingPathComponent("queue", isDirectory: true),
                archivePath: "logs/queue"
            ),
            SessionRecoveryLogSource(
                url: trinity.appendingPathComponent("claims", isDirectory: true),
                archivePath: "logs/claims"
            ),
            SessionRecoveryLogSource(
                url: trinity.appendingPathComponent("state", isDirectory: true),
                archivePath: "logs/state"
            ),
            SessionRecoveryLogSource(
                url: trinity.appendingPathComponent("experience/episodes.jsonl"),
                archivePath: "logs/experience/episodes.jsonl"
            ),
            SessionRecoveryLogSource(
                url: trinity.appendingPathComponent("event_log.jsonl"),
                archivePath: "logs/runtime/event_log.jsonl"
            ),
            SessionRecoveryLogSource(
                url: trinity.appendingPathComponent("cron.log"),
                archivePath: "logs/runtime/cron.log"
            ),
            SessionRecoveryLogSource(
                url: trinity.appendingPathComponent("cron.stdout.log"),
                archivePath: "logs/runtime/cron.stdout.log"
            ),
            SessionRecoveryLogSource(
                url: trinity.appendingPathComponent("cron.stderr.log"),
                archivePath: "logs/runtime/cron.stderr.log"
            ),
            SessionRecoveryLogSource(
                url: trinity.appendingPathComponent("queen-zig.log"),
                archivePath: "logs/runtime/queen-zig.log"
            )
        ]
    }

    private func browserRole(_ role: BrowserOSChatMessage.ChatRole) -> String {
        switch role {
        case .user: return "user"
        case .assistant: return "assistant"
        case .system: return "system"
        case .tool: return "tool"
        }
    }

    private func browserToolStatus(_ status: BrowserOSChatViewModel.ToolCallRecord.ToolStatus) -> String {
        switch status {
        case .running: return "running"
        case .completed: return "completed"
        case .failed: return "failed"
        }
    }

    private func formatBytes(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}

private struct SessionRecoveryNotice: Identifiable {
    let id = UUID()
    let title: String
    let message: String
}

// MARK: - MacTextEditor (NSTextView Wrapper)

final class ChatInputTextView: NSTextView {
    var onSubmit: (() -> Void)?
    var onClear: (() -> Void)?
    var onFileDrop: (([URL]) -> Void)?
    var onFocusNext: (() -> Void)?
    var onFocusPrev: (() -> Void)?
    var onHotkeyPressed: ((String) -> Void)?  // Visual feedback callback

    // History navigation
    var messageHistory: [String] = []
    var historyIndex: Int = -1

    // Visual feedback state
    private var feedbackTimer: Timer?

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if !fileURLs(from: sender.draggingPasteboard).isEmpty {
            return .copy
        }
        return super.draggingEntered(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = fileURLs(from: sender.draggingPasteboard)
        guard !urls.isEmpty else {
            return super.performDragOperation(sender)
        }
        onFileDrop?(urls)
        return true
    }

    private func fileURLs(from pasteboard: NSPasteboard) -> [URL] {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [
            .urlReadingFileURLsOnly: true
        ]
        let objects = pasteboard.readObjects(forClasses: [NSURL.self], options: options) ?? []
        return objects.compactMap { object in
            guard let nsURL = object as? NSURL else { return nil }
            return nsURL as URL
        }
    }

    private func triggerFeedback(hotkey: String) {
        onHotkeyPressed?(hotkey)
        feedbackTimer?.invalidate()
        feedbackTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { _ in
            // Feedback auto-clears after 300ms
        }
    }

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
        case #selector(NSResponder.cancelOperation(_:)):
            // Escape key - clear focus
            NSLog("[ChatInput] Escape pressed - clearing focus")
            window?.makeFirstResponder(nil)
            return
        default:
            super.doCommand(by: selector)
        }
    }

    override func keyDown(with event: NSEvent) {
        let flags = NSEvent.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let editingModifiers = ChatEditingModifierState(
            command: flags.contains(.command),
            shift: flags.contains(.shift),
            option: flags.contains(.option),
            control: flags.contains(.control)
        )

        if let editingCommand = ChatEditingShortcutPolicy.command(
            forKeyCode: event.keyCode,
            modifiers: editingModifiers
        ) {
            performEditingCommand(editingCommand)
            return
        }

        // Cmd+K - Clear input
        if flags.contains(.command) && event.keyCode == 8 {
            NSLog("[ChatInput] Cmd+K - clearing input")
            triggerFeedback(hotkey: "clear")
            self.string = ""
            didChangeText()
            onClear?()
            return
        }

        // Cmd+L - Focus input (already focused, but can scroll to bottom)
        if flags.contains(.command) && event.keyCode == 37 {
            NSLog("[ChatInput] Cmd+L - focusing input")
            triggerFeedback(hotkey: "focus")
            window?.makeFirstResponder(self)
            scrollToVisible(visibleRect)
            return
        }

        // Arrow Up - Previous message in history
        if flags.isEmpty && event.keyCode == 126 {
            if historyIndex < messageHistory.count - 1 {
                historyIndex += 1
                self.string = messageHistory[messageHistory.count - 1 - historyIndex]
                setSelectedRange(NSRange(location: self.string.count, length: 0))
                didChangeText()
                triggerFeedback(hotkey: "history")
                NSLog("[ChatInput] Arrow Up - history[\(historyIndex)]")
            }
            return
        }

        // Arrow Down - Next message in history
        if flags.isEmpty && event.keyCode == 125 {
            if historyIndex > 0 {
                historyIndex -= 1
                self.string = messageHistory[messageHistory.count - 1 - historyIndex]
                setSelectedRange(NSRange(location: self.string.count, length: 0))
                didChangeText()
                triggerFeedback(hotkey: "history")
                NSLog("[ChatInput] Arrow Down - history[\(historyIndex)]")
            } else if historyIndex == 0 {
                historyIndex = -1
                self.string = ""
                didChangeText()
                triggerFeedback(hotkey: "history")
                NSLog("[ChatInput] Arrow Down - cleared history")
            }
            return
        }

        // Cmd+Enter - Send message
        if flags.contains(.command) && event.keyCode == 36 {
            NSLog("[ChatInput] Cmd+Enter - sending message")
            triggerFeedback(hotkey: "send")
            onSubmit?()
            return
        }

        // Cmd+/ - Help overlay
        if flags.contains(.command) && event.keyCode == 44 {
            NSLog("[ChatInput] Cmd+/ - showing help")
            triggerFeedback(hotkey: "help")
            // Help overlay is managed by HotkeyBar parent
            return
        }

        // Cmd+Shift+H - Toggle hotkey bar visibility
        if flags.contains(.command) && flags.contains(.shift) && event.keyCode == 4 {
            NSLog("[ChatInput] Cmd+Shift+H - toggle hotkey bar")
            triggerFeedback(hotkey: "toggle_hotkeys")
            return
        }

        // Cmd+Shift+S - Search overlay
        if flags.contains(.command) && flags.contains(.shift) && event.keyCode == 1 {
            NSLog("[ChatInput] Cmd+Shift+S - search overlay")
            triggerFeedback(hotkey: "search")
            return
        }

        // Cmd+Shift+M - Macro recorder
        if flags.contains(.command) && flags.contains(.shift) && event.keyCode == 46 {
            NSLog("[ChatInput] Cmd+Shift+M - macro recorder")
            triggerFeedback(hotkey: "macro")
            return
        }

        // Cmd+Shift+A - Accessibility overlay
        if flags.contains(.command) && flags.contains(.shift) && event.keyCode == 0 {
            NSLog("[ChatInput] Cmd+Shift+A - accessibility")
            triggerFeedback(hotkey: "accessibility")
            return
        }

        // Cmd+Shift+T - Theme switcher
        if flags.contains(.command) && flags.contains(.shift) && event.keyCode == 17 {
            NSLog("[ChatInput] Cmd+Shift+T - theme switcher")
            triggerFeedback(hotkey: "theme")
            return
        }

        // Cmd+Shift+P - Preferences
        if flags.contains(.command) && flags.contains(.shift) && event.keyCode == 35 {
            NSLog("[ChatInput] Cmd+Shift+P - preferences")
            triggerFeedback(hotkey: "preferences")
            return
        }

        // Preserve all unrelated text-system and input-method commands.
        super.keyDown(with: event)
    }

    private func performEditingCommand(_ command: ChatEditingCommand) {
        switch command {
        case .copy:
            copy(nil)
            triggerFeedback(hotkey: "copy")
        case .paste:
            paste(nil)
            triggerFeedback(hotkey: "paste")
        case .cut:
            cut(nil)
            triggerFeedback(hotkey: "cut")
        case .selectAll:
            selectAll(nil)
            triggerFeedback(hotkey: "select_all")
        case .undo:
            undoManager?.undo()
            triggerFeedback(hotkey: "undo")
        case .redo:
            undoManager?.redo()
            triggerFeedback(hotkey: "redo")
        }
    }
}

struct MacTextEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    @Binding var dynamicHeight: CGFloat
    let minimumHeight: CGFloat
    let maximumHeight: CGFloat
    var onSubmit: () -> Void
    var onFileDrop: (([URL]) -> Void)? = nil
    var messageHistory: [String] = []
    var onHotkeyPressed: ((String) -> Void)? = nil

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.hasHorizontalScroller = false
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder

        let textView = ChatInputTextView()
        textView.onSubmit = onSubmit
        textView.onFileDrop = onFileDrop
        textView.onClear = {
            context.coordinator.parent.text = ""
        }
        textView.onHotkeyPressed = onHotkeyPressed
        textView.messageHistory = messageHistory
        textView.isRichText = false
        textView.isEditable = true
        textView.isSelectable = true
        textView.isFieldEditor = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticLinkDetectionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.font = NSFont.systemFont(ofSize: 15, weight: .regular)
        textView.textColor = NSColor.white
        textView.insertionPointColor = NSColor.white
        textView.backgroundColor = NSColor.clear
        textView.textContainerInset = NSSize(width: 0, height: 4)
        textView.textContainer?.lineFragmentPadding = 0
        textView.string = text
        textView.delegate = context.coordinator
        textView.autoresizingMask = [.width, .height]
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.textContainer?.containerSize = NSSize(width: scrollView.bounds.width, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true
        let dragTypes = Set(textView.registeredDraggedTypes + [.fileURL])
        textView.registerForDraggedTypes(Array(dragTypes))

        // Remove focus ring (causes visual glitches)
        scrollView.focusRingType = .none
        textView.focusRingType = .none

        // Tooltip with hotkeys
        textView.toolTip = """
        Hotkeys:
        ⏎ Send | ⇧⏎ New line
        ⌘C/V/X Copy/Paste/Cut | ⌘A Select all
        ⌘K Clear | ⌘L Focus input
        ↑↓ History | ⎋ Escape (blur)
        ⌘/ Show all shortcuts
        """

        // Accessibility hints for VoiceOver
        textView.setAccessibilityElement(true)
        textView.setAccessibilityLabel("Chat input field")
        textView.setAccessibilityHelp("Press Command K to clear, arrow keys for history, Enter to send. Command slash for all shortcuts.")
        textView.setAccessibilityRole(.textArea)

        // Register for WindowManager first-responder hook
        WindowManager.inputFirstResponder = textView

        scrollView.documentView = textView
        DispatchQueue.main.async {
            context.coordinator.updateHeight(for: textView)
        }
        return scrollView
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        guard let textView = nsView.documentView as? ChatInputTextView else { return }
        context.coordinator.parent = self
        textView.onSubmit = onSubmit
        textView.onFileDrop = onFileDrop
        textView.onClear = {
            context.coordinator.parent.text = ""
        }
        textView.onHotkeyPressed = onHotkeyPressed
        textView.messageHistory = messageHistory
        if textView.string != text {
            let selected = textView.selectedRanges
            textView.string = text
            textView.selectedRanges = selected
        }
        context.coordinator.updateHeight(for: textView)
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
            updateHeight(for: textView)
        }

        func updateHeight(for textView: NSTextView) {
            guard let layoutManager = textView.layoutManager,
                  let textContainer = textView.textContainer else { return }
            layoutManager.ensureLayout(for: textContainer)
            let usedHeight = layoutManager.usedRect(for: textContainer).height
            let insetHeight = textView.textContainerInset.height * 2
            let proposedHeight = min(
                parent.maximumHeight,
                max(parent.minimumHeight, ceil(usedHeight + insetHeight))
            )
            if abs(parent.dynamicHeight - proposedHeight) > 0.5 {
                DispatchQueue.main.async {
                    self.parent.dynamicHeight = proposedHeight
                }
            }
            textView.enclosingScrollView?.hasVerticalScroller = proposedHeight >= parent.maximumHeight
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
                if isFirstInGroup, let senderName {
                    senderLabel(senderName)
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

    private var senderName: String? {
        let kind: ChatSenderKind = message.role == .user
            ? .user
            : (isError ? .system : .assistant)
        return ChatSenderLabelPolicy.label(for: kind)
    }

    private func senderLabel(_ senderName: String) -> some View {
        Text(senderName)
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
                if diffDocuments.isEmpty {
                    Text(result)
                        .font(.system(size: 11))
                        .foregroundColor(.grokMuted)
                        .padding(6)
                        .background(Color.grokElevated.opacity(0.4))
                        .cornerRadius(6)
                } else {
                    ForEach(Array(diffDocuments.enumerated()), id: \.offset) { _, document in
                        UnifiedDiffView(document: document)
                    }
                }
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

    private var diffDocuments: [CodeDiffDocument] {
        guard let result = tool.result, !result.isEmpty else { return [] }
        return StructuredCodeDiffExtractor.documents(
            from: StructuredDetailParser.parse(result)
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

// MARK: - Queen Activity Feed

private extension ChatPanelView {
    var queenActivityFeed: some View {
        queenActivityContent
            .padding(8)
            .background(Color.purple.opacity(0.05), alignment: .center)
    }

    @ViewBuilder
    private var queenActivityContent: some View {
        if queenVM.isActive {
            queenHeader
            if let plan = intelligenceEngine.currentPlan {
                queenTaskList(plan: plan)
            }
            if let prediction = intelligenceEngine.predictions.first {
                queenPrediction(prediction: prediction)
            }
        }
    }

    var queenHeader: some View {
        HStack {
            Image(systemName: "crown.fill")
                .foregroundColor(.purple)
                .font(.caption)
            Text("Queen Active")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(.primary)
            Spacer()
            if intelligenceEngine.isPlanning {
                ProgressView()
                    .scaleEffect(0.7)
            }
        }
    }
    
    func queenTaskList(plan: QueenTaskPlan) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(plan.tasks.prefix(3)) { task in
                HStack(spacing: 6) {
                    Image(systemName: task.statusIcon)
                        .font(.caption2)
                        .foregroundColor(task.statusColor)
                    Text(task.description)
                        .font(.caption)
                        .lineLimit(1)
                    Spacer()
                    Text("\(Int(task.estimatedDuration))s")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
            }
        }
        .padding(6)
        .background(Color.purple.opacity(0.1))
        .cornerRadius(6)
    }
    
    func queenPrediction(prediction: QueenAction) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "lightbulb.fill")
                .font(.caption2)
                .foregroundColor(.yellow)
            Text(prediction.description)
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }
}

private extension QueenTask {
    var statusIcon: String {
        switch status {
        case .pending: return "circle"
        case .inProgress: return "circle.fill"
        case .completed: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.circle.fill"
        }
    }
    
    var statusColor: Color {
        switch status {
        case .pending: return .secondary
        case .inProgress: return .blue
        case .completed: return .green
        case .failed: return .red
        }
    }
}

// MARK: - Status Hint Model

private struct StatusHint: Equatable {
    let icon: String
    let text: String
    let color: Color
}
