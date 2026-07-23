import Foundation

enum ChatLoadingIndicatorAlignment: Equatable {
    case leading
    case center
}

enum ChatLoadingIndicatorPlacement: Equatable {
    case messageFlow
    case screenOverlay
}

enum ChatLoadingIndicatorForegroundTone: Equatable {
    case white
}

enum ChatLoadingIndicatorVisualStyle: Equatable {
    case signalPulse
}

enum ChatLoadingIndicatorLayout {
    static let previousNodeDiameter = 6.0
    static let nodeScale = 1.2
    static let nodeDiameter = previousNodeDiameter * nodeScale
    static let alignment: ChatLoadingIndicatorAlignment = .center
    static let groupsLabelWithDots = true
    static let placement: ChatLoadingIndicatorPlacement = .messageFlow
    static let foregroundTone: ChatLoadingIndicatorForegroundTone = .white
    static let visualStyle: ChatLoadingIndicatorVisualStyle = .signalPulse
    static let rendersInChatStream = true
    static let rendersInsideAssistantBubble = false

    static func shouldRenderAssistantBubble(
        isStreaming: Bool,
        timelineItemCount: Int
    ) -> Bool {
        !isStreaming || timelineItemCount > 0
    }
}
