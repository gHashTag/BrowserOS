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
    static func text(for task: DelegatedTask, skillBody: String? = nil) -> String {
        var text = core(for: task)
        if let skillBody, !skillBody.isEmpty {
            text += "\n\nFollow this procedure:\n\n" + skillBody
        }
        return text
    }

    private static func core(for task: DelegatedTask) -> String {
        var lines = [
            "You are working on \(task.issue.slug).",
            "Issue: \(task.issue.url)",
            "Task: \(task.title)"
        ]
        if let branch = task.virtualBranch {
            lines.append("Your virtual branch: \(branch). Every edit you make belongs to it.")
        }
        if task.ownedPaths.isEmpty {
            lines.append("No file boundary was set. Ask before touching shared files.")
        } else {
            lines.append("You own these paths and only these: \(task.ownedPaths.joined(separator: ", ")).")
        }
        lines.append("Report back when done. The Queen reviews before anything lands.")
        return lines.joined(separator: "\n")
    }
}
