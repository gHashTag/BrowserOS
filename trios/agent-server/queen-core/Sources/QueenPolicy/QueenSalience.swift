import Foundation

/// How much a task deserves the Queen's attention.
///
/// The missing amygdala from the brain atlas. The review queue ordered by age
/// alone, so a task that had failed three times and burned a fortune looked
/// exactly like one that had never run - the supervisor's queue had no opinion,
/// and the user supplied all of it.
///
/// The amygdala's job is not to decide; it is to make some signals louder than
/// others before anything decides. That is all this does: it weights, and the
/// ordering falls out.
public enum QueenSalience {
    /// One observable property of a task that might predict it needs the user.
    ///
    /// Named rather than inlined so the same list drives scoring, learning and
    /// explanation. Three copies of a feature list is two copies that go stale.
    public enum Feature: String, CaseIterable, Sendable {
        case failed
        case rejected
        case expensive
        case committedNothing

        /// My starting estimate, used until there is real evidence.
        ///
        /// Failure dominates: a bee that failed is the only state where waiting
        /// costs something that is not just time - the branch is half-written
        /// and the issue is still open.
        /// Milli-weights, in `[0, 40000]`.
        ///
        /// Fixed point rather than floating, and the reason is ordering rather
        /// than precision. The only source of fraction here is the learner's
        /// rate, a probability in `[0, 1]` scaled into a bounded range that is
        /// known in advance - so the exponent of a float has nothing to do, and
        /// what it costs is real: two tasks whose scores differ by a millionth
        /// swapped places depending on the order the features happened to be
        /// added. Three decimal digits is more resolution than
        /// `minimumObservations` can justify.
        public var prior: Int {
            switch self {
            case .failed: return 40_000
            case .rejected: return 25_000
            case .expensive: return 20_000
            case .committedNothing: return 15_000
            }
        }
    }

    /// Ceiling a learned weight can reach, so learned and prior weights stay on
    /// one scale and a probability does not silently outrank a considered
    /// judgement by an order of magnitude.
    public static let maximumWeight = 40_000
    public static let agePerHourWeight = 1_000
    public static let ageCeiling = 24

    /// Which features a task currently carries.
    public static func features(of task: DelegatedTask, now: Date) -> [Feature] {
        var found: [Feature] = []
        if task.state == .failed { found.append(.failed) }
        if task.state == .rejected { found.append(.rejected) }
        // A worker that came back with nothing committed either only read, or
        // wrote outside its lane. Both need a human sooner than a clean result.
        if task.state == .awaitingReview, task.committedFiles == 0 {
            found.append(.committedNothing)
        }
        if QueenDelegationPolicy.isExpensive(task) { found.append(.expensive) }
        return found
    }

    /// Higher means "look at me first".
    ///
    /// `weightFor` is injected so scoring stays pure and testable: the learner
    /// is a live object with a file behind it, and a ranking that cannot be
    /// tested without one is a ranking nobody will test.
    public static func score(
        for task: DelegatedTask,
        now: Date,
        weightFor: (Feature) -> Int = { $0.prior }
    ) -> Int {
        var score = features(of: task, now: now).reduce(0) { $0 + weightFor($1) }
        // Whole hours. The fractional part of an hour was carrying a millionth
        // of a weight and deciding ties with it.
        let hours = Int(max(0, now.timeIntervalSince(task.updatedAt)) / 3600)
        // Capped: past a day, older is not more urgent, it is just older. An
        // uncapped age term eventually drowns every other signal.
        score += min(hours, ageCeiling) * agePerHourWeight
        return score
    }

    /// The Queen's queue, loudest first.
    ///
    /// Ties break on age so the order is stable and a task cannot starve behind
    /// an equally salient neighbour.
    public static func reviewQueue(
        _ tasks: [DelegatedTask],
        now: Date,
        weightFor: (Feature) -> Int = { $0.prior }
    ) -> [DelegatedTask] {
        tasks
            .filter { $0.state.needsQueenAttention }
            .sorted { lhs, rhs in
                let left = score(for: lhs, now: now, weightFor: weightFor)
                let right = score(for: rhs, now: now, weightFor: weightFor)
                if left != right { return left > right }
                return lhs.updatedAt < rhs.updatedAt
            }
    }

    /// Why this task is at the top, in words the Queen can say out loud.
    ///
    /// A ranking nobody can explain is a ranking nobody trusts, and the first
    /// thing an untrusted ranking gets is ignored.
    public static func reason(for task: DelegatedTask, now: Date) -> String? {
        var causes: [String] = []
        if task.state == .failed { causes.append("it failed rather than finished") }
        if task.state == .rejected { causes.append("you already sent it back once") }
        if task.state == .awaitingReview, task.committedFiles == 0 {
            causes.append("it committed nothing, so it either only read or wrote outside its lane")
        }
        if QueenDelegationPolicy.isExpensive(task) {
            causes.append("it cost more than this kind of task should")
        }
        let hours = max(0, now.timeIntervalSince(task.updatedAt)) / 3600
        if hours >= 4 { causes.append("it has been waiting \(Int(hours)) hours") }

        guard !causes.isEmpty else { return nil }
        if causes.count == 1 { return causes[0] }
        let last = causes.removeLast()
        return causes.joined(separator: ", ") + " and " + last
    }
}
