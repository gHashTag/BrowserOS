import Foundation

actor ConversationStateMachine {
    private var state: ConversationState = .idle
    private var reconnectAttempts: Int = 0
    private let maxReconnectAttempts: Int = 5

    func transition(to newState: ConversationState) -> ConversationState {
        switch (state, newState) {
        case (.idle, .streaming):
            state = newState
        case (.streaming, .idle):
            state = newState
            reconnectAttempts = 0
        case (.streaming, .awaitingContextDecision):
            state = newState
        case (.awaitingContextDecision, .idle):
            state = newState
            reconnectAttempts = 0
        case (.awaitingContextDecision, .streaming):
            state = newState
        case (.awaitingContextDecision, .error):
            state = newState
        case (.streaming, .error):
            state = newState
        case (.error, .idle):
            state = newState
            reconnectAttempts = 0
        case (.error, .streaming):
            state = newState
        case (.idle, .reconnecting(let attempt, _)):
            reconnectAttempts = attempt
            state = newState
        case (.reconnecting, .idle):
            state = newState
            reconnectAttempts = 0
        case (.reconnecting, .reconnecting(let attempt, let max)):
            reconnectAttempts = attempt
            state = .reconnecting(attempt: attempt, maxAttempts: max)
        case (.reconnecting, .error):
            state = newState
        default:
            break
        }
        return state
    }

    func currentState() -> ConversationState {
        return state
    }

    func tryTransition(to newState: ConversationState) -> Bool {
        guard canTransition(from: state, to: newState) else { return false }
        _ = transition(to: newState)
        return true
    }

    private func canTransition(from: ConversationState, to: ConversationState) -> Bool {
        switch (from, to) {
        case (.idle, .streaming),
             (.streaming, .idle),
             (.streaming, .awaitingContextDecision),
             (.awaitingContextDecision, .idle),
             (.awaitingContextDecision, .streaming),
             (.awaitingContextDecision, .error),
             (.streaming, .error),
             (.error, .idle),
             (.error, .streaming),     // allow retry immediately after error
             (.idle, .reconnecting),
             (.reconnecting, .idle),
             (.reconnecting, .reconnecting),
             (.reconnecting, .error):
            return true
        default:
            return false
        }
    }

    func shouldReconnect() -> Bool {
        return reconnectAttempts < maxReconnectAttempts
    }

    func incrementReconnect() {
        reconnectAttempts += 1
    }

    func reset() {
        state = .idle
        reconnectAttempts = 0
    }
}
