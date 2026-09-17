#!/usr/bin/env python3
"""Apply Cycle 27 context-length-aware routing edits to the trios Swift codebase."""
import os
import textwrap

TRIOS = "/Users/playra/BrowserOS/trios"


def replace_exact(path, old, new, count=1):
    full = os.path.join(TRIOS, path) if not path.startswith("/") else path
    with open(full, "r") as f:
        data = f.read()
    occurrences = data.count(old)
    if occurrences != count:
        raise RuntimeError(f"{full}: expected {count} occurrence(s) of snippet, found {occurrences}")
    data = data.replace(old, new, count)
    with open(full, "w") as f:
        f.write(data)
    print(f"[OK] edited {full}")


def write_new(path, content):
    full = os.path.join(TRIOS, path) if not path.startswith("/") else path
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(textwrap.dedent(content).lstrip())
    print(f"[OK] wrote {full}")


def edit_model_configuration_store():
    # A. Add published properties for last estimated token counts.
    replace_exact(
        "rings/SR-00/ModelConfigurationStore.swift",
        """    @Published var contextWindowMargin: Double = 0.85
    @Published private(set) var lastContextRoutingReason: String?
    @Published private(set) var lastContextRoutedAt: Date?
""",
        """    @Published var contextWindowMargin: Double = 0.85
    @Published private(set) var lastContextRoutingReason: String?
    @Published private(set) var lastContextRoutedAt: Date?
    @Published private(set) var lastContextEstimatedInputTokens: Int?
    @Published private(set) var lastContextRequestedOutputTokens: Int?
""",
    )

    # B. Record initial size estimate and useCurrent path.
    replace_exact(
        "rings/SR-00/ModelConfigurationStore.swift",
        """        let currentSize = await requestSizer.size(
            messages: messages,
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            modelProfile: currentProfile,
            requestedOutputTokens: requestedOutputTokens,
            margin: contextWindowMargin
        )
        if currentSize.fitsCurrentModel {
            return .useCurrent
        }
""",
        """        let currentSize = await requestSizer.size(
            messages: messages,
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            modelProfile: currentProfile,
            requestedOutputTokens: requestedOutputTokens,
            margin: contextWindowMargin
        )
        lastContextEstimatedInputTokens = currentSize.estimatedInputTokens
        lastContextRequestedOutputTokens = currentSize.requestedOutputTokens
        if currentSize.fitsCurrentModel {
            return .useCurrent
        }
""",
    )

    # C. Record routed size in the routeTo path.
    replace_exact(
        "rings/SR-00/ModelConfigurationStore.swift",
        """        for candidate in largerCandidates {
            if await isCandidateAllowed(candidate) {
                return .routeTo(candidate)
            }
        }
""",
        """        for candidate in largerCandidates {
            if await isCandidateAllowed(candidate) {
                let routedProfile = await contextService.profile(
                    for: candidate.model,
                    provider: candidate.provider
                )
                let routedSize = await requestSizer.size(
                    messages: messages,
                    currentMessage: currentMessage,
                    systemPrompt: systemPrompt,
                    modelProfile: routedProfile,
                    requestedOutputTokens: requestedOutputTokens,
                    margin: contextWindowMargin
                )
                lastContextEstimatedInputTokens = routedSize.estimatedInputTokens
                lastContextRequestedOutputTokens = routedSize.requestedOutputTokens
                return .routeTo(candidate)
            }
        }
""",
    )

    # D. Await actor-isolated trimmer and record trimmed size.
    replace_exact(
        "rings/SR-00/ModelConfigurationStore.swift",
        """        let trimPolicy = await requestSizer.trim(
            messages: messages,
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            modelProfile: currentProfile,
            requestedOutputTokens: requestedOutputTokens,
            margin: contextWindowMargin,
            minRetainedTurns: 2
        )
        let trimmedMessages = requestSizer.trimmedMessages(from: messages, policy: trimPolicy)
        let trimmedSize = await requestSizer.size(
            messages: trimmedMessages,
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            modelProfile: currentProfile,
            requestedOutputTokens: requestedOutputTokens,
            margin: contextWindowMargin
        )
        if trimmedSize.fitsCurrentModel {
            return .trimHistory(trimPolicy)
        }
""",
        """        let trimPolicy = await requestSizer.trim(
            messages: messages,
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            modelProfile: currentProfile,
            requestedOutputTokens: requestedOutputTokens,
            margin: contextWindowMargin,
            minRetainedTurns: 2
        )
        let trimmedMessages = await requestSizer.trimmedMessages(from: messages, policy: trimPolicy)
        let trimmedSize = await requestSizer.size(
            messages: trimmedMessages,
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            modelProfile: currentProfile,
            requestedOutputTokens: requestedOutputTokens,
            margin: contextWindowMargin
        )
        if trimmedSize.fitsCurrentModel {
            lastContextEstimatedInputTokens = trimmedSize.estimatedInputTokens
            lastContextRequestedOutputTokens = trimmedSize.requestedOutputTokens
            return .trimHistory(trimPolicy)
        }
""",
    )

    # E. Add context-window utilization helper after maxAvailableWindow.
    replace_exact(
        "rings/SR-00/ModelConfigurationStore.swift",
        """        return maxWindow
    }
}
""",
        """        return maxWindow
    }

    /// Returns the estimated utilization of a model's usable context window
    /// (accounting for the configured safety margin). Used by the Models tab
    /// badge and the composer status indicator.
    func contextWindowUtilizationPercent(
        for model: String,
        provider: ModelProvider
    ) async -> Double? {
        guard let input = lastContextEstimatedInputTokens, input >= 0 else {
            return nil
        }
        let output = lastContextRequestedOutputTokens ?? 0
        let profile = await contextService.profile(for: model, provider: provider)
        guard profile.maxContextTokens > 0 else { return nil }
        let usable = Double(profile.maxContextTokens) * contextWindowMargin
        guard usable > 0 else { return nil }
        return Double(input + output) / usable * 100.0
    }
}
""",
    )


