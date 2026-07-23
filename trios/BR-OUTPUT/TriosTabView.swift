// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: FULLSCREEN-CHAT-001 routes the Chat tab through adaptive workspace UI.
// Follow-up: seal against .trinity/specs/fullscreen-chat-history.md.
import SwiftUI
import QueenUILib

struct TriosTabView: View {
    @ObservedObject var viewModel: ChatViewModel
    @StateObject private var modelStore: ModelConfigurationStore

    init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
        _modelStore = StateObject(wrappedValue: viewModel.modelStore)
    }

    var body: some View {
        ZStack {
            UnifiedTriosGlassBackground()

            VStack(spacing: 0) {
                titleBar
                Divider().overlay(Color.grokBorder)
                QueenTabView(viewModel: viewModel)
            }
        }
        .sheet(isPresented: $viewModel.showHistory) {
            historySheet
        }
        .environmentObject(modelStore)
    }

    // MARK: - Title Bar

    private var titleBar: some View {
        HStack(spacing: 12) {
            Button(action: QueenHostNavigation.showMenu) {
                HStack(spacing: 12) {
                    logoView(size: CGSize(width: 22, height: 18))

                    Text(TriosBranding.displayName)
                        .font(.system(size: 12, weight: .bold, design: .default))
                        .foregroundColor(.grokText)
                }
            }
            .buttonStyle(.plain)
            .help("Open the 999 menu")

            Spacer()

            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    Circle()
                        .fill(viewModel.isServerReachable ? Color.green : Color.grokDim)
                        .frame(width: 6, height: 6)
                    Text(viewModel.isServerReachable ? "Online" : "Offline")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(.grokMuted)
                }
                .help("BrowserOS Agent server \(viewModel.isServerReachable ? "is reachable" : "is not reachable") on port \(ProjectPaths.mcpPort)")

                if viewModel.isA2ARegistered {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(Color.blue)
                            .frame(width: 6, height: 6)
                        Text("A2A")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundColor(.grokMuted)
                    }
                    .help("A2A registry client is registered")
                }
            }

            Button(action: {
                viewModel.newConversation()
                if let chat = Trinity999TabMap.route(for: .chat) {
                    QueenHostNavigation.open(petalIndex: chat.petalIndex)
                }
            }) {
                Image(systemName: "plus")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.grokMuted)
            }
            .buttonStyle(.plain)

            Button(action: toggleFullScreen) {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.grokMuted)
            }
            .buttonStyle(.plain)
            .help("Toggle full screen")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private func toggleFullScreen() {
        guard let window = NSApplication.shared.keyWindow else { return }
        window.collectionBehavior.remove(.fullScreenAuxiliary)
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.toggleFullScreen(nil)
    }

    // MARK: - History Sheet

    private var historySheet: some View {
        VStack(spacing: 0) {
            HStack {
                Text("History")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.grokText)
                Spacer()
                Button(action: { viewModel.showHistory = false }) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.grokMuted)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            Divider().overlay(Color.grokBorder)

            if viewModel.conversations.isEmpty {
                Text("No history yet")
                    .font(.system(size: 12))
                    .foregroundColor(.grokDim)
                    .padding(.top, 20)
            } else {
                List(viewModel.conversations) { conv in
                    Button(action: {
                        Task { await viewModel.switchConversation(id: conv.id) }
                    }) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(conv.title)
                                .font(.system(size: 12))
                                .foregroundColor(.grokText)
                                .lineLimit(1)
                            Text(conv.updatedAt, style: .relative)
                                .font(.system(size: 9))
                                .foregroundColor(.grokDim)
                        }
                    }
                    .buttonStyle(.plain)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }

            Spacer()
        }
        .frame(width: 320, height: 400)
        .background(
            GlassmorphismBackground(material: .popover, blending: .withinWindow, cornerRadius: 16)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.grokBorder.opacity(0.4), lineWidth: 1)
        )
    }

    private func logoView(size: CGSize) -> some View {
        Group {
            if let pngURL = Bundle.main.url(forResource: "logo", withExtension: "png"),
               let nsImage = NSImage(contentsOf: pngURL) {
                Image(nsImage: nsImage)
                    .resizable()
                    .renderingMode(.template)
                    .aspectRatio(contentMode: .fit)
                    .frame(width: size.width, height: size.height)
                    .foregroundColor(.grokText)
            } else if FileManager.default.fileExists(atPath: ProjectPaths.logoPNG),
                      let nsImage = NSImage(contentsOfFile: ProjectPaths.logoPNG) {
                Image(nsImage: nsImage)
                    .resizable()
                    .renderingMode(.template)
                    .aspectRatio(contentMode: .fit)
                    .frame(width: size.width, height: size.height)
                    .foregroundColor(.grokText)
            }
        }
    }
}

// MARK: - Settings Placeholder

struct SettingsTabView: View {
    var body: some View {
        SettingsScreen()
    }
}
