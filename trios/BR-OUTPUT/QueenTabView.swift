// AGENT-V-WAIVER: QUEEN-TRINITY-EMBED-001
// Reason: Trios embeds the canonical gHashTag/trinity QueenUILib surface.
// Follow-up: seal against .trinity/specs/embedded-trinity-queen-ui.md.
import SwiftUI
import QueenUILib

struct QueenTabView: View {
    @ObservedObject var viewModel: ChatViewModel
    @EnvironmentObject private var modelStore: ModelConfigurationStore
    @State private var chatBottomRequest = 0
    private let embedding = TrinityQueenEmbedding.resolved()

    var body: some View {
        Group {
            if embedding.hasCanonicalSourceLayout {
                EmbeddedQueenRoot(
                    projectRoot: embedding.projectRoot,
                    hostedRoutes: hostedRoutes
                )
            } else {
                missingSourceView
            }
        }
        .clipped()
        .accessibilityIdentifier("trinity-queen-embedded-root")
        .onChange(of: modelStore.modelsTabRequest) {
            open(.models)
        }
        .onReceive(
            NotificationCenter.default.publisher(for: QueenHostNavigation.didOpen)
        ) { notification in
            guard let petal = notification.object as? Int,
                  petal == route(for: .chat).petalIndex else {
                return
            }
            chatBottomRequest += 1
        }
    }

    private var hostedRoutes: [QueenHostedRoute] {
        [
            hostedRoute(for: .chat) {
                AdaptiveChatWorkspace(
                    viewModel: viewModel,
                    scrollToBottomRequest: chatBottomRequest
                )
            },
            hostedRoute(for: .models) {
                ModelsTabView()
            },
            hostedRoute(for: .git) {
                GitWorkspaceView()
            },
            hostedRoute(for: .terminal) {
                TerminalTabView()
            },
            hostedRoute(for: .mesh) {
                MeshTabView()
            },
            hostedRoute(for: .settings) {
                SettingsTabView()
            },
        ]
    }

    private func hostedRoute<Content: View>(
        for destination: Trios999Destination,
        @ViewBuilder content: () -> Content
    ) -> QueenHostedRoute {
        let mapping = route(for: destination)
        return QueenHostedRoute(
            petalIndex: mapping.petalIndex,
            title: mapping.title,
            systemImage: mapping.systemImage,
            worldName: mapping.worldName,
            formula: mapping.formula,
            keyboardShortcut: mapping.keyboardShortcut,
            content: content
        )
    }

    private func route(for destination: Trios999Destination) -> Trios999Route {
        guard let route = Trinity999TabMap.route(for: destination) else {
            preconditionFailure("Missing 999 route for \(destination.rawValue)")
        }
        return route
    }

    private func open(_ destination: Trios999Destination) {
        QueenHostNavigation.open(petalIndex: route(for: destination).petalIndex)
    }

    private var missingSourceView: some View {
        VStack(spacing: 12) {
            Image(systemName: "crown.fill")
                .font(.system(size: 28, weight: .semibold))
                .foregroundColor(.orange)
            Text("Trinity Queen source is unavailable")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.grokText)
            Text(embedding.packageRoot)
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(.grokMuted)
                .textSelection(.enabled)
            Text("Set TRINITY_ROOT to the gHashTag/trinity checkout and rebuild Trios.")
                .font(.system(size: 10))
                .foregroundColor(.grokDim)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }
}