def edit_chat_view_model():
    # 1. Clear transient routing state at the start of each send.
    replace_exact(
        "rings/SR-02/ChatViewModel.swift",
        """        lastSendTime = now

        // Trinity Queen conversation intercepts slash commands locally.
""",
        """        lastSendTime = now
        contextUtilizationPercent = nil
        contextRoutingLabel = nil
        requestError = nil

        // Trinity Queen conversation intercepts slash commands locally.
""",
    )

    # 2. Make historyForRequest mutable so trimming can reassign it.
    replace_exact(
        "rings/SR-02/ChatViewModel.swift",
        """        let historyForRequest = Array(messages.dropLast())
        beginUsageEstimate(message: text, history: historyForRequest)
""",
        """        var historyForRequest = Array(messages.dropLast())
        beginUsageEstimate(message: text, history: historyForRequest)
""",
    )

    # 3. Insert context routing resolution before the stream is executed.
    replace_exact(
        "rings/SR-02/ChatViewModel.swift",
        """        let activeProvider = modelStore.selectedProvider
        let activeBaseURL = modelStore.baseURL
        let activeModel = modelStore.selectedModel

        let streamStart = Date()
""",
        """        var activeProvider = modelStore.selectedProvider
        var activeBaseURL = modelStore.baseURL
        var activeModel = modelStore.selectedModel

        let systemPrompt = memoryService.promptContext(for: recalledMemories)
        let currentMessage = ChatMessage(role: .user, content: text)
        let routingDecision = await modelStore.resolveContextRoutingDecision(
            conversationId: conversationId,
            messages: historyForRequest,
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            requestedOutputTokens: nil,
            candidates: modelStore.warmupCandidates()
        )

        switch routingDecision {
        case .useCurrent:
            contextRoutingLabel = nil
        case .routeTo(let candidate):
            modelStore.applyContextRoutedSelection(
                candidate: candidate,
                reason: "context routed to \\(candidate.model)"
            )
            activeProvider = candidate.provider
            activeBaseURL = candidate.baseURL
            activeModel = candidate.model
            contextRoutingLabel = "routed to \\(candidate.model)"
        case .trimHistory(let policy):
            historyForRequest = await ChatRequestSizer.shared.trimmedMessages(
                from: historyForRequest,
                policy: policy
            )
            contextRoutingLabel = "trimmed \\(policy.droppedMessageCount) turns"
        case .tooLargeEvenEmpty:
            let errorMessage = "This message is too long for every available model's context window."
            requestError = errorMessage
            contextRoutingLabel = "too large to send"
            contextUtilizationPercent = await modelStore.contextWindowUtilizationPercent(
                for: activeModel,
                provider: activeProvider
            )
            _ = await stateMachine.transition(to: .error(errorMessage))
            state = await stateMachine.currentState()
            await saveHistory(expectedGeneration: generation)
            return
        }

        contextUtilizationPercent = await modelStore.contextWindowUtilizationPercent(
            for: activeModel,
            provider: activeProvider
        )

        let streamStart = Date()
""",
    )


