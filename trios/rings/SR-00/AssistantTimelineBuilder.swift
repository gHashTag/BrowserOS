import Foundation

enum AssistantTimelineItem: Equatable {
    case reasoning(String)
    case text(String)
    case toolCall(id: String)
    case error(String)
}

enum AssistantTimelineBuilder {
    static func build(
        content: String,
        segments: [MessageSegment],
        toolCalls: [ToolCall]
    ) -> [AssistantTimelineItem] {
        let hasStreamTimeline = segments.contains { segment in
            switch segment {
            case .text, .toolCall:
                return true
            default:
                return false
            }
        }

        var items: [AssistantTimelineItem] = []
        var referencedToolIds = Set<String>()
        var hasTimelineText = false

        for segment in segments {
            switch segment {
            case .reasoning(let text) where !text.isEmpty:
                items.append(.reasoning(text))
            case .text(let text) where !text.isEmpty:
                items.append(.text(text))
                hasTimelineText = true
            case .toolCall(let id):
                if referencedToolIds.insert(id).inserted {
                    items.append(.toolCall(id: id))
                }
            case .error(let text) where !text.isEmpty:
                items.append(.error(text))
            default:
                break
            }
        }

        for toolCall in toolCalls where !referencedToolIds.contains(toolCall.id) {
            items.append(.toolCall(id: toolCall.id))
            referencedToolIds.insert(toolCall.id)
        }

        if !content.isEmpty && (!hasStreamTimeline || !hasTimelineText) {
            items.append(.text(content))
        }

        return items
    }
}
