import SwiftUI

struct ModelsTabView: View {
    @EnvironmentObject private var store: ModelConfigurationStore
    @ObservedObject private var viewModel: ChatViewModel
    @State private var apiKeyDraft = ""
    @State private var apiKeyLabelDraft = ""
    @State private var customModel = ""
    @State private var baseURLDraft = ""
    @State private var searchText = ""
    @State private var credentialMessage: String?
    @State private var statusBadges: [String: ProviderModelStatus] = [:]
    @State private var latencyBadges: [String: ModelLatency] = [:]
    @State private var providerProbeResults: [(provider: ModelProvider, baseURL: String, result: ModelHealthResult)] = []
    @State private var isProbingAllProviders = false
    @State private var breakerStates: [(provider: ModelProvider, baseURL: String, state: ProviderCircuitBreakerState, nextRetry: Date?, lastFailureKind: ProviderCircuitBreakerFailureKind?)] = []
    @State private var warmupRemainingTTL: TimeInterval?
    @State private var warmupFailureRate: Double = 0
    @State private var hasWarmupVolatilityHistory: Bool = false
    @State private var warmupVolatilityHistoryCount: Int = 0
    @State private var isCachedWarmupWinnerStale: Bool = false
    @State private var isWarmupCacheRefreshing: Bool = false
    @State private var contextUtilizationBadges: [String: Double] = [:]
    @State private var learnedLimitBadges: [String: StreamingContextLearnedLimits] = [:]
    @State private var effectiveOutputCeiling: Int? = nil
    @State private var isTestingAPIKey = false
    @State private var apiKeyTestResult: APIKeyTestResult?
    @StateObject private var diagnostics = ChatDiagnosticsRunner()

    init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
    }

    /// Result of a lightweight API-key/balance probe.
    private struct APIKeyTestResult: Identifiable {
        let id = UUID()
        let success: Bool
        let title: String
        let subtitle: String
        let httpStatus: Int?
        let logs: [String]
        /// Set when the key authenticates but the account cannot pay for requests.
        /// Rendered amber, because a green "valid" here would contradict the
        /// HTTP 402 the very next chat message is about to hit.
        var warning: String? = nil

        /// Green for a clean pass, amber for authenticated-but-broke, red for failure.
        var accent: Color {
            guard success else { return .red }
            return warning == nil ? .green : .orange
        }

        var iconName: String {
            guard success else { return "xmark.octagon.fill" }
            return warning == nil ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
        }
    }

    /// True when the current conversation has pinned a specific provider/model/baseURL.
    private var isConversationModelPinned: Bool {
        viewModel.conversationModelConstraint != nil
    }

    /// The pinned tuple for the current conversation, if any.
    private var conversationModelConstraint: ConversationModelConstraint? {
        viewModel.conversationModelConstraint
    }

    /// User-facing label naming the pinned provider and model.
    private var pinnedModelLabel: String {
        guard let constraint = conversationModelConstraint else { return "" }
        return "\(constraint.candidate.provider.displayName) / \(constraint.candidate.model)"
    }

    /// User-facing subtitle for the active model section when pinned.
    private var activeModelSubtitle: String {
        if isConversationModelPinned {
            return "Pinned to this conversation: \(pinnedModelLabel)."
        }
        return "This exact identifier is sent with the next request."
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                providerSection
                activeModelSection
                crossProviderSection
                contextRoutingSection
                adaptiveWarmupSection
                smartSelectionSection
                catalogSection
                credentialSection
                connectionSection
                diagnosticsSection
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(20)
            .frame(maxWidth: .infinity)
        }
