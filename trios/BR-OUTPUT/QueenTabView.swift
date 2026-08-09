// AGENT-V-WAIVER: QUEEN-TRINITY-EMBED-001
// Reason: Trios embeds the canonical gHashTag/trinity QueenUILib surface.
// Follow-up: seal against .trinity/specs/embedded-trinity-queen-ui.md.
import SwiftUI
import QueenUILib

// Local route container for the 999 tab definitions.
struct TriosHostedRoute {
    let petalIndex: Int
    let worldName: String
    let formula: String
    let title: String
    let systemImage: String
    let keyboardShortcut: Int
    let content: AnyView
}

// Local navigation bridge — TriosTabView also calls these, and both files share
// one compilation unit, so the definition here is visible there.
enum QueenHostNavigation {
    static let didOpen = Notification.Name("TriosQueenHostNavigationDidOpen")
    static func open(petalIndex: Int) {
        NotificationCenter.default.post(name: didOpen, object: petalIndex)
    }
    static func showMenu() {}
}

// Local tab host rendering the 999 routes.
struct TriosHostedTabView: View {
    let routes: [TriosHostedRoute]
    @State private var selectedPetalIndex: Int

    init(routes: [TriosHostedRoute]) {
        self.routes = routes
        self._selectedPetalIndex = State(initialValue: routes.first?.petalIndex ?? 0)
    }

    var body: some View {
        VStack(spacing: 0) {
            tabBar
            Divider().overlay(Color.grokBorder)
            contentArea
        }
        .onReceive(NotificationCenter.default.publisher(for: QueenHostNavigation.didOpen)) { notification in
            if let petal = notification.object as? Int {
                selectedPetalIndex = petal
            }
        }
    }

    private var tabBar: some View {
        HStack(spacing: 2) {
            ForEach(routes, id: \.petalIndex) { route in
                tabButton(for: route)
            }
            Spacer()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func tabButton(for route: TriosHostedRoute) -> some View {
        let isSelected = route.petalIndex == selectedPetalIndex
        Button(action: { selectedPetalIndex = route.petalIndex }) {
            VStack(spacing: 2) {
                Image(systemName: route.systemImage)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isSelected ? .grokText : .grokMuted)
                Text(route.title)
                    .font(.system(size: 9))
                    .foregroundColor(isSelected ? .grokText : .grokMuted)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(isSelected ? Color.grokSurface.opacity(0.5) : Color.clear)
            .cornerRadius(6)
        }
        .buttonStyle(.plain)
        .keyboardShortcut(KeyEquivalent(Character("\(route.keyboardShortcut)")), modifiers: .command)
    }

    @ViewBuilder
    private var contentArea: some View {
        if let route = routes.first(where: { $0.petalIndex == selectedPetalIndex }) {
            route.content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// Placeholder for the trinity QueenUILib SettingsScreen, which is internal there.
// TriosTabView references it in the same compilation unit, so the definition
// here is visible there.
struct SettingsScreen: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "gear")
                .font(.system(size: 28, weight: .semibold))
                .foregroundColor(.grokMuted)
            Text("Settings")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.grokText)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct QueenTabView: View {
    @ObservedObject var viewModel: ChatViewModel
    @EnvironmentObject private var modelStore: ModelConfigurationStore
    @State private var chatBottomRequest = 0
    @ObservedObject private var logsNavigator = TriosLogsNavigator.shared
    private let embedding = TrinityQueenEmbedding.resolved()

    var body: some View {
        Group {
            if embedding.hasCanonicalSourceLayout {
                TriosHostedTabView(routes: hostedRoutes)
            } else {
                missingSourceView
            }
        }
        .clipped()
        .accessibilityIdentifier("trinity-queen-embedded-root")
        .onChange(of: modelStore.modelsTabRequest) {
            open(.models)
        }
        .onChange(of: logsNavigator.openRequest) {
            open(.logs)
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

    private var hostedRoutes: [TriosHostedRoute] {
        [
            hostedRoute(for: .chat) {
                AdaptiveChatWorkspace(
                    viewModel: viewModel,
                    scrollToBottomRequest: chatBottomRequest
                )
            },
            hostedRoute(for: .models) {
                ModelsTabView(viewModel: viewModel)
            },
            hostedRoute(for: .logs) {
                LogsTabView()
            },
            hostedRoute(for: .skills) {
                SkillsTabView()
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
    ) -> TriosHostedRoute {
        let mapping = route(for: destination)
        return TriosHostedRoute(
            petalIndex: mapping.petalIndex,
            worldName: mapping.worldName,
            formula: mapping.formula,
            title: mapping.title,
            systemImage: mapping.systemImage,
            keyboardShortcut: mapping.keyboardShortcut,
            content: AnyView(content())
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