def edit_chat_panel_view():
    # Insert context status view into composer toolbar.
    replace_exact(
        "BR-OUTPUT/ChatPanelView.swift",
        """        HStack(spacing: CGFloat(composerStatusMetrics.itemSpacing)) {
            composerActionMenu
            composerStatusControl

            if workspaceMode == .expanded {
""",
        """        HStack(spacing: CGFloat(composerStatusMetrics.itemSpacing)) {
            composerActionMenu
            composerStatusControl
            composerContextStatus

            if workspaceMode == .expanded {
""",
    )

    # Add the context status helper and color helper near composerStatusControl.
    replace_exact(
        "BR-OUTPUT/ChatPanelView.swift",
        """    private var composerModelLabel: String {
        if composerStatusMetrics.showsProviderName {
            return "\\(modelStore.selectedProvider.displayName) - \\(modelStore.selectedModel)"
        }
        return modelStore.selectedModel
    }
""",
        """    private var composerModelLabel: String {
        if composerStatusMetrics.showsProviderName {
            return "\\(modelStore.selectedProvider.displayName) - \\(modelStore.selectedModel)"
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

    private func contextUtilizationColor(for percent: Double) -> Color {
        if percent <= 70 { return .green }
        if percent <= 85 { return .yellow }
        return .red
    }
""",
    )


