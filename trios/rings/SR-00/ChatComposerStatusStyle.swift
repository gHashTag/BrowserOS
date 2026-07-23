import Foundation

struct ChatComposerStatusMetrics: Equatable {
    let isEmbeddedInComposer: Bool
    let rendersStandaloneSurface: Bool
    let showsModelSelection: Bool
    let showsProviderName: Bool
    let showsTokenUsage: Bool
    let showsTokenBreakdown: Bool
    let showsRecoveryAction: Bool
    let showsConnectionState: Bool
    let showsCDPLabel: Bool
    let controlHeight: Double
    let itemSpacing: Double
}

enum ChatComposerStatusStyle {
    static func metrics(for mode: ChatWorkspaceMode) -> ChatComposerStatusMetrics {
        switch mode {
        case .compact:
            return ChatComposerStatusMetrics(
                isEmbeddedInComposer: true,
                rendersStandaloneSurface: false,
                showsModelSelection: true,
                showsProviderName: false,
                showsTokenUsage: true,
                showsTokenBreakdown: false,
                showsRecoveryAction: true,
                showsConnectionState: true,
                showsCDPLabel: false,
                controlHeight: 30,
                itemSpacing: 6
            )
        case .expanded:
            return ChatComposerStatusMetrics(
                isEmbeddedInComposer: true,
                rendersStandaloneSurface: false,
                showsModelSelection: true,
                showsProviderName: true,
                showsTokenUsage: true,
                showsTokenBreakdown: true,
                showsRecoveryAction: true,
                showsConnectionState: true,
                showsCDPLabel: true,
                controlHeight: 32,
                itemSpacing: 9
            )
        }
    }
}
