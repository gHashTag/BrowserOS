import Foundation

enum ConversationTitlePolicy {
    static let maximumLength = 80
    static let fallbackTitle = "Untitled"

    static func normalized(_ rawTitle: String) -> String {
        let collapsed = rawTitle
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")

        guard !collapsed.isEmpty else {
            return fallbackTitle
        }
        return String(collapsed.prefix(maximumLength))
    }
}
