// Standalone unit tests for TODOPlanDeriver - Foundation only.
//
// Run (from trios root):
//   swiftc tests/swift/todo_plan_deriver_test.swift rings/SR-00/TODOPlanDeriver.swift \
//     -o /tmp/trios_todo_plan_deriver_test && /tmp/trios_todo_plan_deriver_test

import Foundation

@main
enum TODOPlanDeriverTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static func main() {
        toolTitles()
        dynamicLength()
        consecutiveCollapsing()
        trivialTurns()
        progressReporting()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All TODOPlanDeriver tests passed.")
    }

    static func toolTitles() {
        scenario("tool identifiers become readable step titles")

        check(TODOPlanDeriver.title(forTool: "filesystem_read") == "Read files", "known tool is named")
        check(TODOPlanDeriver.title(forTool: "shell_execute") == "Run commands", "shell is named")
        check(TODOPlanDeriver.title(forTool: "SCREENSHOT") == "Capture screen", "matching is case-insensitive")

        // An unknown tool must still produce a usable row rather than vanish.
        check(
            TODOPlanDeriver.title(forTool: "browser_get_active_page") == "Browser get active page",
            "an unknown tool is humanised instead of dropped"
        )
        check(TODOPlanDeriver.title(forTool: "") == "Run tool", "an empty name still yields a title")
        check(TODOPlanDeriver.humanize("a_b_c") == "A b c", "underscores become spaces")
        check(TODOPlanDeriver.humanize("deploy") == "Deploy", "a single word is capitalised")
    }

    static func dynamicLength() {
        scenario("the plan grows with the work instead of being fixed at three")

        var titles: [String] = []
        titles = TODOPlanDeriver.appendStep(.preparing, to: titles)
        titles = TODOPlanDeriver.appendStep(.tool(name: "filesystem_read"), to: titles)
        titles = TODOPlanDeriver.appendStep(.tool(name: "shell_execute"), to: titles)
        titles = TODOPlanDeriver.appendStep(.tool(name: "filesystem_write"), to: titles)
        titles = TODOPlanDeriver.appendStep(.composing, to: titles)

        check(titles.count == 5, "five observed activities yield five steps, not three")
        check(titles.first == "Understand request", "the first step is understanding")
        check(titles.last == "Compose answer", "the last step is composing the answer")
        check(
            titles == ["Understand request", "Read files", "Run commands", "Edit files", "Compose answer"],
            "steps appear in the order they happened"
        )

        // A longer run keeps growing.
        var long: [String] = []
        for i in 0..<12 {
            long = TODOPlanDeriver.appendStep(.tool(name: "tool_\(i)"), to: long)
        }
        check(long.count == 12, "twelve distinct tools yield twelve steps")
    }

    static func consecutiveCollapsing() {
        scenario("repeated identical work collapses, interleaved work does not")

        var titles: [String] = []
        for _ in 0..<6 {
            titles = TODOPlanDeriver.appendStep(.tool(name: "filesystem_read"), to: titles)
        }
        check(titles == ["Read files"], "six consecutive reads collapse into one step")

        // Different tools that map to the same title also collapse - that is the
        // point: the user cares about the activity, not the identifier.
        var aliases: [String] = []
        aliases = TODOPlanDeriver.appendStep(.tool(name: "filesystem_read"), to: aliases)
        aliases = TODOPlanDeriver.appendStep(.tool(name: "read_file"), to: aliases)
        check(aliases == ["Read files"], "aliases of one activity collapse")

        // Returning to a tool after doing something else is a new phase.
        var revisit: [String] = []
        revisit = TODOPlanDeriver.appendStep(.tool(name: "filesystem_read"), to: revisit)
        revisit = TODOPlanDeriver.appendStep(.tool(name: "shell_execute"), to: revisit)
        revisit = TODOPlanDeriver.appendStep(.tool(name: "filesystem_read"), to: revisit)
        check(
            revisit == ["Read files", "Run commands", "Read files"],
            "a non-consecutive repeat opens a new step"
        )
    }

    static func trivialTurns() {
        scenario("a trivial turn shows no checklist at all")

        var titles: [String] = []
        titles = TODOPlanDeriver.appendStep(.preparing, to: titles)
        check(
            !TODOPlanDeriver.shouldShowPlan(stepTitles: titles),
            "one step is not worth a plan - plain chat instead of an empty skeleton"
        )

        titles = TODOPlanDeriver.appendStep(.composing, to: titles)
        check(
            TODOPlanDeriver.shouldShowPlan(stepTitles: titles),
            "two steps justify showing the plan"
        )
        check(
            !TODOPlanDeriver.shouldShowPlan(stepTitles: []),
            "no observed work shows nothing"
        )

        // `finished` is a lifecycle marker, not a step.
        let before = titles
        check(
            TODOPlanDeriver.appendStep(.finished, to: titles) == before,
            "finishing does not append a step"
        )
    }

    static func progressReporting() {
        scenario("progress is reported over the real step count")

        check(TODOPlanDeriver.progressLabel(completed: 3, total: 3) == "100%", "all done is 100%")
        check(TODOPlanDeriver.progressLabel(completed: 1, total: 3) == "33%", "one of three is 33%")
        check(TODOPlanDeriver.progressLabel(completed: 5, total: 7) == "71%", "five of seven rounds to 71%")
        check(TODOPlanDeriver.progressLabel(completed: 0, total: 9) == "0%", "nothing done is 0%")

        // Guard rails: no divide-by-zero, no impossible values.
        check(TODOPlanDeriver.progressLabel(completed: 0, total: 0) == "0%", "an empty plan is 0%, not a crash")
        check(TODOPlanDeriver.progress(completed: 9, total: 3) == 1, "progress never exceeds 1")
        check(TODOPlanDeriver.progress(completed: -1, total: 3) == 0, "progress never goes negative")
    }
}
