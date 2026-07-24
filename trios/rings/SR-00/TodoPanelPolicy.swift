import Foundation

struct TodoPanelMetrics: Equatable {
    /// Whether the trailing TODO panel can be shown at all for this layout.
    let isAvailable: Bool
    /// Whether the panel should be presented without user action (wide layouts).
    let presentedByDefault: Bool
    let minWidth: Double
    let idealWidth: Double
    let maxWidth: Double
}

/// Layout policy for the trailing TODO/checklist panel in the chat workspace.
///
/// The panel uses a native SwiftUI inspector in the expanded workspace. It is
/// only offered in expanded mode (compact layouts surface tasks inline in the
/// message stream) and is auto-presented only once the window is wide enough
/// that a bounded panel will not crush the conversation column.
enum TodoPanelPolicy {
    static let minWidth: Double = 240
    static let idealWidth: Double = 300
    static let maxWidth: Double = 400

    /// Minimum total width before the panel is presented by default.
    ///
    /// Derived from the reserved history sidebar (272), a comfortable minimum
    /// conversation column, and the panel's ideal width so none is starved.
    static let autoPresentThreshold: Double =
        ChatWorkspaceLayout.standardSidebarWidth + 548 + idealWidth

    static func metrics(width: Double, mode: ChatWorkspaceMode) -> TodoPanelMetrics {
        let available = mode == .expanded
        let presentedByDefault = available && width >= autoPresentThreshold
        return TodoPanelMetrics(
            isAvailable: available,
            presentedByDefault: presentedByDefault,
            minWidth: minWidth,
            idealWidth: idealWidth,
            maxWidth: maxWidth
        )
    }
}
