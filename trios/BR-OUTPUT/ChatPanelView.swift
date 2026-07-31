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
    
    init(viewModel: ChatViewModel,
         scrollToBottomRequest: Int,
         workspaceMode: ChatWorkspaceMode = .compact) {
        self.viewModel = viewModel
        self.scrollToBottomRequest = scrollToBottomRequest
        self.workspaceMode = workspaceMode
    }
    @State private var isNearBottom = true
    @State private var viewportHeight: CGFloat = 0
    @State private var bottomAnchorY: CGFloat = 0
    @State private var isInputFocused = false
    @State private var composerEditorHeight: CGFloat = 42
    @State private var showHotkeyHelp = false
    @State private var isExportingRecovery = false
    @State private var isImportingRecovery = false
    @State private var recoveryNotice: SessionRecoveryNotice?
    @State private var duplicateResolutions: [UUID: SessionRecoveryDuplicateResolution] = [:]
    @State private var pendingDuplicate: SessionRecoveryDuplicateItem?
    @State private var composerAttachments: [ChatComposerAttachment] = []
    @State private var isAttachmentDropTargeted = false
    @State private var pendingAttachmentImports = 0
    @State private var attachmentNotice: String?
    @State private var attachmentImportGeneration = UUID()
    @StateObject private var scrollManager = SmoothScrollManager()
    @StateObject private var batchUpdater = MessageBatchUpdater()
    @StateObject private var throttle = StreamingThrottle()
    private let attachmentImporter = ChatAttachmentImporter()
    @State private var effectiveOutputCeiling: Int? = nil
    @State private var isSpecHeaderCollapsed = false

    // Manual previous-value tracking for .onChange compatibility with the
    // swiftc-based build path, which does not consistently expose the two-arg
    // (oldValue, newValue) overload across all deployment targets.
    @State private var previousMessageCount = 0
    @State private var previousLastContent: String? = nil
    @State private var previousBrowserMessageCount = 0
    /// Measured height of the planner card, so its container hugs the content
    /// instead of leaving a gap above the composer.
    @State private var plannerContentHeight: CGFloat = 0

    var body: some View {
        GeometryReader { pane in
            VStack(spacing: 0) {
                pinnedSpecHeader
                queenBeeBoard
                unifiedMessageArea
                    .frame(maxHeight: .infinity)
                // The planner is bounded and scrolls internally. Unbounded it
                // grew with the step count and pushed the composer off-screen.
                if let cap = ChatPaneLayout.plannerMaxHeight(paneHeight: Double(pane.size.height)) {
                    // A ScrollView is greedy: it fills whatever height it is
                    // offered, so capping it alone left a tall empty gap above
                    // the composer whenever the plan was short. Measure the card
                    // and take only the height it actually needs, up to the cap.
                    ScrollView {
                        queenActivityFeed
                            .background(
                                GeometryReader { content in
                                    Color.clear.preference(
                                        key: PlannerContentHeightPreferenceKey.self,
                                        value: content.size.height
                                    )
                                }
                            )
                    }
                    .frame(
                        height: CGFloat(
                            ChatPaneLayout.plannerHeight(
                                contentHeight: Double(plannerContentHeight),
                                cap: cap
                            )
                        )
                    )
                    .scrollDisabled(Double(plannerContentHeight) <= cap)
                    .onPreferenceChange(PlannerContentHeightPreferenceKey.self) { height in
                        plannerContentHeight = height
                    }
                }
                // The composer keeps its space unconditionally.
                unifiedInputBar
                    .layoutPriority(1)
            }
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
        .onReceive(NotificationCenter.default.publisher(for: .importSessionRecoveryPackage)) { _ in
            importRecoveryPackage()
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
        .sheet(item: $pendingDuplicate) { duplicate in
            SessionRecoveryDuplicateSheet(
                duplicate: duplicate,
                onResolve: { resolution in
                    duplicateResolutions[duplicate.id] = resolution
                    pendingDuplicate = nil
                }
            )
        }
        .task(id: effectiveOutputCeilingTaskID) {
            await refreshEffectiveOutputCeiling()
        }
        .overlay {
            if viewModel.recoveryProgress.isActive {
                recoveryProgressOverlay
            }
        }
    }

    private var recoveryProgressOverlay: some View {
        VStack(spacing: 8) {
            Spacer()
            VStack(spacing: 10) {
                HStack(spacing: 8) {
                    ProgressView(
                        value: viewModel.recoveryProgress.fractionCompleted,
                        total: 1.0
                    )
                    .progressViewStyle(.linear)
                    .frame(width: 220)
                    Button("Cancel") {
                        // Cancellation is co-operative; the current task will
                        // notice `Task.isCancelled` at its next yield point.
                        // For now we stop the UI overlay and let the operation
                        // finish or fail on its own.
                        viewModel.recoveryProgress.reset()
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                Text(viewModel.recoveryProgress.currentFile)
                    .font(.system(size: 11))
                    .foregroundColor(.grokDim)
                    .lineLimit(1)
            }
            .padding(14)
            .background(Color.grokElevated.opacity(0.92))
            .cornerRadius(12)
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color.grokBorder, lineWidth: 1)
            )
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.35))
        .ignoresSafeArea()
    }

    // MARK: - Pinned Spec Header

    @ViewBuilder
    private var pinnedSpecHeader: some View {
        PinnedSpecHeader(
            registry: viewModel.delegationRegistry,
            conversationId: viewModel.conversationId,
            isCollapsed: $isSpecHeaderCollapsed
        )
    }

    // MARK: - Queen Bee Board

    /// One card per live task, shown only in the Queen's master chat.
    ///
    /// The board renders nothing outside `trinityQueenId`, so it never appears
    /// in worker or regular chats. When the swarm is empty the section collapses
    /// to zero height — a permanent header for an idle hive is a permanent tax
    /// on the reading area.
    @ViewBuilder
    private var queenBeeBoard: some View {
        if viewModel.conversationId == ChatConversation.trinityQueenId,
           !viewModel.delegationRegistry.open.isEmpty {
            QueenBeeBoard(
                registry: viewModel.delegationRegistry,
                onSelectBee: { conversationId in
                    viewModel.selectConversation(conversationId)
                }
            )
        }
    }

    // MARK: - Unified Messages / Empty State

    private var unifiedMessageArea: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if viewModel.messages.isEmpty && browserOSVM.messages.isEmpty {
                    emptyStateView
                } else {
                    messageStack
                }
            }
            .coordinateSpace(name: "scrollArea")
            .background(
                GeometryReader { geometry in
                    Color.clear.preference(
                        key: ScrollViewportHeightPreferenceKey.self,
                        value: geometry.size.height
                    )
                }
            )
            .onAppear {
                scrollToBottom(using: proxy, animated: false)
            }
            .onChange(of: scrollToBottomRequest) {
                scrollToBottom(using: proxy, animated: false)
            }
            .onPreferenceChange(ScrollViewportHeightPreferenceKey.self) { height in
                viewportHeight = height
                updateNearBottom()
            }
            .onPreferenceChange(ScrollBottomAnchorPreferenceKey.self) { anchorY in
                bottomAnchorY = anchorY
                updateNearBottom()
            }
            .onChange(of: scrollManager.scrollRequest) { _, request in
                guard request.sequence > 0 else { return }
                scrollToBottom(
                    using: proxy,
                    animated: request.animated
                )
            }
            .onChange(of: viewModel.messages.count) { _, newCount in
                // Scroll only when a brand-new message is appended.
                if newCount > previousMessageCount && isNearBottom {
                    scrollManager.requestScroll(animated: true)
                }
                previousMessageCount = newCount
            }
            .onChange(of: viewModel.messages.last?.content) { _, newContent in
                // Throttled scroll during streaming: react only when the last
                // message content actually changed.
                if isNearBottom && newContent != previousLastContent {
                    scrollManager.requestScroll(animated: true)
                }
                previousLastContent = newContent
            }
            .onChange(of: browserOSVM.messages.count) { _, newCount in
                if newCount > previousBrowserMessageCount && isNearBottom {
                    scrollManager.requestScroll(animated: true)
                }
                previousBrowserMessageCount = newCount
            }
        }
    }

    private var bottomAnchorTracker: some View {
        GeometryReader { geo in
            Color.clear
                .preference(
                    key: ScrollBottomAnchorPreferenceKey.self,
                    value: geo.frame(in: .named("scrollArea")).maxY
                )
        }
        .frame(height: 1)
        .id(ChatScrollAnchor.bottom)
    }

    private var messageStack: some View {
        LazyVStack(spacing: 0) {
            localMessageList
            if shouldShowBrowserSeparator {
                browserSeparator
            }
            browserMessageList
            typingIndicatorArea
            bottomAnchorTracker
        }
    }

    private func updateNearBottom() {
        guard viewportHeight > 0 else { return }
        isNearBottom = ChatScrollPolicy.isNearBottom(
            bottomAnchorY: Double(bottomAnchorY),
            viewportHeight: Double(viewportHeight)
        )
    }

    private func scrollToBottom(using proxy: ScrollViewProxy, animated: Bool) {
        isNearBottom = true
        DispatchQueue.main.async {
            if animated {
                // Use smooth scroll with spring animation
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
                StableMessageView(
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
            if let slashCommand = text.split(separator: " ")
                .map(String.init)
                .first(where: { $0.hasPrefix("/") }) {
                Task { await viewModel.runQueenCommand(slashCommand) }
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
                if let status = viewModel.streamingBudgetStatus {
                    streamingBudgetProgressBar(status)
                }
                if let warning = viewModel.streamingContextWarning {
                    contextWarningBanner(warning)
                }
                if viewModel.isStreamPausedForContext {
                    contextLimitActionBar
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
        let imageData = try? attachment.loadDecryptedData()
        if attachment.kind == .image, let data = imageData, let image = NSImage(data: data) {
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
            composerContextStatus
            composerOutputBudgetControl
            composerDraftContextStatus

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
            .help(sendButtonHelpText)

            if isSendDisabledByPin {
                Button {
                    Task {
                        await viewModel.clearConversationModelOverride()
                        triggerSend()
                    }
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "pin.slash")
                            .font(.system(size: 9))
                        Text("Clear pin & send")
                            .font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundColor(.blue)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.blue.opacity(0.12))
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .help("Remove the per-conversation model pin and send using the global default.")
            }
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
            Section("This conversation") {
                if viewModel.hasConversationModelOverride {
                    Button {
                        Task { await viewModel.clearConversationModelOverride() }
                    } label: {
                        Label("Clear conversation pin", systemImage: "pin.slash")
                    }
                } else {
                    Button {
                        Task {
                            await viewModel.setConversationModelOverride(
                                provider: modelStore.selectedProvider,
                                baseURL: modelStore.baseURL,
                                model: modelStore.selectedModel
                            )
                        }
                    } label: {
                        Label("Pin current model to conversation", systemImage: "pin")
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
                if viewModel.hasConversationModelOverride {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(.white.opacity(0.72))
                }
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

    private var composerContextStatus: some View {
        HStack(spacing: 4) {
            if let percent = viewModel.contextUtilizationPercent {
                Circle()
                    .fill(contextUtilizationColor(for: percent))
                    .frame(width: 6, height: 6)
                Text(String(format: "%.0f%%", percent))
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .foregroundColor(contextUtilizationColor(for: percent))
                    .lineLimit(1)
                if let label = viewModel.contextRoutingLabel {
                    Text(label)
                        .font(.system(size: 9))
                        .foregroundColor(.white.opacity(0.55))
                        .lineLimit(1)
                }
            }
        }
        .frame(height: CGFloat(composerStatusMetrics.controlHeight))
    }

    private var composerDraftContextStatus: some View {
        HStack(spacing: 4) {
            if let status = viewModel.draftContextStatus {
                Image(systemName: status.isTooLarge ? "exclamationmark.triangle.fill" : "pencil.circle")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(draftContextStatusColor(for: status.utilizationPercent))
                Text(String(format: "%.0f%%", status.utilizationPercent))
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .foregroundColor(draftContextStatusColor(for: status.utilizationPercent))
                    .lineLimit(1)
            }
        }
        .frame(height: CGFloat(composerStatusMetrics.controlHeight))
        .help(composerDraftContextStatusHelp)
    }

    private var composerDraftContextStatusHelp: String {
        guard let status = viewModel.draftContextStatus else {
            return "Estimated context utilization for the current draft"
        }
        let label = status.isTooLarge
            ? "Draft alone exceeds the usable window"
            : (status.wouldTrimToFit ? "History will be trimmed to fit" : "Draft fits within the usable window")
        return "Estimated draft input: \(status.estimatedInputTokens) tokens / \(status.usableWindow) usable (\(String(format: "%.0f", status.utilizationPercent))%). \(label)."
    }

    private func draftContextStatusColor(for percent: Double) -> Color {
        if percent <= 70 { return .green }
        if percent <= 85 { return .yellow }
        return .red
    }

    private var composerOutputBudgetControl: some View {
        Menu {
            Button {
                Task { await viewModel.clearConversationOutputTokensOverride() }
            } label: {
                if !viewModel.hasConversationOutputTokensOverride {
                    Label("Default budget", systemImage: "checkmark")
                } else {
                    Text("Default budget")
                }
            }
            Divider()
            ForEach(Self.outputBudgetPresets, id: \.self) { value in
                Button {
                    Task { await viewModel.setConversationRequestedOutputTokens(value) }
                } label: {
                    if viewModel.effectiveConversationOutputTokens == value {
                        Label(formatCompact(value), systemImage: "checkmark")
                    } else {
                        Text(formatCompact(value))
                    }
                }
                .disabled(effectiveOutputCeiling.map { value > $0 } ?? false)
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "waveform")
                    .font(.system(size: 9, weight: .medium))
                Text(composerOutputBudgetLabel)
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .lineLimit(1)
            }
            .font(.system(size: 9, design: .monospaced))
            .foregroundColor(.white.opacity(0.55))
            .frame(height: CGFloat(composerStatusMetrics.controlHeight))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .help(composerOutputBudgetHelp)
    }

    private var composerOutputBudgetLabel: String {
        let requested = viewModel.effectiveConversationOutputTokens
        if let requested {
            let formatted = formatCompact(requested)
            if let ceiling = effectiveOutputCeiling {
                return "\(formatted)/\(formatCompact(ceiling))"
            }
            return formatted
        }
        if let ceiling = effectiveOutputCeiling {
            return "out ≤ \(formatCompact(ceiling))"
        }
        return "out budget"
    }

    private var composerOutputBudgetHelp: String {
        let requested = viewModel.effectiveConversationOutputTokens
        if let requested, let ceiling = effectiveOutputCeiling {
            let scope = viewModel.hasConversationOutputTokensOverride ? "conversation" : "global"
            return "Output budget for this \(scope) chat: \(requested) tokens (ceiling \(ceiling))"
        }
        return "Set per-send output-token budget for this conversation"
    }

    private static let outputBudgetPresets: [Int] = [
        256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536
    ]

    private var effectiveOutputCeilingTaskID: String {
        "\(modelStore.selectedProvider.rawValue)|\(modelStore.selectedModel)|\(modelStore.baseURL)"
    }

    private func refreshEffectiveOutputCeiling() async {
        effectiveOutputCeiling = await modelStore.effectiveMaxOutputTokens(
            for: modelStore.selectedModel,
            provider: modelStore.selectedProvider,
            baseURL: modelStore.baseURL
        )
    }

    private func contextUtilizationColor(for percent: Double) -> Color {
        if percent <= 70 { return .green }
        if percent <= 85 { return .yellow }
        return .red
    }

    private func formatCompact(_ value: Int) -> String {
        if value >= 1_000_000 {
            return String(format: "%.1fM", Double(value) / 1_000_000)
        } else if value >= 1_000 {
            return String(format: "%.1fk", Double(value) / 1_000)
        }
        return "\(value)"
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
        Menu {
            Button("Export recovery package...") {
                exportRecoveryPackage()
            }
            .keyboardShortcut("e", modifiers: [.command, .shift])
            .disabled(isExportingRecovery || isImportingRecovery)

            Button("Import recovery package...") {
                importRecoveryPackage()
            }
            .keyboardShortcut("i", modifiers: [.command, .shift])
            .disabled(isExportingRecovery || isImportingRecovery)
        } label: {
            HStack(spacing: 5) {
                if isExportingRecovery || isImportingRecovery {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 12, height: 12)
                } else {
                    Image(systemName: "arrow.up.arrow.down.square")
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
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .accessibilityLabel("Session recovery options")
        .help("Export or import complete chat, context, tool history, and detailed logs")
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
            // Start TRIOS, restart MCP and run cron had no route into the app.
            // QueenStatusViewModel has offered them all along and the only UI
            // that called them - this badge and the sheet it opens - was itself
            // unreachable, so the three sat behind a door with no handle. This
            // is the status strip the same information already lives in, so the
            // badge costs a dot beside the two that are here.
            QueenStatusBadge(viewModel: viewModel.queenStatusVM)
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

    private var contextLimitActionBar: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let label = viewModel.streamingContextPauseLabel {
                Text(label)
                    .font(.system(size: 11))
                    .foregroundColor(.orange.opacity(0.9))
                    .padding(.horizontal, 2)
            }
            HStack(spacing: 12) {
                Button("Continue on larger model") {
                    Task { await viewModel.continueStreamOnLargerModel(nil) }
                }
                .buttonStyle(ContextLimitButtonStyle())
                .disabled(!viewModel.canContinueOnLargerModel)

                Button("Summarize so far") {
                    Task { await viewModel.summarizeStreamSoFar() }
                }
                .buttonStyle(ContextLimitButtonStyle())
                .disabled(!viewModel.canSummarizeStreamSoFar)

                Button("Stop and keep partial") {
                    Task { await viewModel.stopStreamAndKeepPartial() }
                }
                .buttonStyle(ContextLimitButtonStyle())

                Spacer()
            }
        }
        .padding(.vertical, 6)
    }

    private func streamingBudgetProgressBar(_ status: StreamingBudgetStatus) -> some View {
        let progressColor: Color
        switch status.kind {
        case .safe: progressColor = .green
        case .warning: progressColor = .yellow
        case .critical: progressColor = .red
        }
        let dominantRatio = max(status.outputRatio, status.totalRatio)
        let label: String
        let tooltip: String
        if status.limitKind == .outputTokens || status.outputRatio >= status.totalRatio {
            label = "\(formatCompact(status.outputUsed)) / \(formatCompact(status.outputCeiling)) output"
            tooltip = "Output tokens: \(status.outputUsed) / \(status.outputCeiling). Total context: \(status.totalUsed) / \(status.totalCeiling)."
        } else {
            label = "\(formatCompact(status.totalUsed)) / \(formatCompact(status.totalCeiling)) context"
            tooltip = "Total context: \(status.totalUsed) / \(status.totalCeiling). Output tokens: \(status.outputUsed) / \(status.outputCeiling)."
        }
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: status.limitKind == .outputTokens ? "arrow.up.circle" : "bubble.left.and.bubble.right")
                    .font(.system(size: 10))
                    .foregroundColor(progressColor)
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(Color.white.opacity(0.12))
                            .frame(height: 4)
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(progressColor)
                            .frame(width: max(2, geo.size.width * CGFloat(dominantRatio)), height: 4)
                    }
                }
                .frame(height: 4)
                Text(label)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.grokDim)
            }
        }
        .padding(.vertical, 2)
        .help(tooltip)
    }

    private func contextWarningBanner(_ warning: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundColor(.orange.opacity(0.9))
            Text(warning)
                .font(.system(size: 11))
                .foregroundColor(.orange.opacity(0.9))
                .lineLimit(2)
            Spacer()
        }
        .padding(.vertical, 4)
    }

    private struct ContextLimitButtonStyle: ButtonStyle {
        func makeBody(configuration: Configuration) -> some View {
            configuration.label
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(.white.opacity(configuration.isPressed ? 0.7 : 0.9))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color.white.opacity(configuration.isPressed ? 0.12 : 0.08))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(Color.white.opacity(0.15), lineWidth: 1)
                )
        }
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
        let scope = viewModel.hasConversationModelOverride ? "Pinned to this conversation" : "Global default"
        let constraintNote = viewModel.hasConversationModelOverride
            ? " (warmup and failover constrained to this pin)"
            : ""
        return "\(scope): \(modelStore.selectedProvider.displayName) / \(modelStore.selectedModel)\(constraintNote) - \(viewModel.tokenUsage.detailText)"
    }

    private var isAPIKeyConfigured: Bool {
        modelStore.hasAPIKey
    }

    private var statusHint: StatusHint? {
        if !viewModel.isServerReachable {
            return StatusHint(
                icon: "exclamationmark.triangle.fill",
                text: "BrowserOS Agent offline  -  start it or check port \(ProjectPaths.mcpPort).",
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

    private var sendButtonHelpText: String {
        if viewModel.state != .idle || browserOSVM.isStreaming { return "Stop response" }
        if let reason = viewModel.pinnedSendLimitReason {
            return reason
        }
        if viewModel.isDraftContextLimitExceeded { return "Draft exceeds the usable context window" }
        return "Send message"
    }

    private var sendButtonDisabled: Bool {
        let trimmed = viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed.isEmpty
            && composerAttachments.isEmpty
            && viewModel.state == .idle
            && !browserOSVM.isStreaming)
            || viewModel.isDraftContextLimitExceeded
            || viewModel.isPinnedModelSendBlocked
    }

    /// True when the send button is disabled specifically because the pinned model
    /// cannot fit the draft or output budget.
    private var isSendDisabledByPin: Bool {
        viewModel.isPinnedModelSendBlocked
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

        let imageAttachments = attachments.filter { $0.kind == .image }
        let fileAttachments = attachments.filter { $0.kind == .file }

        // Image attachments travel as encrypted structured payloads; only file
        // attachments still need a local-path block for server-side reading.
        let displayText = fileAttachments.isEmpty
            ? text
            : ChatComposerAttachmentPolicy.outboundMessage(
                userText: text,
                attachments: fileAttachments
            )

        if attachments.isEmpty && text.hasPrefix("/") {
            NSLog("[ChatPanel] routing slash command to Queen")
            viewModel.inputText = ""
            Task { await viewModel.runQueenCommand(text) }
        } else if attachments.isEmpty && browserOSVM.isLikelyCommand(text) {
            NSLog("[ChatPanel] routing to BrowserOS command")
            viewModel.inputText = ""
            browserOSVM.sendMessage(text)
        } else {
            NSLog("[ChatPanel] routing to ChatViewModel.sendMessage")
            viewModel.inputText = displayText
            Task {
                await viewModel.sendMessage(
                    imageAttachments: imageAttachments,
                    onAccepted: {
                        clearComposerAttachments()
                    }
                )
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
        guard !isExportingRecovery, !isImportingRecovery else { return }

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
                let result = try await viewModel.exportRecoveryPackage(
                    request: request,
                    to: destinationURL
                )
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

    private func importRecoveryPackage() {
        guard !isExportingRecovery, !isImportingRecovery else { return }

        let panel = NSOpenPanel()
        panel.title = "Import session recovery package"
        panel.message = "Restore a previously exported Trinity recovery ZIP into TriOS."
        panel.prompt = "Import"
        panel.allowsMultipleSelection = false
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.zip]

        guard panel.runModal() == .OK, let sourceURL = panel.url else { return }

        isImportingRecovery = true
        duplicateResolutions.removeAll()
        Task {
            do {
                let summary = try await viewModel.importRecoveryPackage(
                    from: sourceURL,
                    resolvingDuplicates: { id, title in
                        if let resolution = self.duplicateResolutions[id] {
                            return resolution
                        }
                        self.pendingDuplicate = SessionRecoveryDuplicateItem(
                            id: id,
                            title: title
                        )
                        // Wait for the sheet to set a resolution.
                        while self.duplicateResolutions[id] == nil
                                && !Task.isCancelled {
                            try? await Task.sleep(nanoseconds: 50_000_000)
                        }
                        return self.duplicateResolutions[id] ?? .skip
                    }
                )
                isImportingRecovery = false
                let failureHint = summary.failureCount > 0
                    ? " \(summary.failureCount) failed (IDs: \(summary.failedConversationIDs.map { String($0.uuidString.prefix(8)) }.joined(separator: ", ")))."
                    : ""
                recoveryNotice = SessionRecoveryNotice(
                    title: "Recovery package imported",
                    message: "Restored \(summary.successCount) of \(summary.conversationCount) conversation(s) and \(summary.messageCount) message(s). Active conversation: \(summary.activeConversationID.uuidString.prefix(8)).\(failureHint)"
                )
            } catch {
                isImportingRecovery = false
                recoveryNotice = SessionRecoveryNotice(
                    title: "Import failed",
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
            draft: viewModel.inputText,
            encryptionScheme: "local-aes256-gcm-v1",
            encryptionKeyPath: "~/Library/Application Support/trios/conversation.key"
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

private struct SessionRecoveryDuplicateItem: Identifiable {
    let id: UUID
    let title: String
}

private struct SessionRecoveryDuplicateSheet: View {
    let duplicate: SessionRecoveryDuplicateItem
    let onResolve: (SessionRecoveryDuplicateResolution) -> Void

    var body: some View {
        VStack(spacing: 16) {
            Text("Conversation already exists")
                .font(.headline)
            Text("\"\(duplicate.title)\" has the same ID as an existing conversation. What would you like to do?")
                .font(.system(size: 13))
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            HStack(spacing: 12) {
                Button("Replace") {
                    onResolve(.replace)
                }
                .keyboardShortcut(.defaultAction)

                Button("Merge") {
                    onResolve(.merge)
                }

                Button("Skip") {
                    onResolve(.skip)
                }
                .keyboardShortcut(.cancelAction)
            }
            .padding(.bottom)
        }
        .frame(width: 360)
        .padding()
    }
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
        Return Send | ShiftReturn New line
        CmdC/V/X Copy/Paste/Cut | CmdA Select all
        CmdK Clear | CmdL Focus input
        Up/Down History | Esc Escape (blur)
        Cmd/ Show all shortcuts
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

struct ScrollViewportHeightPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

struct ScrollBottomAnchorPreferenceKey: PreferenceKey {
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
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 12))
                .foregroundColor(.yellow)
            Text(BrowserOSMessageBubble.cleanErrorContent(message.content))
                .font(.system(size: 13, weight: .medium, design: .default))
                .foregroundColor(.grokText)
            // The failure text is a summary; the bus holds the full record.
            TabLogsButton(tab: .chat, compact: true)
                .padding(.top, 1)
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
        cleaned = cleaned.replacingOccurrences(of: "Warning: ", with: "")
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

// MARK: - Execution Planner

private extension ChatPanelView {
    /// Renders the planner only when the turn did enough work to describe.
    /// A one-step turn is plain chat; showing a single-row checklist is an
    /// empty skeleton that costs vertical space and says nothing.
    @ViewBuilder
    var queenActivityFeed: some View {
        if viewModel.todoPlanner.shouldDisplayPlan {
            plannerCard
        }
    }

    var plannerCard: some View {
        TODOListView(
            planner: viewModel.todoPlanner,
            conversationId: viewModel.conversationId,
            memoryControlRevision: viewModel.memoryControlRevision,
            isExpanded: workspaceMode == .expanded,
            recalledMemories: viewModel.recalledMemories,
            onSearchMemory: { query in
                await viewModel.searchMemories(query)
            },
            onLoadRecentMemory: { limit in
                try await viewModel.recentMemories(limit: limit)
            },
            onForgetMemory: { memoryId in
                try await viewModel.forgetMemory(id: memoryId)
            },
            onClearConversationMemory: { conversationId in
                try await viewModel.clearConversationMemories(
                    conversationId: conversationId
                )
            }
        )
        .padding(.horizontal, workspaceMode == .expanded ? 28 : 12)
        .padding(.vertical, 8)
        .background(Color.clear)
    }
}

// MARK: - Status Hint Model

private struct StatusHint: Equatable {
    let icon: String
    let text: String
    let color: Color
}

/// Reports the planner card's natural height so its scroll container can hug it.
private struct PlannerContentHeightPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

// MARK: - Pinned Spec Header

/// Pins the active task's specification above the chat so it stays visible
/// without scrolling. Shows each acceptance criterion with its verdict and,
/// when acceptance is blocked, what is blocking — without running `/verify`.
///
/// Renders nothing when the current conversation has no delegated task, so the
/// header is invisible in normal (non-delegated) chats.
private struct PinnedSpecHeader: View {
    @ObservedObject var registry: QueenDelegationRegistry
    let conversationId: UUID
    @Binding var isCollapsed: Bool

    private var task: DelegatedTask? {
        registry.task(forConversation: conversationId)
    }

    var body: some View {
        if let task {
            headerContent(for: task)
        }
    }

    // MARK: - Layout

    @ViewBuilder
    private func headerContent(for task: DelegatedTask) -> some View {
        let verdicts = QueenAcceptancePolicy.verdicts(
            criteria: task.acceptanceCriteria,
            recorded: task.criterionVerdicts
        )
        let blockReason = QueenAcceptancePolicy.acceptanceBlockReason(
            criteria: task.acceptanceCriteria,
            recorded: task.criterionVerdicts
        )
        let metCount = verdicts.filter { $0.verdict == .met }.count
        let unmetCount = verdicts.filter { $0.verdict == .unmet }.count
        let uncheckedCount = verdicts.filter { $0.verdict == .unchecked }.count

        VStack(spacing: 0) {
            titleBar(
                task: task,
                metCount: metCount,
                unmetCount: unmetCount,
                uncheckedCount: uncheckedCount,
                isBlocked: blockReason != nil
            )
            if !isCollapsed {
                Divider()
                    .overlay(Color.grokDivider.opacity(0.4))
                    .padding(.horizontal, 14)
                criteriaList(verdicts: verdicts)
                if let reason = blockReason {
                    blockReasonBanner(reason: reason)
                }
            }
        }
        .background(
            ZStack {
                GlassmorphismBackground(
                    material: .underWindowBackground,
                    blending: .withinWindow,
                    cornerRadius: 0
                )
                Color.black.opacity(0.25)
            }
        )
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.grokBorder.opacity(0.5))
                .frame(height: 1)
        }
    }

    // MARK: - Title Bar

    @ViewBuilder
    private func titleBar(
        task: DelegatedTask,
        metCount: Int,
        unmetCount: Int,
        uncheckedCount: Int,
        isBlocked: Bool
    ) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "doc.text.magnifyingglass")
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(.white.opacity(0.6))

            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(task.issue.slug)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundColor(.white.opacity(0.88))
                    Text(task.title)
                        .font(.system(size: 11))
                        .foregroundColor(.grokMuted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                HStack(spacing: 8) {
                    if metCount > 0 {
                        verdictPill(count: metCount, label: "met", color: .green)
                    }
                    if unmetCount > 0 {
                        verdictPill(count: unmetCount, label: "unmet", color: .red)
                    }
                    if uncheckedCount > 0 {
                        verdictPill(count: uncheckedCount, label: "unchecked", color: .yellow)
                    }
                    if isBlocked {
                        HStack(spacing: 3) {
                            Image(systemName: "lock.fill")
                                .font(.system(size: 8, weight: .bold))
                            Text("blocked")
                                .font(.system(size: 9, weight: .semibold))
                        }
                        .foregroundColor(.red.opacity(0.9))
                    }
                }
            }

            Spacer(minLength: 4)

            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    isCollapsed.toggle()
                }
            } label: {
                Image(systemName: isCollapsed ? "chevron.down" : "chevron.up")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.white.opacity(0.5))
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(.plain)
            .help(isCollapsed ? "Expand specification" : "Collapse specification")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    // MARK: - Criteria List

    @ViewBuilder
    private func criteriaList(
        verdicts: [(criterion: String, verdict: QueenCriterionVerdict)]
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(verdicts.enumerated()), id: \.offset) { index, row in
                criterionRow(index: index + 1, text: row.criterion, verdict: row.verdict)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private func criterionRow(
        index: Int,
        text: String,
        verdict: QueenCriterionVerdict
    ) -> some View {
        HStack(alignment: .top, spacing: 6) {
            verdictBadge(verdict)
                .frame(width: 14, height: 14)
                .padding(.top, 1)
            Text("\(index). \(text)")
                .font(.system(size: 11))
                .foregroundColor(verdictTextColor(verdict))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func verdictBadge(_ verdict: QueenCriterionVerdict) -> some View {
        ZStack {
            Circle()
                .fill(verdictColor(verdict).opacity(0.18))
            Image(systemName: verdictIcon(verdict))
                .font(.system(size: 8, weight: .bold))
                .foregroundColor(verdictColor(verdict))
        }
    }

    private func verdictPill(count: Int, label: String, color: Color) -> some View {
        HStack(spacing: 3) {
            Text("\(count)")
                .font(.system(size: 9, weight: .bold, design: .monospaced))
            Text(label)
                .font(.system(size: 9))
        }
        .foregroundColor(color.opacity(0.9))
        .padding(.horizontal, 5)
        .padding(.vertical, 1)
        .background(color.opacity(0.12))
        .clipShape(Capsule())
    }

    // MARK: - Block Reason

    @ViewBuilder
    private func blockReasonBanner(reason: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(.red.opacity(0.85))
                .padding(.top, 1)
            Text(reason)
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.red.opacity(0.8))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(Color.red.opacity(0.06))
    }

    // MARK: - Verdict Helpers

    private func verdictColor(_ verdict: QueenCriterionVerdict) -> Color {
        switch verdict {
        case .met: return .green
        case .unmet: return .red
        case .unchecked: return .yellow
        }
    }

    private func verdictIcon(_ verdict: QueenCriterionVerdict) -> String {
        switch verdict {
        case .met: return "checkmark"
        case .unmet: return "xmark"
        case .unchecked: return "questionmark"
        }
    }

    private func verdictTextColor(_ verdict: QueenCriterionVerdict) -> Color {
        switch verdict {
        case .met: return .white.opacity(0.78)
        case .unmet: return .white.opacity(0.78)
        case .unchecked: return .white.opacity(0.55)
        }
    }
}

// MARK: - Queen Bee Board

/// Board of bee cards pinned at the top of the Queen's master chat.
///
/// One card per live task — issue, worker, state, branch — so the Queen sees
/// the swarm at a glance without scrolling through worker transcripts. A task
/// that waits on a human decision is visually distinct from one that is quietly
/// working, because that distinction is the most frequent reason to look.
private struct QueenBeeBoard: View {
    @ObservedObject var registry: QueenDelegationRegistry
    let onSelectBee: (UUID) -> Void

    /// Tasks shown needs-attention first, then newest. Attention-demanding
    /// tasks rise to the left so the Queen does not have to hunt past quiet
    /// workers to find what is blocked.
    private var displayTasks: [DelegatedTask] {
        registry.open.sorted { a, b in
            if a.state.needsQueenAttention != b.state.needsQueenAttention {
                return a.state.needsQueenAttention && !b.state.needsQueenAttention
            }
            return a.updatedAt > b.updatedAt
        }
    }

    /// Whether any task is currently demanding the Queen's attention, so the
    /// header can flag it without the user reading every card.
    private var hasAttentionTasks: Bool {
        displayTasks.contains { $0.state.needsQueenAttention }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            boardHeader
            cardsRow
        }
        .padding(.vertical, 8)
        .background(
            ZStack {
                GlassmorphismBackground(
                    material: .underWindowBackground,
                    blending: .withinWindow,
                    cornerRadius: 0
                )
                Color.black.opacity(0.2)
            }
        )
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.grokBorder.opacity(0.3))
                .frame(height: 1)
        }
    }

    // MARK: - Header

    private var boardHeader: some View {
        HStack(spacing: 6) {
            Image(systemName: "rectangle.grid.2x2.fill")
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(.white.opacity(0.4))
            Text("Bee Board")
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(.white.opacity(0.5))
                .textCase(.uppercase)
                .tracking(0.5)

            Text("\(displayTasks.count)")
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundColor(.white.opacity(0.35))

            if hasAttentionTasks {
                let attentionCount = displayTasks.filter { $0.state.needsQueenAttention }.count
                HStack(spacing: 2) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.system(size: 8))
                    Text("\(attentionCount) need you")
                        .font(.system(size: 9, weight: .semibold))
                }
                .foregroundColor(.yellow.opacity(0.9))
            }
            Spacer()
        }
        .padding(.horizontal, 14)
    }

    // MARK: - Cards

    private var cardsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(displayTasks) { task in
                    BeeCard(task: task) {
                        onSelectBee(task.conversationId)
                    }
                }
            }
            .padding(.horizontal, 14)
        }
    }
}

