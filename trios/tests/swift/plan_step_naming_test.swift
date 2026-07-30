// Standalone unit tests for PlanStepNaming - Foundation only.
//
// Run (from trios root):
//   swiftc tests/swift/plan_step_naming_test.swift rings/SR-00/PlanStepNaming.swift \
//     -o /tmp/trios_plan_step_naming_test && /tmp/trios_plan_step_naming_test

import Foundation

@main
enum PlanStepNamingTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static func main() {
        namesTheTarget()
        pathsAndHosts()
        fallsBackHonestly()
        boundsTheTitle()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All PlanStepNaming tests passed.")
    }

    /// The complaint this addresses: category labels tell the user nothing.
    static func namesTheTarget() {
        scenario("a step names the actual target instead of a category")

        check(
            PlanStepNaming.title(
                toolName: "filesystem_read",
                argumentsJSON: "{\"path\":\"/Users/x/trios/BR-OUTPUT/ChatPanelView.swift\"}",
                generic: "Read files"
            ) == "Read ChatPanelView.swift",
            "a file read names the file, not 'Read files'"
        )
        check(
            PlanStepNaming.title(
                toolName: "shell_execute",
                argumentsJSON: "{\"command\":\"cargo test --workspace --all-features\"}",
                generic: "Run commands"
            ) == "Run cargo test --workspace --all-features",
            "a command that fits the word budget is shown whole"
        )
        check(
            PlanStepNaming.title(
                toolName: "shell_execute",
                argumentsJSON: "{\"command\":\"git log --oneline -20 --author me\"}",
                generic: "Run commands"
            ) == "Run git log --oneline -20...",
            "a longer command is cut at the word budget and marked"
        )
        check(
            PlanStepNaming.title(
                toolName: "navigate",
                argumentsJSON: "{\"url\":\"https://www.example.com/a/b?c=1\"}",
                generic: "Open page"
            ) == "Open example.com",
            "a navigation names the host, without the www or the query"
        )
        check(
            PlanStepNaming.title(
                toolName: "grep",
                argumentsJSON: "{\"pattern\":\"shouldDisplayPlan\"}",
                generic: "Search"
            ) == "Search \"shouldDisplayPlan\"",
            "a search quotes what it looked for"
        )
    }

    static func pathsAndHosts() {
        scenario("path and host extraction behave sensibly")

        check(PlanStepNaming.lastPathComponent("/a/b/c.swift") == "c.swift", "a path yields its leaf")
        check(PlanStepNaming.lastPathComponent("c.swift") == "c.swift", "a bare name is unchanged")
        check(PlanStepNaming.lastPathComponent("/a/b/") == "b", "a trailing slash is ignored")
        check(PlanStepNaming.host(from: "https://sub.example.com/x") == "sub.example.com", "subdomains survive")
        check(PlanStepNaming.host(from: "not a url") == nil, "a non-URL yields no host")
        check(PlanStepNaming.firstWords("one two three four", limit: 2) == "one two...", "truncation is marked")
        check(PlanStepNaming.firstWords("one two", limit: 5) == "one two", "short text is untouched")
    }

    /// Falling back to the generic label is correct; inventing a target is not.
    static func fallsBackHonestly() {
        scenario("without usable arguments the generic title is kept")

        check(
            PlanStepNaming.title(toolName: "filesystem_read", argumentsJSON: nil, generic: "Read files")
                == "Read files",
            "no arguments keeps the generic title"
        )
        check(
            PlanStepNaming.title(toolName: "filesystem_read", argumentsJSON: "", generic: "Read files")
                == "Read files",
            "empty arguments keep the generic title"
        )
        check(
            PlanStepNaming.title(toolName: "filesystem_read", argumentsJSON: "{ broken", generic: "Read files")
                == "Read files",
            "malformed JSON keeps the generic title rather than crashing"
        )
        check(
            PlanStepNaming.title(
                toolName: "filesystem_read",
                argumentsJSON: "{\"unrelated\":\"value\"}",
                generic: "Read files"
            ) == "Read files",
            "arguments with no recognised key keep the generic title"
        )
        check(
            PlanStepNaming.title(
                toolName: "filesystem_read",
                argumentsJSON: "{\"path\":\"   \"}",
                generic: "Read files"
            ) == "Read files",
            "a whitespace-only path is not a target"
        )
        check(
            PlanStepNaming.title(
                toolName: "unknown_tool",
                argumentsJSON: "{\"path\":\"x.txt\"}",
                generic: "Unknown tool"
            ) == "Use x.txt",
            "an unfamiliar tool still names its target with a neutral verb"
        )
    }

    static func boundsTheTitle() {
        scenario("titles stay one line")

        let long = String(repeating: "a", count: 200)
        let title = PlanStepNaming.title(
            toolName: "shell_execute",
            argumentsJSON: "{\"command\":\"\(long)\"}",
            generic: "Run commands"
        )
        check(
            title.count <= PlanStepNaming.maximumTitleLength,
            "a very long argument is truncated to the limit, got \(title.count)"
        )
        check(title.hasSuffix("\u{2026}"), "truncation is visible with an ellipsis")
        check(
            PlanStepNaming.truncate("short") == "short",
            "a short title is untouched"
        )
    }
}