def edit_models_tab_view():
    # Add state for per-model utilization badges.
    replace_exact(
        "BR-OUTPUT/ModelsTabView.swift",
        """    @State private var isCachedWarmupWinnerStale: Bool = false
    @State private var isWarmupCacheRefreshing: Bool = false
""",
        """    @State private var isCachedWarmupWinnerStale: Bool = false
    @State private var isWarmupCacheRefreshing: Bool = false
    @State private var contextUtilizationBadges: [String: Double] = [:]
""",
    )

    # Add context routing section to the main VStack.
    replace_exact(
        "BR-OUTPUT/ModelsTabView.swift",
        """                crossProviderSection
                adaptiveWarmupSection
""",
        """                crossProviderSection
                contextRoutingSection
                adaptiveWarmupSection
""",
    )

    # Refresh utilization badges when the tab is requested.
    replace_exact(
        "BR-OUTPUT/ModelsTabView.swift",
        """        .onChange(of: store.modelsTabRequest) {
            Task {
                await refreshStatusBadges()
                await refreshLatencyBadges()
                await refreshCircuitBreakerStates()
                await refreshQuotaBadges()
                await refreshWarmupStats()
            }
        }
""",
        """        .onChange(of: store.modelsTabRequest) {
            Task {
                await refreshStatusBadges()
                await refreshLatencyBadges()
                await refreshCircuitBreakerStates()
                await refreshQuotaBadges()
                await refreshWarmupStats()
                await refreshContextUtilizationBadges()
            }
        }
        .onChange(of: store.contextWindowMargin) { _, _ in
            Task { await refreshContextUtilizationBadges() }
        }
""",
    )

    # Refresh badges on appear as well.
    replace_exact(
        "BR-OUTPUT/ModelsTabView.swift",
        """.onAppear {
            baseURLDraft = store.baseURL
            customModel = store.selectedModel
            if !store.selectedProvider.requiresAPIKey || store.hasAPIKey {
                Task { await store.refreshModels() }
            }
            Task { await refreshCircuitBreakerStates() }
            Task { await refreshQuotaBadges() }
        }
""",
        """.onAppear {
            baseURLDraft = store.baseURL
            customModel = store.selectedModel
            if !store.selectedProvider.requiresAPIKey || store.hasAPIKey {
                Task { await store.refreshModels() }
            }
            Task { await refreshCircuitBreakerStates() }
            Task { await refreshQuotaBadges() }
            Task { await refreshContextUtilizationBadges() }
        }
""",
    )

    # Add badge helpers and the context routing section view.
    replace_exact(
        "BR-OUTPUT/ModelsTabView.swift",
        """    private func statusBadge(for model: String) -> (label: String, color: Color)? {
""",
        """    private func refreshContextUtilizationBadges() async {
        var badges: [String: Double] = [:]
        for model in store.availableModels {
            if let percent = await store.contextWindowUtilizationPercent(
                for: model,
                provider: store.selectedProvider
            ) {
                badges[model] = percent
            }
        }
        contextUtilizationBadges = badges
    }

    private func contextUtilizationBadge(for model: String) -> (label: String, color: Color)? {
        guard let percent = contextUtilizationBadges[model] else { return nil }
        let color: Color
        if percent <= 70 { color = .green }
        else if percent <= 85 { color = .yellow }
        else { color = .red }
        return (String(format: "~%.0f%%", percent), color)
    }

    private var contextRoutingSection: some View {
        modelSection(
            title: "Context routing",
            subtitle: "TriOS can route or trim long conversations before sending to avoid context-window failures."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                Stepper(
                    "Context window margin: \\(Int(store.contextWindowMargin * 100))%",
                    value: $store.contextWindowMargin,
                    in: 0.50...0.95,
                    step: 0.05
                )
                .onChange(of: store.contextWindowMargin) { _, newValue in
                    store.setContextWindowMargin(newValue)
                }
                .font(.system(size: 12))

                if let reason = store.lastContextRoutingReason {
                    Label(reason, systemImage: "arrow.left.arrow.right.circle")
                        .font(.system(size: 11))
                        .foregroundColor(.grokDim)
                }

                if let lastAt = store.lastContextRoutedAt {
                    Text("Last context route: \\(formatRelativeDate(lastAt))")
                        .font(.system(size: 10))
                        .foregroundColor(.grokMuted)
                }
            }
        }
    }

    private func statusBadge(for model: String) -> (label: String, color: Color)? {
""",
    )

    # Render the badge inside each model row.
    replace_exact(
        "BR-OUTPUT/ModelsTabView.swift",
        """                                if let latencyBadge = latencyBadge(for: model) {
                                    Text(latencyBadge.label)
                                        .font(.system(size: 9, weight: .semibold))
                                        .foregroundColor(latencyBadge.color)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(latencyBadge.color.opacity(0.12))
                                        .clipShape(Capsule())
                                }
                                Spacer()
""",
        """                                if let latencyBadge = latencyBadge(for: model) {
                                    Text(latencyBadge.label)
                                        .font(.system(size: 9, weight: .semibold))
                                        .foregroundColor(latencyBadge.color)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(latencyBadge.color.opacity(0.12))
                                        .clipShape(Capsule())
                                }
                                if let contextBadge = contextUtilizationBadge(for: model) {
                                    Text(contextBadge.label)
                                        .font(.system(size: 9, weight: .semibold))
                                        .foregroundColor(contextBadge.color)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(contextBadge.color.opacity(0.12))
                                        .clipShape(Capsule())
                                }
                                Spacer()
""",
    )


