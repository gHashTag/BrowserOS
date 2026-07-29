import Foundation

/// Accumulates a worker's turn from parser actions, with no UI attached.
///
/// The main chat applies `ParserAction` directly to `ChatViewModel.messages`,
/// which binds a running turn to whichever conversation the user is looking at.
/// A delegated worker must keep running while the Queen stays in her own chat,
/// so its transcript lives here instead: same actions, same resulting messages,
/// no view model.
struct QueenWorkerTranscript {
    private(set) var messages: [ChatMessage] = []
    /// Set when the stream reported a failure, so the caller can mark the task
    /// failed rather than silently filing an empty result for review.
    private(set) var failure: String?
    private(set) var didComplete = false
    /// Provider-reported usage for this turn, so the swarm view can say what a
    /// bee cost rather than only what it said.
    private(set) var inputTokens = 0
    private(set) var outputTokens = 0

    init(seed: [ChatMessage] = []) {
        messages = seed
    }

    /// Text the worker produced, which is what the Queen reviews.
    var assistantText: String {
        messages
            .filter { $0.role == .assistant }
            .map(\.content)
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var toolCallCount: Int {
        messages.reduce(0) { $0 + $1.toolCalls.count }
    }

    mutating func apply(_ action: ParserAction) {
        switch action {
        case .appendMessage(let message):
            messages.append(message)

        case .appendText(let messageId, let delta):
            guard let index = index(of: messageId) else { return }
            messages[index].content += delta
            if let last = messages[index].segments.indices.last,
               case .text(let existing) = messages[index].segments[last] {
                messages[index].segments[last] = .text(existing + delta)
            } else {
                messages[index].segments.append(.text(delta))
            }
            messages[index].isStreaming = true

        case .finishMessage:
            // Text may be done while tool calls continue; `isStreaming` is
            // cleared only on a terminal action, exactly as the main chat does.
            break

        case .startSegment(let messageId, let segment):
            guard let index = index(of: messageId) else { return }
            messages[index].segments.append(segment)

        case .appendToSegment(let messageId, let kind, let delta):
            guard let index = index(of: messageId),
                  let last = messages[index].segments.indices.last else { return }
            switch (kind, messages[index].segments[last]) {
            case (.text, .text(let existing)):
                messages[index].segments[last] = .text(existing + delta)
            case (.reasoning, .reasoning(let existing)):
                messages[index].segments[last] = .reasoning(existing + delta)
            default:
                break
            }

        case .addToolCall(let messageId, let toolCall):
            guard let index = index(of: messageId) else { return }
            messages[index].toolCalls.append(toolCall)
            messages[index].segments.append(.toolCall(id: toolCall.id))

        case .appendToolInput(let messageId, let toolCallId, let delta):
            guard let index = index(of: messageId),
                  let tool = toolIndex(in: index, id: toolCallId) else { return }
            messages[index].toolCalls[tool].arguments += delta

        case .finalizeToolInput(let messageId, let toolCallId, let arguments):
            guard let index = index(of: messageId),
                  let tool = toolIndex(in: index, id: toolCallId) else { return }
            messages[index].toolCalls[tool].arguments = arguments

        case .setToolOutput(let messageId, let toolCallId, let output):
            guard let index = index(of: messageId),
                  let tool = toolIndex(in: index, id: toolCallId) else { return }
            messages[index].toolCalls[tool].output = output
            messages[index].toolCalls[tool].isComplete = true

        case .setToolError(let messageId, let toolCallId, let error):
            guard let index = index(of: messageId),
                  let tool = toolIndex(in: index, id: toolCallId) else { return }
            messages[index].toolCalls[tool].output = "Error: \(error)"
            messages[index].toolCalls[tool].isComplete = true

        case .recordUsage(let input, let output, let total):
            inputTokens += input
            // Some providers report only a total. Deriving output from it beats
            // showing a bee that produced 3000 characters as costing zero.
            outputTokens += output > 0 ? output : max(0, total - input)

        case .streamComplete:
            finalize()
            didComplete = true

        case .streamAborted:
            finalize()
            didComplete = true
            if failure == nil { failure = "The worker's stream was aborted." }

        case .streamError(let message):
            finalize()
            didComplete = true
            failure = message
        }
    }

    /// Records a transport-level failure that never reached the parser.
    mutating func failWithoutStream(_ message: String) {
        finalize()
        didComplete = true
        failure = message
    }

    private mutating func finalize() {
        for index in messages.indices where messages[index].isStreaming {
            messages[index].isStreaming = false
        }
    }

    private func index(of messageId: UUID) -> Int? {
        messages.firstIndex { $0.id == messageId }
    }

    private func toolIndex(in messageIndex: Int, id: String) -> Int? {
        messages[messageIndex].toolCalls.firstIndex { $0.id == id }
    }
}
