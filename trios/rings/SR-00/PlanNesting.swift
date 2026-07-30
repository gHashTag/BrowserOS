import Foundation

/// A step plus the work delegated beneath it.
///
/// Nesting is the accepted answer to plan length: assistant-ui renders a tool
/// call that carries its own conversation as a nested thread, and Deep Agents
/// keeps a lightweight snapshot per subagent so a parent row can show progress
/// without carrying the child's messages. Both point the same way - a parent row
/// summarises, children stay collapsed until asked for.
struct PlanNode: Identifiable, Equatable, Sendable {
    let id: UUID
    var step: PlanStep
    var children: [PlanNode]

    init(id: UUID = UUID(), step: PlanStep, children: [PlanNode] = []) {
        self.id = id
        self.step = step
        self.children = children
    }

    var isLeaf: Bool { children.isEmpty }
}

/// Builds and summarises nested plans.
enum PlanNesting {
    /// Groups steps under parents using an explicit parent title.
    ///
    /// A step whose `parentTitle` matches an earlier step becomes its child.
    /// Unmatched parents are kept at the top level rather than dropped - losing
    /// a step because its parent has not arrived yet would misreport the work.
    static func build(
        steps: [PlanStep],
        parentTitles: [UUID: String]
    ) -> [PlanNode] {
        let ordered = steps.sorted { $0.order < $1.order }
        var roots: [PlanNode] = []
        var indexByTitle: [String: Int] = [:]

        for step in ordered {
            if let parentTitle = parentTitles[step.id],
               let rootIndex = indexByTitle[parentTitle] {
                roots[rootIndex].children.append(PlanNode(step: step))
                continue
            }
            indexByTitle[step.title] = roots.count
            roots.append(PlanNode(step: step))
        }
        return roots
    }

    /// Rolls a parent's state up from its children.
    ///
    /// A parent is only complete when every child is; any failure surfaces, and
    /// any running child keeps the parent running. Reporting a parent complete
    /// while a child failed would hide the very thing the user needs to see.
    static func rolledUpState(for node: PlanNode) -> PlanStepState {
        guard !node.children.isEmpty else { return node.step.state }
        let states = node.children.map { rolledUpState(for: $0) }
        if states.contains(.failed) { return .failed }
        if states.contains(.inProgress) { return .inProgress }
        if states.contains(.pending) { return .inProgress }
        if states.allSatisfy({ $0 == .cancelled }) { return .cancelled }
        if states.allSatisfy({ $0 == .completed || $0 == .cancelled }) { return .completed }
        return .inProgress
    }

    /// Counts every step in the tree, so progress reflects real work rather
    /// than top-level rows.
    static func totalCount(_ nodes: [PlanNode]) -> Int {
        nodes.reduce(0) { $0 + 1 + totalCount($1.children) }
    }

    static func completedCount(_ nodes: [PlanNode]) -> Int {
        nodes.reduce(0) { partial, node in
            let selfCount = rolledUpState(for: node) == .completed ? 1 : 0
            return partial + selfCount + completedCount(node.children)
        }
    }

    /// Short summary shown on a collapsed parent row.
    static func childSummary(for node: PlanNode) -> String? {
        guard !node.children.isEmpty else { return nil }
        let done = node.children.filter { rolledUpState(for: $0) == .completed }.count
        return "\(done)/\(node.children.count) subtasks"
    }
}
