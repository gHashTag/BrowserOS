import Foundation

/// The brief a worker receives when the Queen opens its chat.
///
/// Deliberately a *subset* of the Queen's context: the issue, the branch and
/// the file boundary. The supervisor pattern's main failure mode is the
/// orchestrator's history leaking into every worker until nobody has room to
/// think, so the worker is told what it owns and nothing else.
enum QueenBriefing {
    /// `skillBody` is the full text of a `SKILL.md`, handed over verbatim.
    ///
    /// A brief that paraphrases a procedure drifts from it the moment either
    /// changes; a brief that carries the procedure cannot. The skill goes last
    /// so the boundary is read first - a worker that only skims gets the rules
    /// before the recipe.
    /// `priorAttempts` is what happened to the bees sent at this issue before.
    ///
    /// It goes near the top, ahead of the procedure, because it changes what
    /// the worker should do rather than how it should do it. Without it a
    /// retry is not a second attempt - it is the first attempt run again, with
    /// a worker that has no way of knowing it is repeating anyone. #1127 was
    /// run that way seven times.
    static func text(
        for task: DelegatedTask,
        skillBody: String? = nil,
        priorAttempts: [QueenFailureKind] = []
    ) -> String {
        var text = core(for: task)
        if let history = QueenRetryPolicy.retryBriefing(priorAttempts: priorAttempts) {
            text += "\n\n" + history
        }
        if let skillBody, !skillBody.isEmpty {
            text += "\n\nFollow this procedure:\n\n" + skillBody
        }
        return text
    }

    /// The brief *is* the specification now, not a summary attached to one.
    ///
    /// The prose version told the worker the issue, the branch and the files,
    /// then asked it to report back when done. It never said what done meant,
    /// which is why a worker that stopped and a worker that finished sent the
    /// same signal. Replacing it rather than adding to it is deliberate: two
    /// documents describing the same task drift, and the softer one wins.
    private static func core(for task: DelegatedTask) -> String {
        QueenTaskSpec.render(for: task)
            + "\n\nThe Queen reviews against the criteria above before anything lands."
    }
}
