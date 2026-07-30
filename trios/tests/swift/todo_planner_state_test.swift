// Standalone unit tests for the TODO plan state transitions - Foundation only.
//
// These exercise the pure helpers that WAVE-061 added around plan growth and
// overflow, which is where the dynamic-step change introduced risk.
//
// Run (from trios root):
//   swiftc tests/swift/todo_planner_state_test.swift rings/SR-00/TODOPlanState.swift \
//     rings/SR-00/TODOPlanDeriver.swift -o /tmp/trios_todo_planner_state_test \
//     && /tmp/trios_todo_planner_state_test

import Foundation

@main
enum TODOPlannerStateTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static func main() {
        overflowFolding()
        overflowPreservesActionable()
        persistCoalescing()
        displayGating()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All TODOPlannerState tests passed.")
    }

    static func step(_ title: String, _ state: PlanStepState, _ order: Int) -> PlanStep {
        PlanStep(id: UUID(), title: title, state: state, order: order)
    }

    static func overflowFolding() {
        scenario("a long run folds completed steps instead of growing without limit")

        var steps = (0..<20).map { step("Step \($0)", .completed, $0) }
        steps.append(step("Current", .inProgress, 20))
        let folded = PlanOverflow.coalesce(steps, maximum: 12)

        check(folded.count <= 12, "the list is capped at the maximum")
        check(
            folded.contains { $0.title == PlanOverflow.overflowTitle },
            "an overflow summary row is inserted"
        )

        let summary = folded.first { $0.title == PlanOverflow.overflowTitle }
        check(
            summary?.detail?.contains("steps completed") == true,
            "the summary states how many steps were folded, so nothing is silently lost"
        )
        check(
            folded.first?.title == PlanOverflow.overflowTitle,
            "the summary sits at the top, where the oldest work belongs"
        )
    }

    static func overflowPreservesActionable() {
        scenario("only completed steps fold - anything still actionable stays visible")

        var steps = (0..<18).map { step("Done \($0)", .completed, $0) }
        steps.append(step("Running", .inProgress, 18))
        steps.append(step("Waiting", .pending, 19))
        steps.append(step("Broke", .failed, 20))

        let folded = PlanOverflow.coalesce(steps, maximum: 8)
        let titles = folded.map(\.title)

        check(titles.contains("Running"), "the in-progress step survives folding")
        check(titles.contains("Waiting"), "a pending step survives folding")
        check(titles.contains("Broke"), "a failed step survives folding - it still needs attention")
        check(
            folded.filter { $0.state == .inProgress }.count == 1,
            "exactly one step remains in progress"
        )
    }

    static func persistCoalescing() {
        scenario("intermediate writes coalesce, terminal writes never do")

        let t0 = Date(timeIntervalSince1970: 1_700_000_000)
        check(
            PlanPersistPolicy.shouldWriteNow(isTerminal: true, lastWrite: t0, now: t0),
            "a terminal state writes immediately even with no elapsed time"
        )
        check(
            !PlanPersistPolicy.shouldWriteNow(isTerminal: false, lastWrite: t0, now: t0.addingTimeInterval(0.5)),
            "a rapid intermediate change is deferred"
        )
        check(
            PlanPersistPolicy.shouldWriteNow(isTerminal: false, lastWrite: t0, now: t0.addingTimeInterval(5)),
            "an intermediate change after the interval is written"
        )
        check(
            PlanPersistPolicy.shouldWriteNow(isTerminal: false, lastWrite: nil, now: t0),
            "the first write is never deferred"
        )

        // The point of the policy: a burst of tool calls must not become a burst
        // of encrypted-database writes.
        var writes = 0
        var last: Date? = nil
        for i in 0..<20 {
            let now = t0.addingTimeInterval(Double(i) * 0.2)
            if PlanPersistPolicy.shouldWriteNow(isTerminal: false, lastWrite: last, now: now) {
                writes += 1
                last = now
            }
        }
        check(writes <= 3, "twenty rapid steps collapse to at most three writes, got \(writes)")
    }

    static func displayGating() {
        scenario("a trivial turn renders no checklist")

        check(
            !PlanDisplayPolicy.shouldDisplay(stepCount: 1, isTerminalFailure: false),
            "one step shows nothing rather than an empty skeleton"
        )
        check(
            PlanDisplayPolicy.shouldDisplay(stepCount: 2, isTerminalFailure: false),
            "two steps are worth showing"
        )
        check(
            !PlanDisplayPolicy.shouldDisplay(stepCount: 0, isTerminalFailure: false),
            "no steps shows nothing"
        )
        // A failure must always be visible, however short the turn was.
        check(
            PlanDisplayPolicy.shouldDisplay(stepCount: 1, isTerminalFailure: true),
            "a failed one-step turn is still shown, because the user must see the error"
        )
    }
}