def write_model_context_service_tests():
    write_new(
        "tests/TriOSKitTests/ModelContextServiceTests.swift",
        """
        import Foundation
        import XCTest
        @testable import TriOSKit

        @MainActor
        final class ModelContextServiceTests: XCTestCase {
            private var service: ModelContextService!

            override func setUp() {
                service = ModelContextService()
            }

            func testOpenAIProfile() async {
                let profile = await service.profile(for: "gpt-5", provider: .openai)
                XCTAssertEqual(profile.maxContextTokens, 128_000)
                XCTAssertEqual(profile.maxOutputTokens, 16_384)
            }

            func testAnthropicProfile() async {
                let profile = await service.profile(for: "claude-sonnet-4-5", provider: .anthropic)
                XCTAssertEqual(profile.maxContextTokens, 200_000)
                XCTAssertEqual(profile.maxOutputTokens, 8_192)
            }

            func testZAIProfile() async {
                let profile = await service.profile(for: "glm-5.1", provider: .zai)
                XCTAssertEqual(profile.maxContextTokens, 128_000)
                XCTAssertEqual(profile.maxOutputTokens, 4_096)
            }

            func testOllamaDefault() async {
                let profile = await service.profile(for: "llama3.1", provider: .ollama)
                XCTAssertEqual(profile.maxContextTokens, 128_000)
            }

            func testOpenRouterStripsPrefix() async {
                let profile = await service.profile(for: "openai/gpt-5", provider: .openrouter)
                XCTAssertEqual(profile.maxContextTokens, 128_000)
            }

            func testUnknownModelIsConservative() async {
                let profile = await service.profile(for: "unknown-model", provider: .openai)
                XCTAssertEqual(profile.maxContextTokens, 4_096)
                XCTAssertEqual(profile.maxOutputTokens, 1_024)
            }

            func testFitsWithMargin() async {
                let profile = ModelContextProfile(maxContextTokens: 100_000, maxOutputTokens: 4_096)
                XCTAssertTrue(await service.fits(10_000, profile: profile, outputTokens: 2_000, margin: 0.85))
                XCTAssertFalse(await service.fits(90_000, profile: profile, outputTokens: 10_000, margin: 0.85))
            }

            func testLargerContextCandidatesOrdering() async {
                let current = CrossProviderModelCandidate(provider: .zai, baseURL: "https://z.ai", model: "glm-5")
                let candidates = [
                    CrossProviderModelCandidate(provider: .openai, baseURL: "https://api.openai.com", model: "gpt-5"),
                    CrossProviderModelCandidate(provider: .anthropic, baseURL: "https://api.anthropic.com", model: "claude-sonnet-4-5")
                ]
                let larger = await service.largerContextCandidates(
                    estimatedInput: 50_000,
                    outputTokens: 1_000,
                    current: current,
                    candidates: candidates,
                    margin: 0.85
                )
                XCTAssertEqual(larger.count, 2)
                XCTAssertEqual(larger.first?.model, "claude-sonnet-4-5")
            }

            func testLargerContextCandidatesFiltersSmallerWindows() async {
                let current = CrossProviderModelCandidate(provider: .openai, baseURL: "https://api.openai.com", model: "gpt-5")
                let candidates = [
                    CrossProviderModelCandidate(provider: .zai, baseURL: "https://z.ai", model: "glm-5")
                ]
                let larger = await service.largerContextCandidates(
                    estimatedInput: 1_000,
                    outputTokens: 1_000,
                    current: current,
                    candidates: candidates,
                    margin: 0.85
                )
                XCTAssertTrue(larger.isEmpty)
            }
        }
        """,
    )


