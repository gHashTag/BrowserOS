import Foundation

/// Lifecycle of one plan step. Mirrors `TODOItemState` but lives in SR-00 so the
/// policies below can be unit-tested without the planner's storage stack.
enum PlanStepState: String, Codable, Equatable, Sendable {
    case pending
    case inProgress
    case completed
    case cancelled
    case failed

    /// A step the user may still need to act on, or watch.
    var isActionable: Bool {
        switch self {
        case .completed: return false
        case .pending, .inProgress, .cancelled, .failed: return true
        }
    }
}

/// Minimal step record used by the overflow policy.
struct PlanStep: Identifiable, Equatable, Sendable {
    let id: UUID
    var title: String
    var detail: String?
    var state: PlanStepState
    var order: Int

    init(id: UUID = UUID(), title: String, detail: String? = nil, state: PlanStepState, order: Int) {
        self.id = id
        self.title = title
        self.detail = detail
        self.state = state
        self.order = order
    }
}

/// Keeps a growing plan bounded.
///
/// Steps append per tool call now, so a long run could produce an arbitrarily
/// long checklist. Competitor UIs answer list length with nesting or disclosure
/// rather than truncation, so overflow is *folded into a counted summary*, never
/// dropped: the user can still see that the work happened.
enum PlanOverflow {
    static let overflowTitle = "Earlier steps"

    /// Folds the oldest completed steps until the list fits `maximum`.
    /// Actionable steps are never folded - a pending, running, cancelled, or
    /// failed step is something the user may still need, so hiding it would be
    /// a lie about the plan's state.
    static func coalesce(_ steps: [PlanStep], maximum: Int) -> [PlanStep] {
        guard maximum > 0, steps.count > maximum else { return steps }

        let sorted = steps.sorted { $0.order < $1.order }
        let existingSummary = sorted.first { $0.title == overflowTitle }
        let alreadyFolded = existingSummary
            .flatMap { Int($0.detail?.components(separatedBy: " ").first ?? "") } ?? 0

        var body = sorted.filter { $0.title != overflowTitle }
        let foldable = body.filter { !$0.state.isActionable }
        // Reserve one row for the summary itself.
        let targetBodyCount = max(0, maximum - 1)
        let excess = body.count - targetBodyCount
        guard excess > 0 else { return steps }

        let foldCount = min(excess, foldable.count)
        guard foldCount > 0 else { return steps }

        let foldIDs = Set(foldable.prefix(foldCount).map(\.id))
        body.removeAll { foldIDs.contains($0.id) }

        let summary = PlanStep(
            title: overflowTitle,
            detail: "\(alreadyFolded + foldCount) steps completed",
            state: .completed,
            order: (body.map(\.order).min() ?? 0) - 1
        )
        return [summary] + body
    }
}

/// Decides when a plan change has to reach durable storage.
///
/// Plan mutations used to happen about twice per turn and now happen once per
/// tool call, each writing to the SQLCipher-encrypted database. The in-memory
/// plan drives the UI, so intermediate changes can be coalesced; only terminal
/// states must be durable immediately, because that is what survives a crash.
enum PlanPersistPolicy {
    /// Minimum gap between intermediate writes.
    static let interval: TimeInterval = 2

    static func shouldWriteNow(isTerminal: Bool, lastWrite: Date?, now: Date) -> Bool {
        if isTerminal { return true }
        guard let lastWrite else { return true }
        return now.timeIntervalSince(lastWrite) >= interval
    }
}

/// Decides whether the checklist is worth rendering at all.
enum PlanDisplayPolicy {
    /// Below this, a turn is plain chat.
    static let minimumSteps = 2

    static func shouldDisplay(stepCount: Int, isTerminalFailure: Bool) -> Bool {
        // A failure is always shown, however short the turn: the user has to be
        // able to see what went wrong and retry it.
        if isTerminalFailure { return stepCount > 0 }
        return stepCount >= minimumSteps
    }
}
