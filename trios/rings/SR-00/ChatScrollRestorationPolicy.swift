import Foundation

enum ChatScrollRestorationTarget: Equatable {
    case finalContentAnchor
}

enum ChatScrollRestorationPolicy {
    static let target: ChatScrollRestorationTarget = .finalContentAnchor

    static func shouldRequestBottom(wasChatActive: Bool, isChatActive: Bool) -> Bool {
        !wasChatActive && isChatActive
    }
}
