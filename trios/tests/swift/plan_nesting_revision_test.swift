// Standalone unit tests for PlanNesting and PlanReviser - Foundation only.
//
// Run (from trios root):
//   swiftc tests/swift/plan_nesting_revision_test.swift rings/SR-00/TODOPlanState.swift \
//     rings/SR-00/PlanNesting.swift rings/SR-00/PlanRevision.swift \
//     -o /tmp/trios_plan_nesting_revision_test && /tmp/trios_plan_nesting_revision_test

import Foundation

@main
enum PlanNestingRevisionTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static func step(_ title: String, _ state: PlanStepState, _ order: Int) -> PlanStep {
        PlanStep(title: title, state: state, order: order)
    }

    static func main() {
        nestingBuild()
        parentRollup()
        nestedCounts()
        revisionPreservesHistory()
        revisionShapes()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All PlanNesting/PlanReviser tests passed.")
    }

    static func nestingBuild() {
        scenario("delegated steps nest under their parent")

        let parent = step("Refactor module", .inProgress, 0)
        let childA = step("Read files", .completed, 1)
        let childB = step("Edit files", .inProgress, 2)
        let other = step("Compose answer", .pending, 3)

        let tree = PlanNesting.build(
            steps: [parent, childA, childB, other],
            parentTitles: [childA.id: "Refactor module", childB.id: "Refactor module"]
        )

        check(tree.count == 2, "two top-level rows: the parent and the unrelated step")
        check(tree.first?.children.count == 2, "both delegated steps nest under the parent")
        check(tree.last?.isLeaf == true, "an unrelated step stays a leaf")

        // A child whose parent is unknown must not vanish.
        let orphan = step("Mystery", .pending, 4)
        let withOrphan = PlanNesting.build(
            steps: [parent, orphan],
            parentTitles: [orphan.id: "Nonexistent parent"]
        )
        check(
            withOrphan.count == 2,
            "a step whose parent is missing stays visible at top level instead of being dropped"
        )
    }

    static func parentRollup() {
        scenario("a parent reports the truth about its children")

        let parent = step("Group", .completed, 0)

        let allDone = PlanNode(step: parent, children: [
            PlanNode(step: step("a", .completed, 1)),
            PlanNode(step: step("b", .completed, 2)),
        ])
        check(PlanNesting.rolledUpState(for: allDone) == .completed, "all children done means done")

        // The important one: a failed child must not be hidden by a parent that
        // was itself marked complete.
        let withFailure = PlanNode(step: parent, children: [
            PlanNode(step: step("a", .completed, 1)),
            PlanNode(step: step("b", .failed, 2)),
        ])
        check(
            PlanNesting.rolledUpState(for: withFailure) == .failed,
            "a failed child surfaces through a parent marked complete"
        )

        let running = PlanNode(step: parent, children: [
            PlanNode(step: step("a", .completed, 1)),
            PlanNode(step: step("b", .inProgress, 2)),
        ])
        check(PlanNesting.rolledUpState(for: running) == .inProgress, "a running child keeps the parent running")

        let pendingChild = PlanNode(step: parent, children: [
            PlanNode(step: step("a", .completed, 1)),
            PlanNode(step: step("b", .pending, 2)),
        ])
        check(
            PlanNesting.rolledUpState(for: pendingChild) == .inProgress,
            "unfinished work keeps the parent running, never complete"
        )

        let leaf = PlanNode(step: step("solo", .pending, 0))
        check(PlanNesting.rolledUpState(for: leaf) == .pending, "a leaf reports its own state")
    }

    static func nestedCounts() {
        scenario("progress counts every step, not just top-level rows")

        let tree = [
            PlanNode(step: step("p1", .completed, 0), children: [
                PlanNode(step: step("c1", .completed, 1)),
                PlanNode(step: step("c2", .completed, 2)),
            ]),
            PlanNode(step: step("p2", .inProgress, 3), children: [
                PlanNode(step: step("c3", .completed, 4)),
                PlanNode(step: step("c4", .pending, 5)),
            ]),
        ]
        check(PlanNesting.totalCount(tree) == 6, "six steps in total across two levels")
        check(
            PlanNesting.completedCount(tree) == 4,
            "p1 plus its two children plus c3 are complete; p2 is not, because c4 is pending"
        )
        check(
            PlanNesting.childSummary(for: tree[1]) == "1/2 subtasks",
            "a collapsed parent summarises its children"
        )
        check(
            PlanNesting.childSummary(for: PlanNode(step: step("leaf", .pending, 0))) == nil,
            "a leaf has no subtask summary"
        )
    }

    /// The invariant that makes mid-run revision safe.
    static func revisionPreservesHistory() {
        scenario("a revision may reshape the future but never rewrite history")

        let done = step("Read files", .completed, 0)
        let failed = step("Run commands", .failed, 1)
        let running = step("Edit files", .inProgress, 2)
        let pending = step("Verify", .pending, 3)
        let steps = [done, failed, running, pending]

        let replaced = PlanReviser.apply(.replacePending(["New A", "New B"]), to: steps)
        let titles = replaced.map(\.title)
        check(titles.contains("Read files"), "a completed step survives replacement")
        check(titles.contains("Run commands"), "a failed step survives replacement")
        check(titles.contains("Edit files"), "the running step survives replacement")
        check(!titles.contains("Verify"), "the pending tail is replaced")
        check(titles.contains("New A") && titles.contains("New B"), "the new tail is present")
        check(
            replaced.map(\.order) == Array(0..<replaced.count),
            "orders stay dense after the edit"
        )

        // Renaming history is refused rather than silently applied.
        let renamed = PlanReviser.apply(.rename(id: done.id, title: "Rewritten"), to: steps)
        check(
            renamed.first { $0.id == done.id }?.title == "Read files",
            "renaming a completed step is refused"
        )
        check(
            PlanReviser.wouldRewriteHistory(.rename(id: done.id, title: "x"), in: steps),
            "the caller can detect that a revision would rewrite history"
        )
        check(
            !PlanReviser.wouldRewriteHistory(.rename(id: pending.id, title: "x"), in: steps),
            "renaming a pending step is allowed"
        )
        let renamedPending = PlanReviser.apply(.rename(id: pending.id, title: "Verify twice"), to: steps)
        check(
            renamedPending.first { $0.id == pending.id }?.title == "Verify twice",
            "a pending step can be renamed"
        )
    }

    static func revisionShapes() {
        scenario("insert and drop behave predictably")

        let running = step("Edit files", .inProgress, 0)
        let p1 = step("Verify", .pending, 1)
        let p2 = step("Report", .pending, 2)
        let steps = [running, p1, p2]

        let inserted = PlanReviser.apply(.insertAfterCurrent(["Test"]), to: steps)
        check(
            inserted.map(\.title) == ["Edit files", "Test", "Verify", "Report"],
            "inserted work lands directly after the running step"
        )

        let dropped = PlanReviser.apply(.dropPending(["Report"]), to: steps)
        check(
            dropped.map(\.title) == ["Edit files", "Verify"],
            "a named pending step is dropped"
        )
        let droppedRunning = PlanReviser.apply(.dropPending(["Edit files"]), to: steps)
        check(
            droppedRunning.map(\.title).contains("Edit files"),
            "dropping cannot remove the running step"
        )

        // Empty and whitespace titles must not create ghost rows.
        let noise = PlanReviser.apply(.replacePending(["", "   ", "Real"]), to: steps)
        check(
            noise.filter { $0.state == .pending }.map(\.title) == ["Real"],
            "blank titles are discarded"
        )
    }
}
