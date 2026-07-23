import SwiftUI

struct ModelsTabView: View {
    @EnvironmentObject private var store: ModelConfigurationStore
    @State private var apiKeyDraft = ""
    @State private var customModel = ""
    @State private var baseURLDraft = ""
    @State private var searchText = ""
    @State private var credentialMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                providerSection
                activeModelSection
                catalogSection
                credentialSection
                connectionSection
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
        }
        .onChange(of: store.selectedProvider) {
            baseURLDraft = store.baseURL
            customModel = store.selectedModel
            apiKeyDraft = ""
            credentialMessage = nil
            searchText = ""
            Task { await store.refreshModels() }
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

    private var activeModelSection: some View {
        modelSection(title: "Active model", subtitle: "This exact identifier is sent with the next request.") {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Image(systemName: "cpu")
                        .foregroundColor(.green)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(store.selectedModel)
                            .font(.system(size: 13, weight: .semibold, design: .monospaced))
                            .foregroundColor(.grokText)
                            .textSelection(.enabled)
                        Text(store.selectedProvider.displayName)
                            .font(.system(size: 10))
                            .foregroundColor(.grokDim)
                    }
                    Spacer()
                }

                HStack(spacing: 8) {
                    modelTextField("Custom model ID", text: $customModel)
                    Button("Use") {
                        store.selectModel(customModel)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(customModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private var catalogSection: some View {
        modelSection(
            title: "Available models",
            subtitle: store.discoveredModels.isEmpty
                ? "Showing safe fallbacks until the provider catalog is refreshed."
                : "Loaded from the provider catalog."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    modelTextField("Filter models", text: $searchText)
                    Button {
                        Task { await store.refreshModels() }
                    } label: {
                        if store.isDiscovering {
                            ProgressView().controlSize(.small)
                        } else {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(store.isDiscovering || (store.selectedProvider.requiresAPIKey && !store.hasAPIKey))
                }

                if let error = store.discoveryError {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11))
                        .foregroundColor(.orange)
                }

                LazyVStack(spacing: 5) {
                    ForEach(Array(filteredModels.prefix(100)), id: \.self) { model in
                        Button {
                            store.selectModel(model)
                            customModel = model
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: model == store.selectedModel ? "checkmark.circle.fill" : "circle")
                                    .foregroundColor(model == store.selectedModel ? .green : .grokDim)
                                Text(model)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundColor(.grokText)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                Spacer()
                            }
                            .padding(.horizontal, 10)
                            .frame(height: 32)
                            .background(model == store.selectedModel ? Color.grokElevated.opacity(0.72) : Color.clear)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var credentialSection: some View {
        modelSection(
            title: "API key",
            subtitle: store.credentialStatus
        ) {
            VStack(alignment: .leading, spacing: 10) {
                if store.selectedProvider.requiresAPIKey {
                    HStack(spacing: 8) {
                        SecureField("Paste \(store.selectedProvider.displayName) API key", text: $apiKeyDraft)
                            .textFieldStyle(.plain)
                            .padding(.horizontal, 10)
                            .frame(height: 36)
                            .background(Color.grokSurface)
                            .clipShape(RoundedRectangle(cornerRadius: 9))
                            .overlay { RoundedRectangle(cornerRadius: 9).stroke(Color.grokBorder) }

                        Button("Save") { saveKey() }
                            .buttonStyle(.borderedProminent)
                            .disabled(apiKeyDraft.isEmpty)
                        Button("Remove") { deleteKey() }
                            .buttonStyle(.bordered)
                            .disabled(!store.hasAPIKey)
                    }

                    if let keyURL = keyManagementURL {
                        Link("Open \(store.selectedProvider.displayName) key dashboard", destination: keyURL)
                            .font(.system(size: 11))
                    }
                } else {
                    Label("Ollama runs locally and does not need an API key.", systemImage: "lock.open")
                        .font(.system(size: 12))
                        .foregroundColor(.grokMuted)
                }

                if let credentialMessage {
                    Text(credentialMessage)
                        .font(.system(size: 11))
                        .foregroundColor(credentialMessage.hasPrefix("Saved") ? .green : .orange)
                }
            }
        }
    }

    private var connectionSection: some View {
        modelSection(title: "Endpoint", subtitle: "Advanced: use a compatible proxy or private gateway.") {
            VStack(alignment: .leading, spacing: 8) {
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
        } catch {
            credentialMessage = error.localizedDescription
        }
    }
}
