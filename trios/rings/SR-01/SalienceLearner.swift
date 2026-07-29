import Foundation

/// Learns which signals actually predicted that a task needed the user.
///
/// The salience weights started as numbers I picked. They were explicit and
/// arguable, which beats hiding them inside a sort comparator, but "learned"
/// was a name rather than a fact. This makes it a fact: every review outcome is
/// recorded against the features the task had, and a feature's weight becomes
/// the rate at which tasks carrying it actually needed intervention.
///
/// Intervention means the user rejected or cancelled. Acceptance is the null
/// outcome: the task was fine and looking at it first would have been wasted
/// attention.
@MainActor
final class SalienceLearner {
    static let shared = SalienceLearner()

    /// Observations per feature: how many carried it, how many needed the user.
    struct Tally: Codable, Equatable {
        var seen: Int = 0
        var intervened: Int = 0

        /// Laplace-smoothed rate. Without smoothing the first observation sets
        /// a feature's weight to 0 or 1 forever, and one unlucky task would
        /// silence a signal permanently.
        var rate: Double {
            Double(intervened + 1) / Double(seen + 2)
        }
    }

    private(set) var tallies: [String: Tally] = [:]
    private let storePath: String
    /// Below this many observations a feature keeps its prior. Learning from
    /// three samples is not learning, it is overfitting with extra steps.
    private let minimumObservations: Int

    init(
        storePath: String = "\(ProjectPaths.trinity)/state/queen_salience.json",
        minimumObservations: Int = 8
    ) {
        self.storePath = storePath
        self.minimumObservations = minimumObservations
        load()
    }

    /// Records what happened to a task once the user decided.
    func record(task: DelegatedTask, neededUser: Bool, now: Date = Date()) {
        for feature in QueenSalience.features(of: task, now: now) {
            var tally = tallies[feature.rawValue] ?? Tally()
            tally.seen += 1
            if neededUser { tally.intervened += 1 }
            tallies[feature.rawValue] = tally
        }
        persist()
        TriosLogBus.shared.debug(
            .queen,
            "queen.salience.record",
            "Recorded a review outcome",
            ["issue": task.issue.slug, "needed_user": neededUser ? "yes" : "no"]
        )
    }

    /// The weight to use for a feature: learned once there is enough evidence,
    /// the hand-picked prior until then.
    ///
    /// Scaled so a feature that always needs the user lands near its prior's
    /// magnitude rather than at an arbitrary 1.0 - the priors encode a sense of
    /// proportion between signals that a bare probability throws away.
    func weight(for feature: QueenSalience.Feature) -> Double {
        guard let tally = tallies[feature.rawValue],
              tally.seen >= minimumObservations else {
            return feature.prior
        }
        return tally.rate * QueenSalience.maximumWeight
    }

    /// Human-readable state, for the Queen to explain her own ranking.
    func evidence(for feature: QueenSalience.Feature) -> String {
        guard let tally = tallies[feature.rawValue], tally.seen >= minimumObservations else {
            return "no evidence yet, using my starting estimate"
        }
        let percent = Int((tally.rate * 100).rounded())
        return "\(tally.intervened) of \(tally.seen) needed you, about \(percent)%"
    }

    // MARK: - Persistence

    private func load() {
        guard let data = FileManager.default.contents(atPath: storePath),
              let decoded = try? JSONDecoder().decode([String: Tally].self, from: data) else {
            return
        }
        tallies = decoded
    }

    private func persist() {
        let directory = (storePath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(tallies) else { return }
        try? data.write(to: URL(fileURLWithPath: storePath), options: .atomic)
    }
}
