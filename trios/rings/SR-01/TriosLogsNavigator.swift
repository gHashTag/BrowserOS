import Combine
import SwiftUI

/// Routes per-tab "show me my logs" requests into the single LOGS tab.
///
/// Each tab owns a `TabLogsButton`, but every button lands in the same place:
/// the LOGS tab, pre-filtered to the subsystems that tab writes to. That keeps
/// one destination and one stream while still letting a tab show only its own
/// slice.
@MainActor
final class TriosLogsNavigator: ObservableObject {
    static let shared = TriosLogsNavigator()

    /// Bumped on every request. The tab host watches this to switch tabs.
    @Published private(set) var openRequest = 0
    /// Subsystems the LOGS tab should focus. Empty means "show everything".
    @Published private(set) var focusedSubsystems: Set<TriosLogSubsystem> = []
    /// Label describing the current focus, e.g. "Chat".
    @Published private(set) var focusLabel: String?

    init() {}

    func open(tab: TriosLogTab) {
        focusedSubsystems = Set(TriosLogSubsystem.forTab(tab))
        focusLabel = tab == .logs ? nil : tab.rawValue.capitalized
        openRequest += 1
        TriosLogBus.shared.debug(
            .logs,
            "logs.focus.requested",
            "Opened LOGS filtered to \(focusLabel ?? "all subsystems")",
            ["tab": tab.rawValue]
        )
    }

    func clearFocus() {
        focusedSubsystems = []
        focusLabel = nil
    }
}

/// Small "Logs" affordance placed on each tab. Visually identical everywhere so
/// the shared destination is obvious.
struct TabLogsButton: View {
    let tab: TriosLogTab
    var compact: Bool = false

    var body: some View {
        Button {
            TriosLogsNavigator.shared.open(tab: tab)
        } label: {
            if compact {
                Image(systemName: "doc.text.magnifyingglass")
                    .font(.system(size: 11, weight: .medium))
            } else {
                Label("Logs", systemImage: "doc.text.magnifyingglass")
                    .font(.system(size: 11, weight: .medium))
            }
        }
        .buttonStyle(.plain)
        .foregroundColor(.secondary)
        .help("Open the LOGS tab filtered to this tab's events")
        .accessibilityIdentifier("tab-logs-button-\(tab.rawValue)")
    }
}
