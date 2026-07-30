import Foundation

/// A step the agent is observed to take.
enum AgentActivity: Equatable, Sendable {
    /// The request was accepted and is being prepared.
    case preparing
    /// A tool call started. `name` is the raw tool identifier.
    case tool(name: String)
    /// The model started producing the answer text.
    case composing
    /// The turn finished successfully.
    case finished
}

/// Derives a plan from what the agent actually does, instead of a fixed
/// three-step template.
///
/// The old plan was always "Understand request / Execute task / Verify result"
/// regardless of the work, so it neither described nor tracked reality. The
/// research consensus for agent plan UIs is that the list must be
/// append-and-reorder capable with stable ids, and that trivial turns should
/// show no plan at all rather than an empty skeleton.
///
/// Pure and dependency-free so the mapping is unit-testable.
enum TODOPlanDeriver {
    /// Turns below this many observed steps are not worth a checklist. A
    /// one-shot answer with no tools renders as plain chat.
    static let minimumStepsForPlan = 2

    /// Human titles for the tools TriOS actually surfaces. Unknown tools fall
    /// back to a readable form of their identifier rather than being dropped -
    /// an unnamed step is still real work the user should see.
    static func title(forTool rawName: String) -> String {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return "Run tool" }
        switch name.lowercased() {
        case "filesystem_read", "read_file", "read":
            return "Read files"
        case "filesystem_write", "write_file", "write", "edit":
            return "Edit files"
        case "shell_execute", "bash", "run_command":
            return "Run commands"
        case "navigate", "browser_navigate":
            return "Open page"
        case "screenshot", "browser_screenshot":
            return "Capture screen"
        case "get_active_page", "snapshot", "read_page":
            return "Inspect page"
        case "search", "web_search", "grep":
            return "Search"
        default:
            return humanize(name)
        }
    }

    /// `browser_get_active_page` -> `Browser get active page`.
    static func humanize(_ identifier: String) -> String {
        let words = identifier
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map(String.init)
            .filter { !$0.isEmpty }
        guard let first = words.first else { return identifier }
        let rest = words.dropFirst().joined(separator: " ")
        let head = first.prefix(1).uppercased() + first.dropFirst().lowercased()
        return rest.isEmpty ? head : "\(head) \(rest.lowercased())"
    }

    /// Title shown for a non-tool activity.
    static func title(for activity: AgentActivity) -> String {
        switch activity {
        case .preparing: return "Understand request"
        case .tool(let name): return title(forTool: name)
        case .composing: return "Compose answer"
        case .finished: return "Done"
        }
    }

    /// Folds an observed activity into the running list of step titles.
    ///
    /// Consecutive uses of the same tool collapse into one step - an agent that
    /// reads six files should show "Read files", not six identical rows. A
    /// repeat that is *not* consecutive does open a new step, because returning
    /// to a tool after doing something else is genuinely a new phase.
    static func appendStep(_ activity: AgentActivity, to titles: [String]) -> [String] {
        guard activity != .finished else { return titles }
        let next = title(for: activity)
        if titles.last == next { return titles }
        return titles + [next]
    }

    /// Whether the observed work justifies rendering a checklist.
    static func shouldShowPlan(stepTitles: [String]) -> Bool {
        stepTitles.count >= minimumStepsForPlan
    }

    /// Progress as a fraction, for the header percentage.
    static func progress(completed: Int, total: Int) -> Double {
        guard total > 0 else { return 0 }
        return min(1, max(0, Double(completed) / Double(total)))
    }

    /// Percentage string shown in the plan header.
    static func progressLabel(completed: Int, total: Int) -> String {
        "\(Int((progress(completed: completed, total: total) * 100).rounded()))%"
    }
}
