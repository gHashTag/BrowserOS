import Foundation

enum AssistantActionPresentation: Equatable {
    case none
    case primary
    case hoverCopy

    var copyActionCount: Int {
        self == .none ? 0 : 1
    }
}

enum AssistantActionBarPolicy {
    static func presentation(
        isStreaming: Bool,
        hasContent: Bool,
        isLastInGroup: Bool,
        isConversationIdle: Bool
    ) -> AssistantActionPresentation {
        guard hasContent else { return .none }
        if !isStreaming && isLastInGroup && isConversationIdle {
            return .primary
        }
        return .hoverCopy
    }
}
