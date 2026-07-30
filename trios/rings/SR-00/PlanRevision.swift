import Foundation

/// A requested change to a plan already in flight.
enum PlanRevision: Equatable, Sendable {
    /// Replace the pending tail with a new set of titles.
    case replacePending([String])
    /// Insert steps directly after the running one.
    case insertAfterCurrent([String])
    /// Drop pending steps whose titles match.
    case dropPending([String])
    /// Rename a step without disturbing its state or position.
    case rename(id: UUID, title: String)
}

/// Applies revisions to a running plan.
///
/// AgentScope treats `revise_current_plan` as a first-class operation, so a plan
/// must tolerate mid-run edits rather than assuming append-only. The invariant
/// that makes this safe: **history is immutable**. A revision may reshape what
/// has not happened yet; it may never rewrite or remove a step that already ran,
/// because the user has seen it and it is a record of real work.
enum PlanReviser {
    /// True when a step is finished business and therefore untouchable.
    static func isHistory(_ state: PlanStepState) -> Bool {
        switch state {
        case .completed, .failed, .cancelled: return true
        case .pending, .inProgress: return false
        }
    }

    /// Applies a revision, preserving history and the running step.
    static func apply(_ revision: PlanRevision, to steps: [PlanStep]) -> [PlanStep] {
        let ordered = steps.sorted { $0.order < $1.order }
        let history = ordered.filter { isHistory($0.state) }
        let running = ordered.filter { $0.state == .inProgress }
        let pending = ordered.filter { $0.state == .pending }

        switch revision {
        case .rename(let id, let title):
            let clean = normalize(title)
            guard !clean.isEmpty else { return ordered }
            return ordered.map { step in
                guard step.id == id, !isHistory(step.state) else { return step }
                var copy = step
                copy.title = clean
                return copy
            }

        case .replacePending(let titles):
            let fresh = makeSteps(titles, startingAt: nextOrder(after: history + running))
            return reindex(history + running + fresh)

        case .insertAfterCurrent(let titles):
            let fresh = makeSteps(titles, startingAt: nextOrder(after: history + running))
            return reindex(history + running + fresh + pending)

        case .dropPending(let titles):
            let drop = Set(titles.map(normalize).filter { !$0.isEmpty })
            let kept = pending.filter { !drop.contains(normalize($0.title)) }
            return reindex(history + running + kept)
        }
    }

    /// Rejects a revision that would touch history, so callers can report why
    /// instead of silently doing nothing.
    static func wouldRewriteHistory(_ revision: PlanRevision, in steps: [PlanStep]) -> Bool {
        guard case .rename(let id, _) = revision else { return false }
        return steps.first { $0.id == id }.map { isHistory($0.state) } ?? false
    }

    // MARK: - Helpers

    private static func normalize(_ value: String) -> String {
        value
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    private static func makeSteps(_ titles: [String], startingAt order: Int) -> [PlanStep] {
        var next = order
        var result: [PlanStep] = []
        for title in titles {
            let clean = normalize(title)
            guard !clean.isEmpty else { continue }
            result.append(PlanStep(title: clean, state: .pending, order: next))
            next += 1
        }
        return result
    }

    private static func nextOrder(after steps: [PlanStep]) -> Int {
        (steps.map(\.order).max() ?? -1) + 1
    }

    /// Renumbers so `order` stays dense and stable after edits.
    private static func reindex(_ steps: [PlanStep]) -> [PlanStep] {
        steps.enumerated().map { index, step in
            var copy = step
            copy.order = index
            return copy
        }
    }
}
