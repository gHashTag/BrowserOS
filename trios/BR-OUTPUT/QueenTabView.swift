// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/1244
// Reason: the 999 tab host is local again; the trinity layer that used to
//         host these tabs is deleted upstream and is no longer referenced.
// Follow-up: give the local 999 tab host a spec of its own, then seal it.
import SwiftUI

// MARK: - Hosted route

/// One Trios workspace as the 999 layout defines it.
///
/// This replaces the foreign route container trios used to borrow: a type
/// binding a `Trios999Destination` to its title, icon, world, formula,
/// hotkey and content. Every field but the content was always sourced from
/// `Trinity999TabMap` inside trios; the foreign type only ever carried them.
/// trinity deleted that integration layer, so the container lives here now
/// and the whole 999 strip renders without trinity at runtime.
struct TriosHostedRoute {
    let petalIndex: Int
    let title: String
    let systemImage: String
    let worldName: String
    let formula: String
    let keyboardShortcut: Int
    let content: AnyView
}

// MARK: - Host navigation

/// In-process navigation requests for the hosted 999 workspaces.
///
/// `TriosTabView` (the title bar) and this file both speak through it. The
/// enum used to be re-exported by the deleted trinity integration layer,
/// and the requests only ever travelled between trios views, so the
/// definition is trios' own now. Defining it here keeps the title bar
/// compiling unchanged - it lives in another file and outside this task's
/// boundary.
enum QueenHostNavigation {
    static let didOpen = Notification.Name("trios.queenHostNavigation.didOpen")

    static func open(petalIndex: Int) {
        NotificationCenter.default.post(name: didOpen, object: petalIndex)
    }

    /// The canonical 999 menu - the 27-petal triangle - lived inside the
    /// deleted trinity integration layer and is gone with it. Nothing local
    /// replaces it yet, so the title-bar button that still calls this is
    /// inert. Kept as a real function because `TriosTabView` calls it.
    static func showMenu() {}
}

// MARK: - Hosted tab strip

/// Renders the hosted 999 workspaces as a tab strip.
///
/// One row of petal buttons - icon and title, each reachable through its
/// `Command` hotkey from `Trinity999TabMap` - above the selected
/// workspace's content. The strip is transparent so the shared
/// `UnifiedTriosGlassBackground` shows through, as the embedded Queen
/// surfaces always were.
struct TriosHostedTabView: View {
    let routes: [TriosHostedRoute]
    @State private var selectedPetalIndex: Int

    init(routes: [TriosHostedRoute]) {
        self.routes = routes
        _selectedPetalIndex = State(initialValue: routes.first?.petalIndex ?? 0)
    }

    var body: some View {
        VStack(spacing: 0) {
            tabBar
            Divider().overlay(Color.grokBorder)
            selectedContent
        }
        .onReceive(
            NotificationCenter.default.publisher(for: QueenHostNavigation.didOpen)
        ) { notification in
            guard let petal = notification.object as? Int else { return }
            selectedPetalIndex = petal
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

    private func tabButton(for route: TriosHostedRoute) -> some View {
        let isSelected = route.petalIndex == selectedPetalIndex
        return Button(action: { selectedPetalIndex = route.petalIndex }) {
            HStack(spacing: 6) {
                Image(systemName: route.systemImage)
                    .font(TriosType.font(11, weight: .medium))
                    .foregroundColor(isSelected ? .grokText : .grokMuted)
                Text(route.title)
                    .font(TriosType.font(11, weight: isSelected ? .semibold : .medium))
                    .foregroundColor(isSelected ? .grokText : .grokMuted)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(isSelected ? Color.grokSurface.opacity(0.6) : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(isSelected ? Color.grokDivider.opacity(0.6) : Color.clear, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .keyboardShortcut(
            KeyEquivalent(Character("\(route.keyboardShortcut)")),
            modifiers: .command
        )
        .help("\(route.title) | \(route.worldName) | \(route.formula) | Cmd+\(route.keyboardShortcut)")
        .accessibilityLabel("\(route.title) tab")
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    @ViewBuilder
    private var selectedContent: some View {
        if let route = routes.first(where: { $0.petalIndex == selectedPetalIndex }) {
            route.content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: - Settings workspace surface

/// The Settings workspace, shown by `SettingsTabView` in `TriosTabView`.
///
/// The screen used to be re-exported by the deleted trinity integration
/// layer, so trios owns the surface now. This placeholder keeps the
/// Settings tab alive until it gets a real screen of its own.
struct SettingsScreen: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "gear")
                .font(TriosType.font(28, weight: .semibold))
                .foregroundColor(.grokMuted)
            Text("Settings")
                .font(TriosType.font(14, weight: .semibold))
                .foregroundColor(.grokText)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Queen tab view

struct QueenTabView: View {
    @ObservedObject var viewModel: ChatViewModel
    @EnvironmentObject private var modelStore: ModelConfigurationStore
    @State private var chatBottomRequest = 0
    @ObservedObject private var logsNavigator = TriosLogsNavigator.shared

    var body: some View {
        TriosHostedTabView(routes: hostedRoutes)
            .clipped()
            .accessibilityIdentifier("trios-queen-host-root")
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
            title: mapping.title,
            systemImage: mapping.systemImage,
            worldName: mapping.worldName,
            formula: mapping.formula,
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
}