.onAppear {
            baseURLDraft = store.baseURL
            customModel = store.selectedModel
            if !store.selectedProvider.requiresAPIKey || store.hasAPIKey {
                Task { await store.refreshModels() }
            }
            Task { await refreshCircuitBreakerStates() }
            Task { await refreshQuotaBadges() }
            Task { await refreshContextUtilizationBadges() }
        }
        .onChange(of: store.selectedProvider) {
            baseURLDraft = store.baseURL
            customModel = store.selectedModel
            apiKeyDraft = ""
            credentialMessage = nil
            searchText = ""
            statusBadges.removeAll()
            Task { await store.refreshModels() }
            Task { await refreshCircuitBreakerStates() }
            Task { await refreshQuotaBadges() }
            Task { await refreshContextUtilizationBadges() }
        }
        .onChange(of: store.modelsTabRequest) {
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
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Models & API keys")
                .font(.system(size: 22, weight: .bold))
                .foregroundColor(.grokText)
            Text("Choose the runtime used by new messages. Secrets stay in macOS Keychain.")
                .font(.system(size: 12))
                .foregroundColor(.grokMuted)
        }
    }

    private var providerSection: some View {
        modelSection(title: "Provider", subtitle: "Switching provider restores its last model and endpoint.") {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 118), spacing: 8)], spacing: 8) {
                ForEach(ModelProvider.allCases) { provider in
                    Button {
                        store.selectProvider(provider)
                    } label: {
                        HStack(spacing: 7) {
                            Circle()
                                .fill(provider == store.selectedProvider ? Color.green : Color.grokDim)
                                .frame(width: 7, height: 7)
                            Text(provider.displayName)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.grokText)
                        .padding(.horizontal, 10)
                        .frame(height: 38)
                        .background(provider == store.selectedProvider ? Color.grokElevated : Color.grokSurface)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay {
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(provider == store.selectedProvider ? Color.grokText.opacity(0.32) : Color.grokBorder)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var smartSelectionSection: some View {
        modelSection(
            title: "Smart model selection",
            subtitle: store.isPredictiveSelectionEnabled
                ? (store.predictiveSelectionReason ?? "TriOS will pick the best eligible model automatically.")
                : "Let TriOS choose the best model using reliability history and cost preferences."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                Toggle("Enable smart selection", isOn: $store.isPredictiveSelectionEnabled)
                    .toggleStyle(.switch)

                if store.isPredictiveSelectionEnabled {
                    HStack(spacing: 10) {
                        Text("Cost tier:")
                            .font(.system(size: 12))
                            .foregroundColor(.grokText)
                        Picker("Cost tier", selection: $store.preferredCostTier) {
                            ForEach(ModelCostTier.allCases) { tier in
                                Text(tier.displayName).tag(tier)
                            }
                        }
                        .pickerStyle(.segmented)
                        .frame(maxWidth: 280)
                        Spacer()
                        Button {
                            Task { await store.selectBestModel() }
                        } label: {
                            Label("Pick best now", systemImage: "wand.and.stars")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(store.availableModels.count <= 1)
                    }

                    if let reason = store.predictiveSelectionReason {
                        Text(reason)
                            .font(.system(size: 10))
                            .foregroundColor(.grokDim)
                    }
                }
            }
        }
    }

    private var activeModelSection: some View {
        modelSection(title: "Active model", subtitle: activeModelSubtitle) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Image(systemName: "cpu")
                        .foregroundColor(.green)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(store.selectedModel)
                            .font(.system(size: 13, weight: .semibold, design: .monospaced))
                            .foregroundColor(.grokText)
                            .textSelection(.enabled)
                        HStack(spacing: 6) {
                            Text(store.selectedProvider.displayName)
                                .font(.system(size: 10))
                                .foregroundColor(.grokDim)
                            if isConversationModelPinned {
                                HStack(spacing: 3) {
                                    Image(systemName: "pin.fill")
                                        .font(.system(size: 8))
                                    Text("pinned")
                                }
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundColor(.blue)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.blue.opacity(0.12))
                                .clipShape(Capsule())
                            }
                            if store.unhealthyModels.contains(store.selectedModel) {
                                Text("unavailable")
                                    .font(.system(size: 9, weight: .semibold))
                                    .foregroundColor(.red)
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 1)
                                    .background(Color.red.opacity(0.12))
                                    .clipShape(Capsule())
                            }
                        }
                    }
                    Spacer()
                }

                if isConversationModelPinned, let constraint = conversationModelConstraint {
                    HStack(spacing: 6) {
                        Image(systemName: "link")
                            .font(.system(size: 10))
                            .foregroundColor(.grokDim)
                        Text(constraint.candidate.baseURL)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.grokDim)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                    }
                    .help("Pinned base URL for this conversation")
                }

                HStack(spacing: 8) {
                    modelTextField("Custom model ID", text: $customModel)
                    Button("Use") {
                        store.selectModel(customModel)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(customModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                if isConversationModelPinned {
                    Label(
                        "This conversation is pinned to \(pinnedModelLabel). Changing the global default here does not affect the pinned conversation.",
                        systemImage: "info.circle"
                    )
                    .font(.system(size: 10))
                    .foregroundColor(.grokDim)
                }

                if let ceiling = effectiveOutputCeiling {
                    HStack(spacing: 6) {
                        Image(systemName: "waveform.circle")
                            .font(.system(size: 11))
                            .foregroundColor(.grokDim)
                        Text("Effective output limit: \(formatCompact(ceiling))")
                            .font(.system(size: 11))
                            .foregroundColor(.grokDim)
                        if let learned = learnedLimitBadge(for: store.selectedModel) {
                            Text("• \(learned.label)")
                                .font(.system(size: 11))
                                .foregroundColor(learned.color)
                        }
                    }
                }
            }
        }
    }

    private var adaptiveWarmupSection: some View {
        modelSection(
            title: "Adaptive provider warmup",
            subtitle: store.isAdaptiveProviderWarmupEnabled
                ? "TriOS races lightweight probes across eligible providers before each send."
                : "TriOS can race lightweight probes and pick the fastest live provider before sending."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                Toggle("Warm up providers before sending", isOn: $store.isAdaptiveProviderWarmupEnabled)
                    .toggleStyle(.switch)
                    .onChange(of: store.isAdaptiveProviderWarmupEnabled) { _, newValue in
                        store.setAdaptiveProviderWarmupEnabled(newValue)
                    }

                if store.isAdaptiveProviderWarmupEnabled {
                    Toggle("Strict quota gating", isOn: $store.isStrictQuotaGatingEnabled)
                        .toggleStyle(.switch)
                        .onChange(of: store.isStrictQuotaGatingEnabled) { _, newValue in
                            store.setStrictQuotaGatingEnabled(newValue)
                        }

                    Toggle("Predictive background warmup", isOn: $store.isPredictiveWarmupEnabled)
                        .toggleStyle(.switch)
                        .onChange(of: store.isPredictiveWarmupEnabled) { _, newValue in
                            store.setPredictiveWarmupEnabled(newValue)
                        }
                }

                if let reason = store.lastAdaptiveWarmupReason {
                    Label(reason, systemImage: "bolt.horizontal.circle")
                        .font(.system(size: 11))
                        .foregroundColor(.grokDim)
                }

                if let lastAt = store.lastAdaptiveWarmupAt {
                    Text("Last send-path warmup: \(formatRelativeDate(lastAt))")
                        .font(.system(size: 10))
                        .foregroundColor(.grokMuted)
                }

                if store.isPredictiveWarmupEnabled {
                    if let reason = store.lastPredictiveWarmupReason {
                        Label(reason, systemImage: "calendar.bolt.circle")
                            .font(.system(size: 11))
                            .foregroundColor(.grokDim)
                    }

                    if let lastAt = store.lastPredictiveWarmupAt {
                        Text("Last background warmup: \(formatRelativeDate(lastAt))")
                            .font(.system(size: 10))
                            .foregroundColor(.grokMuted)
                    }

                    Stepper(
                        "Cache TTL: \(Int(store.predictiveWarmupTTL))s",
                        value: $store.predictiveWarmupTTL,
                        in: 15...300,
                        step: 15
                    )
                    .onChange(of: store.predictiveWarmupTTL) { _, newValue in
                        store.setPredictiveWarmupTTL(newValue)
                    }
                    .font(.system(size: 12))

                    Stepper(
                        "Refresh interval: \(Int(store.predictiveWarmupInterval))s",
                        value: $store.predictiveWarmupInterval,
                        in: 15...600,
                        step: 15
                    )
                    .onChange(of: store.predictiveWarmupInterval) { _, newValue in
                        store.setPredictiveWarmupInterval(newValue)
                    }
                    .font(.system(size: 12))

                    Stepper(
                        "Max staleness: \(Int(store.predictiveWarmupMaxStaleness))s",
                        value: $store.predictiveWarmupMaxStaleness,
                        in: 0...600,
                        step: 30
                    )
                    .onChange(of: store.predictiveWarmupMaxStaleness) { _, newValue in
                        store.setPredictiveWarmupMaxStaleness(newValue)
                    }
                    .font(.system(size: 12))

                    HStack(spacing: 10) {
                        if let ttl = warmupRemainingTTL {
                            Label("Fresh for \(Int(ttl))s", systemImage: "clock")
                        } else if isCachedWarmupWinnerStale {
                            Label("Serving stale winner", systemImage: "exclamationmark.triangle.fill")
                                .foregroundColor(.orange)
                        } else {
                            Label("No fresh cached winner", systemImage: "clock.badge.exclamationmark")
                        }
                        if warmupFailureRate > 0 {
                            Text("• \(Int(warmupFailureRate * 100))% recent failures")
                                .foregroundColor(warmupFailureRate > 0.5 ? .orange : .grokMuted)
                        }
                    }
                    .font(.system(size: 10))
                    .foregroundColor(.grokMuted)

                    if isWarmupCacheRefreshing {
                        Label("Refreshing in background", systemImage: "arrow.clockwise")
                            .font(.system(size: 10))
                            .foregroundColor(.grokMuted)
                    }

                    if hasWarmupVolatilityHistory {
                        Label(
                            "Learning from \(warmupVolatilityHistoryCount) candidate(s)",
                            systemImage: "brain.head.profile"
                        )
                        .font(.system(size: 10))
                        .foregroundColor(.grokMuted)
                    }

                    HStack(spacing: 12) {
                        Button {
                            Task {
                                _ = await store.forcePredictiveWarmupRefresh()
                                await refreshCircuitBreakerStates()
                                await refreshWarmupStats()
                            }
                        } label: {
                            Label("Refresh background warmup", systemImage: "calendar.bolt.circle.fill")
                        }
                        .buttonStyle(.bordered)

                        if hasWarmupVolatilityHistory {
                            Button {
                                Task {
                                    await store.resetWarmupVolatilityHistory()
                                    await refreshWarmupStats()
                                }
                            } label: {
                                Label("Reset learning", systemImage: "arrow.counterclockwise")
                            }
                            .buttonStyle(.borderless)
                            .foregroundColor(.grokMuted)
                        }
                    }
                }

                Button {
                    Task {
                        _ = await store.runAdaptiveWarmup(constrainedTo: conversationModelConstraint)
                        await refreshCircuitBreakerStates()
                    }
                } label: {
                    Label(
                        isConversationModelPinned ? "Warm up pinned model" : "Warm up now",
                        systemImage: "bolt.horizontal.circle.fill"
                    )
                }
                .buttonStyle(.bordered)
                .disabled(!store.isAdaptiveProviderWarmupEnabled)
                .help(
                    isConversationModelPinned
                        ? "Probes only the pinned provider/model/baseURL for this conversation."
                        : "Races probes across eligible providers and may switch the active selection."
                )

                if !quotaBadges.isEmpty {
                    LazyVStack(spacing: 5) {
                        ForEach(Array(quotaBadges.enumerated()), id: \.offset) { index, entry in
                            HStack(spacing: 8) {
                                Image(systemName: quotaIcon(for: entry.quota))
                                    .foregroundColor(quotaColor(for: entry.quota))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.provider.displayName)
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundColor(.grokText)
                                    Text(quotaLabel(for: entry.quota))
                                        .font(.system(size: 9))
                                        .foregroundColor(quotaColor(for: entry.quota))
                                }
                                Spacer()
                            }
                            .padding(.horizontal, 10)
                            .frame(height: 34)
                            .background(Color.grokSurface)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }
        }
    }

    @State private var quotaBadges: [(provider: ModelProvider, baseURL: String, quota: ProviderQuotaStatus)] = []

    private func refreshQuotaBadges() async {
        var newBadges: [(provider: ModelProvider, baseURL: String, quota: ProviderQuotaStatus)] = []
        for config in store.eligibleProviderConfigurations {
            let quota = await store.quotaStatus(for: config.provider, baseURL: config.baseURL)
            if quota != .unknown {
                newBadges.append((provider: config.provider, baseURL: config.baseURL, quota: quota))
            }
        }
        quotaBadges = newBadges
    }

    private func refreshWarmupStats() async {
        warmupRemainingTTL = await store.cachedWarmupRemainingTTL(
            tier: store.preferredCostTier,
            strictQuotaGating: store.isStrictQuotaGatingEnabled
        )
        warmupFailureRate = await store.cachedWinnerFailureRate(
            tier: store.preferredCostTier,
            strictQuotaGating: store.isStrictQuotaGatingEnabled
        )
        hasWarmupVolatilityHistory = await store.hasWarmupVolatilityHistory
        warmupVolatilityHistoryCount = await store.warmupVolatilityHistoryCount
        isCachedWarmupWinnerStale = await store.isCachedWarmupWinnerStale(
            tier: store.preferredCostTier,
            strictQuotaGating: store.isStrictQuotaGatingEnabled
        )
        isWarmupCacheRefreshing = await store.isWarmupCacheRefreshing
    }

    private func quotaIcon(for quota: ProviderQuotaStatus) -> String {
        switch quota {
        case .unknown: return "questionmark.circle.fill"
        case .healthy: return "checkmark.circle.fill"
        case .low: return "exclamationmark.triangle.fill"
        case .depleted: return "xmark.octagon.fill"
        }
    }

    private func quotaColor(for quota: ProviderQuotaStatus) -> Color {
        switch quota {
        case .unknown: return .gray
        case .healthy: return .green
        case .low: return .orange
        case .depleted: return .red
        }
    }

    private func quotaLabel(for quota: ProviderQuotaStatus) -> String {
        switch quota {
        case .unknown:
            return "quota unknown"
        case .healthy(let requests, let tokens):
            var parts: [String] = []
            if let requests { parts.append("requests: \(requests)") }
            if let tokens { parts.append("tokens: \(tokens)") }
            return parts.isEmpty ? "quota healthy" : "quota healthy — \(parts.joined(separator: ", "))"
        case .low(let requests, let tokens):
            var parts: [String] = []
            if let requests { parts.append("requests: \(requests)") }
            if let tokens { parts.append("tokens: \(tokens)") }
            return parts.isEmpty ? "quota low" : "quota low — \(parts.joined(separator: ", "))"
        case .depleted(let reason):
            return "depleted — \(reason)"
        }
    }

    private func formatRelativeDate(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private var crossProviderSection: some View {
        modelSection(
            title: "Cross-provider failover",
            subtitle: store.isCrossProviderFailoverEnabled
                ? "TriOS can switch providers when the current one is unavailable."
                : "TriOS will stay on the current provider during failures."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                Toggle("Allow cross-provider failover", isOn: $store.isCrossProviderFailoverEnabled)
                    .toggleStyle(.switch)
                    .onChange(of: store.isCrossProviderFailoverEnabled) { _, newValue in
                        store.setCrossProviderFailoverEnabled(newValue)
                    }

                if isConversationModelPinned {
                    Label(
                        "Pinned conversations ignore cross-provider failover and stay on \(pinnedModelLabel).",
                        systemImage: "pin.circle"
                    )
                    .font(.system(size: 10))
                    .foregroundColor(.grokDim)
                }

                if let reason = store.crossProviderFailoverReason {
                    Label(reason, systemImage: "arrow.left.arrow.right.circle")
                        .font(.system(size: 11))
                        .foregroundColor(.grokDim)
                }

                Button {
                    Task {
                        isProbingAllProviders = true
                        defer { isProbingAllProviders = false }
                        providerProbeResults = await store.probeAllEligibleProviders()
                    }
                } label: {
                    if isProbingAllProviders {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Probe all providers", systemImage: "network.badge.shield.half.filled")
                    }
                }
                .buttonStyle(.bordered)
                .disabled(isProbingAllProviders)

                if !providerProbeResults.isEmpty {
                    LazyVStack(spacing: 5) {
                        ForEach(providerProbeResults, id: \.provider) { entry in
                            HStack(spacing: 8) {
                                Image(systemName: providerHealthIcon(for: entry.result.health))
                                    .foregroundColor(providerHealthColor(for: entry.result.health))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.provider.displayName)
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundColor(.grokText)
                                    Text(entry.baseURL)
                                        .font(.system(size: 9, design: .monospaced))
                                        .foregroundColor(.grokDim)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                Spacer()
                                Text(providerHealthLabel(for: entry.result.health))
                                    .font(.system(size: 9, weight: .semibold))
                                    .foregroundColor(providerHealthColor(for: entry.result.health))
                            }
                            .padding(.horizontal, 10)
                            .frame(height: 34)
                            .background(Color.grokSurface)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }

                if !breakerStates.isEmpty {
                    LazyVStack(spacing: 5) {
                        ForEach(Array(breakerStates.enumerated()), id: \.offset) { index, entry in
                            HStack(spacing: 8) {
                                Image(systemName: circuitBreakerIcon(for: entry.state))
                                    .foregroundColor(circuitBreakerColor(for: entry.state))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.provider.displayName)
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundColor(.grokText)
                                    Text(entry.baseURL)
                                        .font(.system(size: 9, design: .monospaced))
                                        .foregroundColor(.grokDim)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                    if let label = circuitBreakerDetail(for: entry.state, kind: entry.lastFailureKind, nextRetry: entry.nextRetry) {
                                        Text(label)
                                            .font(.system(size: 9))
                                            .foregroundColor(.grokDim)
                                    }
                                }
                                Spacer()
                                Text(circuitBreakerLabel(for: entry.state))
                                    .font(.system(size: 9, weight: .semibold))
                                    .foregroundColor(circuitBreakerColor(for: entry.state))
                            }
                            .padding(.horizontal, 10)
                            .frame(height: 42)
                            .background(Color.grokSurface)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }
        }
    }

    private func providerHealthIcon(for health: ModelHealth) -> String {
        switch health {
        case .healthy: return "checkmark.circle.fill"
        case .unavailable: return "xmark.circle.fill"
        case .unknown: return "questionmark.circle.fill"
        }
    }

    private func providerHealthColor(for health: ModelHealth) -> Color {
        switch health {
        case .healthy: return .green
        case .unavailable: return .red
        case .unknown: return .orange
        }
    }

    private func providerHealthLabel(for health: ModelHealth) -> String {
        switch health {
        case .healthy: return "healthy"
        case .unavailable(let reason): return reason
        case .unknown(let error): return error
        }
    }

    private func refreshCircuitBreakerStates() async {
        var newStates: [(provider: ModelProvider, baseURL: String, state: ProviderCircuitBreakerState, nextRetry: Date?, lastFailureKind: ProviderCircuitBreakerFailureKind?)] = []
        for config in store.eligibleProviderConfigurations {
            let state = await store.circuitBreakerState(for: config.provider, baseURL: config.baseURL)
            let nextRetry = await store.circuitBreakerNextRetryAt(for: config.provider, baseURL: config.baseURL)
            let lastKind = await store.circuitBreakerLastFailureKind(for: config.provider, baseURL: config.baseURL)
            newStates.append((provider: config.provider, baseURL: config.baseURL, state: state, nextRetry: nextRetry, lastFailureKind: lastKind))
        }
        breakerStates = newStates
    }

    private func circuitBreakerIcon(for state: ProviderCircuitBreakerState) -> String {
        switch state {
        case .closed: return "bolt.horizontal.circle.fill"
        case .open: return "exclamationmark.triangle.fill"
        case .halfOpen: return "bolt.horizontal.badge.clock.fill"
        }
    }

    private func circuitBreakerColor(for state: ProviderCircuitBreakerState) -> Color {
        switch state {
        case .closed: return .green
        case .open: return .red
        case .halfOpen: return .yellow
        }
    }

    private func circuitBreakerLabel(for state: ProviderCircuitBreakerState) -> String {
        switch state {
        case .closed: return "circuit closed"
        case .open: return "circuit open"
        case .halfOpen: return "half-open"
        }
    }

    private func circuitBreakerDetail(for state: ProviderCircuitBreakerState, kind: ProviderCircuitBreakerFailureKind?, nextRetry: Date?) -> String? {
        var parts: [String] = []
        if let kind {
            switch kind {
            case .rateLimit: parts.append("rate limit")
            case .auth: parts.append("auth")
            case .balance: parts.append("balance")
            case .gateway: parts.append("gateway")
            case .connection: parts.append("connection")
            case .timeout: parts.append("timeout")
            case .modelUnavailable: parts.append("model unavailable")
            case .contextLength: parts.append("context length")
            case .unknown: parts.append("unknown")
            }
        }
        if let nextRetry {
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .short
            parts.append("retry \(formatter.localizedString(for: nextRetry, relativeTo: Date()))")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var catalogSection: some View {
        modelSection(
            title: "Available models",
            subtitle: store.discoveredModels.isEmpty
                ? "Showing safe fallbacks until the provider catalog is refreshed."
                : "Loaded from the provider catalog."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                // The panel is often narrow. One row truncates the buttons to
                // "Refre..." and stacks the toggle label letter by letter, so
                // fall back to a two-row layout when the width is not there.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        modelTextField("Filter models", text: $searchText)
                        catalogRefreshButton
                        catalogHealthButton
                        catalogAutoToggle
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        modelTextField("Filter models", text: $searchText)
                        HStack(spacing: 8) {
                            catalogRefreshButton
                            catalogHealthButton
                            Spacer(minLength: 0)
                            catalogAutoToggle
                        }
                    }
                }

                HStack(spacing: 6) {
                    if let lastCheck = store.lastHealthCheckAt {
                        Text("Last check: \(Self.format(lastCheck))")
                            .font(.system(size: 10))
                            .foregroundColor(.grokDim)
                    } else {
                        Text("Background health polling idle")
                            .font(.system(size: 10))
                            .foregroundColor(.grokDim)
                    }
                    Spacer()
                }

                if let error = store.discoveryError {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11))
                        .foregroundColor(.orange)
                }

                LazyVStack(spacing: 5) {
                    ForEach(Array(filteredModels.prefix(100)), id: \.self) { model in
                        let isUnhealthy = store.unhealthyModels.contains(model)
                        Button {
                            guard !isUnhealthy || model == store.selectedModel else { return }
                            store.selectModel(model)
                            customModel = model
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: model == store.selectedModel ? "checkmark.circle.fill" : (isUnhealthy ? "xmark.circle.fill" : "circle"))
                                    .foregroundColor(model == store.selectedModel ? .green : (isUnhealthy ? .red : .grokDim))
                                Text(model)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundColor(isUnhealthy ? .grokDim : .grokText)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                if isUnhealthy {
                                    Text("unavailable")
                                        .font(.system(size: 9, weight: .semibold))
                                        .foregroundColor(.red)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(Color.red.opacity(0.12))
                                        .clipShape(Capsule())
                                }
                                if let badge = statusBadge(for: model) {
                                    Text(badge.label)
                                        .font(.system(size: 9, weight: .semibold))
                                        .foregroundColor(badge.color)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(badge.color.opacity(0.12))
                                        .clipShape(Capsule())
                                }
                                if let latencyBadge = latencyBadge(for: model) {
                                    Text(latencyBadge.label)
                                        .font(.system(size: 9, weight: .semibold))
                                        .foregroundColor(latencyBadge.color)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(latencyBadge.color.opacity(0.12))
                                        .clipShape(Capsule())
                                }
                                if let learned = learnedLimitBadge(for: model) {
                                    Text(learned.label)
                                        .font(.system(size: 9, weight: .semibold))
                                        .foregroundColor(learned.color)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(learned.color.opacity(0.12))
                                        .clipShape(Capsule())
                                }
                                Spacer()
                            }
                            .padding(.horizontal, 10)
                            .frame(height: 32)
                            .background(model == store.selectedModel ? Color.grokElevated.opacity(0.72) : Color.clear)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                        .disabled(isUnhealthy && model != store.selectedModel)
                    }
                }
            }
        }
    }

    /// Lists every stored key for the provider. Each row can be made active or
    /// deleted on its own - deleting one key never disturbs the others.
    @ViewBuilder
    private var storedKeysList: some View {
        // Reading through credentialRevision keeps the list in step with adds
        // and deletes without a second published mirror of the Keychain.
        let entries = store.storedKeys
        let activeID = store.activeKeyID
        let states = store.keyStates(for: store.selectedProvider)
        let rotating = store.isKeyRotationEnabled
        if entries.isEmpty {
            Label("No keys stored yet. Paste one below to get started.", systemImage: "key")
                .font(.system(size: 11))
                .foregroundColor(.grokDim)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                rotationControls(total: entries.count)
                ForEach(entries) { entry in
                    let state = states[entry.id]
                    let parked = state?.isAvailable(at: Date()) == false
                    HStack(spacing: 8) {
                        Button {
                            store.activateAPIKey(entryID: entry.id)
                        } label: {
                            Image(systemName: entry.id == activeID ? "largecircle.fill.circle" : "circle")
                                .foregroundColor(entry.id == activeID ? .green : .grokDim)
                        }
                        .buttonStyle(.plain)
                        .disabled(rotating)
                        .help(rotating
                              ? "Rotation picks the key automatically"
                              : (entry.id == activeID ? "Active key" : "Use this key"))

                        VStack(alignment: .leading, spacing: 1) {
                            Text(entry.label)
                                .font(.system(size: 12, weight: entry.id == activeID ? .semibold : .regular))
                                .foregroundColor(.grokText)
                            Text(entry.maskedValue)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(.grokDim)
                        }

                        Spacer()

                        if let reason = state?.cooldownReason, parked {
                            Button {
                                store.resetKeyCooldown(entryID: entry.id, for: store.selectedProvider)
                            } label: {
                                Text(reason.displayName)
                                    .font(.system(size: 9, weight: .medium))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 3)
                                    .background(
                                        Capsule().fill(
                                            reason.isTerminal
                                                ? Color.orange.opacity(0.18)
                                                : Color.yellow.opacity(0.18)
                                        )
                                    )
                                    .foregroundColor(reason.isTerminal ? .orange : .yellow)
                            }
                            .buttonStyle(.plain)
                            .help("Parked by rotation. Click to put this key back in service.")
                        } else if let created = entry.createdAt {
                            Text(created, style: .date)
                                .font(.system(size: 10))
                                .foregroundColor(.grokDim)
                        }

                        Button {
                            Task { await testStoredKey(entry) }
                        } label: {
                            Image(systemName: "checkmark.seal")
                        }
                        .buttonStyle(.plain)
                        .foregroundColor(.grokMuted)
                        .disabled(isTestingAPIKey)
                        .help("Test this key")

                        Button {
                            deleteKey(entryID: entry.id)
                        } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.plain)
                        .foregroundColor(.orange)
                        .help("Delete this key only")
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(
                        RoundedRectangle(cornerRadius: 8)
                            .fill(entry.id == activeID ? Color.green.opacity(0.08) : Color.grokSurface)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(entry.id == activeID ? Color.green.opacity(0.35) : Color.grokBorder)
                    }
                }
            }
            .id(store.credentialRevision)
        }
    }

    private var credentialSection: some View {
        modelSection(
            title: "API key",
            subtitle: store.credentialStatus
        ) {
            VStack(alignment: .leading, spacing: 10) {
                if store.selectedProvider.requiresAPIKey {
                    storedKeysList

                    HStack(spacing: 8) {
                        SecureField("Paste \(store.selectedProvider.displayName) API key", text: $apiKeyDraft)
                            .textFieldStyle(.plain)
                            .padding(.horizontal, 10)
                            .frame(height: 36)
                            .background(Color.grokSurface)
                            .clipShape(RoundedRectangle(cornerRadius: 9))
                            .overlay { RoundedRectangle(cornerRadius: 9).stroke(Color.grokBorder) }

                        TextField("Label", text: $apiKeyLabelDraft)
                            .textFieldStyle(.plain)
                            .padding(.horizontal, 10)
                            .frame(width: 120, height: 36)
                            .background(Color.grokSurface)
                            .clipShape(RoundedRectangle(cornerRadius: 9))
                            .overlay { RoundedRectangle(cornerRadius: 9).stroke(Color.grokBorder) }
                            .help("Optional name so you can tell your keys apart")

                        Button("Add key") { addKey() }
                            .buttonStyle(.borderedProminent)
                            .disabled(apiKeyDraft.isEmpty)
                        Button {
                            Task { await testAPIKey() }
                        } label: {
                            if isTestingAPIKey {
                                ProgressView().controlSize(.small)
                            } else {
                                Label("Test", systemImage: "checkmark.seal")
                            }
                        }
                        .buttonStyle(.bordered)
                        .disabled(isTestingAPIKey || (!store.hasAPIKey && apiKeyDraft.isEmpty))
                        .help("Tests the pasted key, or the active stored key when the field is empty")
                    }

                    HStack(spacing: 12) {
                        if let keyURL = keyManagementURL {
                            Link("Open \(store.selectedProvider.displayName) key dashboard", destination: keyURL)
                                .font(.system(size: 11))
                        }
                        Spacer()
                        TabLogsButton(tab: .models)
                    }
                } else {
                    Label("Ollama runs locally and does not need an API key.", systemImage: "lock.open")
                        .font(.system(size: 12))
                        .foregroundColor(.grokMuted)
                }

                if let credentialMessage {
                    Text(credentialMessage)
                        .font(.system(size: 11))
                        .foregroundColor(credentialMessage.hasPrefix("Saved") || credentialMessage.hasPrefix("Key valid") ? .green : .orange)
                }

                if let apiKeyTestResult {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 6) {
                            Image(systemName: apiKeyTestResult.iconName)
                                .foregroundColor(apiKeyTestResult.accent)
                            Text(apiKeyTestResult.title)
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(apiKeyTestResult.accent)
                            if let status = apiKeyTestResult.httpStatus {
                                Text("HTTP \(status)")
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundColor(.grokDim)
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 2)
                                    .background(Color.grokSurface)
                                    .clipShape(RoundedRectangle(cornerRadius: 4))
                            }
                            Spacer()
                        }
                        Text(apiKeyTestResult.subtitle)
                            .font(.system(size: 11))
                            .foregroundColor(apiKeyTestResult.accent)
                            .lineLimit(nil)
                            .fixedSize(horizontal: false, vertical: true)

                        if let warning = apiKeyTestResult.warning {
                            Text(warning)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundColor(.orange)
                                .lineLimit(nil)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        if !apiKeyTestResult.logs.isEmpty {
                            DisclosureGroup("Diagnostics") {
                                ScrollView {
                                    Text(apiKeyTestResult.logs.joined(separator: "\n"))
                                        .font(.system(size: 10, design: .monospaced))
                                        .foregroundColor(.grokText)
                                        .textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .frame(maxHeight: 180)
                            }
                            .font(.system(size: 11))
                            .foregroundColor(.grokMuted)
                        }
                    }
                    .padding(9)
                    .background(apiKeyTestResult.accent.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 9))
                    .overlay {
                        RoundedRectangle(cornerRadius: 9)
                            .stroke(apiKeyTestResult.accent.opacity(0.45), lineWidth: 1)
                    }
                }
            }
        }
    }

    private var catalogRefreshButton: some View {
        Button {
            Task { await store.refreshModels() }
        } label: {
            if store.isDiscovering {
                ProgressView().controlSize(.small)
            } else {
                Label("Refresh", systemImage: "arrow.clockwise")
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .buttonStyle(.bordered)
        .disabled(store.isDiscovering || (store.selectedProvider.requiresAPIKey && !store.hasAPIKey))
    }

    private var catalogHealthButton: some View {
        Button {
            Task {
                await store.refreshHealth()
                await refreshStatusBadges()
                await refreshLatencyBadges()
            }
        } label: {
            if store.isCheckingHealth {
                ProgressView().controlSize(.small)
            } else {
                Label("Health", systemImage: "stethoscope")
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .buttonStyle(.bordered)
        .disabled(store.isCheckingHealth || (store.selectedProvider.requiresAPIKey && !store.hasAPIKey))
    }

    private var catalogAutoToggle: some View {
        Toggle("Auto", isOn: $store.isBackgroundHealthPollingEnabled)
            .toggleStyle(.switch)
            .controlSize(.small)
            .lineLimit(1)
            .fixedSize()
            .help("Probe all models every 60 seconds in the background")
    }

    /// Live end-to-end diagnostics, including a real chat completion.
    private var diagnosticsSection: some View {
        modelSection(
            title: "Diagnostics",
            subtitle: diagnostics.isRunning ? "Running live checks..." : diagnostics.summary
        ) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Button {
                        Task { await runDiagnostics() }
                    } label: {
                        if diagnostics.isRunning {
                            ProgressView().controlSize(.small)
                        } else {
                            Label("Run checks", systemImage: "stethoscope")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(diagnostics.isRunning)
                    .help("Probes the server, endpoint, key, and sends one real chat request")

                    if let last = diagnostics.lastRunAt {
                        Text(last, style: .relative)
                            .font(.system(size: 10))
                            .foregroundColor(.grokDim)
                    }
                    Spacer(minLength: 0)
                    TabLogsButton(tab: .models, compact: true)
                }

                ForEach(diagnostics.checks) { check in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .top, spacing: 6) {
                            Image(systemName: check.status.symbolName)
                                .font(.system(size: 11))
                                .foregroundColor(color(for: check.status))
                                .frame(width: 14)
                            Text(check.title)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundColor(.grokText)
                            if let ms = check.latencyMs, check.status != .pending {
                                Text("\(ms) ms")
                                    .font(.system(size: 9, design: .monospaced))
                                    .foregroundColor(.grokDim)
                            }
                            Spacer(minLength: 0)
                        }
                        if !check.detail.isEmpty {
                            Text(check.detail)
                                .font(.system(size: 10))
                                .foregroundColor(.grokMuted)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.leading, 20)
                        }
                        if let remedy = check.remedy, check.status == .fail || check.status == .warn {
                            Text(remedy)
                                .font(.system(size: 10))
                                .foregroundColor(.orange)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.leading, 20)
                        }
                    }
                    .padding(.vertical, 3)
                }
            }
        }
    }

    private func color(for status: DiagnosticStatus) -> Color {
        switch status {
        case .pass: return .green
        case .warn: return .orange
        case .fail: return .red
        case .running: return .blue
        case .pending, .skipped: return .grokDim
        }
    }

    private func runDiagnostics() async {
        await diagnostics.run(
            serverHealthURL: ProjectPaths.browserOSHealthURL,
            localTokenURL: "\(ProjectPaths.mcpBaseURL)/auth/local-token",
            provider: store.selectedProvider,
            baseURL: store.baseURL,
            model: store.selectedModel,
            apiKey: store.resolvedAPIKeySync(for: store.selectedProvider),
            a2aAgentsURL: "\(ProjectPaths.mcpBaseURL)/a2a/agents",
            isA2ARegistered: viewModel.isA2ARegistered
        )
    }

    /// Rotation switch plus a live count of how many keys are actually usable.
    @ViewBuilder
    private func rotationControls(total: Int) -> some View {
        let available = store.availableKeyCount(for: store.selectedProvider)
        HStack(spacing: 8) {
            Toggle(isOn: Binding(
                get: { store.isKeyRotationEnabled },
                set: { store.isKeyRotationEnabled = $0 }
            )) {
                Text("Rotate keys")
                    .font(.system(size: 11, weight: .medium))
            }
            .toggleStyle(.switch)
            .controlSize(.mini)
            .help("Spread requests across stored keys so one key does not absorb the whole rate limit")

            Text("\(available) of \(total) ready")
                .font(.system(size: 10))
                .foregroundColor(available == total ? .grokDim : .orange)

            Spacer()

            if available == 0 && total > 0 {
                Text("every key is parked")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.orange)
            }
        }
        .padding(.bottom, 2)
    }

    /// Named hosts for providers that ship more than one.
    ///
    /// Z.AI is the reason this exists: a Coding Plan key authenticates on the
    /// pay-as-you-go host but fails every completion there with code 1113
    /// "Insufficient balance", which looks exactly like an expired key. Making
    /// the choice explicit stops that misdiagnosis.
    private var endpointPresetsForProvider: [(label: String, url: String, note: String)] {
        switch store.selectedProvider {
        case .zai:
            return [
                (
                    "Coding Plan",
                    "https://api.z.ai/api/coding/paas/v4",
                    "Subscription keys. Use this unless you topped up a prepaid balance."
                ),
                (
                    "Pay-as-you-go",
                    "https://api.z.ai/api/paas/v4",
                    "Prepaid balance only. Subscription keys report code 1113 here."
                )
            ]
        default:
            return []
        }
    }

    @ViewBuilder
    private var endpointPresets: some View {
        let presets = endpointPresetsForProvider
        if !presets.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    ForEach(presets, id: \.url) { preset in
                        let isCurrent = store.baseURL == preset.url
                        Button {
                            baseURLDraft = preset.url
                            store.updateBaseURL(preset.url)
                            Task { await store.refreshModels() }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: isCurrent ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 10))
                                Text(preset.label)
                                    .font(.system(size: 11, weight: isCurrent ? .semibold : .regular))
                            }
                            .padding(.horizontal, 9)
                            .padding(.vertical, 5)
                            .background(
                                Capsule().fill(isCurrent ? Color.green.opacity(0.14) : Color.grokSurface)
                            )
                            .overlay(
                                Capsule().stroke(isCurrent ? Color.green.opacity(0.45) : Color.grokBorder)
                            )
                            .foregroundColor(isCurrent ? .green : .grokMuted)
                        }
                        .buttonStyle(.plain)
                        .help(preset.note)
                    }
                }
                if let current = presets.first(where: { $0.url == store.baseURL }) {
                    Text(current.note)
                        .font(.system(size: 10))
                        .foregroundColor(.grokDim)
                }
            }
        }
    }

    private var connectionSection: some View {
        modelSection(title: "Endpoint", subtitle: "Advanced: use a compatible proxy or private gateway.") {
            VStack(alignment: .leading, spacing: 8) {
                endpointPresets
                HStack(spacing: 8) {
                    modelTextField("Base URL", text: $baseURLDraft)
                    Button("Apply") {
                        store.updateBaseURL(baseURLDraft)
                        Task { await store.refreshModels() }
                    }
                    .buttonStyle(.bordered)
                    Button("Reset") {
                        store.resetBaseURL()
                        baseURLDraft = store.baseURL
                    }
                    .buttonStyle(.bordered)
                }
                Text(store.baseURL)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.grokDim)
                    .textSelection(.enabled)
            }
        }
    }

    private var filteredModels: [String] {
        guard !searchText.isEmpty else { return store.availableModels }
        return store.availableModels.filter {
            $0.localizedCaseInsensitiveContains(searchText)
        }
    }

    private func refreshStatusBadges() async {
        guard store.selectedProvider.hasProviderCatalog else {
            statusBadges.removeAll()
            return
        }
        var newBadges: [String: ProviderModelStatus] = [:]
        await withTaskGroup(of: (String, ProviderModelStatus).self) { group in
            for model in store.availableModels {
                group.addTask {
                    let status = await store.providerStatus(for: model)
                    return (model, status)
                }
            }
            for await (model, status) in group {
                switch status {
                case .disabled, .missing:
                    newBadges[model] = status
                case .present, .unknown:
                    break
                }
            }
        }
        statusBadges = newBadges
    }

    private func refreshContextUtilizationBadges() async {
        var badges: [String: Double] = [:]
        var limits: [String: StreamingContextLearnedLimits] = [:]
        for model in store.availableModels {
            if let percent = await store.contextWindowUtilizationPercent(
                for: model,
                provider: store.selectedProvider,
                baseURL: store.baseURL
            ) {
                badges[model] = percent
            }
            limits[model] = await store.learnedLimits(
                for: model,
                provider: store.selectedProvider,
                baseURL: store.baseURL
            )
        }
        contextUtilizationBadges = badges
        learnedLimitBadges = limits
        effectiveOutputCeiling = await store.effectiveMaxOutputTokens(
            for: store.selectedModel,
            provider: store.selectedProvider,
            baseURL: store.baseURL
        )
    }

    private func contextUtilizationBadge(for model: String) -> (label: String, color: Color)? {
        guard let percent = contextUtilizationBadges[model] else { return nil }
        let color: Color
        if percent <= 70 { color = .green }
        else if percent <= 85 { color = .yellow }
        else { color = .red }
        return (String(format: "~%.0f%%", percent), color)
    }

    private func learnedLimitBadge(for model: String) -> (label: String, color: Color)? {
        let limits = learnedLimitBadges[model] ?? .empty
        guard limits.outputObservationCount > 0 || limits.totalObservationCount > 0 else {
            return nil
        }
        var parts: [String] = []
        if let output = limits.effectiveMaxOutputTokens {
            parts.append("learned out: \(formatCompact(output))")
        }
        if let context = limits.effectiveMaxContextTokens {
            parts.append("learned ctx: \(formatCompact(context))")
        }
        guard !parts.isEmpty else { return nil }
        return (parts.joined(separator: " · "), .grokDim)
    }

    private func formatCompact(_ value: Int) -> String {
        if value >= 1_000_000 {
            return String(format: "%.1fM", Double(value) / 1_000_000)
        } else if value >= 1_000 {
            return String(format: "%.1fk", Double(value) / 1_000)
        }
        return "\(value)"
    }

    private var contextRoutingSection: some View {
        modelSection(
            title: "Context routing",
            subtitle: "TriOS can route or trim long conversations before sending to avoid context-window failures."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                Stepper(
                    "Context window margin: \(Int(store.contextWindowMargin * 100))%",
                    value: $store.contextWindowMargin,
                    in: 0.50...0.95,
                    step: 0.05
                )
                .onChange(of: store.contextWindowMargin) { _, newValue in
                    store.setContextWindowMargin(newValue)
                }
                .font(.system(size: 12))

                Toggle("Pause stream on context limit", isOn: $store.isStreamingContextWatchdogEnabled)
                    .onChange(of: store.isStreamingContextWatchdogEnabled) { _, newValue in
                        store.setStreamingContextWatchdogEnabled(newValue)
                    }
                    .font(.system(size: 12))

                if let reason = store.lastContextRoutingReason {
                    Label(reason, systemImage: "arrow.left.arrow.right.circle")
                        .font(.system(size: 11))
                        .foregroundColor(.grokDim)
                }

                if let lastAt = store.lastContextRoutedAt {
                    Text("Last context route: \(formatRelativeDate(lastAt))")
                        .font(.system(size: 10))
                        .foregroundColor(.grokMuted)
                }
            }
        }
    }

    private func statusBadge(for model: String) -> (label: String, color: Color)? {
        switch statusBadges[model] {
        case .disabled:
            return ("disabled", .orange)
        case .missing:
            return ("not in catalog", .red)
        default:
            return nil
        }
    }

    private func refreshLatencyBadges() async {
        var newBadges: [String: ModelLatency] = [:]
        await withTaskGroup(of: (String, ModelLatency).self) { group in
            for model in store.availableModels {
                group.addTask {
                    let latency = await store.latency(for: model)
                    return (model, latency)
                }
            }
            for await (model, latency) in group {
                if latency.isAvailable {
                    newBadges[model] = latency
                }
            }
        }
        latencyBadges = newBadges
    }

    private func latencyBadge(for model: String) -> (label: String, color: Color)? {
        guard let latency = latencyBadges[model], latency.totalCount > 0 else {
            return nil
        }
        let avgMs = latency.perceivedAvgMs
        let seconds = avgMs / 1000.0
        let label: String
        if seconds < 1 {
            label = String(format: "%dms", Int(avgMs))
        } else if seconds < 10 {
            label = String(format: "%.1fs", seconds)
        } else {
            label = String(format: "%.0fs", seconds)
        }
        let color: Color
        if avgMs <= 1000 {
            color = .green
        } else if avgMs <= 3000 {
            color = .yellow
        } else {
            color = .orange
        }
        return (label, color)
    }

    private static func format(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private var keyManagementURL: URL? {
        switch store.selectedProvider {
        case .openai: return URL(string: "https://platform.openai.com/api-keys")
        case .anthropic: return URL(string: "https://console.anthropic.com/settings/keys")
        case .openrouter: return URL(string: "https://openrouter.ai/settings/keys")
        case .zai: return URL(string: "https://z.ai/manage-apikey/apikey-list")
        case .ollama: return nil
        }
    }

    private func modelSection<Content: View>(
        title: String,
        subtitle: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.grokText)
                Text(subtitle)
                    .font(.system(size: 10))
                    .foregroundColor(.grokDim)
            }
            content()
        }
        .padding(14)
        .background(Color.grokSurface)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay { RoundedRectangle(cornerRadius: 14).stroke(Color.grokBorder) }
    }

    private func modelTextField(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .textFieldStyle(.plain)
            .font(.system(size: 11, design: .monospaced))
            .padding(.horizontal, 10)
            .frame(height: 36)
            .background(Color.grokSurface)
            .clipShape(RoundedRectangle(cornerRadius: 9))
            .overlay { RoundedRectangle(cornerRadius: 9).stroke(Color.grokBorder) }
    }

    private func saveKey() {
        do {
            try store.saveAPIKey(apiKeyDraft)
            apiKeyDraft = ""
            credentialMessage = "Saved securely in macOS Keychain."
            apiKeyTestResult = nil
            Task { await store.refreshModels() }
        } catch {
            credentialMessage = error.localizedDescription
        }
    }

    /// Stores an additional key. Unlike `saveKey`, existing keys survive.
    private func addKey() {
        do {
            try store.addAPIKey(apiKeyDraft, label: apiKeyLabelDraft)
            apiKeyDraft = ""
            apiKeyLabelDraft = ""
            credentialMessage = "Added to macOS Keychain and made active."
            apiKeyTestResult = nil
            Task { await store.refreshModels() }
        } catch {
            credentialMessage = error.localizedDescription
        }
    }

    private func deleteKey() {
        do {
            try store.deleteAPIKey()
            apiKeyDraft = ""
            credentialMessage = "Removed from macOS Keychain."
            apiKeyTestResult = nil
        } catch {
            credentialMessage = error.localizedDescription
        }
    }

    /// Deletes exactly one stored key.
    private func deleteKey(entryID: String) {
        do {
            try store.deleteAPIKey(entryID: entryID)
            credentialMessage = "Deleted that key. Other keys were left untouched."
            apiKeyTestResult = nil
        } catch {
            credentialMessage = error.localizedDescription
        }
    }

    /// Tests one stored key by id, without making it active first.
    private func testStoredKey(_ entry: ModelKeyEntry) async {
        guard !isTestingAPIKey else { return }
        guard let secret = ModelCredentialStore.read(entryID: entry.id, for: store.selectedProvider),
              !secret.isEmpty else {
            apiKeyTestResult = APIKeyTestResult(
                success: false,
                title: "Key unreadable",
                subtitle: "The Keychain did not return a value for \(entry.label).",
                httpStatus: nil,
                logs: []
            )
            return
        }
        await runKeyTest(key: secret, label: entry.label)
    }

    /// Runs a lightweight auth/balance probe using the drafted or stored key.
    /// Does not persist the draft; if the test passes, the user still has to press Save.
    private func testAPIKey() async {
        guard !isTestingAPIKey else { return }
        isTestingAPIKey = true
        defer { isTestingAPIKey = false }
        apiKeyTestResult = nil

        let key = apiKeyDraft.isEmpty ? store.resolvedAPIKeySync(for: store.selectedProvider) : apiKeyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            apiKeyTestResult = APIKeyTestResult(
                success: false,
                title: "No API key",
                subtitle: "Paste or save an API key before testing.",
                httpStatus: nil,
                logs: []
            )
            return
        }

        await runKeyTest(key: key, label: apiKeyDraft.isEmpty ? "active key" : "pasted key")
    }

    /// Shared probe path for the draft field and for individual stored keys, so
    /// both report balance exhaustion the same way.
    private func runKeyTest(key: String, label: String) async {
        let wasTesting = isTestingAPIKey
        if !wasTesting { isTestingAPIKey = true }
        defer { if !wasTesting { isTestingAPIKey = false } }

        let result = await store.testAPIKey(
            key: key,
            provider: store.selectedProvider,
            baseURL: store.baseURL
        )
        let balanceWarning = result.balanceWarning
        let title: String
        if !result.isValid {
            title = "Key failed"
        } else if balanceWarning != nil {
            title = "Key valid — but out of credits"
        } else {
            title = "Key valid"
        }
        TriosLogBus.shared.log(
            result.isValid && balanceWarning == nil ? .info : .warn,
            subsystem: .models,
            event: "models.key.tested",
            message: "\(title) (\(label))",
            attributes: [
                "provider": store.selectedProvider.rawValue,
                "http_status": result.httpStatus.map(String.init) ?? "none",
                "latency_ms": String(result.latencyMs)
            ]
        )
        apiKeyTestResult = APIKeyTestResult(
            success: result.isValid,
            title: title,
            subtitle: result.message,
            httpStatus: result.httpStatus,
            logs: result.logs,
            warning: balanceWarning
        )
        if result.isValid {
            credentialMessage = balanceWarning == nil
                ? "Key valid — ready to save if this is a new key."
                : "Authenticated, but this account has no credits left to spend."
        }
        await refreshQuotaBadges()
    }
}