// MARK: - Bee Card

/// One task card on the bee board.
///
/// The card answers four questions at a glance: which issue, which bee, what
/// state, and which branch. Clicking opens that bee's conversation.
///
/// A card that needs a human decision is visually distinct from one that is
/// working: it gets a coloured border, a tinted background, and a filled dot
/// indicator instead of a glyph, so the most important distinction — "do I
/// need to act?" — is visible before reading any text.
private struct BeeCard: View {
    let task: DelegatedTask
    let onTap: () -> Void

    @State private var isHovered = false

    private var needsAttention: Bool { task.state.needsQueenAttention }
    private var accentColor: Color { QueenTaskStyle.color(for: task.state) }
    private var stateIcon: String { QueenTaskStyle.symbol(for: task.state) }

    /// State label tuned for the board: "Ready to merge" for an accepted task
    /// with a pull request reads more clearly than "Accepted", because the
    /// question the Queen asks is not "did I accept this?" but "is it ready?".
    private var stateLabel: String {
        switch task.state {
        case .accepted:
            return task.pullRequestNumber != nil ? "Ready to merge" : "Accepted"
        default:
            return QueenTaskStyle.label(for: task.state)
        }
    }

    var body: some View {
        Button(action: onTap) {
            cardContent
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovered = hovering
        }
        .help("Open \(task.worker)'s chat")
    }