def write_chat_request_sizer_tests():
    write_new(
        "tests/TriOSKitTests/ChatRequestSizerTests.swift",
        """
        import Foundation
        import XCTest
        @testable import TriOSKit

        @MainActor
        final class ChatRequestSizerTests: XCTestCase {
            private var sizer: ChatRequestSizer!

            override func setUp() {
                sizer = ChatRequestSizer()
            }

            private func smallProfile() -> ModelContextProfile {
                ModelContextProfile(maxContextTokens: 1_024, maxOutputTokens: 256)
            }

            func testSizeFitsWhenRequestWithinWindow() async {
                let messages = [ChatMessage(role: .user, content: "hello")]
                let current = ChatMessage(role: .user, content: "world")
                let size = await sizer.size(
                    messages: messages,
                    currentMessage: current,
                    systemPrompt: nil,
                    modelProfile: smallProfile(),
                    requestedOutputTokens: nil,
                    margin: 0.85
                )
                XCTAssertTrue(size.fitsCurrentModel)
            }

            func testSizeOverflowsWhenRequestExceedsWindow() async {
                let messages = [ChatMessage(role: .user, content: String(repeating: "a ", count: 5_000))]
                let current = ChatMessage(role: .user, content: "ok")
                let size = await sizer.size(
                    messages: messages,
                    currentMessage: current,
                    systemPrompt: nil,
                    modelProfile: smallProfile(),
                    requestedOutputTokens: nil,
                    margin: 0.85
                )
                XCTAssertFalse(size.fitsCurrentModel)
            }

            func testTrimPreservesSystemPromptAndToolPairs() async {
                let system = "You are helpful."
                let assistant = ChatMessage(
                    role: .assistant,
                    content: "searching",
                    toolCalls: [ToolCall(id: "1", name: "search", arguments: "{}", isComplete: false)]
                )
                let tool = ChatMessage(role: .tool, content: "result")
                let messages = [
                    ChatMessage(role: .system, content: system),
                    assistant,
                    tool
                ]
                let current = ChatMessage(role: .user, content: "next")
                let policy = await sizer.trim(
                    messages: messages,
                    currentMessage: current,
                    systemPrompt: system,
                    modelProfile: smallProfile(),
                    requestedOutputTokens: nil,
                    margin: 0.85,
                    minRetainedTurns: 2
                )
                XCTAssertTrue(policy.preservedSystemPrompt)
                XCTAssertEqual(policy.originalMessageCount, 3)
            }

            func testTrimDropsOldestTurnsFirst() async {
                let messages = [
                    ChatMessage(role: .user, content: String(repeating: "a ", count: 2_000)),
                    ChatMessage(role: .assistant, content: "response"),
                    ChatMessage(role: .user, content: String(repeating: "b ", count: 100)),
                    ChatMessage(role: .assistant, content: "response")
                ]
                let current = ChatMessage(role: .user, content: "final")
                let policy = await sizer.trim(
                    messages: messages,
                    currentMessage: current,
                    systemPrompt: nil,
                    modelProfile: smallProfile(),
                    requestedOutputTokens: nil,
                    margin: 0.85,
                    minRetainedTurns: 2
                )
                let retained = await sizer.trimmedMessages(from: messages, policy: policy)
                XCTAssertTrue(retained.count < messages.count)
                XCTAssertFalse(retained.contains { $0.content.hasPrefix("a ") })
            }

            func testTrimCanDropBelowMinRetainedTurnsWhenNeeded() async {
                let messages = [
                    ChatMessage(role: .user, content: "first"),
                    ChatMessage(role: .assistant, content: "second")
                ]
                let current = ChatMessage(role: .user, content: String(repeating: "huge ", count: 500))
                let policy = await sizer.trim(
                    messages: messages,
                    currentMessage: current,
                    systemPrompt: nil,
                    modelProfile: smallProfile(),
                    requestedOutputTokens: nil,
                    margin: 0.85,
                    minRetainedTurns: 2
                )
                XCTAssertTrue(policy.droppedMessageCount >= 0)
                XCTAssertTrue(policy.retainedMessageCount <= messages.count)
            }
        }
        """,
    )


