import Foundation

/// Why a task ended in `failed`, and what the Queen should do about it next.
///
/// The registry has one word for two different events. A worker whose app was
/// restarted under it and a worker that ran for forty tool calls and produced
/// nothing both end as `failed`, and until now they were indistinguishable
/// afterwards - so the Queen treated them the same way, which is to say she
/// chose the issue again and sent another bee with the same brief.
///
/// The dev registry at the time of writing: nineteen tasks, fourteen failed,
/// #1127 attempted seven times, #1129 five, #1128 four. Ten of the fourteen had
/// `streamOutcome: open` and every measurement nil - nobody had failed at
/// anything, the process had gone away. The other four had done real work. One
/// of those two groups should be retried immediately and the other should not
/// be retried blindly at all, and nothing in the record could tell them apart.
enum QueenFailureKind: String, Codable, Equatable, Sendable, CaseIterable {
    /// The process died under the worker - a restart, a crash, a kill. Nobody
    /// failed; the attempt simply stopped existing.
    case interrupted
    /// The worker ran and finished, but produced nothing: no commit, no tool
    /// calls that changed anything. Retrying the same brief will do this again.
    case producedNothing
    /// The worker did real work and it was judged unacceptable. This is the
    /// only kind that is genuinely about the task being hard.
    case workedButFailed
    /// Nobody tallied the branch, so nothing is known about what it produced.
    ///
    /// A separate kind rather than a guess in either direction. It counts
    /// against the issue - the attempt did end in failure - but it must not
    /// tell the next bee that the last one committed nothing, because on the
    /// occasion that produced this case the last one had committed 288 lines.
    case unmeasured

    /// Whether an attempt of this kind counts against the issue.
    ///
    /// An interruption is the supervisor's accident, not the issue's
    /// difficulty. Counting it would retire issues for the crime of having been
    /// open while somebody rebuilt the app - which, on this machine tonight,
    /// would have retired three of them.
    var countsAgainstTheIssue: Bool { self != .interrupted }

    /// What a later worker needs told about it.
    var briefingLine: String {
        switch self {
        case .interrupted:
            return "the previous attempt was cut off by a restart, not by a problem with the task"
        case .producedNothing:
            return "the previous attempt ran to the end and committed nothing"
        case .workedButFailed:
            return "the previous attempt produced work that did not pass review"
        case .unmeasured:
            return "an earlier attempt ended without its branch being tallied, so what "
                + "it left behind is unknown - look at the branch before assuming it is empty"
        }
    }
}

/// How many bees an issue is worth, and what the next one is told.
enum QueenRetryPolicy {
    /// Real attempts allowed before the issue is handed back to the operator.
    ///
    /// Two, because the second attempt is the one that can differ from the
    /// first - it is briefed with what the first hit - and a third identical
    /// failure is evidence about the issue rather than about the workers. The
    /// number is small on purpose: every attempt is a provider bill and a
    /// worker slot, and an issue that has defeated two briefed bees needs a
    /// person to look at it, not a third bee.
    static let maximumRealAttempts = 2

    enum Decision: Equatable {
        /// Send a bee. `attempt` is 1-based and counts only real attempts.
        case attempt(number: Int)
        /// Stop choosing this issue; say why.
        case escalate(reason: String)
    }

    /// Classify an ended attempt from what the registry actually recorded.
    ///
    /// Deliberately reads the measurements rather than trusting a label,
    /// because the label is what was missing. `streamOutcome == "open"` with no
    /// completed turns is the signature of a process that went away: a worker
    /// that finishes always closes its stream, and one that was killed never
    /// gets to.
    static func classify(
        streamOutcome: String?,
        completedTurns: Int?,
        toolCalls: Int?,
        committedFiles: Int?
    ) -> QueenFailureKind {
        if streamOutcome == "open" && (completedTurns ?? 0) == 0 {
            return .interrupted
        }
        // `nil` is not zero. Absent means the branch was never tallied; zero
        // means it was tallied and held nothing, and only the second is a
        // statement about the worker.
        //
        // Collapsing them with `?? 0` labelled #1282 `producedNothing` while
        // its branch carried a 288-line commit - a false claim about a bee that
        // had done the work, and one that counts against the issue in exactly
        // the same way as a real failure. `QueenReviewDigest` in this same ring
        // has always kept the two apart; this one did not, and the one that was
        // wrong is the one that decides whether another bee is sent.
        guard let committedFiles else {
            return .unmeasured
        }
        if committedFiles == 0 {
            return .producedNothing
        }
        return .workedButFailed
    }

    /// Whether to send another bee at an issue, given every attempt so far.
    ///
    /// Takes the kinds rather than a count so the caller cannot accidentally
    /// pass the wrong total: the interruption filter belongs to the policy, not
    /// to whoever remembers to apply it.
    static func decision(priorAttempts: [QueenFailureKind]) -> Decision {
        let real = priorAttempts.filter(\.countsAgainstTheIssue)
        guard real.count < maximumRealAttempts else {
            let kinds = real.map(\.rawValue).joined(separator: ", ")
            return .escalate(
                reason: "\(real.count) attempts have already failed on their own merits "
                    + "(\(kinds)); a third would be the same brief against the same "
                    + "issue, so this one needs you rather than another bee"
            )
        }
        return .attempt(number: real.count + 1)
    }

    /// What the next worker is told about the ones before it.
    ///
    /// Empty for a first attempt, because there is nothing to say and a brief
    /// that opens by discussing attempts that never happened wastes the one
    /// thing a worker reads most carefully.
    ///
    /// This is the half that makes a retry worth making. Sending an identical
    /// brief to a fresh worker is not a second attempt, it is the first attempt
    /// run twice - which is exactly what #1127 got, seven times.
    static func retryBriefing(priorAttempts: [QueenFailureKind]) -> String? {
        let real = priorAttempts.filter(\.countsAgainstTheIssue)
        guard !real.isEmpty else { return nil }
        var lines = [
            "This issue has been attempted \(real.count) time(s) before. "
                + "You are not starting from a blank sheet:",
        ]
        for (index, kind) in real.enumerated() {
            lines.append("  \(index + 1). \(kind.briefingLine).")
        }
        lines.append(
            "Do not repeat the previous approach unchanged. If you reach the same "
                + "wall, say what the wall is rather than stopping quietly - a named "
                + "obstacle is worth more than another empty branch."
        )
        return lines.joined(separator: "\n")
    }
}
