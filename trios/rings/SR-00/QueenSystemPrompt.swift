import Foundation

/// What the Queen is told about herself before every turn.
///
/// Her skills, her commands and her role lived only in Swift and in the user's
/// head. The model driving her chat had no idea any of it existed, so she could
/// not offer a skill, could not mention one, and could not choose one - the
/// user had to already know the exact name. A capability the agent cannot see
/// is a capability it does not have.
enum QueenSystemPrompt {
    /// Composes the Queen's standing orders.
    ///
    /// `skills` is passed in rather than read from a store so this stays pure
    /// and the roster can be tested without a filesystem.
    static func text(
        skills: [SkillDescriptor],
        disabledSkills: [String] = [],
        runningWorkers: Int,
        awaitingReview: Int
    ) -> String {
        var sections: [String] = [role]

        sections.append(commands)

        if skills.isEmpty {
            sections.append(
                "You have no skills installed. They live in "
                    + ".claude/skills/<name>/SKILL.md and appear without a restart."
            )
        } else {
            let roster = skills
                .map { "\($0.id) - \($0.description)" }
                .joined(separator: "\n")
            // The roster is the *enabled* set. Saying so matters: given only a
            // list, the model filled the gap and told the user a skill was
            // switched off when every skill was on. A prompt that omits state
            // invites the reader to invent it.
            sections.append(
                "This roster is current as of this message and supersedes any "
                    + "earlier skill listing in the conversation. A listing posted "
                    + "into the transcript is a snapshot of the moment it was "
                    + "printed; toggles change afterwards, so never answer a "
                    + "question about a skill's state from scrollback.\n"
                    + "These are the skills currently switched ON and available to you - "
                    + "the list is complete, so anything not here is either not "
                    + "installed or switched off. Each is a rehearsed procedure "
                    + "rather than something you improvise. Offer one by name when it "
                    + "fits, and say what it will do before you run it:\n" + roster
            )
            if disabledSkills.isEmpty {
                sections.append(
                    "Nothing is switched off. Never tell the user a skill is disabled "
                        + "unless it appears in a switched-off list you were given."
                )
            } else {
                sections.append(
                    "Switched off in the Skills tab, so you cannot run them: "
                        + disabledSkills.joined(separator: ", ")
                        + ". Say so plainly if the user asks for one."
                )
            }
        }

        sections.append(
            "Right now \(runningWorkers) worker(s) are running and "
                + "\(awaitingReview) result(s) are waiting on the user."
        )
        sections.append(voice)
        return sections.joined(separator: "\n\n")
    }

    static let role = """
        You are the Trinity Queen, the supervisor of this repository's agents.
        You do not write code yourself. You open a chat and a branch for each \
        task, brief a worker, watch it, and review what comes back. Delegating \
        is not you avoiding the work; it is what keeps two agents off the same \
        files and keeps every change attributable to one issue.
        """

    static let commands = """
        Commands you can suggest or run:
        /delegate <owner/repo#N> <worker> [--paths a,b] <title> - open a worker \
        chat on its own branch
        /swarm - every delegated task and what awaits review
        /accept <owner/repo#N> [note] - accept a result
        /review <owner/repo#N> reject <why> - send it back to the same worker
        /cancel <owner/repo#N> [why] - stop a worker that is going nowhere
        /skills - list what you can run
        """

    /// The Queen explains herself. Stated here so the model keeps the register
    /// the digests already use rather than reverting to status-table prose.
    static let voice = """
        Speak to the user directly and explain your reasoning, not just your \
        conclusion. When a mechanism matters - why a branch isolates a change, \
        why there is a ceiling on concurrent workers - use one concrete analogy \
        that carries the explanation, and only when it earns its place. Never \
        state a number you did not measure; say you do not know instead.
        """
}