def extend_cross_provider_tests():
    # Insert new tests before the MARK: - Test doubles.
    replace_exact(
        "tests/TriOSKitTests/ModelConfigurationStoreCrossProviderTests.swift",
        """    func testCrossProviderFailoverTogglePersists() {
        XCTAssertFalse(store.isCrossProviderFailoverEnabled)
        store.setCrossProviderFailoverEnabled(true)
        XCTAssertTrue(store.isCrossProviderFailoverEnabled)

        let fresh = ModelConfigurationStore(
            defaults: defaults,
            environment: [:],
            catalogService: ModelCatalogService(),
            statusService: statusService,
            healthService: healthService,
            reliabilityService: reliabilityService
        )
        XCTAssertTrue(fresh.isCrossProviderFailoverEnabled)
    }
}

// MARK: - Test doubles
""",
        """    func testCrossProviderFailoverTogglePersists() {
        XCTAssertFalse(store.isCrossProviderFailoverEnabled)
        store.setCrossProviderFailoverEnabled(true)
        XCTAssertTrue(store.isCrossProviderFailoverEnabled)

        let fresh = ModelConfigurationStore(
            defaults: defaults,
            environment: [:],
            catalogService: ModelCatalogService(),
            statusService: statusService,
            healthService: healthService,
            reliabilityService: reliabilityService
        )
        XCTAssertTrue(fresh.isCrossProviderFailoverEnabled)
    }

    func testResolveContextRoutingDecisionRoutesToLargerCandidate() async {
        store.applySelection(provider: .zai, baseURL: "https://z.ai", model: "glm-5")

        let huge = String(repeating: "word ", count: 30_000)
        let currentMessage = ChatMessage(role: .user, content: huge)
        let candidates = [
            CrossProviderModelCandidate(provider: .openai, baseURL: "https://api.openai.com", model: "gpt-5")
        ]

        let decision = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: [],
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: nil,
            candidates: candidates
        )

        guard case .routeTo(let candidate) = decision else {
            XCTFail("Expected routeTo, got \\(decision)")
            return
        }
        XCTAssertEqual(candidate.provider, .openai)
        XCTAssertEqual(candidate.model, "gpt-5")
    }

    func testResolveContextRoutingDecisionTrimsWhenNoLargerCandidateFits() async {
        store.applySelection(provider: .zai, baseURL: "https://z.ai", model: "glm-5")

        let history = [
            ChatMessage(role: .user, content: String(repeating: "old ", count: 20_000)),
            ChatMessage(role: .assistant, content: "ok")
        ]
        let currentMessage = ChatMessage(role: .user, content: String(repeating: "word ", count: 10_000))
        let candidates: [CrossProviderModelCandidate] = []

        let decision = await store.resolveContextRoutingDecision(
            conversationId: UUID(),
            messages: history,
            currentMessage: currentMessage,
            systemPrompt: nil,
            requestedOutputTokens: nil,
            candidates: candidates
        )

        guard case .trimHistory(let policy) = decision else {
            XCTFail("Expected trimHistory, got \\(decision)")
            return
        }
        XCTAssertTrue(policy.droppedMessageCount > 0)
    }
}

// MARK: - Test doubles
""",
    )


if __name__ == "__main__":
    edit_model_configuration_store()
    edit_chat_view_model()
    edit_chat_panel_view()
    edit_models_tab_view()
    write_model_context_service_tests()
    write_chat_request_sizer_tests()
    extend_cross_provider_tests()
    print("All edits applied.")
