import Foundation

enum TriosBranding {
    // Keep the source ASCII-only while rendering the requested superscript.
    static let displayName = "Trinity S\u{00B3}AI"
    static let messagePlaceholder = "Message..."
    static let localTypingLabel: String? = nil
    static let statusProductLabel: String? = nil
}

enum ChatSenderKind: Equatable {
    case user
    case assistant
    case system
}

enum ChatSenderLabelPolicy {
    static func label(for sender: ChatSenderKind) -> String? {
        sender == .user ? "You" : nil
    }
}
