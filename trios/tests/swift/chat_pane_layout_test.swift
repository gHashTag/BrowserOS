// Standalone unit tests for ChatPaneLayout - Foundation only.
//
// Run (from trios root):
//   swiftc tests/swift/chat_pane_layout_test.swift rings/SR-00/ChatPaneLayout.swift \
//     -o /tmp/trios_chat_pane_layout_test && /tmp/trios_chat_pane_layout_test

import Foundation

@main
enum ChatPaneLayoutTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static func main() {
        composerAlwaysFits()
        plannerIsBounded()
        shortPanes()
        degenerateInput()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All ChatPaneLayout tests passed.")
    }

    /// The regression this file exists for: a tall planner must never take the
    /// composer's space.
    static func composerAlwaysFits() {
        scenario("the composer always keeps its space, whatever the planner wants")

        for height in [400.0, 600.0, 900.0, 1400.0] {
            let cap = ChatPaneLayout.plannerMaxHeight(paneHeight: height) ?? 0
            let remaining = height - cap
            check(
                remaining >= ChatPaneLayout.composerReservedHeight,
                "at \(Int(height))pt the composer still fits (\(Int(remaining))pt left)"
            )
            check(
                remaining >= ChatPaneLayout.composerReservedHeight + ChatPaneLayout.messagesReservedHeight
                    || cap == 0,
                "at \(Int(height))pt the message list also keeps its floor"
            )
        }
    }

    static func plannerIsBounded() {
        scenario("the planner never exceeds its share of the pane")

        let height = 1000.0
        guard let cap = ChatPaneLayout.plannerMaxHeight(paneHeight: height) else {
            check(false, "a 1000pt pane yields a planner cap")
            return
        }
        check(
            cap <= height * ChatPaneLayout.plannerMaxHeightFraction + 0.001,
            "the cap respects the fraction"
        )
        check(cap > 0, "the cap is positive")

        // A taller pane may give the planner more room, never less.
        let taller = ChatPaneLayout.plannerMaxHeight(paneHeight: 1400) ?? 0
        check(taller >= cap, "a taller pane does not shrink the planner")
    }

    static func shortPanes() {
        scenario("a short pane hides the planner rather than rendering a sliver")

        // 108 composer + 120 messages = 228 before the planner gets anything.
        check(
            ChatPaneLayout.shouldHidePlanner(paneHeight: 200),
            "a 200pt pane cannot host a planner"
        )
        check(
            ChatPaneLayout.shouldHidePlanner(paneHeight: 300),
            "a 300pt pane still cannot fit a useful planner"
        )
        check(
            !ChatPaneLayout.shouldHidePlanner(paneHeight: 700),
            "a 700pt pane can"
        )
        check(
            ChatPaneLayout.plannerMaxHeight(paneHeight: 200) == nil,
            "hiding is expressed as nil, not as a zero-height card"
        )

        // Whenever it is shown, it is at least useful.
        for height in stride(from: 300.0, through: 1600.0, by: 50.0) {
            if let cap = ChatPaneLayout.plannerMaxHeight(paneHeight: height) {
                check(
                    cap >= ChatPaneLayout.plannerMinUsefulHeight,
                    "at \(Int(height))pt a shown planner is at least usable"
                )
            }
        }
    }

    static func degenerateInput() {
        scenario("degenerate pane heights do not produce nonsense")

        check(ChatPaneLayout.plannerMaxHeight(paneHeight: 0) == nil, "zero height hides the planner")
        check(ChatPaneLayout.plannerMaxHeight(paneHeight: -50) == nil, "negative height hides the planner")
        check(
            ChatPaneLayout.plannerMaxHeight(paneHeight: .infinity) == nil,
            "a non-finite height is rejected rather than producing an infinite card"
        )
        check(
            ChatPaneLayout.plannerMaxHeight(paneHeight: .nan) == nil,
            "NaN is rejected"
        )
    }
}