    private var cardContent: some View {
        VStack(alignment: .leading, spacing: 5) {
            // Row 1 — status + issue number
            HStack(spacing: 6) {
                statusIndicator
                Text(stateLabel)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(accentColor)
                    .lineLimit(1)

                Spacer(minLength: 4)

                Text("#\(task.issue.number)")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundColor(.white.opacity(0.55))
            }

            // Row 2 — task title
            Text(task.title)
                .font(.system(size: 11))
                .foregroundColor(.white.opacity(0.82))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

            // Row 3 — bee + branch
            HStack(spacing: 4) {
                Image(systemName: "ant.fill")
                    .font(.system(size: 8))
                    .foregroundColor(accentColor.opacity(0.7))
                Text(task.worker)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundColor(.grokMuted)
                    .lineLimit(1)
                if let branch = task.virtualBranch {
                    Text("·")
                        .font(.system(size: 9))
                        .foregroundColor(.grokDim)
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 7))
                        .foregroundColor(.grokDim)
                    Text(branch)
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundColor(.grokMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(10)
        .frame(width: 208)
        .background(cardBackground)
        .overlay(cardBorder)
        .scaleEffect(isHovered ? 1.02 : 1.0)
        .animation(.easeOut(duration: 0.12), value: isHovered)
    }

    // MARK: - Status Indicator

    @ViewBuilder
    private var statusIndicator: some View {
        if needsAttention {
            // A filled dot with a halo ring is visually distinct from the SF
            // Symbol icons on working cards. The shape difference — circle vs
            // glyph — reads instantly before any text is scanned.
            Circle()
                .fill(accentColor)
                .frame(width: 8, height: 8)
                .overlay(
                    Circle()
                        .stroke(accentColor.opacity(0.3), lineWidth: 2)
                        .padding(-3)
                )
        } else {
            Image(systemName: stateIcon)
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(accentColor)
        }
    }

    // MARK: - Background & Border

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 10)
            .fill(needsAttention
                  ? accentColor.opacity(0.08)
                  : Color.grokElevated.opacity(0.5))
    }

    private var cardBorder: some View {
        RoundedRectangle(cornerRadius: 10)
            .strokeBorder(
                needsAttention
                    ? accentColor.opacity(0.5)
                    : (isHovered ? Color.grokBorder.opacity(0.5) : Color.grokBorder.opacity(0.2)),
                lineWidth: needsAttention ? 1.5 : 1
            )
    }
}
