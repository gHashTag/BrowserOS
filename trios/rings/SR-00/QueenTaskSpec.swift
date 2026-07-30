import Foundation

/// Renders a task as a specification the worker is held to, in the shape GitHub
/// Spec Kit uses: intent, acceptance criteria, boundary, out of scope,
/// verification.
///
/// The brief used to be prose - what the issue is, which branch, which files,
/// "report back when done". Nothing in it said what finished looks like, so "I
/// have finished" and "I have stopped" produced the same signal and neither the
/// worker nor the Queen could tell completion from abandonment. That is the
/// defect this exists to remove.
///
/// A specification is not longer prose. The difference is that every criterion
/// is something someone can run and get an answer from.
enum QueenTaskSpec {
    /// The sections, in the order a worker who only skims should meet them.
    /// Boundary before method: the rules land before the recipe.
    ///
    /// An enum rather than a list of strings, and `render` writes its headings
    /// from it. They used to be two copies of the same knowledge - the list said
    /// five sections, the renderer spelled five headings, and nothing tied them
    /// together. A sixth section added to the renderer would have been invisible
    /// to the test that walks this list, which is the kind of coverage that
    /// reads as thorough and checks the wrong thing.
    enum Section: String, CaseIterable {
        case intent = "Intent"
        case acceptanceCriteria = "Acceptance criteria"
        case boundary = "Boundary"
        case outOfScope = "Out of scope"
        case verification = "Verification"

        var heading: String { "## \(rawValue)" }
    }

    static var sectionTitles: [String] { Section.allCases.map(\.rawValue) }

    static func render(for task: DelegatedTask) -> String {
        var lines: [String] = ["# Specification: \(task.issue.slug)", ""]

        lines.append(Section.intent.heading)
        lines.append(task.title)
        lines.append("Issue: \(task.issue.url)")
        lines.append("")

        lines.append(Section.acceptanceCriteria.heading)
        if task.acceptanceCriteria.isEmpty {
            // Stated, never hidden. A task with no criteria cannot be judged
            // complete - only abandoned - and the worker needs to know that
            // before it starts rather than at review.
            lines.append("None were set. Nothing here can be judged finished, so "
                + "before doing anything else, write down what would make this "
                + "task done and say so in this chat. If you cannot, the task is "
                + "not ready and saying that is the correct outcome.")
        } else {
            for (index, criterion) in task.acceptanceCriteria.enumerated() {
                lines.append("\(index + 1). \(criterion)")
            }
        }
        lines.append("")

        lines.append(Section.boundary.heading)
        if task.ownedPaths.isEmpty {
            lines.append("No paths were assigned. Ask before editing anything shared.")
        } else {
            lines.append("You may write to these paths and no others: "
                + task.ownedPaths.joined(separator: ", ") + ".")
        }
        if let branch = task.virtualBranch {
            lines.append("Every edit belongs to `\(branch)`.")
        }
        lines.append("")

        lines.append(Section.outOfScope.heading)
        lines.append("Anything not required by a criterion above. Work that seems "
            + "obviously needed and is not listed is a thing to raise here, not "
            + "to do quietly - unstated scope is where a review turns into an "
            + "argument.")
        lines.append("")

        lines.append(Section.verification.heading)
        lines.append("State each criterion and whether you met it, did not meet "
            + "it, or could not check. Do not summarise. An unchecked criterion "
            + "is not a pass, and reporting it honestly costs you nothing.")

        return lines.joined(separator: "\n")
    }

    /// Whether this specification can be handed to a worker at all.
    ///
    /// Separate from rendering so the Queen can tell the difference between "no
    /// criteria yet" and "ready", and so the answer is testable without reading
    /// the rendered text back.
    static func isActionable(_ task: DelegatedTask) -> Bool {
        !task.acceptanceCriteria.isEmpty
    }
}
